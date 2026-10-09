'use strict';
// SSH/SFTP 连接管理：每台主机一条 SSH 连接，浏览用一条 SFTP 通道，
// 传输另开通道池（可被单独 end 掉以实现取消，不影响其它任务）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Client, utils } = require('ssh2');

const store = require('./store');
const keychain = require('./keychain');
const knownHosts = require('./known-hosts');

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

class SftpPool {
  constructor(client, max) {
    this.client = client;
    this.max = Math.max(1, max);
    this.idle = [];
    this.live = 0;
    this.waiters = [];
    this.closed = false;
  }

  _open() {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
    });
  }

  async acquire() {
    if (this.closed) throw new Error('连接已关闭');
    if (this.idle.length) return this._wrap(this.idle.pop());
    if (this.live < this.max) {
      this.live += 1;
      try {
        return this._wrap(await this._open());
      } catch (e) {
        this.live -= 1;
        throw e;
      }
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  _wrap(sftp) {
    let done = false;
    const self = this;
    return {
      sftp,
      release() {
        if (done) return;
        done = true;
        self._give(sftp);
      },
      destroy() {
        if (done) return;
        done = true;
        self.live -= 1;
        try { sftp.end(); } catch { /* 已断开 */ }
        self._pump();
      },
    };
  }

  _give(sftp) {
    if (this.closed) {
      try { sftp.end(); } catch { /* ignore */ }
      this.live -= 1;
      return;
    }
    const w = this.waiters.shift();
    if (w) return w.resolve(this._wrap(sftp));
    this.idle.push(sftp);
  }

  async _pump() {
    while (this.waiters.length && this.live < this.max && !this.closed) {
      const w = this.waiters.shift();
      this.live += 1;
      try {
        w.resolve(this._wrap(await this._open()));
      } catch (e) {
        this.live -= 1;
        w.reject(e);
      }
    }
  }

  close() {
    this.closed = true;
    for (const s of this.idle) { try { s.end(); } catch { /* ignore */ } }
    this.idle = [];
    for (const w of this.waiters) w.reject(new Error('连接已关闭'));
    this.waiters = [];
  }
}

function friendly(err) {
  const m = String((err && err.message) || err || '未知错误');
  if (/All configured authentication methods failed/i.test(m)) return '认证失败：服务器拒绝了提供的密钥或密码';
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return '无法解析主机名，请检查地址';
  if (/ECONNREFUSED/i.test(m)) return '连接被拒绝，请确认端口与 sshd 是否在运行';
  if (/ETIMEDOUT|Timed out while waiting/i.test(m)) return '连接超时，请检查网络或防火墙';
  if (/ECONNRESET/i.test(m)) return '连接被服务器重置';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(m)) return '网络不可达';
  if (/Cannot parse privateKey/i.test(m)) return '私钥无法解析：格式不支持或文件已损坏';
  if (/no such file|ENOENT/i.test(m)) return '文件或目录不存在';
  if (/Permission denied|EACCES/i.test(m)) return '权限不足';
  return m;
}

class SshManager extends EventEmitter {
  constructor() {
    super();
    this.conns = new Map(); // hostId -> conn
    this.ask = async () => null; // 由 main.js 注入，用来向界面要口令/确认
  }

  setPrompt(fn) {
    this.ask = fn;
  }

  state(hostId) {
    const c = this.conns.get(hostId);
    return c ? c.state : 'offline';
  }

  statuses() {
    const out = {};
    for (const [id, c] of this.conns) out[id] = { state: c.state, error: c.error || null, info: c.info || null };
    return out;
  }

  _setState(conn, state, error) {
    conn.state = state;
    conn.error = error ? friendly(error) : null;
    this.emit('status', { hostId: conn.hostId, state, error: conn.error, info: conn.info || null });
  }

