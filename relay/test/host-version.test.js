// The session host loads once and runs until a full stop, while the relay reloads with every Update
// (T-172). So a new relay can find an older host. A fake host here answers the list as a host from
// before T-172 does, with no version, and the relay says so in its log and on the Update panel, and
// sends it only messages it knows.
'use strict';
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const host = require('../session-host.js');
const { relay, until } = require('./helpers.js');

function fakeHost(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-old-host-'));
  fs.chmodSync(dir, 0o700);
  const socket = path.join(dir, 'host.sock');
  const got = [];
  const server = net.createServer((c) => {
    let pending = '';
    c.on('error', () => {});
    c.on('data', (d) => {
      pending += d;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        const m = JSON.parse(line);
        got.push(m);
        if (m.op === 'list') c.write(JSON.stringify(Object.assign({ op: 'list', sessions: [] }, version ? { version } : {})) + '\n');
      }
    });
  });
  const listening = new Promise((r) => server.listen(socket, r));
  const stop = () => new Promise((r) => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); }));
  return { socket, got, listening, stop };
}

test('the host says which version of its messages it speaks', () => {
  assert.ok(Number.isInteger(host.VERSION) && host.VERSION > 1, 'a host from before T-172 says no version, and counts as 1');
  for (const [op, since] of Object.entries(host.OPS)) assert.ok(since >= 1 && since <= host.VERSION, op + ' came in a version the host has');
});

test('a relay that finds an older host says so in its log and on the Update panel', async (t) => {
  const old = fakeHost(null);
  await old.listening;
  const R = await relay({ RELAY_WORKER: '1', RELAY_HOST_SOCKET: old.socket });  // no supervisor, which would start a host of its own
  t.after(async () => { await R.stop(); await old.stop(); });
  const words = 'The session host runs version 1 of its messages, and this relay speaks version ' + host.VERSION + '. Stop and start the office to use the new host.';
  await until(() => R.output().includes(words), 'the log to say so');
  const u = (await R.call('GET', '/update')).body;
  assert.strictEqual(u.host, words, 'the Update panel says so');
});

test('a relay sends an older host only the messages it knows', async (t) => {
  const old = fakeHost(1);
  await old.listening;
  const before = process.env.RELAY_HOST_SOCKET;
  process.env.RELAY_HOST_SOCKET = old.socket;
  const link = require('../host-link.js');
  const ops = host.OPS || {}, resize = ops.resize;
  t.after(async () => {
    ops.resize = resize;
    if (before === undefined) delete process.env.RELAY_HOST_SOCKET; else process.env.RELAY_HOST_SOCKET = before;
    link.close(); await old.stop();
  });
  assert.ok(host.OPS, 'the host lists the version each message came in');
  ops.resize = host.VERSION;  // stands for a message that came after version 1
  const said = [];
  await link.connect((line) => said.push(line));
  assert.deepStrictEqual(link.versionGap(), { host: 1, relay: host.VERSION });
  assert.ok(said.some((l) => /version 1 of its messages/.test(l)), 'it says so: ' + said.join(' | '));
  const io = link.spawn({ id: 'aaaaaaaaaaaa', cwd: process.cwd(), env: {}, cmd: ['true'], cols: 80, rows: 24, meta: {} }, { out: () => {}, exit: () => {} });
  io.resize(100, 30);
  io.write('hi');
  await until(() => old.got.some((m) => m.op === 'write'), 'the write');
  assert.deepStrictEqual(old.got.map((m) => m.op), ['list', 'spawn', 'write'], 'no resize, which version 1 does not know');
  assert.ok(said.some((l) => /did not send resize/.test(l)), 'it says what it held back: ' + said.join(' | '));
});
