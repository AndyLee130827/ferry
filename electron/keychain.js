'use strict';
// 用 macOS 自带的 security 命令把密码/口令存进登录钥匙串，不落盘明文。
const { execFile } = require('child_process');

const SERVICE = 'Ferry SSH';

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/security', args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

async function get(account) {
  let out;
  try {
    out = await run(['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
  } catch {
    return null;
  }
  const raw = out.replace(/\r?\n$/, '');
  // 我们统一以 "v1:<base64>" 落库，这样 security -w 总是原样回显 ASCII，不会退化成十六进制
  if (raw.startsWith('v1:')) {
    try {
      return Buffer.from(raw.slice(3), 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  // 兼容极早期/外部写入的裸值：偶数长度纯十六进制按 security 的 hex 回显处理
  if (/^[0-9A-Fa-f]+$/.test(raw) && raw.length % 2 === 0 && raw.length >= 2) {
    const decoded = Buffer.from(raw, 'hex').toString('utf8');
    if (!decoded.includes('\uFFFD')) return decoded;
  }
  return raw;
}

async function set(account, secret) {
  // -X 用十六进制传值，密码不会出现在进程参数里被 ps 看到；-U 覆盖同名条目
  const payload = 'v1:' + Buffer.from(String(secret), 'utf8').toString('base64');
  const hex = Buffer.from(payload, 'utf8').toString('hex');
  await run(['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-D', 'Ferry secret', '-X', hex]);
}

async function del(account) {
  try {
    await run(['delete-generic-password', '-s', SERVICE, '-a', account]);
  } catch {
    /* 本来就没有 */
  }
}

module.exports = {
  passwordKey: (id) => `${id}::password`,
  passphraseKey: (id) => `${id}::passphrase`,
  get,
  set,
  del,
  async clearHost(id) {
    await del(`${id}::password`);
    await del(`${id}::passphrase`);
  },
};
