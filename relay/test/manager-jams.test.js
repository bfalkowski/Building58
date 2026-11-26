// The manager's jam review (relay/manager-jams.js, relay/manager-jams-plan.js): a kind of jam logged three times in a day
// becomes one ticket labelled manager with the jams as evidence, and the next jams of that kind go on that ticket as a note.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');
const plan = require('../manager-jams-plan.js');
const jamsMod = require('../manager-jams.js');

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const jam = (kind, minutesAgo, by) => ({ at: new Date(NOW - minutesAgo * 60000).toISOString(), kind, ticket: null, pr: null, since: null, fix: 'Fixed by hand.', by: by || 'you' });

test('a cause is a kind of jam logged three times in a day, by anyone but Autopilot', () => {
  const list = [jam('flake-blocks', 10), jam('flake-blocks', 600), jam('flake-blocks', 1500), jam('dev-idle', 5), jam('dev-idle', 6), jam('main-red', 1, 'autopilot'), jam('main-red', 2, 'autopilot'), jam('main-red', 3, 'autopilot')];
  assert.deepStrictEqual(plan.bursts(list, NOW).map((b) => [b.kind, b.count]), [], 'two in a day and one a day old is not three');
  list.push(jam('flake-blocks', 20));
  assert.deepStrictEqual(plan.bursts(list, NOW).map((b) => [b.kind, b.count]), [['flake-blocks', 3]]);
});

test('one ticket for a cause: file it, add new jams to it, file again only when its fix is done and the jams come back', () => {
  const burst = plan.bursts([jam('flake-blocks', 10), jam('flake-blocks', 20), jam('flake-blocks', 30)], NOW)[0];
  assert.deepStrictEqual(plan.decide(burst, undefined, undefined, NOW), { act: 'file', earlier: null });
  const cause = { kind: 'flake-blocks', ticket: '9', seen: burst.jams.map((j) => j.at) };
  assert.deepStrictEqual(plan.decide(burst, cause, 'triage', NOW), { act: 'none' });
  const more = plan.bursts([jam('flake-blocks', 1)].concat(burst.jams), NOW)[0];
  assert.strictEqual(plan.decide(more, cause, 'ready', NOW).act, 'add');
  assert.deepStrictEqual(plan.decide(more, cause, 'rejected', NOW), { act: 'none' }, 'the person said no');
  assert.deepStrictEqual(plan.decide(more, cause, 'done', NOW), { act: 'file', earlier: '9' });
  assert.deepStrictEqual(plan.decide(burst, cause, 'done', NOW), { act: 'none' }, 'the same jams after the fix are not news');
  const t = plan.ticketOf(more, 'Flaky test blocks', '9');
  assert.match(t.title, /^Find why "Flaky test blocks" jams keep happening$/);
  assert.match(t.body, /4 jams of the kind/);
  assert.match(t.body, /Ticket 9 was meant to stop this kind of jam/);
});

test('it says whether the jam count went down after the fix merged', () => {
  const cause = { kind: 'flake-blocks', before: 4, fixedAt: NOW - 2 * 24 * 3600000 };
  assert.strictEqual(plan.outcomeOf(cause, [jam('flake-blocks', 60)], NOW).down, true);
  assert.strictEqual(plan.outcomeOf(cause, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => jam('flake-blocks', n * 10)), NOW).down, false);
  assert.strictEqual(plan.outcomeOf({ kind: 'x', before: 3, fixedAt: null }, [], NOW), null);
});

test('with the same jam kind logged three times in a day, the manager files one ticket naming the cause, and adds to it the next time', async (t) => {
  const R = await H.relay({ RELAY_MANAGER_WATCH_SECONDS: '1' });
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  await R.call('POST', '/tickets', { title: 'Something to anchor the repo', repo });
  const mine = async () => (await R.call('GET', '/tickets')).body.tickets.filter((x) => (x.labels || []).includes('manager'));
  const log = (kind) => R.call('POST', '/jams', { kind, fix: 'Reran the check by hand.' });
  await log('flake-blocks'); await log('flake-blocks');
  await H.until(async () => (await R.call('GET', '/manager')).body.looks >= 2, 'two looks');
  assert.strictEqual((await mine()).length, 0, 'two is not a pattern');
  await log('flake-blocks');
  const [filed] = await H.until(async () => { const l = await mine(); return l.length && l; }, 'the manager\'s ticket');
  assert.strictEqual(filed.status, 'triage');
  assert.strictEqual(filed.createdBy, 'Manager');
  assert.match(filed.title, /Find why "Flaky test blocks" jams keep happening/);
  assert.strictEqual((filed.body.match(/Reran the check by hand/g) || []).length, 3, 'the three jams are the evidence');
  await H.until(async () => (await R.call('GET', '/manager')).body.looks >= 4, 'more looks');
  assert.strictEqual((await mine()).length, 1, 'one ticket while nothing is new');
  assert.deepStrictEqual((await R.call('GET', '/tickets/' + filed.id)).body.ticket.notes, []);

  await log('flake-blocks');
  const noted = await H.until(async () => { const n = (await R.call('GET', '/tickets/' + filed.id)).body.ticket.notes; return n.length && n; }, 'a note on it');
  assert.match(noted[0].text, /1 more "Flaky test blocks" jam since/);
  assert.strictEqual(noted[0].by, 'Manager');
  assert.strictEqual((await mine()).length, 1, 'no second ticket');
  const chat = (await R.call('GET', '/chat/office')).body;
  assert.match(JSON.stringify(chat), /Filed ticket/);
  assert.strictEqual((await R.call('GET', '/tasks')).body.tasks.length, 0, 'nothing was started');
});

test('the daily text lists causes that have an open ticket, leaves out fixed ones, and keeps the instruction first', () => {
  const kinds = [['stall', 4]];
  const none = jamsMod.dailyText(kinds, []);
  assert.match(none, /Causes that already have a ticket: none\./);
  assert.match(none, /^Daily jam review\. File one ticket for each cause with no ticket/);
  const text = jamsMod.dailyText(kinds, [{ kind: 'stall', ticket: 77 }, { kind: 'lint', ticket: 78, fixedAt: NOW }]);
  assert.match(text, /stall.* is ticket 77/);
  assert.doesNotMatch(text, /ticket 78/);
});
