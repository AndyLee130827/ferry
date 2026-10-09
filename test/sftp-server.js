'use strict';
// 测试用的最小 SFTP 服务器：真实文件系统，根目录限制在 sandbox 里
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Server, utils } = require('ssh2');
const { STATUS_CODE, OPEN_MODE, flagsToString } = utils.sftp;

function startServer({ hostKey, root, authorizedKey, password, port = 0 }) {
  const handles = new Map();
  let nextId = 1;
  const mkHandle = (obj) => {
    const id = nextId++;
    handles.set(id, obj);
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(id, 0);
    return buf;
  };
  const getHandle = (buf) => (buf && buf.length === 4 ? handles.get(buf.readUInt32BE(0)) : null);
  const delHandle = (buf) => { if (buf && buf.length === 4) handles.delete(buf.readUInt32BE(0)); };

  // 把客户端给的路径限制在 root 内
  const resolve = (p) => {
    const joined = path.resolve('/', String(p || '.'));
    return path.join(root, joined);
  };
  const toClient = (abs) => {
    const rel = path.relative(root, abs);
    return rel ? `/${rel.split(path.sep).join('/')}` : '/';
  };
  const attrs = (st) => ({
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  });
  const errCode = (e) => (e && (e.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE
    : e.code === 'EACCES' || e.code === 'EPERM' ? STATUS_CODE.PERMISSION_DENIED
      : STATUS_CODE.FAILURE));

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey' && authorizedKey) {
        const ok = ctx.key.algo === authorizedKey.type
          && ctx.key.data.equals(authorizedKey.getPublicSSH())
          && (!ctx.signature || authorizedKey.verify(ctx.blob, ctx.signature, ctx.key.algo));
        return ok ? ctx.accept() : ctx.reject();
      }
      if (ctx.method === 'password' && password) {
        return ctx.password === password ? ctx.accept() : ctx.reject();
      }
      if (ctx.method === 'none') return ctx.reject(['publickey', 'password']);
      return ctx.reject();
    });

    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('exec', (acceptExec, _rej, info) => {
          const stream = acceptExec();
          stream.write(`FakeSSH 1.0\n---\n/dev/fake 10G 2G 8G 20% ${root}\n---\nload average: 0.1\n`);
          stream.exit(0);
          stream.end();
        });
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();

          sftp.on('REALPATH', async (reqid, p) => {
            try {
              const abs = resolve(p);
              await fsp.stat(abs).catch(() => null);
              sftp.name(reqid, [{ filename: toClient(abs), longname: toClient(abs), attrs: {} }]);
            } catch (e) { sftp.status(reqid, errCode(e)); }
          });

          sftp.on('OPENDIR', async (reqid, p) => {
            try {
              const abs = resolve(p);
              const st = await fsp.stat(abs);
              if (!st.isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE);
              const names = await fsp.readdir(abs);
              sftp.handle(reqid, mkHandle({ type: 'dir', abs, names, i: 0 }));
            } catch (e) { sftp.status(reqid, errCode(e)); }
          });

          sftp.on('READDIR', async (reqid, hb) => {
            const hd = getHandle(hb);
            if (!hd || hd.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (hd.i >= hd.names.length) return sftp.status(reqid, STATUS_CODE.EOF);
            const slice = hd.names.slice(hd.i, hd.i + 50);
            hd.i += slice.length;
            const out = [];
            for (const n of slice) {
              try {
                const st = await fsp.lstat(path.join(hd.abs, n));
                out.push({ filename: n, longname: `${st.isDirectory() ? 'd' : '-'}rwxr-xr-x 1 u g ${st.size} ${n}`, attrs: attrs(st) });
              } catch { /* 读不到就跳过 */ }
            }
            sftp.name(reqid, out);
          });

          const statLike = (ev, fn) => sftp.on(ev, async (reqid, p) => {
            try { sftp.attrs(reqid, attrs(await fn(resolve(p)))); } catch (e) { sftp.status(reqid, errCode(e)); }
          });
          statLike('STAT', (a) => fsp.stat(a));
          statLike('LSTAT', (a) => fsp.lstat(a));

          sftp.on('FSTAT', async (reqid, hb) => {
            const hd = getHandle(hb);
            if (!hd) return sftp.status(reqid, STATUS_CODE.FAILURE);
            try { sftp.attrs(reqid, attrs(await fsp.stat(hd.abs))); } catch (e) { sftp.status(reqid, errCode(e)); }
          });

          sftp.on('OPEN', async (reqid, p, flags) => {
            try {
              const abs = resolve(p);
              const fd = await fsp.open(abs, flagsToString(flags) || 'r');
              sftp.handle(reqid, mkHandle({ type: 'file', abs, fd }));
            } catch (e) { sftp.status(reqid, errCode(e)); }
          });

          sftp.on('READ', async (reqid, hb, offset, len) => {
            const hd = getHandle(hb);
            if (!hd || hd.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
            try {
              const buf = Buffer.alloc(len);
              const { bytesRead } = await hd.fd.read(buf, 0, len, offset);
              if (!bytesRead) return sftp.status(reqid, STATUS_CODE.EOF);
              sftp.data(reqid, buf.slice(0, bytesRead));
            } catch (e) { sftp.status(reqid, errCode(e)); }
          });

          sftp.on('WRITE', async (reqid, hb, offset, data) => {
            const hd = getHandle(hb);
            if (!hd || hd.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
            try {
              await hd.fd.write(data, 0, data.length, offset);
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (e) { sftp.status(reqid, errCode(e)); }
          });

          sftp.on('CLOSE', async (reqid, hb) => {
            const hd = getHandle(hb);
            try { if (hd && hd.fd) await hd.fd.close(); } catch { /* ignore */ }
            delHandle(hb);
            sftp.status(reqid, STATUS_CODE.OK);
          });

          const simple = (ev, fn) => sftp.on(ev, async (reqid, ...args) => {
            try { await fn(...args); sftp.status(reqid, STATUS_CODE.OK); } catch (e) { sftp.status(reqid, errCode(e)); }
          });
          simple('MKDIR', (p) => fsp.mkdir(resolve(p)));
          simple('RMDIR', (p) => fsp.rmdir(resolve(p)));
          simple('REMOVE', (p) => fsp.unlink(resolve(p)));
          simple('RENAME', (from, to) => fsp.rename(resolve(from), resolve(to)));
          simple('SETSTAT', async (p, a) => {
            const abs = resolve(p);
            if (a.mode !== undefined && a.mode !== null) await fsp.chmod(abs, a.mode & 0o777);
            if (a.mtime !== undefined && a.mtime !== null) await fsp.utimes(abs, a.atime || a.mtime, a.mtime);
          });
          simple('FSETSTAT', async () => {});
        });
      });
    });
  });

  return new Promise((resolve2) => {
    server.listen(port, '127.0.0.1', () => resolve2({ server, port: server.address().port }));
  });
}

module.exports = { startServer };
