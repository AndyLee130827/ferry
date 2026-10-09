(function () {
  'use strict';
  /* global window, document */
  const F = window.F;
  const { h, clear, icon, iconEl, bytes, speed, duration, toast, openSheet } = F;

  const ORDER = { running: 0, queued: 1, error: 2, cancelled: 3, done: 4 };

  class Queue {
    constructor(app) {
      this.app = app;
      this.rows = new Map();
      this.tasks = new Map();
      this.stats = null;
      this.build();
    }

    build() {
      this.title = h('span', { class: 'q-title', text: '传输' });
      this.stat = h('span', { class: 'q-stat', text: '空闲' });
      this.bar = h('i', { class: 'q-bar', style: { width: '0%' } });
      this.barWrap = h('div', { class: 'q-bar-wrap', hidden: true }, this.bar);

      this.pauseBtn = h('button', { class: 'btn icon ghost', title: '暂停 / 继续 (⌘P)', html: icon('pause', 14), onclick: () => this.togglePause() });
      this.retryBtn = h('button', { class: 'btn ghost', text: '重试失败', hidden: true, onclick: () => window.ferry.transfers.retryFailed() });
      this.clearBtn = h('button', { class: 'btn ghost', title: '清除已完成 (⇧⌘K)', html: icon('trash', 14), onclick: () => window.ferry.transfers.clear() });
      this.cancelBtn = h('button', { class: 'btn ghost danger', text: '全部取消', hidden: true, onclick: () => window.ferry.transfers.cancelAll() });

      this.head = h('div', { class: 'q-head' },
        iconEl('bolt', 14), this.title, this.stat,
        h('span', { class: 'spacer' }),
        this.barWrap, this.retryBtn, this.cancelBtn, this.pauseBtn, this.clearBtn,
        h('button', { class: 'btn icon ghost', title: '收起 (⌘T)', html: icon('chevD', 14), onclick: () => this.app.toggleQueue(false) }));

      this.body = h('div', { class: 'q-body' });
      this.el = h('div', { class: 'queue' }, this.head, this.body);
    }

    togglePause() {
      window.ferry.transfers.pause(!(this.stats && this.stats.paused));
    }

    setSnapshot(snap) {
      this.stats = snap.stats;
      const tasks = snap.tasks.slice().sort((a, b) => {
        const d = (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9);
        if (d) return d;
        return (b.startedAt || b.endedAt || 0) - (a.startedAt || a.endedAt || 0) || F.naturalCmp(a.name, b.name);
      });

      const seen = new Set();
      let prev = null;
      for (const t of tasks) {
        seen.add(t.id);
        let row = this.rows.get(t.id);
        if (!row) {
          row = this.makeRow(t);
          this.rows.set(t.id, row);
        }
        this.updateRow(row, t);
        // 保持 DOM 顺序和排序一致
        const anchor = prev ? prev.el.nextSibling : this.body.firstChild;
        if (anchor !== row.el) this.body.insertBefore(row.el, anchor);
        prev = row;
        this.tasks.set(t.id, t);
      }
      for (const [id, row] of this.rows) {
        if (!seen.has(id)) { row.el.remove(); this.rows.delete(id); this.tasks.delete(id); }
      }

      if (!tasks.length) {
        if (!this.empty) {
          this.empty = h('div', { class: 'pane-empty' },
            h('div', { text: '队列是空的' }),
            h('div', { style: { marginTop: '6px', fontSize: '11.5px' }, text: '把文件拖到另一侧，或用 ⌘→ / ⌘← 开始传输' }));
          this.body.append(this.empty);
        }
      } else if (this.empty) {
        this.empty.remove();
        this.empty = null;
      }

      this.renderHeader();
    }

    applyProgress({ deltas, stats }) {
      this.stats = stats;
      for (const d of deltas) {
        const row = this.rows.get(d.id);
        const t = this.tasks.get(d.id);
        if (!row || !t) continue;
        t.transferred = d.transferred;
        t.speed = d.speed;
        this.paint(row, t);
      }
      this.renderHeader();
    }

    makeRow(t) {
      const dir = h('span', { class: 'q-dir' });
      const name = h('div', { class: 'q-name' },
        h('div', { class: 'truncate' }),
        h('div', { class: 'q-sub truncate' }));
      const progInner = h('i', { style: { width: '0%' } });
      const prog = h('div', { class: 'q-prog' }, progInner);
      const right = h('span', { class: 'q-right num' });
      const x = h('button', { class: 'q-x', onclick: () => this.rowAction(t.id) });
      const el = h('div', { class: 'q-item', dataset: { state: t.state } }, dir, name, prog, right, x);
      el.addEventListener('dblclick', () => {
        const cur = this.tasks.get(t.id);
        if (cur) this.showDetail(cur);
      });
      return { el, dir, nameMain: name.firstChild, nameSub: name.lastChild, prog, progInner, right, x };
    }

    rowAction(id) {
      const t = this.tasks.get(id);
      if (!t) return;
      if (t.state === 'error' || t.state === 'cancelled') window.ferry.transfers.retry(id);
      else if (t.state === 'done') window.ferry.transfers.clear();
      else window.ferry.transfers.cancel(id);
    }

    updateRow(row, t) {
      row.el.dataset.state = t.state;
      row.dir.innerHTML = icon(t.direction === 'upload' ? 'arrowR' : 'arrowL', 14);
      row.nameMain.textContent = t.name;
      row.x.innerHTML = icon(t.state === 'error' || t.state === 'cancelled' ? 'retry' : t.state === 'done' ? 'check' : 'x', 13);
      row.x.title = t.state === 'error' || t.state === 'cancelled' ? '重试' : t.state === 'done' ? '已完成' : '取消';
      row.el.title = `${t.src}\n↓\n${t.dst}`;
      this.paint(row, t);
    }

    paint(row, t) {
      const pct = t.size ? Math.min(100, (t.transferred / t.size) * 100) : (t.state === 'done' ? 100 : 0);
      row.progInner.style.width = `${pct}%`;
      row.prog.hidden = t.state === 'done' || t.state === 'cancelled';

      if (t.state === 'running') {
        row.nameSub.textContent = `${t.hostName} · ${bytes(t.transferred)} / ${bytes(t.size)}`;
        row.right.textContent = speed(t.speed);
        row.nameSub.className = 'q-sub truncate';
      } else if (t.state === 'error') {
        row.nameSub.textContent = t.error || '失败';
        row.nameSub.className = 'q-err truncate';
        row.right.textContent = '失败';
      } else if (t.state === 'done') {
        row.nameSub.textContent = `${t.hostName} · ${bytes(t.size)}`;
        row.nameSub.className = 'q-sub truncate';
        const secs = t.startedAt && t.endedAt ? (t.endedAt - t.startedAt) / 1000 : 0;
        row.right.textContent = secs > 0.4 ? speed(t.size / secs) : '完成';
      } else if (t.state === 'cancelled') {
        row.nameSub.textContent = '已取消';
        row.nameSub.className = 'q-sub truncate';
        row.right.textContent = '';
      } else {
        row.nameSub.textContent = `${t.hostName} · 排队中 · ${bytes(t.size)}`;
        row.nameSub.className = 'q-sub truncate';
        row.right.textContent = '';
      }
    }

    renderHeader() {
      const s = this.stats;
      if (!s) return;
      const busy = s.running + s.queued > 0;
      this.barWrap.hidden = !busy;
      if (busy) {
        const pct = s.total ? (s.done / s.total) * 100 : 0;
        this.bar.style.width = `${Math.min(100, pct)}%`;
      }
      this.pauseBtn.innerHTML = icon(s.paused ? 'play' : 'pause', 14);
      this.pauseBtn.disabled = !busy && !s.paused;
      this.retryBtn.hidden = !s.failed;
      this.retryBtn.textContent = `重试 ${s.failed} 个失败项`;
      this.cancelBtn.hidden = !busy;

      const parts = [];
      if (s.paused && busy) parts.push('已暂停');
      if (s.running) parts.push(`${s.running} 个进行中`);
      if (s.queued) parts.push(`${s.queued} 个排队`);
      if (busy) {
        parts.push(`${bytes(s.done)} / ${bytes(s.total)}`);
        if (s.speed > 1024) parts.push(speed(s.speed));
        if (s.eta) parts.push(`剩余约 ${duration(s.eta)}`);
      } else {
        if (s.finished) parts.push(`${s.finished} 个已完成`);
        if (s.failed) parts.push(`${s.failed} 个失败`);
        if (!parts.length) parts.push('空闲');
      }
      this.stat.textContent = parts.join(' · ');
      this.app.onQueueStats(s);
    }

    async showDetail(t) {
      const lines = [
        ['方向', t.direction === 'upload' ? '上传到服务器' : '下载到本机'],
        ['主机', t.hostName],
        ['来源', t.src],
        ['目标', t.dst],
        ['大小', bytes(t.size)],
        ['状态', { running: '进行中', queued: '排队中', done: '已完成', error: '失败', cancelled: '已取消' }[t.state]],
      ];
      if (t.error) lines.push(['错误', t.error]);
      if (t.startedAt && t.endedAt) lines.push(['耗时', duration((t.endedAt - t.startedAt) / 1000)]);
      await openSheet({
        title: F.posix.basename(t.name),
        wide: true,
        body: h('div', { class: 'list-box' }, lines.map(([k, v]) => h('div', { class: 'list-row' },
          h('span', { style: { width: '54px', color: 'var(--text-2)', flex: 'none' }, text: k }),
          h('span', { class: 'mono', style: { userSelect: 'text', wordBreak: 'break-all' }, text: String(v) })))),
        actions: [{ label: '关闭', value: true, kind: 'primary' }],
      });
    }
  }

  // 冲突确认
  async function confirmPlan(plan) {
    const { conflicts, conflictCount, fileCount, totalBytes, direction, destDir, hostName } = plan;
    const dirLabel = direction === 'upload' ? `上传到 ${hostName}` : '下载到本机';

    if (!conflictCount) {
      return { go: true, conflict: 'overwrite' };
    }

    const rows = conflicts.slice(0, 80).map((c) => h('div', { class: 'list-row' },
      iconEl('warn', 13),
      h('div', { style: { minWidth: '0', flex: '1' } },
        h('div', { class: 'truncate', text: c.rel }),
        h('div', { class: 'q-sub truncate', text: `目标已有 ${bytes(c.existingSize)}（${F.when(c.mtime)}）→ 新文件 ${bytes(c.newSize)}` }))));

    const body = h('div', {},
      h('div', { class: 'alert warn' }, iconEl('warn', 15),
        h('div', { text: `目标位置有 ${conflictCount} 个同名文件。选择如何处理：` })),
      h('div', { class: 'list-box' }, rows,
        conflictCount > rows.length ? h('div', { class: 'list-row q-sub', text: `…另有 ${conflictCount - rows.length} 个` }) : null));

    const choice = await openSheet({
      title: `${dirLabel}：${fileCount} 个文件 · ${bytes(totalBytes)}`,
      desc: `目标目录 ${F.escapeHtml(destDir)}`,
      wide: true,
      body,
      actions: [
        { label: '取消', value: null },
        { label: '跳过同名', value: 'skip' },
        { label: '两者都留', value: 'rename' },
        { label: '覆盖', value: 'overwrite', kind: 'primary' },
      ],
    });
    if (!choice) return { go: false };
    return { go: true, conflict: choice };
  }

  F.Queue = Queue;
  F.confirmPlan = confirmPlan;

})();
