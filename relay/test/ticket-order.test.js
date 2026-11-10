// The ticket list's order (T-42): open tickets high, normal, low, oldest first within each, then the
// done and rejected ones, the latest first. The order is worked out each time, so closing a ticket
// writes only that ticket.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');
const { boardOrder } = require('../ticket-order.js');

test('the ticket list comes back in Board order, and ticket.js list prints it with priorities', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const file = async (title, priority) => (await R.call('POST', '/tickets', { title, repo, priority })).body.ticket.id;
  const ids = {};
  for (const [title, priority] of [['Normal one', 'normal'], ['High one', 'high'], ['Low one', 'low'], ['Normal two', 'normal'], ['High two', 'high'], ['Gets done', 'high'], ['Gets rejected', 'high'], ['Low two', 'low']]) {
    ids[title] = await file(title, priority);
    await H.sleep(5);  // each one later than the last
  }
  const before = (await R.call('GET', '/tickets')).body.tickets;
  assert.strictEqual((await R.call('POST', '/tickets/' + ids['Gets rejected'] + '/move', { to: 'rejected' })).status, 200);
  await H.sleep(5);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids['Gets done'] + '/move', { to: 'done', pr: 'https://github.com/o/r/pull/9' })).status, 200);

  const list = (await R.call('GET', '/tickets')).body.tickets;
  assert.deepStrictEqual(list.map((x) => x.title), ['High one', 'High two', 'Normal one', 'Normal two', 'Low one', 'Low two', 'Gets done', 'Gets rejected']);

  // Closing two tickets wrote only those two: every other ticket is as it was.
  const same = (x) => [x.id, x.status, x.priority, x.updatedAt];
  const closed = [ids['Gets done'], ids['Gets rejected']];
  assert.deepStrictEqual(list.filter((x) => !closed.includes(x.id)).map(same).sort(), before.filter((x) => !closed.includes(x.id)).map(same).sort());

  const worker = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const token = await H.until(() => { try { return H.sessionToken(worker.sessionId); } catch (e) { return null; } }, 'the session');
  const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: token };
  const lines = execFileSync('node', [path.join(H.ROOT, 'relay', 'ticket.js'), 'list'], { env, encoding: 'utf8' }).trim().split('\n');
  assert.deepStrictEqual(lines.map((l) => l.split(/ {2}/).slice(1, 4)), [
    ['ready', 'high', 'High one'], ['ready', 'high', 'High two'], ['ready', 'normal', 'Normal one'], ['ready', 'normal', 'Normal two'],
    ['ready', 'low', 'Low one'], ['ready', 'low', 'Low two'], ['done', 'high', 'Gets done'], ['rejected', 'high', 'Gets rejected']]);
});

test('Board order keeps tickets saved before it: no priority counts as normal, no time keeps the store order', () => {
  const list = [
    { id: 'A', status: 'ready' },
    { id: 'B', status: 'started', priority: 'high', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'C', status: 'triage', priority: 'normal' },
    { id: 'D', status: 'done', priority: 'high', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'E', status: 'ready', priority: 'high', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'F', status: 'rejected', priority: 'low', updatedAt: '2026-01-03T00:00:00.000Z' },
  ];
  assert.deepStrictEqual(boardOrder(list).map((x) => x.id), ['E', 'B', 'A', 'C', 'F', 'D']);
  assert.deepStrictEqual(list.map((x) => x.id), ['A', 'B', 'C', 'D', 'E', 'F'], 'the list it was given is not changed');
});

// T-43: the person sets a ticket's priority and its place in the work order.
const { placeNear, groupOf } = require('../ticket-order.js');

