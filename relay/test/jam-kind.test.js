// T-466: a ticket of kind jam is stuck work, so it is high priority and first in High whoever files it,
// and the relay refuses a lower priority for it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

test('a jam ticket is high priority and first in High, and no one lowers it', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const file = (extra) => R.call('POST', '/tickets', { repo, body: 'Why it is stuck.', ...extra });
  const high = (await file({ title: 'Another high one', priority: 'high' })).body.ticket;
  const jam = await file({ title: 'Flaky test holds five PRs', priority: 'low', kind: 'jam' });
  assert.strictEqual(jam.status, 201, JSON.stringify(jam.body));
  assert.deepStrictEqual([jam.body.ticket.kind, jam.body.ticket.priority], ['jam', 'high'], 'asked low, filed high');
  const order = (await R.call('GET', '/tickets')).body.tickets.map((x) => x.id);
  assert.ok(order.indexOf(jam.body.ticket.id) < order.indexOf(high.id), 'ahead of other high tickets');
  assert.ok((await R.call('GET', '/tickets')).body.kinds.includes('jam'));

  const lower = await R.call('POST', '/tickets/' + jam.body.ticket.id + '/edit', { priority: 'normal' });
  assert.deepStrictEqual([lower.status, lower.body.error], [409, 'jam_priority']);
  assert.strictEqual((await R.call('POST', '/tickets/' + jam.body.ticket.id + '/edit', { priority: 'high', title: 'Flaky test holds six PRs' })).status, 200);

  const plain = (await file({ title: 'A small thing', priority: 'low' })).body.ticket;
  const made = await R.call('POST', '/tickets/' + plain.id + '/edit', { kind: 'jam' });
  assert.strictEqual(made.status, 200, JSON.stringify(made.body));
  assert.deepStrictEqual([made.body.ticket.kind, made.body.ticket.priority], ['jam', 'high'], 'the kind raises it');
  const high2 = (await file({ title: 'Already high', priority: 'high' })).body.ticket;
  const again = (await file({ title: 'High and made a jam', priority: 'high' })).body.ticket;
  assert.strictEqual((await R.call('POST', '/tickets/' + again.id + '/edit', { kind: 'jam' })).status, 200);
  const order2 = (await R.call('GET', '/tickets')).body.tickets.map((x) => x.id);
  assert.ok(order2.indexOf(again.id) < order2.indexOf(high2.id) && order2.indexOf(again.id) < order2.indexOf(high.id), 'a high ticket made a jam goes first in High');
  assert.ok(order2.indexOf(plain.id) < order2.indexOf(high2.id), 'a low ticket made a jam goes first in High too');
});

test('a session files a jam ticket at high priority too, and the PM check puts it ahead', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const s = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const token = await H.until(() => { try { return { 'X-Office-Token': H.sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');
  const r = await R.call('POST', '/tickets', { title: 'Red main', body: 'CI is red on main.', priority: 'low', kind: 'jam' }, token);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.ticket.kind, r.body.ticket.priority], ['jam', 'high']);
  const brief = require('../pm-check-brief.js').checkBrief({ ticket: r.body.ticket, all: [r.body.ticket], rung: 1, cli: '/x/ticket.js', minutes: 5 });
  assert.match(brief, /kind jam .*ahead of other high tickets/);
});
