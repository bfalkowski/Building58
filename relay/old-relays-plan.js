// Other relays on this room's state folder. Each relay reads its files once and writes them whole, so a
// second relay on the same folder can erase what this one saves, and a paused one can wake up later and do
// it. relay/old-relays.js lists the processes with ps when the relay starts and acts on this plan. A plain
// function with no side effects, so the tests run it on a fake process list. See docs/manual/running.html#old-relays.
//
//   psOf(text) -> [{ pid, ppid, stat, started, script, env, cwd }]   from ps axeww -o pid=,ppid=,stat=,lstart=,command=
//   planOf({ me, procs }) -> [{ pid, pids, file, port, started, paused, worker, own }]
//
// me is the relay that runs now: { pid, ppid, file, stateDir, port, defaultPort, world }. A relay is one
// supervisor and the worker it runs, and pid is the top one. It is in the plan when its state folder is
// this one, and its world is this one or none. own says it runs this same relay/server.js on this same port:
// this relay holds that port, so the other is an old copy that cannot answer, and it is stopped. Any other
// is named for the person to stop. A relay whose HOME ps does not show is left out, since its folder is unknown.
'use strict';
const path = require('path');

const SCRIPT = /^\S*node\s+(\S*relay\/server\.js)(?=\s|$)/;
const ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;
const NAMES = ['HOME', 'RELAY_STATE_DIR', 'PORT', 'RELAY_WORLD', 'RELAY_WORKER'];

function envOf(command) {
  const env = {};
  for (const n of NAMES) {
    const m = command.match(new RegExp('\\s' + n + '=(\\S*)'));
    if (m) env[n] = m[1];
  }
  return env;
}

function psOf(text) {
  const out = [];
  for (const row of String(text || '').split('\n')) {
    const m = row.match(ROW);
    if (!m) continue;
    const s = m[5].match(SCRIPT);
    if (!s) continue;
    const at = new Date(m[4].replace(/\s+/g, ' '));
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], started: isNaN(at) ? null : at.toISOString(), script: s[1], env: envOf(m[5]), cwd: null });
  }
  return out;
}

function stateDirOf(env) {
  if (!env.HOME) return null;
  const given = env.RELAY_STATE_DIR;
  if (!given) return path.join(env.HOME, '.office-world');
  const p = given === '~' ? env.HOME : given.startsWith('~/') ? path.join(env.HOME, given.slice(2)) : given;
  return path.isAbsolute(p) ? path.resolve(p) : null;
}
function fileOf(p) {
  if (path.isAbsolute(p.script)) return path.resolve(p.script);
  return p.cwd ? path.resolve(p.cwd, p.script) : null;
}

function planOf({ me, procs }) {
  const relays = (procs || []).filter((p) => p && p.script);
  const byPid = new Map(relays.map((p) => [p.pid, p]));
  const groups = new Map();
  for (const p of relays) {
    const top = p.env.RELAY_WORKER === '1' && byPid.has(p.ppid) ? byPid.get(p.ppid) : p;
    if (!groups.has(top.pid)) groups.set(top.pid, { top, members: [] });
    if (p !== top) groups.get(top.pid).members.push(p);
  }
  const out = [];
  for (const { top, members } of groups.values()) {
    const all = [top].concat(members);
    if (all.some((p) => p.pid === me.pid || p.pid === me.ppid)) continue;
    const worker = members.find((p) => p.env.RELAY_WORKER === '1') || (top.env.RELAY_WORKER === '1' ? top : null);
    const env = Object.assign({}, top.env, worker ? worker.env : {});
    const dir = stateDirOf(env);
    if (!dir || dir !== me.stateDir) continue;
    if (env.RELAY_WORLD && me.world && env.RELAY_WORLD !== me.world) continue;
    const file = fileOf(top), port = Number(env.PORT) || me.defaultPort;
    out.push({ pid: top.pid, pids: all.map((p) => p.pid), file, port, started: top.started, paused: all.some((p) => p.stat.startsWith('T')), worker: !!worker, own: !!file && file === me.file && port === me.port });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

module.exports = { psOf, planOf, SCRIPT };
