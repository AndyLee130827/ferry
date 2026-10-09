'use strict';
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SP = path.join(require('os').tmpdir(), 'ferry-e2e');

const electron = require('electron');
const { app, BrowserWindow } = electron;

const SANDBOX = path.join(SP, 'e2e');
const USERDATA = path.join(SANDBOX, 'userdata');
const SERVER_ROOT = path.join(SANDBOX, 'server');
const LOCAL_SRC = path.join(SANDBOX, 'local-src');
const LOCAL_DST = path.join(SANDBOX, 'local-dst');
const KEYS = path.join(SANDBOX, 'keys');

fs.mkdirSync(SP, { recursive: true });
fs.rmSync(SANDBOX, { recursive: true, force: true });
for (const d of [USERDATA, SERVER_ROOT, LOCAL_SRC, LOCAL_DST, KEYS]) fs.mkdirSync(d, { recursive: true });

// --- 造测试素材 ---
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
fs.writeFileSync(path.join(LOCAL_SRC, 'plain.txt'), 'hello ferry 你好\n');
fs.writeFileSync(path.join(LOCAL_SRC, 'big.bin'), crypto.randomBytes(3 * 1024 * 1024));
fs.mkdirSync(path.join(LOCAL_SRC, 'tree/nested'), { recursive: true });
fs.writeFileSync(path.join(LOCAL_SRC, 'tree/a.txt'), 'A'.repeat(1000));
fs.writeFileSync(path.join(LOCAL_SRC, 'tree/nested/b.bin'), crypto.randomBytes(200 * 1024));
fs.writeFileSync(path.join(SERVER_ROOT, 'remote-only.log'), 'server side file\n'.repeat(500));
fs.mkdirSync(path.join(SERVER_ROOT, 'logs'), { recursive: true });
fs.writeFileSync(path.join(SERVER_ROOT, 'logs/app.log'), crypto.randomBytes(80 * 1024));

// --- 生成密钥 ---
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(KEYS, 'host')]);
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(KEYS, 'client')]);
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'pass-phrase-123', '-f', path.join(KEYS, 'client_enc')]);

const { utils } = require(path.join(ROOT, 'node_modules/ssh2'));
const hostKey = fs.readFileSync(path.join(KEYS, 'host'));
const clientPub = utils.parseKey(fs.readFileSync(path.join(KEYS, 'client.pub')));
const clientEncPub = utils.parseKey(fs.readFileSync(path.join(KEYS, 'client_enc.pub')));

const { startServer } = require(path.join(__dirname, 'sftp-server.js'));

// --- 让主进程用隔离的配置目录 ---
app.setPath('userData', USERDATA);
require(path.join(ROOT, 'electron/main.js'));

const results = [];
const logs = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

let win;
const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(code, label, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await js(`return (${code});`).catch(() => false);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`等待超时：${label}`);
    await sleep(120);
  }
}

