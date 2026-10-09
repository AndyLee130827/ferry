'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme, shell } = require('electron');

const store = require('./store');
const keychain = require('./keychain');
const sshConfig = require('./ssh-config');
const local = require('./local');
const { SshManager, friendly } = require('./ssh');
const { TransferEngine } = require('./transfer');

const isDev = process.argv.includes('--dev');

app.setName('Ferry');

let win = null;
let ssh = null;
let engine = null;
const pendingPrompts = new Map();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function ask(type, payload) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve({ cancelled: true });
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (pendingPrompts.has(id)) {
        pendingPrompts.delete(id);
        resolve({ cancelled: true });
      }
    }, 5 * 60 * 1000);
    timer.unref?.();
    pendingPrompts.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    send('prompt:request', { id, type, payload });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 940,
    minHeight: 580,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  const fire = (action) => () => send('menu', action);
  const template = [
    {
      label: app.name,
      submenu: [
        { label: `关于 ${app.name}`, click: fire('about') },
        { type: 'separator' },
        { label: '设置…', accelerator: 'Cmd+,', click: fire('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '主机',
      submenu: [
        { label: '添加主机…', accelerator: 'Cmd+N', click: fire('host:new') },
        { label: '编辑当前主机…', accelerator: 'Cmd+E', click: fire('host:edit') },
        { label: '从 ~/.ssh/config 导入…', accelerator: 'Cmd+Shift+I', click: fire('host:import') },
        { type: 'separator' },
        { label: '连接 / 断开', accelerator: 'Cmd+Shift+C', click: fire('host:toggle') },
        { label: '快速切换…', accelerator: 'Cmd+K', click: fire('palette') },
      ],
    },
    {
      label: '文件',
      submenu: [
        { label: '新建文件夹', accelerator: 'Cmd+Shift+N', click: fire('file:newFolder') },
        { label: '重命名', click: fire('file:rename') },
        { label: '删除', accelerator: 'Cmd+Backspace', click: fire('file:delete') },
        { type: 'separator' },
        { label: '上传到服务器', accelerator: 'Cmd+Right', click: fire('transfer:up') },
        { label: '下载到本机', accelerator: 'Cmd+Left', click: fire('transfer:down') },
        { type: 'separator' },
        { label: '刷新', accelerator: 'Cmd+R', click: fire('file:refresh') },
        { label: '上一级', accelerator: 'Cmd+Up', click: fire('file:up') },
        { label: '搜索当前目录', accelerator: 'Cmd+F', click: fire('file:filter') },
        { label: '显示隐藏文件', accelerator: 'Cmd+Shift+.', click: fire('file:toggleHidden') },
      ],
    },
    {
      label: '传输',
      submenu: [
        { label: '显示 / 隐藏传输面板', accelerator: 'Cmd+T', click: fire('queue:toggle') },
        { label: '暂停 / 继续队列', accelerator: 'Cmd+P', click: fire('queue:pause') },
        { label: '重试失败项', click: fire('queue:retry') },
        { label: '清除已完成', accelerator: 'Cmd+Shift+K', click: fire('queue:clear') },
      ],
    },
    { role: 'editMenu', label: '编辑' },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function wire() {
  ssh = new SshManager();
  ssh.setPrompt(ask);
  ssh.on('status', (s) => send('ssh:status', s));

  engine = new TransferEngine(ssh, store);
  engine.on('snapshot', (s) => send('transfer:snapshot', s));
  engine.on('progress', (p) => send('transfer:progress', p));

  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  });

  // --- 主机 ---
  handle('hosts:list', () => ({ hosts: store.all(), statuses: ssh.statuses(), palette: store.palette() }));
  handle('hosts:save', (host) => store.upsert(host));
  handle('hosts:remove', async (id) => {
    await ssh.disconnect(id);
    await keychain.clearHost(id);
    store.remove(id);
    return true;
  });
  handle('hosts:reorder', (ids) => { store.reorder(ids); return store.all(); });
  handle('hosts:forgetSecrets', async (id) => {
    await keychain.clearHost(id);
    const h = store.get(id);
    if (h) store.upsert({ ...h, savePassword: false, savePassphrase: false });
    return true;
  });
  handle('hosts:sshConfig', () => sshConfig.list());
  handle('hosts:defaultKeys', () => sshConfig.defaultKeys());

  // --- 设置 ---
  handle('settings:get', () => store.settings());
  handle('settings:set', (patch) => store.setSettings(patch));

  // --- 连接 ---
  handle('ssh:connect', (id) => ssh.connect(id).then(() => ({ state: 'ready' })));
  handle('ssh:disconnect', (id) => ssh.disconnect(id).then(() => true));
  handle('ssh:statuses', () => ssh.statuses());
  handle('ssh:home', (id) => ssh.home(id));
  handle('ssh:list', (id, dir) => ssh.list(id, dir));
  handle('ssh:mkdir', (id, p) => ssh.mkdir(id, p));
  handle('ssh:rename', (id, from, to) => ssh.rename(id, from, to));
  handle('ssh:remove', (id, p) => ssh.removePath(id, p));
  handle('ssh:chmod', (id, p, mode) => ssh.chmod(id, p, mode));
  handle('ssh:info', async (id, dir) => {
    const r = await ssh.exec(id, `uname -sr; echo ---; df -h ${JSON.stringify(dir || '.')} | tail -n +2; echo ---; uptime`);
    return r.stdout;
  });

  // --- 本地 ---
  handle('local:list', (dir) => local.list(dir));
  handle('local:home', () => local.home());
  handle('local:places', () => local.places());
  handle('local:mkdir', (p) => local.mkdir(p));
  handle('local:rename', (from, to) => local.rename(from, to));
  handle('local:trash', (p) => local.trash(p));
  handle('local:reveal', (p) => { local.reveal(p); return true; });
  handle('local:open', (p) => local.open(p));
  handle('local:chmod', (p, mode) => local.chmod(p, mode));

  // --- 对话框 ---
  handle('dialog:pickKey', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择 SSH 私钥',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
      buttonLabel: '选择',
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:pickDir', async (start) => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择本地文件夹',
      defaultPath: start || os.homedir(),
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:pickFiles', async (start) => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要上传的文件',
      defaultPath: start || os.homedir(),
      properties: ['openFile', 'multiSelections', 'showHiddenFiles'],
    });
    return r.canceled ? [] : r.filePaths;
  });

  // --- 传输 ---
  handle('transfer:plan', (req) => engine.plan(req));
  handle('transfer:start', (planId, opts) => engine.start(planId, opts));
  handle('transfer:snapshot', () => engine.snapshot());
  handle('transfer:cancel', (id) => { engine.cancelTask(id); return true; });
  handle('transfer:cancelJob', (id) => { engine.cancelJob(id); return true; });
  handle('transfer:cancelAll', () => { engine.cancelAll(); return true; });
  handle('transfer:retry', (id) => { engine.retryTask(id); return true; });
  handle('transfer:retryFailed', () => { engine.retryFailed(); return true; });
  handle('transfer:clear', () => { engine.clearFinished(); return true; });
  handle('transfer:pause', (v) => { engine.setPaused(v); return engine.stats(); });

  // --- 来自界面的口令/确认回执 ---
  ipcMain.handle('prompt:reply', (_e, { id, value }) => {
    const resolve = pendingPrompts.get(id);
    if (resolve) {
      pendingPrompts.delete(id);
      resolve(value);
    }
    return true;
  });

  handle('app:meta', () => ({
    version: app.getVersion(),
    name: app.name,
    electron: process.versions.electron,
    node: process.versions.node,
    homedir: os.homedir(),
    hasAgent: !!process.env.SSH_AUTH_SOCK,
    knownHostsFile: require('./known-hosts').file,
    sshConfigFile: sshConfig.file,
    userData: app.getPath('userData'),
  }));
  handle('app:revealUserData', () => { shell.openPath(app.getPath('userData')); return true; });
}

app.on('ready', () => {
  // 开发模式下（未打包）Dock 图标默认是 Electron 的，手动换掉
  if (!app.isPackaged && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png')); } catch { /* 没图标也能跑 */ }
  }
  store.load();
  wire();
  buildMenu();
  createWindow();
  nativeTheme.on('updated', () => send('theme', { dark: nativeTheme.shouldUseDarkColors }));
});

app.on('activate', () => {
  if (!BrowserWindow.getAllWindows().length) createWindow();
});

app.on('window-all-closed', () => {
  if (ssh) ssh.disconnectAll();
  app.quit();
});

app.on('before-quit', () => {
  if (engine) engine.cancelAll();
  if (ssh) ssh.disconnectAll();
});
