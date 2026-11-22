// Which Claude Code the room's sessions run, and whether the room was tested with it. The relay depends on
// Claude Code's hooks, menus, trust question, status line and transcripts, and Claude Code updates itself,
// so a new version can change what safe typing reads with no error. TESTED is the range the room was last
// tested with: the container image pins TESTED.newest (Dockerfile, relay/test/claude-version.test.js), and
// moving it is a pull request that runs the canary. See docs/manual/how-it-works.html#claude-version.
//
//   current() -> { version, oldest, newest, ok } once read, or null
//   compare(a, b) -> -1, 0 or 1 for two versions like 2.1.330
//
// It reads `$CLAUDE_CMD --version` when first asked, and again each hour, since a Claude Code on a computer
// updates itself while the room runs.
'use strict';
const { spawn } = require('child_process');

const TESTED = { oldest: '2.1.330', newest: '2.1.330' };
const CLAUDE = process.env.CLAUDE_CMD || 'claude';
const HOUR = 60 * 60 * 1000;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/;

function compare(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

function verdict(version) {
  if (!VERSION.test(String(version || '') + ' ')) return null;
  const v = String(version).match(VERSION).slice(1).join('.');
  return { version: v, oldest: TESTED.oldest, newest: TESTED.newest, ok: compare(v, TESTED.oldest) >= 0 && compare(v, TESTED.newest) <= 0 };
}

let last = null, reading = false, timer = null;
function read() {
  if (reading) return;
  reading = true;
  let out = '';
  let child;
  try { child = spawn(CLAUDE, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { reading = false; return; }
  const stop = setTimeout(() => child.kill('SIGKILL'), 10000);
  child.stdout.on('data', (d) => { out += d; if (out.length > 1000) child.kill('SIGKILL'); });
  child.on('error', () => { clearTimeout(stop); reading = false; });
  child.on('close', () => { clearTimeout(stop); reading = false; const v = verdict(out.trim()); if (v) last = v; });
}

function current() {
  if (!timer) { read(); timer = setInterval(read, HOUR); timer.unref(); }
  return last;
}

module.exports = { current, compare, verdict, TESTED };