test('the person changes a priority and the work order, and a session cannot', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const ids = {};
  for (const [title, priority] of [['A', 'high'], ['B', 'high'], ['C', 'normal'], ['D', 'normal'], ['E', 'normal'], ['F', 'low']]) {
    ids[title] = (await R.call('POST', '/tickets', { title, repo, priority })).body.ticket.id;
    await H.sleep(5);
  }
  const titles = async () => (await R.call('GET', '/tickets')).body.tickets.map((x) => x.title);
  assert.deepStrictEqual(await titles(), ['A', 'B', 'C', 'D', 'E', 'F']);

  // A new priority puts the ticket last in that group.
  const p = await R.call('POST', '/tickets/' + ids.A + '/priority', { priority: 'normal' });
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.body.ticket.priority, 'normal');
  assert.deepStrictEqual(await titles(), ['B', 'C', 'D', 'E', 'A', 'F']);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.F + '/priority', { priority: 'high' })).status, 200);
  assert.deepStrictEqual(await titles(), ['B', 'F', 'C', 'D', 'E', 'A']);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.F + '/priority', { priority: 'urgent' })).status, 400);

  // A place above or below another ticket with the same priority.
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.E + '/order', { before: ids.C })).status, 200);
  assert.deepStrictEqual(await titles(), ['B', 'F', 'E', 'C', 'D', 'A']);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.E + '/order', { after: ids.D })).status, 200);
  assert.deepStrictEqual(await titles(), ['B', 'F', 'C', 'D', 'E', 'A']);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.F + '/order', { before: ids.B })).status, 200);
  assert.deepStrictEqual(await titles(), ['F', 'B', 'C', 'D', 'E', 'A']);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.C + '/order', { before: ids.B })).status, 409, 'another priority');
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.C + '/order', { before: 'T-999' })).status, 400);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.C + '/order', {})).status, 400);

  // A new ticket goes last in its priority, after one moved there.
  ids.G = (await R.call('POST', '/tickets', { title: 'G', repo, priority: 'high' })).body.ticket.id;
  assert.deepStrictEqual(await titles(), ['F', 'B', 'G', 'C', 'D', 'E', 'A']);

  // Closing a ticket leaves the order of the rest the same, and writes none of them.
  const before = (await R.call('GET', '/tickets')).body.tickets;
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.D + '/move', { to: 'rejected' })).status, 200);
  const after = (await R.call('GET', '/tickets')).body.tickets;
  const open = (list) => list.filter((x) => x.id !== ids.D);
  assert.deepStrictEqual(open(after).map((x) => [x.id, x.rank, x.updatedAt]), open(before).map((x) => [x.id, x.rank, x.updatedAt]));
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.D + '/priority', { priority: 'high' })).status, 409, 'a rejected ticket');
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.C + '/order', { before: ids.D })).status, 409, 'next to a rejected ticket');

  // A session's token gets 403, and nothing changes.
  const worker = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const token = await H.until(() => { try { return H.sessionToken(worker.sessionId); } catch (e) { return null; } }, 'the session');
  const agent = { 'X-Office-Token': token };
  const shown = await titles();
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.C + '/priority', { priority: 'high' }, agent)).status, 403);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.E + '/order', { before: ids.C }, agent)).status, 403);
  assert.deepStrictEqual(await titles(), shown);
});

test('tickets saved before ranks still load, sort as before, and can be moved', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
  const repo = H.makeRepo(home);
  const old = (id, priority, at) => ({ id, title: 'Old ' + id, body: '', priority, repo, base: 'main', blockedBy: [], status: 'ready', createdBy: 'you', approvedBy: 'you', createdAt: at, updatedAt: at });
  fs.mkdirSync(path.join(home, '.office-world'), { recursive: true });
  fs.writeFileSync(path.join(home, '.office-world', 'tickets.json'), JSON.stringify({ t: { next: 4, tickets: [
    old('T-1', 'normal', '2026-01-03T00:00:00.000Z'), old('T-2', 'high', '2026-01-02T00:00:00.000Z'), old('T-3', 'normal', '2026-01-01T00:00:00.000Z')] } }));
  const R = await H.relay({}, home);
  t.after(async () => { await R.stop(); await R.remove(); });
  const ids = async () => (await R.call('GET', '/tickets')).body.tickets.map((x) => x.id);
  assert.deepStrictEqual(await ids(), ['T-2', 'T-3', 'T-1']);
  const filed = (await R.call('POST', '/tickets', { title: 'New', repo, priority: 'normal' })).body.ticket;
  assert.strictEqual(typeof filed.rank, 'number');
  assert.deepStrictEqual(await ids(), ['T-2', 'T-3', 'T-1', filed.id]);
  assert.strictEqual((await R.call('POST', '/tickets/T-1/order', { before: 'T-3' })).status, 200);
  assert.deepStrictEqual(await ids(), ['T-2', 'T-1', 'T-3', filed.id]);
});

