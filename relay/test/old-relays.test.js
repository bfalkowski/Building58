'use strict';
// Other relays on one state folder (relay/old-relays.js), with real relays. On 2026-11-19 ps showed a relay
// from 2026-11-12 that was paused with Ctrl+Z after its worker was killed: its supervisor and session host
// still ran, with a Claude Code session in it. A new relay on the same port and folder stops such a copy,
// and names one on another port in Needs you, with a Stop button that stops it.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const { relay, until } = require('./helpers.js');

const alive = (pid) => { try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; } try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z'); } catch (e) { return false; } };
const childrenOf = (pid) => execFileSync('ps', ['axo', 'pid=,ppid=,command=']).toString().split('\n')
  .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m) => m && Number(m[2]) === pid).map((m) => ({ pid: Number(m[1]), command: m[3] }));

test('an old copy of this relay is stopped at start, and another relay on the folder waits for the person', async (t) => {
  const old = await relay();
  t.after(async () => { await old.remove(); });
  const supervisor = old.child.pid;
  const kids = childrenOf(supervisor);
  const worker = kids.find((k) => /relay\/server\.js/.test(k.command)).pid, host = kids.find((k) => /session-host\.js/.test(k.command)).pid;

  process.kill(supervisor, 'SIGSTOP');
  process.kill(worker, 'SIGKILL');
  await until(() => !alive(worker), 'the old worker to end, a zombie while its paused supervisor cannot reap it');
  assert.ok(alive(supervisor) && alive(host), 'the paused supervisor and its host stay, as on 2026-11-12');

  const now = await relay({}, old.home, { port: old.port });
  t.after(async () => { await now.kill(); });
  await until(() => !alive(supervisor) && !alive(host), 'the old copy and its host to stop', 300);
  assert.match(now.output(), /Stopping an old copy of this relay that still runs \(pid \d+/);
  assert.deepStrictEqual((await now.call('GET', '/old-relays')).body.relays, [], 'a stopped copy is not named');

  const other = await relay({}, old.home);
  t.after(async () => { await other.kill(); });
  const listed = (await other.call('GET', '/old-relays')).body.relays;
  assert.deepStrictEqual(listed.map((r) => [r.pid, r.port, r.worker, r.paused]), [[now.child.pid, now.port, true, false]]);
  assert.ok(alive(now.child.pid), 'a relay on another port is only named');

  const items = (await other.call('GET', '/needs-you')).body.items;
  assert.strictEqual(items[0].kind, 'relay');
  assert.deepStrictEqual(items[0].link, { stop: now.child.pid });
  assert.match(items[0].line, new RegExp('^Stop the other relay, pid ' + now.child.pid + ': it runs \\S+relay/server\\.js on port ' + now.port + ' since '));

  const nobody = await fetch(other.base + '/old-relays/' + now.child.pid + '/stop', { method: 'POST', headers: { Authorization: 'Bearer test-key', Origin: 'https://evil.example' } });
  assert.strictEqual(nobody.status, 403, 'only the room page on this computer stops a relay');
  assert.strictEqual((await other.call('POST', '/old-relays/1/stop')).status, 404, 'a pid that is not on the list is refused');
  assert.ok(alive(now.child.pid));

  const stopped = await other.call('POST', '/old-relays/' + now.child.pid + '/stop');
  assert.deepStrictEqual(stopped.body, { ok: true, stopped: now.child.pid });
  await until(() => now.child.exitCode !== null || now.child.signalCode, 'the other relay to stop');
  assert.deepStrictEqual((await other.call('GET', '/needs-you')).body.items, []);
});
