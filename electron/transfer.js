'use strict';
// 传输队列：目录递归展开 -> 冲突检查 -> 并发执行 -> 进度/取消/重试
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const local = require('./local');

const FLUSH_MS = 150;

function basename(p, posix) {
  const parts = String(p).replace(/\/+$/, '').split(posix ? '/' : path.sep);
  return parts[parts.length - 1] || p;
}

function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return [name, ''];
  return [name.slice(0, i), name.slice(i)];
}

class TransferEngine extends EventEmitter {
  constructor(ssh, store) {
    super();
    this.ssh = ssh;
    this.store = store;
    this.tasks = new Map();
    this.jobs = new Map();
    this.queue = [];
    this.active = new Map();
    this.plans = new Map();
    this.paused = false;
    this.dirty = new Set();
    this.flushTimer = null;
    this.structural = false;
  }

  get concurrency() {
    return Math.max(1, Math.min(8, this.store.settings().concurrency || 3));
  }

  // ---------- 对外：先出计划，界面确认冲突后再开跑 ----------

  async plan({ hostId, direction, sources, destDir }) {
    const host = this.store.get(hostId);
    if (!host) throw new Error('主机不存在');
    const posixSrc = direction === 'download';
    const files = [];
    const dirs = [];

    for (const s of sources) {
      const name = s.name || basename(s.path, posixSrc);
      const isDir = s.kind === 'dir' || s.linkTo === 'dir';
      if (isDir) {
        dirs.push(name);
        const sub = direction === 'upload' ? await local.walk(s.path) : await this.ssh.walk(hostId, s.path);
        for (const d of sub.dirs) dirs.push(`${name}/${d}`);
        for (const f of sub.files) files.push({ src: f.abs, rel: `${name}/${f.rel}`, size: f.size, mode: f.mode, mtime: f.mtime });
      } else {
        const st = direction === 'upload' ? await local.stat(s.path) : await this.ssh.stat(hostId, s.path);
        if (!st) throw new Error(`读不到 ${name}`);
        files.push({ src: s.path, rel: name, size: st.size, mode: st.mode, mtime: st.mtime });
      }
    }

    const joinDst = direction === 'upload'
      ? (rel) => path.posix.join(destDir, rel)
      : (rel) => path.join(destDir, rel.split('/').join(path.sep));

    const statDst = direction === 'upload'
      ? (p) => this.ssh.stat(hostId, p)
      : (p) => local.stat(p);

    const conflicts = [];
    for (const f of files) {
      f.dst = joinDst(f.rel);
      const st = await statDst(f.dst);
      if (st) conflicts.push({ rel: f.rel, dst: f.dst, size: st.size, existingSize: st.size, newSize: f.size, mtime: st.mtime });
    }

    const planId = crypto.randomUUID();
    const totalBytes = files.reduce((a, f) => a + (f.size || 0), 0);
    this.plans.set(planId, { planId, hostId, hostName: host.name, direction, destDir, files, dirs, totalBytes });
    setTimeout(() => this.plans.delete(planId), 10 * 60 * 1000).unref?.();

    return {
      planId,
      direction,
      hostName: host.name,
      destDir,
      fileCount: files.length,
      dirCount: dirs.length,
      totalBytes,
      conflicts: conflicts.slice(0, 200),
      conflictCount: conflicts.length,
    };
  }

