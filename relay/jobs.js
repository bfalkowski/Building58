// Jobs: commands a session's claude started that still run, such as `npm test` sent to the background
// by the Bash tool. The session host (relay/session-host.js) looks at the process tree every few seconds
// and tells the relay how many each session has, and relay/liveness.js calls a session whose turn ended
// with a job still running busy (job), not idle. It reads only process state, never hooks: a Stop hook
// says the turn ended, and nothing says when a job sent to the background ends.
//
// A job is told from a helper by what the process is. Each session runs as host > pty-bridge.py >
// claude > its children. On 2026-11-08, on this machine, an idle claude had no children at all. A busy
// one had two kinds:
//   - a shell run with -c that first sources Claude Code's shell snapshot, such as
//     `/bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-....sh ... && eval 'npm test'`. That is
//     a command from the Bash tool, in the foreground or the background. It is a job.
//   - `caffeinate -i -t 300`, which Claude Code starts so the computer does not sleep while it works.
//     It is a helper.
// MCP servers (node, npx, uvx, python, docker) are helpers too. Hook and status line commands are shells
// run with -c, but they end within seconds. So a job is a shell run with -c that names the shell
// snapshot, or that has run for LONG, in case a later Claude Code stops using the snapshot. Anything
// else is a helper.
//
// It uses ps, which macOS and Linux both have, and nothing to install.
'use strict';
const { execFile } = require('child_process');
const path = require('path');

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const SNAPSHOT = /\/shell-snapshots\/snapshot-/;
const LONG = 60 * 1000;
const EVERY = Number(process.env.RELAY_JOB_SCAN_MS) > 0 ? Number(process.env.RELAY_JOB_SCAN_MS) : 5000;

// p: { args, ageMs }. Plain, so the tests can run it on its own.
function isJob(p) {
  const words = String((p && p.args) || '').trim().split(/\s+/);
  if (!SHELLS.has(path.basename(words[0] || '').replace(/^-/, ''))) return false;
  // -c among the options before the first word that is not one: -c, -lc, -l -c.
  let withC = false;
  for (const w of words.slice(1)) { if (!/^-[A-Za-z]+$/.test(w)) break; if (w.includes('c')) withC = true; }
  if (!withC) return false;
  return SNAPSHOT.test(p.args) || (p.ageMs || 0) >= LONG;
}

// ps prints how long a process has run as [[dd-]hh:]mm:ss.
function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s || '').trim());
  if (!m) return 0;
  return ((((Number(m[1] || 0) * 24) + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
}
// What `ps -A -ww -o pid=,ppid=,etime=,args=` prints, as [{ pid, ppid, ageMs, args }].
function parsePs(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), ageMs: parseEtime(m[3]), args: m[4] });
  }
  return out;
}
// The jobs of the claude under a session's bridge: [{ pid, ageMs }]. The bridge's children are its claude.
function jobsUnder(table, bridgePid) {
  const claudes = new Set(table.filter((p) => p.ppid === bridgePid).map((p) => p.pid));
  return table.filter((p) => claudes.has(p.ppid) && isJob(p)).map((p) => ({ pid: p.pid, ageMs: p.ageMs }));
}

function scan(done) {
  execFile('ps', ['-A', '-ww', '-o', 'pid=,ppid=,etime=,args='], { maxBuffer: 64 * 1024 * 1024, timeout: 5000 }, (err, out) => done(err ? null : parsePs(out)));
}

// For the session host. Every EVERY ms, while list() gives any sessions ({ child } each, the bridge),
// it reads the process tree once, and calls changed(s, { count, since }) for each session whose jobs
// changed. since is when the oldest of them started, in ms, or null with none.
function watch(list, changed) {
  const last = new WeakMap();
  let busy = false;
  const timer = setInterval(() => {
    const sessions = list();
    if (busy || !sessions.length) return;
    busy = true;
    scan((table) => {
      busy = false;
      if (!table) return;  // ps failed: say nothing new, rather than something wrong
      const now = Date.now();
      for (const s of sessions) {
        if (!s.child || !s.child.pid) continue;
        const jobs = jobsUnder(table, s.child.pid);
        const key = jobs.map((j) => j.pid).sort((a, b) => a - b).join(' ');
        if (key === (last.get(s) || '')) continue;
        last.set(s, key);
        changed(s, { count: jobs.length, since: jobs.length ? now - Math.max(...jobs.map((j) => j.ageMs)) : null });
      }
    });
  }, EVERY);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { isJob, parseEtime, parsePs, jobsUnder, watch, LONG };
