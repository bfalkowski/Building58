// The manager's seat (relay/manager-seat.js): the room keeps one manager session running and starts it again
// when it ends, and workers have six of the nine desks, because the Lead, the PM and the manager keep three.
'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until } = require('./helpers.js');

const CHANNEL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'office', 'world.json'), 'utf8')).channel;
const roomCall = async (R, method, p, body) => {
  const r = await fetch('http://127.0.0.1:' + R.port + '/channels/' + CHANNEL + p, { method, headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  return { status: r.status, body: await r.json() };
};
const managers = async (R) => (await roomCall(R, 'GET', '/terminals')).body.terminals.filter((x) => x.running && x.role === 'manager');

test('the room keeps a manager running, and starts it again when it ends', async (t) => {
  const R = await relay({ RELAY_MANAGER_SEAT: '1', RELAY_MANAGER_SEAT_RETRY_MS: '100' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const [first] = await until(async () => { const l = await managers(R); return l.length && l; }, 'a manager');
  assert.strictEqual((await managers(R)).length, 1, 'one manager');
  const floor = (await roomCall(R, 'GET', '/floor')).body;
  assert.strictEqual(floor.sessions.find((s) => s.terminal === first.id).seat, 'manager');
  await roomCall(R, 'POST', '/terminals/' + first.id + '/stop');
  const [second] = await until(async () => { const l = await managers(R); return l.length && l[0].id !== first.id && l; }, 'a new manager');
  assert.notStrictEqual(second.sessionId, first.sessionId);
  assert.strictEqual((await managers(R)).length, 1, 'still one manager');
});

test('workers have at most 6 desks, and the Lead, the PM and the manager can still sit', async (t) => {
  const R = await relay({ RELAY_MANAGER_SEAT: '1', RELAY_PM_SEAT: '1' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  await until(async () => (await managers(R)).length, 'a manager');
  await until(async () => (await roomCall(R, 'GET', '/terminals')).body.terminals.some((x) => x.running && x.role === 'pm'), 'a PM');
  for (let i = 0; i < 6; i++) assert.strictEqual((await roomCall(R, 'POST', '/terminals', { cwd: repo })).status, 201, 'worker ' + (i + 1));
  const full = await roomCall(R, 'POST', '/terminals', { cwd: repo });
  assert.strictEqual(full.status, 409);
  assert.match(full.body.message, /All 6 worker desks are taken\. The other 3 are kept for the Lead, the PM and the manager/);
  const all = (await roomCall(R, 'GET', '/terminals')).body.terminals.filter((x) => x.running);
  assert.strictEqual(all.length, 8, '6 workers, the PM and the manager');
});
