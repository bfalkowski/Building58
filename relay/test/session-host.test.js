// The session host on its own (relay/session-host.js): a session outlives the connection that started
// it, the next connection gets its output so far and drives it, and the session ends with the host.
'use strict';
const fs = require('fs');
const net = require('net');
const test = require('node:test');
const assert = require('node:assert');
const { launch } = require('../session-host.js');
const { until } = require('./helpers.js');

// A connection to the host, as a relay makes one: lines of JSON each way.
function connect(socket) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socket);
    const got = [];
    let pending = '';
    c.on('data', (d) => { pending += d; const lines = pending.split('\n'); pending = lines.pop(); for (const l of lines) got.push(JSON.parse(l)); });
    c.on('error', reject);
    c.on('connect', () => resolve({
      got,
      send: (m) => c.write(JSON.stringify(m) + '\n'),
      output: (id) => got.filter((m) => m.op === 'out' && m.id === id).map((m) => Buffer.from(m.data, 'base64').toString()).join(''),
      close: () => new Promise((r) => { c.once('close', r); c.end(); }),
    }));
  });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };

test('a session outlives the connection that started it, and ends with the host', async (t) => {
  const host = launch();
  t.after(() => new Promise((r) => host.stop(r)));
  assert.strictEqual(await host.ready, true);
  assert.strictEqual(fs.statSync(require('path').dirname(host.socket)).mode & 0o777, 0o700, 'only you can open its folder');
  assert.strictEqual(fs.statSync(host.socket).mode & 0o777, 0o600);

  const first = await connect(host.socket);
  first.send({ op: 'list' });
  await until(() => first.got.some((m) => m.op === 'list'), 'the list');
  // It prints its pid, then echoes what it is sent.
  first.send({ op: 'spawn', id: 'aaaaaaaaaaaa', cwd: process.cwd(), env: process.env, cmd: ['/bin/sh', '-c', 'echo "pid $$"; exec cat'], cols: 80, rows: 24, meta: { channel: 't', token: 'x' } });
  const pid = Number((await until(() => first.output('aaaaaaaaaaaa').match(/pid (\d+)/), 'the pid'))[1]);
  first.send({ op: 'write', id: 'aaaaaaaaaaaa', data: Buffer.from('one\r').toString('base64') });
  await until(() => /one/.test(first.output('aaaaaaaaaaaa').replace(/pid \d+/, '')), 'the echo');
  await first.close();  // the relay restarts

  await t.test('the next connection gets it running, with its output so far', async () => {
    assert.ok(alive(pid), 'still running');
    const second = await connect(host.socket);
    second.send({ op: 'list' });
    const list = (await until(() => second.got.find((m) => m.op === 'list'), 'the list')).sessions;
    assert.strictEqual(list.length, 1);
    assert.deepStrictEqual([list[0].id, list[0].exited, list[0].meta], ['aaaaaaaaaaaa', false, { channel: 't', token: 'x' }]);
    const before = Buffer.from(list[0].out, 'base64').toString();
    assert.match(before, new RegExp('pid ' + pid)); assert.match(before, /one/);
    second.send({ op: 'write', id: 'aaaaaaaaaaaa', data: Buffer.from('two\r').toString('base64') });
    await until(() => /two/.test(second.output('aaaaaaaaaaaa')), 'it to take keys from the new connection');
    await second.close();
  });
  await t.test('an end with no connection waits for the next list', async () => {
    const third = await connect(host.socket);
    third.send({ op: 'list' });
    await until(() => third.got.some((m) => m.op === 'list'), 'the list');
    third.send({ op: 'spawn', id: 'bbbbbbbbbbbb', cwd: process.cwd(), env: process.env, cmd: ['/bin/sh', '-c', 'sleep 0.5; echo done'], cols: 80, rows: 24, meta: {} });
    await third.close();  // before it ends
    await new Promise((r) => setTimeout(r, 1500));
    const fourth = await connect(host.socket);
    fourth.send({ op: 'list' });
    const list = (await until(() => fourth.got.find((m) => m.op === 'list'), 'the list')).sessions;
    assert.deepStrictEqual(list.map((s) => [s.id, s.exited]).sort(), [['aaaaaaaaaaaa', false], ['bbbbbbbbbbbb', true]]);
    assert.match(Buffer.from(list.find((s) => s.exited).out, 'base64').toString(), /done/, 'with its last output');
    fourth.send({ op: 'list' });
    await until(() => fourth.got.filter((m) => m.op === 'list').length === 2, 'the second list');
    assert.deepStrictEqual(fourth.got.filter((m) => m.op === 'list')[1].sessions.map((s) => s.id), ['aaaaaaaaaaaa'], 'told once');
    await fourth.close();
  });
  await t.test('when whoever started the host stops, its sessions end', async () => {
    await new Promise((r) => host.stop(r));
    await until(() => !alive(pid), 'the session to end', 50);
    assert.ok(!fs.existsSync(host.socket), 'its socket is gone');
  });
});
