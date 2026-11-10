// The session host: owns each session's pty-bridge.py and the claude in it, so a relay restart does not
// touch them. The supervisor (relay/supervisor.js) starts it once, and the relay connects to it over a
// local socket (relay/host-link.js). When the relay restarts, the new one connects, gets each session's
// output so far, and carries on with the same processes.
//
// It lives as long as whoever started it: when its stdin closes, it ends every session and stops. So
// stopping the relay for good still ends the sessions, and the next start brings them back with
// claude --resume (relay/sessions.js).
//
// It loads once and runs until you stop the relay, so a change here or in pty-bridge.py needs a stop
// and start by hand. Keep it small: it knows nothing of the room, only processes and bytes.
//
// The socket is in a folder only you can open, and one connection is served at a time: a new one
// replaces the last. Each message is one line of JSON.
//   to the host:   { op: 'list' }, { op: 'spawn', id, cwd, env, cmd, cols, rows, meta },
//                  { op: 'write', id, data (base64) }, { op: 'resize', id, cols, rows },
//                  { op: 'hangup', id }, { op: 'kill', id, signal }
//   from the host: { op: 'list', sessions: [{ id, meta, cols, rows, exited, code, out (base64), jobs }] },
//                  { op: 'out', id, data (base64) }, { op: 'exit', id, code },
//                  { op: 'jobs', id, count, since }  when the commands its claude started and that still
//                  run change (relay/jobs.js). jobs in the list is the last of these, or null.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const jobs = require('./jobs.js');

const KEEP = 256 * 1024;  // output kept for a relay that connects later
const BRIDGE = path.join(__dirname, 'pty-bridge.py');
const ENDING = 3000;  // how long the sessions get to end before they are killed

function serve(socket) {
  const sessions = new Map();
  let client = null;
  const send = (msg) => { if (client && !client.destroyed) client.write(JSON.stringify(msg) + '\n'); };

  function start(m) {
    if (sessions.has(m.id)) return;
    const child = spawn('python3', [BRIDGE, String(m.cols), String(m.rows)].concat(m.cmd), { cwd: m.cwd, env: m.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const s = { id: m.id, meta: m.meta, cols: m.cols, rows: m.rows, child, out: [], outSize: 0, exited: false, code: null };
    sessions.set(m.id, s);
    const out = (buf) => {
      s.out.push(buf); s.outSize += buf.length;
      while (s.outSize > KEEP && s.out.length > 1) s.outSize -= s.out.shift().length;
      send({ op: 'out', id: s.id, data: buf.toString('base64') });
    };
    // A bridge can die at any moment. Without these, a late write ends the host.
    child.stdin.on('error', () => {});
    child.stdio[3].on('error', () => {});
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    child.on('error', (err) => out(Buffer.from('\r\nCould not start the terminal: ' + (err.code === 'ENOENT' ? 'python3 was not found.' : err.message) + '\r\n')));
    // close, not exit: all its output has come by then.
    child.on('close', (code) => {
      s.exited = true; s.code = code;
      // With no relay to tell, the end waits for the next one's list.
      if (client && !client.destroyed) { send({ op: 'exit', id: s.id, code }); sessions.delete(s.id); }
    });
  }

  function handle(m) {
    const s = sessions.get(m.id);
    if (m.op === 'list') {
      send({ op: 'list', sessions: [...sessions.values()].map((x) => ({ id: x.id, meta: x.meta, cols: x.cols, rows: x.rows, exited: x.exited, code: x.code, out: Buffer.concat(x.out).toString('base64'), jobs: x.jobs || null })) });
      for (const x of sessions.values()) if (x.exited) sessions.delete(x.id);
    } else if (m.op === 'spawn') start(m);
    else if (!s || s.exited) return;
    else if (m.op === 'write') s.child.stdin.write(Buffer.from(String(m.data), 'base64'));
    else if (m.op === 'resize') { s.cols = m.cols; s.rows = m.rows; s.child.stdio[3].write(m.cols + ' ' + m.rows + '\n'); }
    else if (m.op === 'hangup') s.child.stdin.end();
    else if (m.op === 'kill') { try { s.child.kill(m.signal || 'SIGTERM'); } catch (e) { /* gone */ } }
  }

  // Every few seconds, which commands each session's claude started still run.
  jobs.watch(() => [...sessions.values()].filter((s) => !s.exited), (s, j) => { s.jobs = j; send({ op: 'jobs', id: s.id, count: j.count, since: j.since }); });

  const server = net.createServer((conn) => {
    if (client) client.destroy();
    client = conn;
    let pending = '';
    conn.on('data', (d) => {
      pending += d;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) { let m; try { m = JSON.parse(line); } catch (e) { continue; } if (m && typeof m === 'object') handle(m); }
    });
    conn.on('error', () => {});
    conn.on('close', () => { if (client === conn) client = null; });
  });
  server.listen(socket, () => { fs.chmodSync(socket, 0o600); process.stdout.write('ready\n'); });

  // Whoever started it is gone or asks it to stop: the sessions end, then the host.
  let ending = false;
  function end() {
    if (ending) return;
    ending = true;
    server.close();
    const left = () => [...sessions.values()].filter((s) => !s.exited);
    for (const s of left()) { try { s.child.kill('SIGTERM'); } catch (e) { /* gone */ } }  // the bridge hangs up its claude
    const started = Date.now();
    const timer = setInterval(() => {
      if (left().length && Date.now() - started < ENDING) return;
      for (const s of left()) { try { s.child.kill('SIGKILL'); } catch (e) { /* gone */ } }
      clearInterval(timer);
      try { fs.rmSync(path.dirname(socket), { recursive: true, force: true }); } catch (e) { /* gone */ }
      process.exit(0);
    }, 50);
  }
  process.stdin.on('end', end); process.stdin.on('error', end); process.stdin.resume();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, end);
}

// Starts a host as a child of this process, with its socket in a new folder only you can open.
// stop() ends it and its sessions, and calls back once it has gone.
function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-host-'));
  const socket = path.join(dir, 'host.sock');
  // Its own process group, so Ctrl+C reaches the relay first, and the relay can save its sessions.
  const child = spawn(process.execPath, [__filename, socket], { stdio: ['pipe', 'pipe', 'inherit'], detached: true });
  child.stdin.on('error', () => {});
  const ready = new Promise((resolve) => {
    child.stdout.once('data', () => resolve(true));
    child.once('exit', () => resolve(false));
  });
  const stop = (done) => {
    if (child.exitCode !== null || child.signalCode) { done(); return; }
    child.once('exit', () => done());
    child.stdin.end();
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, ENDING + 2000).unref();
  };
  return { socket, child, ready, stop };
}

if (require.main === module) serve(process.argv[2]);

module.exports = { launch };
