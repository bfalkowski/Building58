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
// A job that does nothing is stuck. For each job the host keeps when its process tree last used CPU, or
// when its output file last grew, whichever was later (track below). One quiet for STUCK (30 minutes) is
// stuck: relay/liveness.js no longer counts it as busy, and relay/stuck-jobs.js tells the Dev and later
// ends that one process. CPU counts only over a whole WINDOW, and only when it gains CPU_SHARE of that
// time, since a wait loop such as `until grep ...; do sleep 3; done` uses a few milliseconds a turn.
// The gain is summed per process, so a build whose short compilers come and go still counts.
//
// It uses ps, which macOS and Linux both have, and nothing to install. The output file is what the
// job's standard output points to: /proc on Linux, lsof elsewhere.
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const SNAPSHOT = /\/shell-snapshots\/snapshot-/;
const LONG = 60 * 1000;
const positive = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
const STUCK = () => positive('RELAY_JOB_STUCK_MS', 30 * 60 * 1000);
const WINDOW = () => positive('RELAY_JOB_CPU_WINDOW_MS', 60 * 1000);
const CPU_SHARE = 0.05;
const EVERY = Number(process.env.RELAY_JOB_SCAN_MS) > 0 ? Number(process.env.RELAY_JOB_SCAN_MS) : 5000;

function isJob(p) {
  const words = String((p && p.args) || '').trim().split(/\s+/);
  if (!SHELLS.has(path.basename(words[0] || '').replace(/^-/, ''))) return false;
  let withC = false;
  for (const w of words.slice(1)) { if (!/^-[A-Za-z]+$/.test(w)) break; if (w.includes('c')) withC = true; }
  if (!withC) return false;
  return SNAPSHOT.test(p.args) || (p.ageMs || 0) >= LONG;
}

function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.\d+)?$/.exec(String(s || '').trim());
  if (!m) return 0;
  return ((((Number(m[1] || 0) * 24) + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
}
function parsePs(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), ageMs: parseEtime(m[3]), cpuMs: parseEtime(m[4]), args: m[5] });
  }
  return out;
}
function treeOf(table, pid) {
  const kids = new Map();
  for (const p of table) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const out = [], seen = new Set([pid]);
  const root = table.find((p) => p.pid === pid);
  const queue = root ? [root] : [];
  while (queue.length) {
    const p = queue.shift();
    out.push(p);
    for (const k of kids.get(p.pid) || []) if (!seen.has(k.pid)) { seen.add(k.pid); queue.push(k); }
  }
  return out;
}
function jobsUnder(table, bridgePid) {
  const claudes = new Set(table.filter((p) => p.ppid === bridgePid).map((p) => p.pid));
  return table.filter((p) => claudes.has(p.ppid) && isJob(p)).map((p) => ({ pid: p.pid, ageMs: p.ageMs }));
}

function commandOf(args) {
  const text = String(args || '');
  const m = /\beval '((?:[^'\\]|\\.|'\\'')*)'/.exec(text);
  return String((m ? m[1].replace(/'\\''/g, "'") : text).split('\n').map((l) => l.trim()).filter(Boolean).join(' ')).slice(0, 200);
}

function track(prev, sample, now) {
  const cpus = sample.cpus || {};
  if (!prev) return { activeAt: now, windowAt: now, gained: 0, cpus, size: sample.size };
  const next = Object.assign({}, prev, { cpus, size: sample.size });
  for (const [pid, ms] of Object.entries(cpus)) next.gained += Math.max(0, ms - (prev.cpus[pid] || 0));
  if (sample.size != null && prev.size != null && sample.size > prev.size) next.activeAt = now;
  if (now - prev.windowAt >= WINDOW()) {
    if (next.gained >= (now - prev.windowAt) * CPU_SHARE) next.activeAt = now;
    next.windowAt = now; next.gained = 0;
  }
  return next;
}
const quietFor = (tracked, now) => (tracked ? Math.max(0, now - tracked.activeAt) : 0);
const isStuck = (tracked, now) => quietFor(tracked, now) >= STUCK();

function outputSize(pid, done) {
  const finish = (file) => fs.stat(file, (err, st) => done(!err && st.isFile() ? st.size : null));
  fs.readlink('/proc/' + pid + '/fd/1', (err, target) => {
    if (!err) { if (path.isAbsolute(target)) finish(target); else done(null); return; }
    execFile('lsof', ['-a', '-p', String(pid), '-d', '1', '-Fn'], { timeout: 3000 }, (e, out) => {
      const m = !e && /^n(\/.*)$/m.exec(String(out));
      if (m) finish(m[1]); else done(null);
    });
  });
}

function end(table, bridgePid, pid, kill) {
  if (!jobsUnder(table, bridgePid).some((j) => j.pid === pid)) return false;
  for (const p of treeOf(table, pid).reverse()) { try { (kill || process.kill)(p.pid, 'SIGTERM'); } catch (e) { continue; } }
  return true;
}

function scan(done) {
  execFile('ps', ['-A', '-ww', '-o', 'pid=,ppid=,etime=,time=,args='], { maxBuffer: 64 * 1024 * 1024, timeout: 5000 }, (err, out) => done(err ? null : parsePs(out)));
}

function sizes(pids) {
  return Promise.all(pids.map((pid) => new Promise((resolve) => outputSize(pid, resolve)))).then((list) => new Map(pids.map((pid, i) => [pid, list[i]])));
}

function watch(list, changed) {
  const last = new WeakMap(), tracks = new WeakMap();
  let busy = false;
  const timer = setInterval(() => {
    const sessions = list();
    if (busy || !sessions.length) return;
    busy = true;
    scan(async (table) => {
      try {
        if (!table) return;
        const now = Date.now();
        for (const s of sessions) {
          if (!s.child || !s.child.pid) continue;
          const jobs = jobsUnder(table, s.child.pid);
          const size = await sizes(jobs.map((j) => j.pid));
          const mine = new Map();
          const stuck = [];
          for (const j of jobs) {
            const cpus = {};
            for (const p of treeOf(table, j.pid)) cpus[p.pid] = p.cpuMs;
            const tracked = track((tracks.get(s) || new Map()).get(j.pid), { cpus, size: size.get(j.pid) }, now);
            mine.set(j.pid, tracked);
            if (isStuck(tracked, now)) stuck.push({ pid: j.pid, command: commandOf((table.find((p) => p.pid === j.pid) || {}).args), since: tracked.activeAt });
          }
          tracks.set(s, mine);
          const key = jobs.map((j) => j.pid).sort((a, b) => a - b).join(' ') + '|' + stuck.map((j) => j.pid).sort((a, b) => a - b).join(' ');
          if (key === (last.get(s) || '|')) continue;
          last.set(s, key);
          changed(s, { count: jobs.length, since: jobs.length ? now - Math.max(...jobs.map((j) => j.ageMs)) : null, stuck });
        }
      } finally { busy = false; }
    });
  }, EVERY);
  timer.unref();
  return () => clearInterval(timer);
}

function endIn(session, pid, done) {
  scan((table) => done(!!table && !!session.child && end(table, session.child.pid, pid)));
}

module.exports = { isJob, parseEtime, parsePs, jobsUnder, treeOf, commandOf, track, quietFor, isStuck, end, endIn, watch, LONG, STUCK };