test('a place with no room left numbers the group again, in its new order', () => {
  const list = [
    { id: 'A', status: 'ready', priority: 'normal', rank: 1 },
    { id: 'B', status: 'ready', priority: 'normal', rank: 1 + Number.EPSILON },
    { id: 'C', status: 'triage', priority: 'normal', rank: 5 },
    { id: 'H', status: 'ready', priority: 'high', rank: 0 },
  ];
  const writes = placeNear(list, list[2], list[1], false);  // C before B: there is no number between A and B
  assert.ok(writes.length > 1);
  const ranks = new Map(writes);
  const next = list.map((x) => (ranks.has(x.id) ? { ...x, rank: ranks.get(x.id) } : x));
  assert.deepStrictEqual(groupOf(next, 'normal').map((x) => x.id), ['A', 'C', 'B']);
  assert.ok(!ranks.has('H'), 'another priority is not written');
  assert.deepStrictEqual(placeNear(list, list[0], list[2], true), [['A', 5 + 1000]], 'room after the last: one write');
});

test('a renumber that fails partway puts back what it wrote, and Started tickets are not in the work order', async (t) => {
  const R = await H.relay({ RELAY_TICKET_STORE: path.join(__dirname, 'failing-store.js') });
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const file = async (title) => (await R.call('POST', '/tickets', { title, repo, priority: 'normal' })).body.ticket.id;
  const A = await file('A'), B = await file('B');
  await file('X no-rank');  // last, and its rank cannot be written
  const ranks = async () => (await R.call('GET', '/tickets')).body.tickets.map((x) => [x.id, x.rank]);
  // Each move puts A or B just before X, halving the room there, until there is none and the group
  // is numbered again. That writes A and B first, then fails on X, which is last.
  let last, before;
  for (let i = 0; i < 80; i++) {
    before = await ranks();
    last = await R.call('POST', '/tickets/' + (i % 2 ? B : A) + '/order', { after: i % 2 ? A : B });
    if (last.status !== 200) break;
  }
  assert.strictEqual(last.status, 502, 'a renumber was reached and failed');
  assert.match(last.body.message, /The order is as it was before the move/);
  assert.deepStrictEqual(await ranks(), before, 'the ranks are the ones from before the move');

  // A Started ticket is not a place to move next to.
  const S = await file('S');
  assert.strictEqual((await R.call('POST', '/tickets/' + S + '/start', {})).status, 200);
  const refused = await R.call('POST', '/tickets/' + A + '/order', { before: S });
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.body.error, 'not_ordered');
});

test('a renumber writes only the tickets that movable lets through', () => {
  const list = [
    { id: 'A', status: 'ready', priority: 'normal', rank: 1 },
    { id: 'S', status: 'started', priority: 'normal', rank: 1 + Number.EPSILON / 2 },
    { id: 'B', status: 'ready', priority: 'normal', rank: 1 + Number.EPSILON },
    { id: 'C', status: 'triage', priority: 'normal', rank: 5 },
  ];
  const movable = (x) => x.status === 'triage' || x.status === 'ready';
  const writes = placeNear(list, list[3], list[2], false, movable);
  assert.ok(writes.length > 1, 'a renumber');
  assert.ok(!writes.some(([id]) => id === 'S'), 'the Started ticket keeps its rank');
});
