'use strict';
// 自己解析 ~/.ssh/known_hosts（含 |1| 哈希条目），做首次连接指纹确认 + 变更告警。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(os.homedir(), '.ssh', 'known_hosts');

function hostToken(host, port) {
  return Number(port) === 22 ? host : `[${host}]:${port}`;
}

function fingerprint(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

function keyType(keyBuf) {
  try {
    const len = keyBuf.readUInt32BE(0);
    if (len > 0 && len < 64 && keyBuf.length >= 4 + len) return keyBuf.slice(4, 4 + len).toString('ascii');
  } catch { /* 不是标准 SSH 公钥编码 */ }
  return 'unknown';
}

function patternMatches(pattern, token) {
  if (pattern === token) return true;
  if (!/[*?]/.test(pattern)) return false;
  const rx = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return rx.test(token);
}

function entryMatches(field, token) {
  if (field.startsWith('|1|')) {
    const [, saltB64, hashB64] = field.split('|').filter((x, i) => i > 0); // |1|salt|hash
    if (!saltB64 || !hashB64) return false;
    try {
      const mac = crypto.createHmac('sha1', Buffer.from(saltB64, 'base64')).update(token).digest('base64');
      return mac === hashB64;
    } catch {
      return false;
    }
  }
  return field.split(',').some((p) => {
    const neg = p.startsWith('!');
    const pat = neg ? p.slice(1) : p;
    return !neg && patternMatches(pat, token);
  });
}

function readLines() {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n');
  } catch {
    return [];
  }
}

/**
 * @returns {{status:'match'|'unknown'|'mismatch'|'revoked', fingerprint:string, type:string, known?:string[]}}
 */
function check(host, port, keyBuf) {
  const token = hostToken(host, port);
  const fp = fingerprint(keyBuf);
  const type = keyType(keyBuf);
  const known = [];
  let revoked = false;

  for (const line of readLines()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    let parts = t.split(/\s+/);
    let marker = null;
    if (parts[0].startsWith('@')) {
      marker = parts[0];
      parts = parts.slice(1);
    }
    if (marker === '@cert-authority') continue; // 证书签发方，不做逐 key 比对
    const [hostField, kType, b64] = parts;
    if (!hostField || !kType || !b64) continue;
    if (!entryMatches(hostField, token)) continue;

    let entryFp;
    try {
      entryFp = 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '');
    } catch {
      continue;
    }
    if (marker === '@revoked') {
      if (entryFp === fp) revoked = true;
      continue;
    }
    known.push({ type: kType, fingerprint: entryFp });
  }

  if (revoked) return { status: 'revoked', fingerprint: fp, type };
  if (!known.length) return { status: 'unknown', fingerprint: fp, type };
  if (known.some((k) => k.fingerprint === fp)) return { status: 'match', fingerprint: fp, type };
  // 同类型算法下指纹不同 => 真正的变更；只有其他算法记录则视为新算法，走确认流程
  const sameType = known.filter((k) => k.type === type);
  if (sameType.length) return { status: 'mismatch', fingerprint: fp, type, known: sameType.map((k) => k.fingerprint) };
  return { status: 'unknown', fingerprint: fp, type, known: known.map((k) => `${k.type} ${k.fingerprint}`) };
}

function add(host, port, keyBuf) {
  const dir = path.dirname(FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const line = `${hostToken(host, port)} ${keyType(keyBuf)} ${keyBuf.toString('base64')}\n`;
  let prefix = '';
  try {
    const cur = fs.readFileSync(FILE, 'utf8');
    if (cur.length && !cur.endsWith('\n')) prefix = '\n';
  } catch { /* 文件还不存在 */ }
  fs.appendFileSync(FILE, prefix + line, { mode: 0o600 });
}

module.exports = { check, add, fingerprint, keyType, hostToken, file: FILE };
