'use strict';
// 配置持久化：主机列表 + 应用设置。密钥口令/密码不在这里，走 Keychain。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const DEFAULT_SETTINGS = {
  concurrency: 3,
  showHidden: false,
  preserveMtime: true,
  confirmDelete: true,
  lastHostId: null,
};

let file = null;
let data = null;

function load() {
  file = path.join(app.getPath('userData'), 'hosts.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = {
      version: 1,
      hosts: Array.isArray(raw.hosts) ? raw.hosts.map(normalize) : [],
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    };
  } catch {
    data = { version: 1, hosts: [], settings: { ...DEFAULT_SETTINGS } };
  }
  return data;
}

function save() {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const PALETTE = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#eab308', '#ef4444'];

function normalize(h) {
  return {
    id: h.id || crypto.randomUUID(),
    name: (h.name || h.host || '未命名').trim(),
    host: (h.host || '').trim(),
    port: Number(h.port) || 22,
    username: (h.username || '').trim(),
    auth: ['agent', 'key', 'password'].includes(h.auth) ? h.auth : 'key',
    privateKeyPath: h.privateKeyPath || '',
    savePassphrase: !!h.savePassphrase,
    savePassword: !!h.savePassword,
    remotePath: h.remotePath || '',
    localPath: h.localPath || '',
    color: h.color || PALETTE[Math.floor(Math.random() * PALETTE.length)],
    note: h.note || '',
    createdAt: h.createdAt || Date.now(),
  };
}

module.exports = {
  load,
  all: () => data.hosts.slice(),
  get: (id) => data.hosts.find((h) => h.id === id) || null,
  settings: () => ({ ...data.settings }),
  setSettings(patch) {
    data.settings = { ...data.settings, ...patch };
    save();
    return { ...data.settings };
  },
  upsert(host) {
    const h = normalize(host);
    const i = data.hosts.findIndex((x) => x.id === h.id);
    if (i >= 0) data.hosts[i] = { ...data.hosts[i], ...h };
    else data.hosts.push(h);
    save();
    return h;
  },
  remove(id) {
    data.hosts = data.hosts.filter((h) => h.id !== id);
    save();
  },
  reorder(ids) {
    const map = new Map(data.hosts.map((h) => [h.id, h]));
    const next = ids.map((id) => map.get(id)).filter(Boolean);
    for (const h of data.hosts) if (!ids.includes(h.id)) next.push(h);
    data.hosts = next;
    save();
  },
  palette: () => PALETTE.slice(),
};
