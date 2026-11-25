// The manager session's token (relay/token-routes.js, relay/manager-watch.js): it reaches the watch, the brake, the jam log,
// the metrics, filing and noting tickets and the chat board, and gets 403 for anything else. It lowers the trust level one
// step while the person allows it, and has no way to raise it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const GET = 'GET', POST = 'POST';
test('the manager\'s token reaches the watch and the brake, and gets 403 for the rest', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const ticket = (await R.call(POST, '/tickets', { title: 'A', repo })).body.ticket;
  const s = (await R.call(POST, '/terminals', { cwd: repo, role: 'manager', title: 'Manager' })).body;
  const token = { 'X-Office-Token': await H.until(() => { try { return H.sessionToken(s.sessionId); } catch (e) { return null; } }, 'the token') };
  const as = (method, p, body) => R.call(method, p, body, token);

  await t.test('it reads its notes, the jam log and the metrics, and files and notes a ticket', async () => {
    const seen = (await as(GET, '/manager')).body;
    assert.strictEqual(seen.ok, true);
    assert.strictEqual(typeof seen.lowersTrust, 'boolean');
    assert.strictEqual((await as(GET, '/jams')).status, 200);
    assert.strictEqual((await as(GET, '/metrics?range=1d')).status, 200);
    assert.strictEqual((await as(GET, '/tickets')).status, 200);
    assert.strictEqual((await as(GET, '/chat')).status, 200);
    const filed = await as(POST, '/tickets', { title: 'Find why X keeps jamming', body: 'Evidence.', labels: ['manager'] });
    assert.strictEqual(filed.status, 201);
    assert.strictEqual(filed.body.ticket.createdBy, 'Manager');
    assert.deepStrictEqual(filed.body.ticket.labels, ['manager']);
    assert.strictEqual((await as(POST, '/tickets/' + ticket.id + '/note', { text: 'More evidence.' })).status, 200);
  });

  await t.test('anything beyond the watch and the brake is 403, and changes nothing', async () => {
    const before = JSON.stringify((await R.call(GET, '/tickets')).body.tickets.map((x) => [x.id, x.status, x.priority, x.title]));
    const refused = [
      [POST, '/tickets/' + ticket.id + '/start', {}], [POST, '/tickets/' + ticket.id + '/move', { to: 'rejected' }], [POST, '/tickets/' + ticket.id + '/edit', { title: 'B' }],
      [POST, '/tickets/' + ticket.id + '/order', { before: ticket.id }], [POST, '/tickets/' + ticket.id + '/propose', { action: 'close' }], [POST, '/tickets/' + ticket.id + '/proposal', { decision: 'approve' }],
      [POST, '/tasks', {}], [GET, '/tasks'], [GET, '/floor'], [POST, '/floor/stop', { who: 'x' }], [POST, '/settings', { values: { managerLowersTrust: true } }], [GET, '/settings'],
      [POST, '/reviews', { auto: true }], [POST, '/reviews/lead', { pr: 'x' }], [POST, '/autopilot', { on: true }], [POST, '/autopilot/fix', { task: 'x' }], [POST, '/ready', {}],
      [POST, '/jams', { kind: 'other', fix: 'x' }], [POST, '/terminals', { cwd: repo }], [POST, '/rules', { text: 'x' }], [GET, '/needs-you'], [POST, '/manager/raise', {}]
    ];
    for (const [method, p, body] of refused) assert.strictEqual((await as(method, p, body)).status, 403, method + ' ' + p);
    assert.strictEqual(JSON.stringify((await R.call(GET, '/tickets')).body.tickets.map((x) => [x.id, x.status, x.priority, x.title]).filter((x) => x[0] === ticket.id)), JSON.stringify(JSON.parse(before).filter((x) => x[0] === ticket.id)));
  });

  await t.test('another session\'s token cannot lower the trust level or put a note on Needs you', async () => {
    const w = (await R.call(POST, '/terminals', { cwd: repo })).body;
    const other = { 'X-Office-Token': await H.until(() => { try { return H.sessionToken(w.sessionId); } catch (e) { return null; } }, 'the token') };
    assert.strictEqual((await R.call(POST, '/manager/lower', { why: 'x' }, other)).status, 401);
    assert.strictEqual((await R.call(POST, '/manager/note', { text: 'x' }, other)).status, 401);
  });

  await t.test('it lowers the trust level one step while the person allows it, and cannot raise it', async () => {
    const level = async () => (await as(GET, '/manager')).body.level;
    await R.call(POST, '/reviews', { auto: true, again: true });
    assert.strictEqual(await level(), 1);
    const off = await as(POST, '/manager/lower', { why: 'Autopilot hands every task to the person.' });
    assert.strictEqual(off.status, 403, 'off by default');
    assert.match(off.body.message, /Let the manager lower the trust level/);
    assert.strictEqual(await level(), 1);
    await R.call(POST, '/settings', { values: { managerLowersTrust: true } });
    assert.strictEqual((await as(POST, '/manager/lower', {})).status, 400, 'with no reason');
    const down = await as(POST, '/manager/lower', { why: 'Autopilot hands every task to the person.' });
    assert.strictEqual(down.status, 200);
    assert.deepStrictEqual([down.body.from, down.body.to], [1, 0]);
    assert.strictEqual(await level(), 0);
    const again = await as(POST, '/manager/lower', { why: 'Again.' });
    assert.strictEqual(again.status, 409, 'level 0 has no step down');
    assert.strictEqual(await level(), 0, 'nothing raised it');
    const view = (await as(GET, '/manager')).body;
    assert.strictEqual(view.lowered.length, 1);
    assert.strictEqual(view.notes.filter((n) => n.kind === 'brake').length, 1);
    assert.strictEqual((await R.call(GET, '/tasks')).body.tasks.length, 0, 'no ticket or task was touched');
  });

  await t.test('a note goes on Needs you and is replaced by one with the same key', async () => {
    const put = (text) => as(POST, '/manager/note', { text, key: 'stall-1' });
    assert.strictEqual((await put('Autopilot gave 3 tasks in a row to you. Look at Waiting on you.')).status, 200);
    assert.strictEqual((await put('Now it gave 4. Look at Waiting on you.')).status, 200);
    assert.strictEqual((await as(POST, '/manager/note', { text: '  ' })).status, 400);
    const items = (await R.call(GET, '/needs-you')).body.items.filter((i) => i.kind === 'manager-note');
    assert.strictEqual(items.length, 1);
    assert.match(items[0].line, /^The manager saw a stall: Now it gave 4\./);
  });
});
