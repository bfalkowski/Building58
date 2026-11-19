// Finds the other relays on this room's state folder when the relay starts, with the rules in
// relay/old-relays-plan.js. An old copy of this relay is stopped at once. Any other is kept in a list that
// Needs you (relay/needs-you.js) names with a Stop button, and the person stops it with
// POST /channels/<channel>/old-relays/<pid>/stop. GET /channels/<channel>/old-relays gives the list.
// Like the terminal, both answer only the room page on this machine, with the person's key.
//
// To stop a relay it sends SIGTERM to each of its processes, then SIGCONT, so a relay paused with Ctrl+Z
// wakes up to take it. Its supervisor then stops its session host. One still running after STOP_MS gets
// SIGKILL, and its host ends when the supervisor's pipe closes. ps and lsof run only at start and before
// a stop, and the list drops a relay once its process is gone. See docs/manual/running.html#old-relays.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const terminal = require('./terminal.js');
const state = require('./state.js');
const { psOf, planOf } = require('./old-relays-plan.js');

const STOP_MS = 10000;
let me = null, others = [];

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out)));
});
const realOf = (p) => { try { return fs.realpathSync(p); } catch (e) { return p; } };
const procCwd = (pid) => { try { return fs.readlinkSync('/proc/' + pid + '/cwd'); } catch (e) { return null; } };
async function cwdOf(pid) {
  if (procCwd(pid)) return procCwd(pid);
  const m = (await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])).match(/^n(.+)$/m);
  return m ? realOf(m[1]) : null;
}
async function scan() {
  const procs = psOf(await run('ps', ['axeww', '-o', 'pid=,ppid=,stat=,lstart=,command=']));
  for (const p of procs) if (path.isAbsolute(p.script)) p.script = realOf(p.script);
  const unknown = planOf({ me, procs }).filter((r) => !r.file).map((r) => r.pid);
  for (const p of procs) if (unknown.includes(p.pid)) p.cwd = await cwdOf(p.pid);
  return planOf({ me, procs });
}
function signal(pid, sig) { try { process.kill(pid, sig); return true; } catch (e) { return false; } }
function stop(r, log) {
  for (const pid of r.pids) signal(pid, 'SIGTERM');
  for (const pid of r.pids) signal(pid, 'SIGCONT');
  return new Promise((resolve) => {
    const began = Date.now();
    const tick = setInterval(() => {
      const left = r.pids.filter(alive);
      if (left.length && Date.now() - began < STOP_MS) return;
      clearInterval(tick);
      for (const pid of left) signal(pid, 'SIGKILL');
      if (left.length) log('The relay with pid ' + r.pid + ' did not stop in ' + STOP_MS / 1000 + ' seconds, so it was killed.');
      resolve();
    }, 200);
  });
}
const named = (r) => 'pid ' + r.pid + (r.started ? ', started ' + r.started.slice(0, 16).replace('T', ' ') + ' UTC' : '') + ', ' + (r.file ? state.shown(r.file) : 'from a folder ps does not show') + ', port ' + r.port + (r.paused ? ', paused' : '');

async function begin({ port, defaultPort, world, log }) {
  me = { pid: process.pid, ppid: process.ppid, file: fs.realpathSync(path.join(__dirname, 'server.js')), stateDir: state.dir(), port, defaultPort, world: world || '' };
  let found;
  try { found = await scan(); } catch (e) { log('Could not look for other relays: ' + e.message); return; }
  for (const r of found.filter((x) => x.own)) {
    log('Stopping an old copy of this relay that still runs (' + named(r) + ').');
    await stop(r, log);
  }
  others = found.filter((x) => !x.own);
  for (const r of others) log('Another relay uses this room\'s state folder (' + named(r) + '). Needs you has a Stop button for it.');
}

function list() {
  others = others.filter((r) => r.pids.some(alive));
  return others.map((r) => ({ pid: r.pid, file: r.file ? state.shown(r.file) : null, port: r.port, started: r.started, paused: r.paused, worker: r.worker }));
}

async function handle(req, res, channel, rest, ctx) {
  const m = rest.match(/^\/old-relays(?:\/(\d+)\/stop)?$/);
  if (!m) return false;
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (ctx.agent) { ctx.problem(res, 401, 'unauthorized', 'Only the person stops another relay.'); return true; }
  if (!m[1]) {
    if (req.method !== 'GET') { ctx.problem(res, 404, 'not_found', 'Use GET for the list.'); return true; }
    ctx.send(res, 200, { ok: true, relays: list() });
    return true;
  }
  if (req.method !== 'POST') { ctx.problem(res, 404, 'not_found', 'Use POST to stop a relay.'); return true; }
  const pid = Number(m[1]);
  if (!list().some((r) => r.pid === pid)) { ctx.problem(res, 404, 'unknown_relay', 'No other relay with pid ' + pid + ' is on the list.'); return true; }
  const now = me ? (await scan()).find((r) => r.pid === pid) : null;
  if (!now) {
    others = others.filter((r) => r.pid !== pid);
    ctx.problem(res, 404, 'unknown_relay', 'pid ' + pid + ' is no longer a relay on this room\'s state folder.');
    return true;
  }
  ctx.log('The person stops another relay (' + named(now) + ').');
  await stop(now, ctx.log);
  others = others.filter((r) => r.pid !== pid);
  ctx.send(res, 200, { ok: true, stopped: pid });
  return true;
}

module.exports = { begin, list, handle };