  async start(planId, { conflict = 'overwrite' } = {}) {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error('这个传输计划已过期，请重新拖一次');
    this.plans.delete(planId);

    const { hostId, hostName, direction, destDir, dirs } = plan;
    const jobId = crypto.randomUUID();
    const isUp = direction === 'upload';

    // 先建好目标目录
    for (const rel of dirs.slice().sort((a, b) => a.split('/').length - b.split('/').length)) {
      const dir = isUp ? path.posix.join(destDir, rel) : path.join(destDir, rel.split('/').join(path.sep));
      try {
        if (isUp) await this.ssh.mkdir(hostId, dir);
        else await local.mkdir(dir);
      } catch { /* 已存在就跳过 */ }
    }

    const statDst = isUp ? (p) => this.ssh.stat(hostId, p) : (p) => local.stat(p);
    const taskIds = [];

    for (const f of plan.files) {
      let dst = f.dst;
      const existing = await statDst(dst);
      if (existing) {
        if (conflict === 'skip') continue;
        if (conflict === 'rename') {
          const dir = isUp ? path.posix.dirname(dst) : path.dirname(dst);
          const [stem, ext] = splitExt(basename(dst, isUp));
          for (let i = 2; i < 1000; i += 1) {
            const cand = isUp ? path.posix.join(dir, `${stem} ${i}${ext}`) : path.join(dir, `${stem} ${i}${ext}`);
            if (!(await statDst(cand))) { dst = cand; break; }
          }
        }
      }
      const id = crypto.randomUUID();
      this.tasks.set(id, {
        id,
        jobId,
        hostId,
        hostName,
        direction,
        src: f.src,
        dst,
        name: f.rel,
        size: f.size || 0,
        mode: f.mode,
        mtime: f.mtime,
        transferred: 0,
        speed: 0,
        state: 'queued',
        error: null,
        startedAt: null,
        endedAt: null,
      });
      taskIds.push(id);
      this.queue.push(id);
    }

    this.jobs.set(jobId, {
      id: jobId,
      hostId,
      hostName,
      direction,
      destDir,
      taskIds,
      createdAt: Date.now(),
      label: taskIds.length === 1 ? basename(this.tasks.get(taskIds[0]).name, true) : `${taskIds.length} 个文件`,
    });

    this.structural = true;
    this._flush(true);
    this._pump();
    return { jobId, taskCount: taskIds.length };
  }

  // ---------- 调度 ----------

  _pump() {
    if (this.paused) return;
    while (this.active.size < this.concurrency && this.queue.length) {
      const id = this.queue.shift();
      const task = this.tasks.get(id);
      if (!task || task.state !== 'queued') continue;
      this._run(task);
    }
    if (!this.active.size && !this.queue.length) this._flush(true);
  }