app.whenReady().then(async () => {
  await sleep(500);
  win = BrowserWindow.getAllWindows()[0];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) logs.push(message);
  });
  await waitFor('!!window.app && !!window.app.settings', '界面就绪');

  // 自动应答主机密钥确认 / 口令输入（不写真实 known_hosts）
  await js(`
    window.__prompts = [];
    window.__answers = { passphrase: 'pass-phrase-123', password: 'hunter2-correct' };
    window.F.handlePrompt = (req) => {
      window.__prompts.push({ type: req.type, payload: req.payload });
      const t = req.type;
      if (t === 'hostkey') return window.ferry.reply(req.id, { accept: true, remember: false });
      if (t === 'passphrase') return window.ferry.reply(req.id, { value: window.__answers.passphrase, save: false });
      if (t === 'password') return window.ferry.reply(req.id, { value: window.__answers.password, save: false });
      if (t === 'error') return window.ferry.reply(req.id, { ok: true });
      return window.ferry.reply(req.id, { cancelled: true });
    };
    return true;
  `);

  // ================= 场景 1：密钥免密登录 =================
  console.log('\n[1] 密钥登录 + 目录浏览');
  const s1 = await startServer({ hostKey, root: SERVER_ROOT, authorizedKey: clientPub });
  const h1 = await js(`
    const h = await window.ferry.hosts.save({
      name: 'E2E 密钥', host: '127.0.0.1', port: ${s1.port}, username: 'tester',
      auth: 'key', privateKeyPath: ${JSON.stringify(path.join(KEYS, 'client'))},
    });
    await window.app.reloadHosts();
    await window.app.selectHost(h.id);
    return h.id;
  `);
  await waitFor('window.app.statusOf(window.app.currentHostId).state === "ready"', '建立连接');
  check('密钥认证连接成功', true);
  check('收到主机密钥确认提示', await js('return window.__prompts.some(p => p.type === "hostkey");'));
  await waitFor('!!window.app.remote.path', '远端目录加载');
  const remoteList = await js('return { path: window.app.remote.path, names: window.app.remote.entries.map(e => e.name).sort(), rows: document.querySelectorAll(".pane.remote .ent").length };');
  check('远端目录列出正确', JSON.stringify(remoteList.names) === JSON.stringify(['logs', 'remote-only.log']), JSON.stringify(remoteList));
  check('远端面板渲染出行', remoteList.rows === 2, `${remoteList.rows} 行`);

  // ================= 场景 2：上传（含递归目录 + 3MB 文件） =================
  console.log('\n[2] 上传：多选 + 递归目录 + 大文件');
  await js(`
    await window.app.local.navigate(${JSON.stringify(LOCAL_SRC)}, { replace: true });
    window.app.local.selected = new Set(['plain.txt', 'big.bin', 'tree']);
    await window.app.transferSelection('upload');
    return true;
  `);
  await waitFor('window.app.queue.stats && window.app.queue.stats.running + window.app.queue.stats.queued === 0 && window.app.queue.stats.finished >= 4', '上传完成', 60000);
  const upStats = await js('return window.app.queue.stats;');
  check('上传任务全部成功', upStats.failed === 0 && upStats.finished >= 4, JSON.stringify(upStats));
  check('big.bin 内容一致', sha(path.join(LOCAL_SRC, 'big.bin')) === sha(path.join(SERVER_ROOT, 'big.bin')));
  check('中文内容文件一致', fs.readFileSync(path.join(SERVER_ROOT, 'plain.txt'), 'utf8') === 'hello ferry 你好\n');
  check('递归目录结构完整',
    fs.existsSync(path.join(SERVER_ROOT, 'tree/a.txt')) && fs.existsSync(path.join(SERVER_ROOT, 'tree/nested/b.bin')));
  check('嵌套文件内容一致', sha(path.join(LOCAL_SRC, 'tree/nested/b.bin')) === sha(path.join(SERVER_ROOT, 'tree/nested/b.bin')));
  const srcMtime = Math.floor(fs.statSync(path.join(LOCAL_SRC, 'big.bin')).mtimeMs / 1000);
  const dstMtime = Math.floor(fs.statSync(path.join(SERVER_ROOT, 'big.bin')).mtimeMs / 1000);
  check('保留修改时间', Math.abs(srcMtime - dstMtime) <= 1, `${srcMtime} vs ${dstMtime}`);

  // ================= 场景 3：下载 =================
  console.log('\n[3] 下载到本机');
  await js(`
    await window.app.local.navigate(${JSON.stringify(LOCAL_DST)}, { replace: true });
    await window.app.remote.refresh();
    window.app.remote.selected = new Set(['remote-only.log', 'logs']);
    await window.app.transferSelection('download');
    return true;
  `);
  await waitFor('window.app.queue.stats.running + window.app.queue.stats.queued === 0', '下载完成', 60000);
  check('下载文件一致', sha(path.join(SERVER_ROOT, 'remote-only.log')) === sha(path.join(LOCAL_DST, 'remote-only.log')));
  check('下载远端目录一致', sha(path.join(SERVER_ROOT, 'logs/app.log')) === sha(path.join(LOCAL_DST, 'logs/app.log')));

  // ================= 场景 4：同名冲突 =================
  console.log('\n[4] 同名冲突处理');
  const conflict = await js(`
    await window.app.local.navigate(${JSON.stringify(LOCAL_SRC)}, { replace: true });
    window.app.local.selected = new Set(['plain.txt']);
    const p = window.app.transferSelection('upload');
    // 等冲突对话框出现
    for (let i = 0; i < 100 && !document.querySelector('.sheet-foot'); i++) await new Promise(r => setTimeout(r, 60));
    const foot = document.querySelector('.sheet-foot');
    const labels = foot ? [...foot.querySelectorAll('button')].map(b => b.textContent) : null;
    const text = document.querySelector('.sheet') ? document.querySelector('.sheet').textContent : '';
    const btn = foot ? [...foot.querySelectorAll('button')].find(b => b.textContent === '两者都留') : null;
    if (btn) btn.click();
    await p;
    return { labels, sawWarning: text.includes('个同名文件') };
  `);
  check('弹出冲突选项', conflict.labels && conflict.labels.join('/') === '取消/跳过同名/两者都留/覆盖', JSON.stringify(conflict.labels));
  check('冲突提示文案正确', conflict.sawWarning);
  await waitFor('window.app.queue.stats.running + window.app.queue.stats.queued === 0', '冲突传输完成', 30000);
  check('“两者都留”生成了副本', fs.existsSync(path.join(SERVER_ROOT, 'plain 2.txt')), fs.readdirSync(SERVER_ROOT).join(','));

  // ================= 场景 5：远端文件操作 =================
  console.log('\n[5] 远端新建 / 重命名 / 删除');
  await js(`await window.ferry.ssh.mkdir(window.app.currentHostId, window.app.remote.path + '/made-by-ferry'); return true;`);
  check('远端新建目录', fs.existsSync(path.join(SERVER_ROOT, 'made-by-ferry')));
  await js(`await window.ferry.ssh.rename(window.app.currentHostId, window.app.remote.path + '/made-by-ferry', window.app.remote.path + '/renamed'); return true;`);
  check('远端重命名', fs.existsSync(path.join(SERVER_ROOT, 'renamed')) && !fs.existsSync(path.join(SERVER_ROOT, 'made-by-ferry')));
  await js(`await window.ferry.ssh.remove(window.app.currentHostId, window.app.remote.path + '/tree'); return true;`);
  check('远端递归删除目录', !fs.existsSync(path.join(SERVER_ROOT, 'tree')));
  const info = await js(`return await window.ferry.ssh.info(window.app.currentHostId, '/');`);
  check('远端 exec 可用', String(info).includes('FakeSSH'), String(info).split('\n')[0]);

  // ================= 场景 6：加密私钥 + 口令 =================
  console.log('\n[6] 加密私钥（口令）');
  const s2 = await startServer({ hostKey, root: SERVER_ROOT, authorizedKey: clientEncPub });
  await js(`
    const h = await window.ferry.hosts.save({
      name: 'E2E 加密密钥', host: '127.0.0.1', port: ${s2.port}, username: 'tester',
      auth: 'key', privateKeyPath: ${JSON.stringify(path.join(KEYS, 'client_enc'))},
    });
    await window.app.reloadHosts();
    await window.app.selectHost(h.id);
    return h.id;
  `);
  await waitFor('window.app.statusOf(window.app.currentHostId).state === "ready"', '加密密钥连接', 25000);
  check('加密私钥解锁并连接', true);
  check('弹出了口令输入', await js('return window.__prompts.some(p => p.type === "passphrase");'));

  // 错误口令应当被拒并重新询问
  await js(`window.app.statuses = {}; window.__answers.passphrase = 'wrong-one'; window.__prompts = []; return true;`);
  const wrongPass = await js(`
    const id = window.app.currentHostId;
    await window.ferry.ssh.disconnect(id);
    window.F.handlePrompt = (req) => {
      window.__prompts.push({ type: req.type });
      if (req.type === 'hostkey') return window.ferry.reply(req.id, { accept: true, remember: false });
      if (req.type === 'passphrase') return window.ferry.reply(req.id, { cancelled: true });
      if (req.type === 'error') return window.ferry.reply(req.id, { ok: true });
      return window.ferry.reply(req.id, { cancelled: true });
    };
    try { await window.ferry.ssh.connect(id); return { connected: true }; }
    catch (e) { return { connected: false, error: e.message }; }
  `);
  check('取消口令输入不会连上', wrongPass.connected === false, wrongPass.error);

  // ================= 场景 7：密码认证 =================
  console.log('\n[7] 密码认证');
  const s3 = await startServer({ hostKey, root: SERVER_ROOT, password: 'hunter2-correct' });
  await js(`
    window.__answers.password = 'hunter2-correct';
    window.F.handlePrompt = (req) => {
      window.__prompts.push({ type: req.type });
      if (req.type === 'hostkey') return window.ferry.reply(req.id, { accept: true, remember: false });
      if (req.type === 'password') return window.ferry.reply(req.id, { value: window.__answers.password, save: false });
      if (req.type === 'error') return window.ferry.reply(req.id, { ok: true });
      return window.ferry.reply(req.id, { cancelled: true });
    };
    const h = await window.ferry.hosts.save({
      name: 'E2E 密码', host: '127.0.0.1', port: ${s3.port}, username: 'tester', auth: 'password',
    });
    await window.app.reloadHosts();
    await window.app.selectHost(h.id);
    return h.id;
  `);
  await waitFor('window.app.statusOf(window.app.currentHostId).state === "ready"', '密码连接', 25000);
  check('密码认证连接成功', true);

  const badPw = await js(`
    const id = window.app.currentHostId;
    await window.ferry.ssh.disconnect(id);
    window.__answers.password = 'totally-wrong';
    try { await window.ferry.ssh.connect(id); return { connected: true }; }
    catch (e) { return { connected: false, error: e.message }; }
  `);
  check('错误密码被拒绝且提示友好', badPw.connected === false && /认证失败/.test(badPw.error || ''), badPw.error);

  // ================= 场景 8：主机密钥不匹配 =================
  console.log('\n[8] 主机密钥不匹配告警');
  const kh = path.join(SANDBOX, 'known_hosts_test');
  const otherPub = fs.readFileSync(path.join(KEYS, 'client.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  fs.writeFileSync(kh, `[127.0.0.1]:${s3.port} ${otherPub}\n`);
  const khMod = require(path.join(ROOT, 'electron/known-hosts.js'));
  const realKey = utils.parseKey(hostKey).getPublicSSH();
  // 直接验证解析器对“同类型指纹不同”的判定
  const Module = require('module');
  const srcKh = fs.readFileSync(path.join(ROOT, 'electron/known-hosts.js'), 'utf8').replace(/const FILE = .*/, `const FILE = ${JSON.stringify(kh)};`);
  const m = new Module('kh2'); m._compile(srcKh, '/tmp/kh2.js');
  const verdict = m.exports.check('127.0.0.1', s3.port, realKey);
  check('同算法指纹变更判定为 mismatch', verdict.status === 'mismatch', verdict.status);
  check('未记录的主机判定为 unknown', m.exports.check('1.2.3.4', 22, realKey).status === 'unknown');

  // ================= 场景 9：取消传输 =================
  console.log('\n[9] 取消传输');
  await js(`
    window.F.handlePrompt = (req) => {
      if (req.type === 'hostkey') return window.ferry.reply(req.id, { accept: true, remember: false });
      return window.ferry.reply(req.id, { cancelled: true });
    };
    await window.app.selectHost(${JSON.stringify(h1)});
    return true;
  `);
  await waitFor('window.app.statusOf(window.app.currentHostId).state === "ready" && !!window.app.remote.path', '回到第一台主机', 25000);
  fs.writeFileSync(path.join(LOCAL_SRC, 'huge.bin'), crypto.randomBytes(24 * 1024 * 1024));
  const cancelled = await js(`
    await window.app.local.navigate(${JSON.stringify(LOCAL_SRC)}, { replace: true });
    window.app.local.selected = new Set(['huge.bin']);
    const p = window.app.transferSelection('upload');
    for (let i = 0; i < 200; i++) {
      await new Promise(r => setTimeout(r, 50));
      const s = window.app.queue.stats;
      if (s && s.running > 0 && s.done > 300000) break;
    }
    await window.ferry.transfers.cancelAll();
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 60));
      const s = window.app.queue.stats;
      if (s.running + s.queued === 0) break;
    }
    return { states: [...window.app.queue.tasks.values()].map(t => t.state), stats: window.app.queue.stats };
  `);
  check('取消后任务标记为 cancelled', cancelled.states.includes('cancelled'), JSON.stringify(cancelled.states.slice(-3)));
  const partial = fs.existsSync(path.join(SERVER_ROOT, 'huge.bin'));
  check('取消后连接仍然可用', await js(`
    const r = await window.ferry.ssh.list(window.app.currentHostId, window.app.remote.path);
    return r.entries.length > 0;
  `), partial ? '服务器上留有部分文件（符合 SFTP 语义）' : '');

  // ================= 场景 10：并发与队列控制 =================
  console.log('\n[10] 队列控制');
  const q = await js(`
    await window.ferry.transfers.clear();
    const s1 = (await window.ferry.transfers.pause(true)).paused;
    const s2 = (await window.ferry.transfers.pause(false)).paused;
    await window.ferry.settings.set({ concurrency: 5 });
    const snap = await window.ferry.transfers.snapshot();
    return { pausedOn: s1, pausedOff: s2, cleared: snap.tasks.length, conc: snap.stats.concurrency };
  `);
  check('暂停 / 继续开关有效', q.pausedOn === true && q.pausedOff === false);
  check('清除已完成生效', q.cleared === 0, `${q.cleared} 条残留`);
  check('并发数设置生效', q.conc === 5, String(q.conc));

  // ================= 收尾 =================
  console.log('\n[11] 渲染层无异常');
  check('渲染进程没有未捕获错误', logs.length === 0, logs.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== ${results.length - failed.length}/${results.length} 项通过 ====`);
  if (failed.length) console.log('失败：', failed.map((f) => f.name).join('; '));
  app.exit(failed.length ? 1 : 0);
}).catch((e) => {
  console.log('HARNESS ERROR:', e && e.stack || e);
  console.log('renderer logs:', logs.slice(0, 5));
  app.exit(1);
});
