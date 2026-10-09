'use strict';
// 读取 ~/.ssh/config，把已有主机一键导入（支持 Include）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.ssh', 'config');

function expand(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function globInclude(spec) {
  const abs = path.isAbsolute(spec) ? spec : path.join(os.homedir(), '.ssh', spec);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  if (!/[*?]/.test(base)) return [abs];
  try {
    const rx = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return fs.readdirSync(dir).filter((f) => rx.test(f)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function parseFile(file, seen, out) {
  if (seen.has(file)) return;
  seen.add(file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)[\s=]+(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');

    if (key === 'include') {
      for (const spec of value.split(/\s+/)) for (const f of globInclude(expand(spec))) parseFile(f, seen, out);
      continue;
    }
    if (key === 'host') {
      const aliases = value.split(/\s+/).filter((a) => !/[*?!]/.test(a));
      current = aliases.length ? { alias: aliases[0], aliases } : null;
      if (current) out.push(current);
      continue;
    }
    if (!current) continue;
    if (key === 'hostname') current.hostname = value;
    else if (key === 'user') current.user = value;
    else if (key === 'port') current.port = Number(value) || 22;
    else if (key === 'identityfile') (current.identityFiles ||= []).push(expand(value));
    else if (key === 'identityagent') current.identityAgent = expand(value);
    else if (key === 'proxyjump') current.proxyJump = value;
  }
}

function list() {
  const out = [];
  parseFile(ROOT, new Set(), out);
  return out
    .filter((e) => e.hostname || e.alias)
    .map((e) => ({
      alias: e.alias,
      host: e.hostname || e.alias,
      port: e.port || 22,
      username: e.user || '',
      identityFile: (e.identityFiles || []).map(expand).find((f) => fs.existsSync(f)) || (e.identityFiles || [])[0] || '',
      proxyJump: e.proxyJump || '',
    }));
}

function defaultKeys() {
  const dir = path.join(os.homedir(), '.ssh');
  return ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa']
    .map((n) => path.join(dir, n))
    .filter((f) => fs.existsSync(f));
}

module.exports = { list, defaultKeys, file: ROOT, expand };
