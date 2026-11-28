// The PM's seat (relay/pm-seat.js): the room keeps one PM running and starts it again when it ends, and
// workers have six of the nine desks, because the Lead, the PM and the manager keep three (relay/terminal.js).
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
const pms = async (R) => (await roomCall(R, 'GET', '/terminals')).body.terminals.filter((x) => x.running && x.role === 'pm' && x.standing);

test('the room keeps a PM running, and starts it again when it ends', async (t) => {
  const R = await relay({ RELAY_PM_SEAT: '1', RELAY_PM_SEAT_RETRY_MS: '100' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const [first] = await until(async () => { const l = await pms(R); return l.length && l; }, 'a PM');
  assert.strictEqual((await pms(R)).length, 1, 'one PM');
  await roomCall(R, 'POST', '/terminals/' + first.id + '/stop');
  const [second] = await until(async () => { const l = await pms(R); return l.length && l[0].id !== first.id && l; }, 'a new PM');
  assert.notStrictEqual(second.sessionId, first.sessionId);
  assert.strictEqual((await pms(R)).length, 1, 'still one PM');
});

test('workers have at most 6 desks, and the Lead and the PM can still sit', async (t) => {
  const R = await relay({ RELAY_PM_SEAT: '1' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  await until(async () => (await pms(R)).length, 'a PM');
  for (let i = 0; i < 6; i++) assert.strictEqual((await roomCall(R, 'POST', '/terminals', { cwd: repo })).status, 201, 'worker ' + (i + 1));
  const full = await roomCall(R, 'POST', '/terminals', { cwd: repo });
  assert.strictEqual(full.status, 409);
  assert.match(full.body.message, /All 6 worker desks are taken\. The other 3 are kept for the Lead, the PM and the manager/);
  const all = (await roomCall(R, 'GET', '/terminals')).body.terminals.filter((x) => x.running);
  assert.strictEqual(all.length, 7, '6 workers and the PM');
});
