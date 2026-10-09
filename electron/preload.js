'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r || r.ok) return r ? r.data : undefined;
  const err = new Error(r.error || '操作失败');
  err.handled = true;
  throw err;
}

const listeners = new Map();
function on(channel, fn) {
  const wrapped = (_e, payload) => fn(payload);
  listeners.set(fn, wrapped);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('ferry', {
  hosts: {
    list: () => call('hosts:list'),
    save: (h) => call('hosts:save', h),
    remove: (id) => call('hosts:remove', id),
    reorder: (ids) => call('hosts:reorder', ids),
    forgetSecrets: (id) => call('hosts:forgetSecrets', id),
    sshConfig: () => call('hosts:sshConfig'),
    defaultKeys: () => call('hosts:defaultKeys'),
  },
  settings: {
    get: () => call('settings:get'),
    set: (p) => call('settings:set', p),
  },
  ssh: {
    connect: (id) => call('ssh:connect', id),
    disconnect: (id) => call('ssh:disconnect', id),
    statuses: () => call('ssh:statuses'),
    home: (id) => call('ssh:home', id),
    list: (id, dir) => call('ssh:list', id, dir),
    mkdir: (id, p) => call('ssh:mkdir', id, p),
    rename: (id, a, b) => call('ssh:rename', id, a, b),
    remove: (id, p) => call('ssh:remove', id, p),
    chmod: (id, p, m) => call('ssh:chmod', id, p, m),
    info: (id, dir) => call('ssh:info', id, dir),
  },
  local: {
    list: (dir) => call('local:list', dir),
    home: () => call('local:home'),
    places: () => call('local:places'),
    mkdir: (p) => call('local:mkdir', p),
    rename: (a, b) => call('local:rename', a, b),
    trash: (p) => call('local:trash', p),
    reveal: (p) => call('local:reveal', p),
    open: (p) => call('local:open', p),
    chmod: (p, m) => call('local:chmod', p, m),
  },
  dialog: {
    pickKey: () => call('dialog:pickKey'),
    pickDir: (s) => call('dialog:pickDir', s),
    pickFiles: (s) => call('dialog:pickFiles', s),
  },
  transfers: {
    plan: (req) => call('transfer:plan', req),
    start: (planId, opts) => call('transfer:start', planId, opts),
    snapshot: () => call('transfer:snapshot'),
    cancel: (id) => call('transfer:cancel', id),
    cancelJob: (id) => call('transfer:cancelJob', id),
    cancelAll: () => call('transfer:cancelAll'),
    retry: (id) => call('transfer:retry', id),
    retryFailed: () => call('transfer:retryFailed'),
    clear: () => call('transfer:clear'),
    pause: (v) => call('transfer:pause', v),
  },
  app: {
    meta: () => call('app:meta'),
    revealUserData: () => call('app:revealUserData'),
  },
  reply: (id, value) => ipcRenderer.invoke('prompt:reply', { id, value }),
  // 从 Finder 拖进来的文件，在 Electron 新版里要靠 webUtils 拿真实路径
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file.path || null;
    }
  },
  on,
});
