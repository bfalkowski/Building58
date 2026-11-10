// The relay's side of the session host (relay/session-host.js), which owns the sessions' processes.
// The supervisor names the host's socket in RELAY_HOST_SOCKET. A relay started without one starts a
// host of its own, whose sessions end with this relay.
//
// connect() asks the host what is running. Those sessions wait here, output and all, until
// relay/sessions.js takes each one back with adopt(). The rest are hung up by dropUnclaimed().
'use strict';
const net = require('net');
const host = require('./session-host.js');
const liveness = require('./liveness.js');

let conn = null, ready = false, closing = false;
const sessions = new Map();  // id -> { handlers: { out, exit } }, for sessions this relay drives
const live = new Map();      // id -> { meta, cols, rows, out: [Buffer] }, running in the host and not taken back yet
const jobs = new Map();      // id -> { count, since }: what the host last said of the commands its claude started
let lost = () => {};
// relay/liveness.js asks this for a session's jobs, by its id, which is the terminal's id too.
liveness.useJobs((id) => jobs.get(id) || null);

const send = (msg) => { if (conn && !conn.destroyed) conn.write(JSON.stringify(msg) + '\n'); };

function receive(m) {
  if (m.op === 'list') {
    for (const s of m.sessions || []) {
      if (s.exited) continue;
      live.set(s.id, { meta: s.meta, cols: s.cols, rows: s.rows, out: [Buffer.from(s.out || '', 'base64')] });
      if (s.jobs) jobs.set(s.id, { count: s.jobs.count, since: s.jobs.since });
    }
    ready = true;
    return;
  }
  const mine = sessions.get(m.id), waiting = live.get(m.id);
  if (m.op === 'jobs') { jobs.set(m.id, { count: Number(m.count) || 0, since: m.since || null }); return; }
  if (m.op === 'exit') jobs.delete(m.id);
  if (m.op === 'out') {
    const buf = Buffer.from(String(m.data || ''), 'base64');
    if (mine) mine.handlers.out(buf); else if (waiting) waiting.out.push(buf);
  } else if (m.op === 'exit') {
    if (mine) { sessions.delete(m.id); mine.handlers.exit(m.code); } else live.delete(m.id);
  }
}

function attach(socket) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socket);
    let pending = '';
    c.on('connect', () => { conn = c; send({ op: 'list' }); });
    c.on('data', (d) => {
      pending += d;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        receive(m);
        if (m.op === 'list') resolve();
      }
    });
    c.on('error', (err) => { if (!ready) reject(err); });
    c.on('close', () => { if (ready && !closing) lost(); });
  });
}

// Connects, and resolves once the host has said what is running. Tries for a few seconds, since a
// host the supervisor just started may not be listening yet.
async function connect() {
  let socket = process.env.RELAY_HOST_SOCKET;
  if (!socket) {
    const own = host.launch();
    if (!(await own.ready)) throw new Error('The session host did not start.');
    socket = own.socket;
  }
  for (let tries = 0; ; tries++) {
    try { await attach(socket); return; } catch (e) {
      if (tries >= 50) throw new Error('Could not reach the session host at ' + socket + ': ' + e.message);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

// What a relay drives a session through.
function io(id) {
  return {
    write: (data) => send({ op: 'write', id, data: Buffer.from(data).toString('base64') }),
    resize: (cols, rows) => send({ op: 'resize', id, cols, rows }),
    hangup: () => send({ op: 'hangup', id }),
    kill: (signal) => send({ op: 'kill', id, signal }),
  };
}

// Starts a session in the host. handlers.out (Buffer) gets its output, handlers.exit (code) its end.
// meta comes back with it after a restart. Returns null while there is no host to start it in.
function spawn(opts, handlers) {
  if (!ready || !conn || conn.destroyed) return null;
  sessions.set(opts.id, { handlers });
  send(Object.assign({ op: 'spawn' }, opts));
  return io(opts.id);
}

// A session still running in the host from the last relay, or null. Its output so far is in out.
function peek(id) { return live.get(id) || null; }
function adopt(id, handlers) {
  const s = live.get(id);
  if (!s) return null;
  live.delete(id);
  sessions.set(id, { handlers });
  return { io: io(id), out: Buffer.concat(s.out), meta: s.meta, cols: s.cols, rows: s.rows };
}
// Running sessions nothing took back have no desk, so they end.
function dropUnclaimed(log) {
  for (const [id, s] of live) { log('Ended a session nothing took back after the restart, in ' + ((s.meta && s.meta.cwd) || 'an unknown folder') + '.'); io(id).hangup(); }
  live.clear();
}
const onLost = (fn) => { lost = fn; };
// The relay is stopping. Its sessions run on in the host.
function close() { closing = true; if (conn) conn.end(); }

module.exports = { connect, spawn, peek, adopt, dropUnclaimed, onLost, close, isReady: () => ready && !!conn && !conn.destroyed };
