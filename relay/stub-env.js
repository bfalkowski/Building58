// Stub env: a task checkout's own .env, with the names the project uses, placeholder values, no real
// keys, and a pair of ports no other checkout of the repo holds. So tests in two checkouts do not
// collide, and a tool that looks for .env finds this one, not the main checkout's. The main
// checkout's .env gives only its names, never a value. See docs/manual/running.html#stub-env.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { LOGIN_LIKE } = require('./session-env.js');

const NAME = '.env';
const EXAMPLES = ['.env.example', '.env.sample', '.env.template'];
const FIRST = 41000, LAST = 41998;
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const PORT_KEY = /(^|_)PORT$/i;
const SEAL = '# room stub ';
const PORTS = /^# ports (\d+) (\d+)$/m;
const PLACEHOLDER = 'stub';

function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; } }
function entries(text) {
  const found = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.match(LINE);
    if (m && !found.has(m[1])) found.set(m[1], m[2].trim());
  }
  return found;
}
const sealOf = (body) => SEAL + crypto.createHash('sha256').update(body).digest('hex').slice(0, 16) + '\n';
function ours(folder) {
  const text = read(path.join(folder, NAME));
  if (!text || !text.endsWith('\n')) return null;
  const cut = text.lastIndexOf('\n', text.length - 2) + 1, body = text.slice(0, cut);
  if (text.slice(cut) !== sealOf(body)) return null;
  const m = body.match(PORTS);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
function held(top, worktrees, folder) {
  const dir = path.join(top, worktrees), out = new Set();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const name of names) {
    const other = path.join(dir, name);
    if (other === folder) continue;
    for (const p of ours(other) || []) out.add(p);
  }
  return out;
}
function bindable(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}
const free = async (port) => (await bindable(port, '127.0.0.1')) && bindable(port);
async function pick(used) {
  for (let p = FIRST; p < LAST; p += 2) {
    if (used.has(p) || used.has(p + 1)) continue;
    if ((await free(p)) && (await free(p + 1))) return [p, p + 1];
  }
  throw new Error('no free pair of ports from ' + FIRST + ' to ' + (LAST + 1));
}
function text(names, ports) {
  const lines = ['# Written by the room for this task checkout: placeholder values and no real keys.',
    '# Keep real keys out of it. The ports are this checkout\'s own.', '# ports ' + ports[0] + ' ' + ports[1]];
  let next = 0;
  for (const [key, example] of names) {
    if (PORT_KEY.test(key)) lines.push(key + '=' + ports[Math.min(next++, 1)]);
    else lines.push(key + '=' + (example && !LOGIN_LIKE.test(key) ? example : PLACEHOLDER));
  }
  if (!next) lines.push('PORT=' + ports[0]);
  const body = lines.join('\n') + '\n';
  return body + sealOf(body);
}
async function write(top, folder, worktrees) {
  const file = path.join(folder, NAME);
  if (fs.existsSync(file)) return null;
  const names = new Map();
  for (const example of EXAMPLES) for (const [k, v] of entries(read(path.join(folder, example)))) if (!names.has(k)) names.set(k, v);
  for (const k of entries(read(path.join(top, NAME))).keys()) if (!names.has(k)) names.set(k, '');
  const ports = await pick(held(top, worktrees, folder));
  fs.writeFileSync(file, text(names, ports), { mode: 0o600 });
  return { file: NAME, ports };
}

module.exports = { write, ours, NAME };
