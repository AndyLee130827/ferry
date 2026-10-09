'use strict';
// 本地（Mac 侧）文件操作
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { shell } = require('electron');

function expand(p) {
  if (!p || p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function list(dir) {
  const abs = path.resolve(expand(dir || os.homedir()));
  const items = await fsp.readdir(abs, { withFileTypes: true });
  const entries = await Promise.all(items.map(async (d) => {
    const full = path.join(abs, d.name);
    let st = null;
    let kind = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file';
    try {
      st = await fsp.lstat(full);
    } catch {
      return { name: d.name, path: full, kind, size: 0, mtime: 0, mode: 0, broken: true };
    }
    const e = {
      name: d.name,
      path: full,
      kind,
      size: st.isDirectory() ? 0 : st.size,
      mtime: st.mtimeMs,
      mode: st.mode & 0o7777,
    };
    if (kind === 'link') {
      try {
        const t = await fsp.stat(full);
        e.linkTo = t.isDirectory() ? 'dir' : 'file';
        e.size = t.isDirectory() ? 0 : t.size;
      } catch {
        e.broken = true;
      }
    }
    return e;
  }));
  return { path: abs, parent: path.dirname(abs) === abs ? null : path.dirname(abs), entries };
}

async function walk(root) {
  const files = [];
  const dirs = [];
  const stack = [{ abs: root, rel: '' }];
  while (stack.length) {
    const cur = stack.pop();
    let items;
    try {
      items = await fsp.readdir(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of items) {
      const abs = path.join(cur.abs, d.name);
      const rel = cur.rel ? `${cur.rel}/${d.name}` : d.name;
      let st;
      try {
        st = await fsp.stat(abs); // 跟随符号链接，和 scp -r 的行为一致
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        dirs.push(rel);
        stack.push({ abs, rel });
      } else if (st.isFile()) {
        files.push({ abs, rel, size: st.size, mode: st.mode & 0o7777, mtime: st.mtimeMs });
      }
    }
  }
  return { files, dirs };
}

async function stat(p) {
  try {
    const st = await fsp.stat(p);
    return { size: st.size, mtime: st.mtimeMs, mode: st.mode & 0o7777, isDir: st.isDirectory() };
  } catch {
    return null;
  }
}

const places = () => {
  const home = os.homedir();
  const candidates = [
    { name: '个人目录', path: home, icon: 'home' },
    { name: '桌面', path: path.join(home, 'Desktop'), icon: 'desktop' },
    { name: '下载', path: path.join(home, 'Downloads'), icon: 'download' },
    { name: '文档', path: path.join(home, 'Documents'), icon: 'doc' },
  ];
  return candidates.filter((c) => fs.existsSync(c.path));
};

module.exports = {
  expand,
  list,
  walk,
  stat,
  places,
  home: () => os.homedir(),
  mkdir: (p) => fsp.mkdir(p, { recursive: true }).then(() => true),
  rename: (from, to) => fsp.rename(from, to).then(() => true),
  async trash(p) {
    await shell.trashItem(p);
    return true;
  },
  reveal: (p) => shell.showItemInFolder(p),
  open: (p) => shell.openPath(p),
  chmod: (p, mode) => fsp.chmod(p, mode).then(() => true),
};
