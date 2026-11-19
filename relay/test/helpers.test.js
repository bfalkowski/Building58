// The test helpers themselves, where a busy machine once broke them (T-154, T-220), or a slow session host (T-228).
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay } = require('./helpers.js');

// The relay closes a kept-alive connection after 5 idle seconds. A test that blocks for longer, as a few
// execFileSync calls do on a busy machine, cannot see that close, and its next request used to fail
// with "fetch failed" (ECONNRESET). In tickets.test.js the child was ticket.js, and the reset request
// was the test's own next call, not the child's: the child opens a new connection (T-220).
test('a request after the test was blocked longer than the relay keeps a connection still gets its answer', async (t) => {
  const R = await relay(); t.after(R.stop);
  assert.strictEqual((await R.call('GET', '/terminals')).status, 200);
  execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 6000)']);
  assert.strictEqual((await R.call('GET', '/terminals')).status, 200);
});

// The relay prints "Relay on" and answers /health before it has connected to the session host, and until
// then it refuses a new session with 503 no_host. A test that started a session at once after a restart
// got that refusal (T-228). So relay() waits until the relay has taken its sessions back, which it does
// only once the host has answered. This host holds its answer for 1.5 seconds.
function slowHost(ms) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-slow-host-'));
  fs.chmodSync(dir, 0o700);
  const socket = path.join(dir, 'host.sock');
  const timers = new Set();
  const server = net.createServer((c) => {
    let pending = '';
    c.on('error', () => {});
    c.on('data', (d) => {
      pending += d;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        if (JSON.parse(line).op !== 'list') continue;
        const t = setTimeout(() => { timers.delete(t); if (!c.destroyed) c.write(JSON.stringify({ op: 'list', version: require('../session-host.js').VERSION, sessions: [] }) + '\n'); }, ms);
        timers.add(t);
      }
    });
  });
  const listening = new Promise((r) => server.listen(socket, r));
  const stop = () => new Promise((r) => { for (const t of timers) clearTimeout(t); server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); }); });
  return { socket, listening, stop };
}
test('a relay is ready only once its session host has answered, so a session can start at once', async (t) => {
  const host = slowHost(1500);
  await host.listening;
  const R = await relay({ RELAY_WORKER: '1', RELAY_HOST_SOCKET: host.socket });
  t.after(async () => { await R.stop(); await host.stop(); });
  const r = await R.call('POST', '/terminals', { cwd: R.home });
  assert.strictEqual(r.status, 201, 'not ' + r.body.error + ': ' + r.body.message);
});