  async _resolveAuth(host) {
    const cfg = {};
    if (host.auth === 'agent') {
      const sock = process.env.SSH_AUTH_SOCK;
      if (!sock) throw new Error('没有找到 ssh-agent（SSH_AUTH_SOCK 未设置），请改用密钥文件');
      cfg.agent = sock;
      return cfg;
    }

    if (host.auth === 'password') {
      let pw = host.savePassword ? await keychain.get(keychain.passwordKey(host.id)) : null;
      if (!pw) {
        const r = await this.ask('password', { host: host.name, user: host.username, canSave: true });
        if (!r || r.cancelled) throw new Error('已取消');
        pw = r.value;
        if (r.save) {
          await keychain.set(keychain.passwordKey(host.id), pw);
          store.upsert({ ...host, savePassword: true });
        }
      } else {
        cfg.__usedStoredSecret = keychain.passwordKey(host.id);
      }
      cfg.password = pw;
      return cfg;
    }

    // 密钥登录
    const keyPath = host.privateKeyPath;
    if (!keyPath) throw new Error('没有选择私钥文件');
    let keyData;
    try {
      keyData = fs.readFileSync(keyPath);
    } catch {
      throw new Error(`读不到私钥文件：${keyPath}`);
    }

    const plain = utils.parseKey(keyData);
    if (!(plain instanceof Error)) {
      cfg.privateKey = keyData;
      return cfg;
    }
    if (!/passphrase|encrypted|decipher|bad decrypt|integrity/i.test(plain.message)) {
      throw new Error(friendly(plain));
    }

    // 加密私钥：先试钥匙串里存的口令，不行再问用户
    let pass = host.savePassphrase ? await keychain.get(keychain.passphraseKey(host.id)) : null;
    let fromStore = !!pass;
    let wantSave = false;

    for (;;) {
      if (!pass) {
        const r = await this.ask('passphrase', { host: host.name, keyPath, canSave: true });
        if (!r || r.cancelled) throw new Error('已取消');
        pass = r.value;
        wantSave = !!r.save;
        fromStore = false;
      }

      const unlocked = utils.parseKey(keyData, pass);
      if (!(unlocked instanceof Error)) {
        if (wantSave) {
          await keychain.set(keychain.passphraseKey(host.id), pass);
          store.upsert({ ...host, savePassphrase: true });
        }
        cfg.privateKey = keyData;
        cfg.passphrase = pass;
        if (fromStore) cfg.__usedStoredSecret = keychain.passphraseKey(host.id);
        return cfg;
      }
      if (!/passphrase|encrypted|decipher|bad decrypt|integrity/i.test(unlocked.message)) {
        throw new Error(friendly(unlocked));
      }
      if (fromStore) {
        // 钥匙串里的口令已经失效，清掉重新问
        await keychain.del(keychain.passphraseKey(host.id));
      } else {
        await this.ask('error', { message: '口令不正确，请重新输入' });
      }
      pass = null;
      fromStore = false;
    }
  }

  _hostVerifier(host) {
    return (keyBuf, cb) => {
      const res = knownHosts.check(host.host, host.port, keyBuf);
      if (res.status === 'match') return cb(true);
      const type = res.status;
      this.ask('hostkey', {
        host: host.host,
        port: host.port,
        name: host.name,
        kind: type,
        fingerprint: res.fingerprint,
        keyType: res.type,
        known: res.known || [],
      })
        .then((r) => {
          if (!r || r.cancelled || !r.accept) return cb(false);
          if (r.remember && type !== 'revoked') {
            try { knownHosts.add(host.host, host.port, keyBuf); } catch { /* 写不进去也不拦着连接 */ }
          }
          cb(true);
        })
        .catch(() => cb(false));
    };
  }

  async connect(hostId, { force = false } = {}) {
    const existing = this.conns.get(hostId);
    if (existing) {
      if (existing.state === 'ready' && !force) return existing;
      if (existing.state === 'connecting' && existing.readyPromise) return existing.readyPromise;
      await this.disconnect(hostId);
    }

    const host = store.get(hostId);
    if (!host) throw new Error('主机不存在');
    if (!host.host) throw new Error('主机地址为空');
    if (!host.username) throw new Error('用户名为空');

    const conn = { hostId, host, state: 'connecting', client: null, pool: null, browse: null, error: null, info: null };
    this.conns.set(hostId, conn);
    this._setState(conn, 'connecting');

    const settings = store.settings();
    const readyPromise = (async () => {
      const auth = await this._resolveAuth(host);
      const usedStored = auth.__usedStoredSecret;
      delete auth.__usedStoredSecret;

      const client = new Client();
      conn.client = client;

      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, arg) => {
          if (settled) return;
          settled = true;
          fn(arg);
        };

        client.on('ready', () => finish(resolve));
        client.on('error', async (err) => {
          if (usedStored && /All configured authentication methods failed/i.test(String(err.message))) {
            await keychain.del(usedStored); // 存着的密码不对了，清掉，下次重新问
          }
          finish(reject, err);
        });
        client.on('end', () => {
          if (!settled) finish(reject, new Error('连接被关闭'));
        });
        client.on('close', () => {
          if (!settled) return finish(reject, new Error('连接被关闭'));
          if (conn.state === 'ready') this._setState(conn, 'offline');
        });
        client.on('keyboard-interactive', (nameStr, instructions, lang, prompts, done) => {
          (async () => {
            const answers = [];
            for (const p of prompts) {
              const r = await this.ask('interactive', { host: host.name, prompt: p.prompt, echo: p.echo });
              if (!r || r.cancelled) return done([]);
              answers.push(r.value);
            }
            done(answers);
          })();
        });

        client.connect({
          host: host.host,
          port: host.port,
          username: host.username,
          readyTimeout: 20000,
          keepaliveInterval: 15000,
          keepaliveCountMax: 4,
          tryKeyboard: true,
          hostVerifier: this._hostVerifier(host),
          ...auth,
        });
      });