  async _run(task) {
    task.state = 'running';
    task.startedAt = Date.now();
    task.transferred = 0;
    this.structural = true;
    this._flush(true);

    const ctl = { cancelled: false, handle: null, abort: null };
    this.active.set(task.id, ctl);

    let lastBytes = 0;
    let lastAt = Date.now();
    const onStep = (total) => {
      task.transferred = total;
      const now = Date.now();
      const dt = now - lastAt;
      if (dt >= 400) {
        const inst = ((total - lastBytes) * 1000) / dt;
        task.speed = task.speed ? task.speed * 0.6 + inst * 0.4 : inst;
        lastBytes = total;
        lastAt = now;
      }
      this.dirty.add(task.id);
      this._schedule();
    };

    try {
      const handle = await this.ssh.acquire(task.hostId);
      ctl.handle = handle;
      if (ctl.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });

      await this._transfer(handle.sftp, task, onStep, ctl);
      handle.release();
      ctl.handle = null;

      if (this.store.settings().preserveMtime && task.mtime) {
        try {
          if (task.direction === 'download') await fsp.utimes(task.dst, new Date(), new Date(task.mtime));
        } catch { /* 时间戳设不上不算失败 */ }
      }

      task.transferred = task.size;
      task.state = 'done';
      task.endedAt = Date.now();
    } catch (err) {
      if (ctl.handle) { try { ctl.handle.destroy(); } catch { /* ignore */ } ctl.handle = null; }
      if (ctl.cancelled || err.cancelled) {
        task.state = 'cancelled';
        task.error = null;
        await this._cleanupPartial(task);
      } else {
        task.state = 'error';
        task.error = String(err.message || err);
      }
      task.endedAt = Date.now();
    } finally {
      task.speed = 0;
      this.active.delete(task.id);
      this.structural = true;
      this._flush(true);
      this._pump();
    }
  }

  _transfer(sftp, task, onStep, ctl) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };
      const ok = () => { if (!settled) { settled = true; resolve(); } };
      // fastPut/fastGet 没有中断接口，关掉通道后它的回调可能再也不来，
      // 所以取消时直接在这里结算：通道已销毁，字节流确实停了。
      ctl.abort = () => fail(Object.assign(new Error('已取消'), { cancelled: true }));

      const opts = {
        concurrency: 32,
        chunkSize: 32 * 1024,
        step: (transferred) => onStep(transferred),
      };
      if (task.direction === 'upload' && task.mode) opts.mode = task.mode;

      const cb = (err) => {
        if (err) return fail(ctl.cancelled ? Object.assign(new Error('已取消'), { cancelled: true }) : err);
        if (task.direction === 'upload' && this.store.settings().preserveMtime && task.mtime) {
          const secs = Math.floor(task.mtime / 1000);
          return sftp.utimes(task.dst, secs, secs, () => ok());
        }
        ok();
      };

      if (task.direction === 'upload') sftp.fastPut(task.src, task.dst, opts, cb);
      else sftp.fastGet(task.src, task.dst, opts, cb);
    });
  }

  async _cleanupPartial(task) {
    try {
      if (task.direction === 'download') {
        const st = await local.stat(task.dst);
        if (st && !st.isDir && st.size < task.size) await fsp.unlink(task.dst);
      }
    } catch { /* 清不掉就算了 */ }
  }

  // ---------- 控制 ----------

  cancelTask(id) {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.state === 'queued') {
      task.state = 'cancelled';
      this.queue = this.queue.filter((q) => q !== id);
    } else if (task.state === 'running') {
      const ctl = this.active.get(id);
      if (ctl) {
        ctl.cancelled = true;
        if (ctl.handle) { try { ctl.handle.destroy(); } catch { /* ignore */ } ctl.handle = null; }
        if (ctl.abort) ctl.abort();
      }
    }
    this.structural = true;
    this._flush(true);
    this._pump();
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    for (const id of job.taskIds) {
      const t = this.tasks.get(id);
      if (t && (t.state === 'queued' || t.state === 'running')) this.cancelTask(id);
    }
  }

  cancelAll() {
    for (const [id, t] of this.tasks) if (t.state === 'queued' || t.state === 'running') this.cancelTask(id);
  }

  retryTask(id) {
    const task = this.tasks.get(id);
    if (!task || !['error', 'cancelled'].includes(task.state)) return;
    task.state = 'queued';
    task.error = null;
    task.transferred = 0;
    task.endedAt = null;
    this.queue.push(id);
    this.structural = true;
    this._flush(true);
    this._pump();
  }

  retryFailed() {
    for (const [id, t] of this.tasks) if (t.state === 'error') this.retryTask(id);
  }

  setPaused(v) {
    this.paused = !!v;
    if (!this.paused) this._pump();
    this.structural = true;
    this._flush(true);
  }

  clearFinished() {
    for (const [id, t] of this.tasks) {
      if (['done', 'error', 'cancelled'].includes(t.state)) this.tasks.delete(id);
    }
    for (const [jid, job] of this.jobs) {
      if (!job.taskIds.some((id) => this.tasks.has(id))) this.jobs.delete(jid);
    }
    this.structural = true;
    this._flush(true);
  }

  // ---------- 快照 / 事件 ----------

  stats() {
    let total = 0;
    let done = 0;
    let speed = 0;
    let running = 0;
    let queued = 0;
    let failed = 0;
    let finished = 0;
    for (const t of this.tasks.values()) {
      if (t.state === 'cancelled') continue;
      total += t.size;
      done += t.state === 'done' ? t.size : t.transferred;
      if (t.state === 'running') { running += 1; speed += t.speed; }
      else if (t.state === 'queued') queued += 1;
      else if (t.state === 'error') failed += 1;
      else if (t.state === 'done') finished += 1;
    }
    const remaining = Math.max(0, total - done);
    return {
      total,
      done,
      speed,
      running,
      queued,
      failed,
      finished,
      paused: this.paused,
      active: running + queued > 0,
      eta: speed > 1024 ? remaining / speed : null,
      concurrency: this.concurrency,
    };
  }

  snapshot() {
    return {
      tasks: [...this.tasks.values()].map((t) => ({ ...t })),
      jobs: [...this.jobs.values()],
      stats: this.stats(),
    };
  }

  _schedule() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this._flush(false);
    }, FLUSH_MS);
    this.flushTimer.unref?.();
  }

  _flush(force) {
    if (this.structural || force) {
      this.structural = false;
      this.dirty.clear();
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
      this.emit('snapshot', this.snapshot());
      return;
    }
    if (!this.dirty.size) return;
    const deltas = [...this.dirty].map((id) => {
      const t = this.tasks.get(id);
      return t ? { id, transferred: t.transferred, speed: t.speed, state: t.state } : null;
    }).filter(Boolean);
    this.dirty.clear();
    this.emit('progress', { deltas, stats: this.stats() });
  }
}

module.exports = { TransferEngine };
