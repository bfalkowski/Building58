// The relay's side of the session host (relay/session-host.js), which owns the sessions' processes.
// The supervisor names the host's socket in RELAY_HOST_SOCKET. A relay started without one starts a
// host of its own, whose sessions end with this relay.
//
// connect() asks the host what is running. Those sessions wait here, output and all, until
// relay/sessions.js takes each one back with adopt(). The rest are hung up by dropUnclaimed().
//
// The host loads once, but this file reloads with every Update, so the host can be older than this
// relay. Its list reply says which version of the messages it speaks (relay/session-host.js). When that
// is not this relay's, connect() says so in the log, versionGap() tells the Update panel, and a message
// the host's version does not know is not sent.
'use strict';
const net = require('net');
const host = require('./session-host.js');
const liveness = require('./liveness.js');

let conn = null, ready = false, closing = false, hostVersion = null, log = () => {};
const heldBack = new Set();
const sessions = new Map();
const live = new Map();
const jobs = new Map();
let lost = () => {};
liveness.useJobs((id) => jobs.get(id) || null);

const jobOf = (j) => ({ count: Number(j.count) || 0, since: j.since || null, stuck: Array.isArray(j.stuck) ? j.stuck.filter((x) => x && Number.isInteger(x.pid)).map((x) => ({ pid: x.pid, command: String(x.command || ''), since: Number(x.since) || 0 })) : [] });
const knows = (op) => op === 'list' || (host.OPS[op] || Infinity) <= hostVersion;
function send(msg) {
  if (!conn || conn.destroyed) return;
  if (!knows(msg.op)) {
    if (!heldBack.has(msg.op)) { heldBack.add(msg.op); log('The relay did not send ' + msg.op + ' to the session host, which speaks version ' + hostVersion + ' of its messages and does not know it. Stop and start the office to use the new host.'); }
    return;
  }
  conn.write(JSON.stringify(msg) + '\n');
}
const versionGap = () => (hostVersion !== null && hostVersion !== host.VERSION ? { host: hostVersion, relay: host.VERSION } : null);
function gapWords() {
  const gap = versionGap();
  return gap && 'The session host runs version ' + gap.host + ' of its messages, and this relay speaks version ' + gap.relay + '. Stop and start the office to use the new host.';
}

function receive(m) {
  if (m.op === 'list') {
    hostVersion = Number.isInteger(m.version) && m.version > 0 ? m.version : 1;
    for (const s of m.sessions || []) {
      if (s.exited) continue;
      live.set(s.id, { meta: s.meta, cols: s.cols, rows: s.rows, out: [Buffer.from(s.out || '', 'base64')] });
      if (s.jobs) jobs.set(s.id, jobOf(s.jobs));
    }
    ready = true;
    return;
  }
  const mine = sessions.get(m.id), waiting = live.get(m.id);
  if (m.op === 'jobs') { jobs.set(m.id, jobOf(m)); return; }
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

async function connect(logTo) {
  if (logTo) log = logTo;
  let socket = process.env.RELAY_HOST_SOCKET;
  if (!socket) {
    const own = host.launch();
    if (!(await own.ready)) throw new Error('The session host did not start.');
    socket = own.socket;
  }
  for (let tries = 0; ; tries++) {
    try { await attach(socket); if (versionGap()) log(gapWords()); return; } catch (e) {
      if (tries >= 50) throw new Error('Could not reach the session host at ' + socket + ': ' + e.message);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function io(id) {
  return {
    write: (data) => send({ op: 'write', id, data: Buffer.from(data).toString('base64') }),
    resize: (cols, rows) => send({ op: 'resize', id, cols, rows }),
    hangup: () => send({ op: 'hangup', id }),
    kill: (signal) => send({ op: 'kill', id, signal }),
  };
}

function endJob(id, pid) { send({ op: 'end', id, pid }); return knows('end'); }

function spawn(opts, handlers) {
  if (!ready || !conn || conn.destroyed) return null;
  sessions.set(opts.id, { handlers });
  send(Object.assign({ op: 'spawn' }, opts));
  return io(opts.id);
}

function peek(id) { return live.get(id) || null; }
function adopt(id, handlers) {
  const s = live.get(id);
  if (!s) return null;
  live.delete(id);
  sessions.set(id, { handlers });
  return { io: io(id), out: Buffer.concat(s.out), meta: s.meta, cols: s.cols, rows: s.rows };
}
function dropUnclaimed(log) {
  for (const [id, s] of live) { log('Ended a session nothing took back after the restart, in ' + ((s.meta && s.meta.cwd) || 'an unknown folder') + '.'); io(id).hangup(); }
  live.clear();
}
const onLost = (fn) => { lost = fn; };
function close() { closing = true; if (conn) conn.end(); }

module.exports = { connect, endJob, versionGap, gapWords, spawn, peek, adopt, dropUnclaimed, onLost, close, isReady: () => ready && !!conn && !conn.destroyed };