      conn.pool = new SftpPool(client, Math.max(2, (settings.concurrency || 3) + 1));
      conn.browse = await new Promise((resolve, reject) => client.sftp((e, s) => (e ? reject(e) : resolve(s))));
      conn.info = { connectedAt: Date.now() };
      this._setState(conn, 'ready');
      store.setSettings({ lastHostId: hostId });
      return conn;
    })();

    conn.readyPromise = readyPromise;
    try {
      return await readyPromise;
    } catch (err) {
      this._setState(conn, 'error', err);
      try { conn.client && conn.client.end(); } catch { /* ignore */ }
      if (conn.pool) conn.pool.close();
      this.conns.delete(hostId);
      throw new Error(friendly(err));
    } finally {
      delete conn.readyPromise;
    }
  }

  async disconnect(hostId) {
    const conn = this.conns.get(hostId);
    if (!conn) return;
    this.conns.delete(hostId);
    if (conn.pool) conn.pool.close();
    try { conn.browse && conn.browse.end(); } catch { /* ignore */ }
    try { conn.client && conn.client.end(); } catch { /* ignore */ }
    this.emit('status', { hostId, state: 'offline', error: null, info: null });
  }

  disconnectAll() {
    for (const id of [...this.conns.keys()]) this.disconnect(id);
  }

  async _browse(hostId) {
    const conn = await this.connect(hostId);
    return conn.browse;
  }

  acquire(hostId) {
    const conn = this.conns.get(hostId);
    if (!conn || conn.state !== 'ready') throw new Error('未连接');
    return conn.pool.acquire();
  }

  // ---- SFTP 操作 ----

  async home(hostId) {
    const sftp = await this._browse(hostId);
    return new Promise((resolve, reject) => sftp.realpath('.', (e, p) => (e ? reject(new Error(friendly(e))) : resolve(p))));
  }

  async realpath(hostId, p) {
    const sftp = await this._browse(hostId);
    return new Promise((resolve, reject) => sftp.realpath(p, (e, r) => (e ? reject(new Error(friendly(e))) : resolve(r))));
  }

  async list(hostId, dir) {
    const sftp = await this._browse(hostId);
    const target = dir && dir !== '~' ? dir : await this.home(hostId);
    const abs = await new Promise((resolve, reject) =>
      sftp.realpath(target, (e, r) => (e ? reject(new Error(friendly(e))) : resolve(r))));
    const raw = await new Promise((resolve, reject) =>
      sftp.readdir(abs, (e, l) => (e ? reject(new Error(friendly(e))) : resolve(l))));

    const entries = raw
      .filter((it) => it.filename !== '.' && it.filename !== '..')
      .map((it) => {
        const mode = it.attrs.mode || 0;
        const kind = (mode & S_IFMT) === S_IFDIR ? 'dir' : (mode & S_IFMT) === S_IFLNK ? 'link' : 'file';
        return {
          name: it.filename,
          path: path.posix.join(abs, it.filename),
          kind,
          size: it.attrs.size || 0,
          mtime: (it.attrs.mtime || 0) * 1000,
          mode: mode & 0o7777,
          uid: it.attrs.uid,
          gid: it.attrs.gid,
        };
      });

    // 符号链接单独 stat 一次，判断它指向文件还是目录
    await Promise.all(entries.filter((e) => e.kind === 'link').map((e) => new Promise((resolve) => {
      sftp.stat(e.path, (err, st) => {
        if (!err && st) {
          e.linkTo = ((st.mode || 0) & S_IFMT) === S_IFDIR ? 'dir' : 'file';
          if (e.linkTo === 'dir') e.size = 0;
          else e.size = st.size || 0;
        } else {
          e.broken = true;
        }
        resolve();
      });
    })));

    return { path: abs, parent: abs === '/' ? null : path.posix.dirname(abs), entries };
  }

  async stat(hostId, p) {
    const sftp = await this._browse(hostId);
    return new Promise((resolve, reject) => sftp.stat(p, (e, st) => {
      if (e) return resolve(null);
      resolve({
        size: st.size || 0,
        mtime: (st.mtime || 0) * 1000,
        mode: (st.mode || 0) & 0o7777,
        isDir: ((st.mode || 0) & S_IFMT) === S_IFDIR,
      });
    }));
  }

  async mkdir(hostId, p) {
    const sftp = await this._browse(hostId);
    return new Promise((resolve, reject) => sftp.mkdir(p, (e) => (e ? reject(new Error(friendly(e))) : resolve(true))));
  }

  async rename(hostId, from, to) {
    const sftp = await this._browse(hostId);
    return new Promise((resolve, reject) => sftp.rename(from, to, (e) => (e ? reject(new Error(friendly(e))) : resolve(true))));
  }

  async chmod(hostId, p, mode) {
    const sftp = await this._browse(hostId);
    return new Promise((resolve, reject) => sftp.chmod(p, mode, (e) => (e ? reject(new Error(friendly(e))) : resolve(true))));
  }

  async removePath(hostId, p) {
    const sftp = await this._browse(hostId);
    const st = await this.stat(hostId, p);
    if (st && st.isDir) return this._rmrf(sftp, p);
    return new Promise((resolve, reject) => sftp.unlink(p, (e) => (e ? reject(new Error(friendly(e))) : resolve(true))));
  }

  async _rmrf(sftp, dir) {
    const items = await new Promise((resolve, reject) => sftp.readdir(dir, (e, l) => (e ? reject(new Error(friendly(e))) : resolve(l))));
    for (const it of items) {
      if (it.filename === '.' || it.filename === '..') continue;
      const child = path.posix.join(dir, it.filename);
      const mode = it.attrs.mode || 0;
      if ((mode & S_IFMT) === S_IFDIR) await this._rmrf(sftp, child);
      else await new Promise((resolve, reject) => sftp.unlink(child, (e) => (e ? reject(new Error(friendly(e))) : resolve())));
    }
    return new Promise((resolve, reject) => sftp.rmdir(dir, (e) => (e ? reject(new Error(friendly(e))) : resolve(true))));
  }

  /** 递归展开远端目录，列出所有文件和需要创建的子目录 */
  async walk(hostId, root, onProgress) {
    const sftp = await this._browse(hostId);
    const files = [];
    const dirs = [];
    const stack = [{ abs: root, rel: '' }];
    while (stack.length) {
      const cur = stack.pop();
      const items = await new Promise((resolve, reject) =>
        sftp.readdir(cur.abs, (e, l) => (e ? reject(new Error(friendly(e))) : resolve(l))));
      for (const it of items) {
        if (it.filename === '.' || it.filename === '..') continue;
        const abs = path.posix.join(cur.abs, it.filename);
        const rel = cur.rel ? `${cur.rel}/${it.filename}` : it.filename;
        const mode = it.attrs.mode || 0;
        const type = mode & S_IFMT;
        if (type === S_IFDIR) {
          dirs.push(rel);
          stack.push({ abs, rel });
        } else if (type === S_IFLNK) {
          const st = await this.stat(hostId, abs);
          if (st && st.isDir) {
            dirs.push(rel);
            stack.push({ abs, rel });
          } else if (st) {
            files.push({ abs, rel, size: st.size, mode: st.mode, mtime: st.mtime });
          }
        } else {
          files.push({ abs, rel, size: it.attrs.size || 0, mode: mode & 0o7777, mtime: (it.attrs.mtime || 0) * 1000 });
        }
        if (onProgress && (files.length + dirs.length) % 200 === 0) onProgress(files.length + dirs.length);
      }
    }
    return { files, dirs };
  }

  async exec(hostId, cmd) {
    const conn = await this.connect(hostId);
    return new Promise((resolve, reject) => {
      conn.client.exec(cmd, (err, stream) => {
        if (err) return reject(new Error(friendly(err)));
        let out = '';
        let errOut = '';
        stream.on('data', (d) => { out += d; });
        stream.stderr.on('data', (d) => { errOut += d; });
        stream.on('close', (code) => resolve({ code, stdout: out, stderr: errOut }));
      });
    });
  }
}

module.exports = { SshManager, friendly, SftpPool };
