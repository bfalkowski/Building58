// T-465: Let the Lead unstick the board. Off by default, the Lead only reports. On, it merges the duplicate tickets
// of a failure, sets the one left high and first and starts it, writes the jam log, and an item it names on three
// passes in a row with no action goes on Needs you (relay/failures.js, relay/lead-stuck.js, relay/tickets.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sessionToken } = require('./helpers.js');

const PR = (n) => 'https://github.com/acme/widgets/pull/' + n;
const tokenOf = (s) => until(() => { try { return { 'X-Office-Token': sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');

test('the rung is in Settings, off by default, and in the Lead\'s brief only while it is on', async (t) => {
  const { leadBrief, UNSTICK } = require('../lead-brief.js');
  const off = leadBrief('/r/relay', {}), on = leadBrief('/r/relay', { unstick: true });
  assert.strictEqual(on.replace(UNSTICK, ''), off, 'the rung adds its line and changes nothing else');
  assert.ok(!/ticket\.js stuck/.test(off));
  assert.match(UNSTICK, /look for stuck work first/);
  const R = await relay();
  t.after(R.stop);
  const s = (await R.call('GET', '/settings')).body.settings.find((x) => x.name === 'leadUnstick');
  assert.deepStrictEqual([s.group, s.label, s.kind, s.value, s.def], ['The Lead', 'Let the Lead unstick the board', 'bool', false, false]);
});

test('off, the Lead only reports: every route it would act through is refused', async (t) => {
  const R = await relay();
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' });
  await until(async () => (await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true })).status === 200, 'the Lead');
  const leadT = await tokenOf(lead);
  const ticket = (await R.call('POST', '/tickets', { title: 'A ticket', repo })).body.ticket;
  const refused = [
    await R.call('POST', '/stuck', { item: PR(1), why: 'no review' }, leadT),
    await R.call('POST', '/rerun', { pr: PR(1) }, leadT),
    await R.call('POST', '/jams', { kind: 'other', fix: 'x' }, leadT),
    await R.call('POST', '/failures', { check: 'browser', prs: [PR(1), PR(2)] }, leadT),
    await R.call('POST', '/tickets/' + ticket.id + '/edit', { priority: 'high' }, leadT)
  ];
  assert.deepStrictEqual(refused.map((r) => r.status), [403, 403, 403, 403, 403]);
  assert.match(refused[0].body.message, /Let the Lead unstick the board/);
  assert.match(refused[4].body.message, /Let the Lead set priority/);
  assert.strictEqual((await R.call('GET', '/tickets/' + ticket.id)).body.ticket.priority, 'normal');
});

test('on, one failing check on two PRs: the Lead merges the duplicate tickets, the one left is high and first, and it starts', async (t) => {
  const R = await relay({ RELAY_WIP_LIMIT: '8' });
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' });
  await until(async () => (await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true })).status === 200, 'the Lead');
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, starts: 1, total: 10 })).status, 200);
  const leadT = await tokenOf(lead);
  const file = async (title, extra) => (await R.call('POST', '/tickets', { title, repo, ...extra })).body.ticket;
  const urgent = await file('Something else urgent', { priority: 'high' });
  const first = await file('Browser check fails on every PR', {});
  const twin = await file('Browser check fails again', {});
  const unrelated = await file('Unrelated', {});
  assert.strictEqual((await R.call('POST', '/settings', { values: { leadUnstick: true } })).status, 200);
  const ticket = async (id) => (await R.call('GET', '/tickets/' + id)).body.ticket;
  const order = async () => (await R.call('GET', '/tickets')).body.tickets.filter((x) => x.status === 'ready').map((x) => x.id);

  const opened = await R.call('POST', '/failures', { check: 'browser', prs: [PR(1), PR(2)] }, leadT);
  assert.strictEqual(opened.status, 201, JSON.stringify(opened.body));
  assert.strictEqual(opened.body.failure.name, 'failure-browser');
  assert.strictEqual((await R.call('POST', '/failures', { check: 'browser', prs: [PR(1), PR(2)] }, leadT)).status, 409, 'one channel for one failure');
  for (const x of [first, twin]) assert.strictEqual((await R.call('POST', '/failures/failure-browser/tickets', { ticket: x.id }, leadT)).status, 200);

  assert.strictEqual((await R.call('POST', '/tickets/' + unrelated.id + '/edit', { priority: 'high' }, leadT)).status, 403, 'only a ticket of the failure');
  const merged = await R.call('POST', '/tickets/' + twin.id + '/propose', { action: 'merge', ids: [first.id], why: 'Same failure' }, leadT);
  assert.strictEqual(merged.status, 200, JSON.stringify(merged.body));
  const gone = await ticket(twin.id);
  assert.deepStrictEqual([gone.status, gone.closedAs, gone.closedFor], ['rejected', 'merged', [first.id]]);
  const notUnlinked = await R.call('POST', '/tickets/' + unrelated.id + '/propose', { action: 'merge', ids: [first.id] }, leadT);
  assert.strictEqual((await ticket(unrelated.id)).status, 'ready', 'a ticket outside the failure waits for the person: ' + notUnlinked.status);
  assert.ok((await ticket(unrelated.id)).proposal, 'it is only a proposal');

  assert.strictEqual((await R.call('POST', '/tickets/' + first.id + '/edit', { priority: 'high' }, leadT)).status, 200);
  assert.strictEqual((await R.call('POST', '/tickets/' + first.id + '/order', { before: urgent.id }, leadT)).status, 200);
  assert.strictEqual((await order())[0], first.id, 'high and first');
  const started = await R.call('POST', '/tickets/' + first.id + '/start', {}, leadT);
  assert.strictEqual(started.status, 200, JSON.stringify(started.body));
  assert.strictEqual((await ticket(first.id)).status, 'started');
  assert.strictEqual((await R.call('POST', '/settings', { values: { leadUnstick: false } })).status, 200);
  assert.strictEqual((await R.call('POST', '/tickets/' + urgent.id + '/edit', { priority: 'low' }, leadT)).status, 403, 'and off again, it is refused');
});

test('the Lead\'s jam log: by Lead whatever it sends, since from the first time it named the item, and a person\'s log stays the person\'s', async (t) => {
  const R = await relay({ RELAY_STUCK_PASS_MS: '0' });
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' });
  await until(async () => (await R.call('POST', '/terminals/lead', { terminal: lead.id })).status === 200, 'the Lead');
  const leadT = await tokenOf(lead);
  await R.call('POST', '/settings', { values: { leadUnstick: true } });
  const seen = await R.call('POST', '/stuck', { item: PR(5), why: 'Green, and no review runs', kind: 'no-first-review' }, leadT);
  assert.deepStrictEqual([seen.status, seen.body.passes, seen.body.onNeedsYou], [200, 1, false]);
  const logged = await R.call('POST', '/jams', { kind: 'no-first-review', fix: 'Started its review', pr: PR(5), by: 'someone else', outcome: 'passed' }, leadT);
  assert.strictEqual(logged.status, 201, JSON.stringify(logged.body));
  assert.deepStrictEqual([logged.body.jam.by, logged.body.jam.outcome], ['Lead', undefined], 'by Lead, and a fix');
  assert.ok(logged.body.jam.since, 'since is when the Lead first named it');
  assert.strictEqual((await R.call('GET', '/jams', undefined, leadT)).status, 403, 'a session reads no log');
  const listed = (await R.call('GET', '/jams')).body.jams;
  assert.deepStrictEqual(listed.map((j) => j.by), ['Lead']);
});

test('an item named on three passes in a row with no action goes to Needs you with the Lead\'s reason, until it acts', async (t) => {
  const R = await relay({ RELAY_STUCK_PASS_MS: '0' });
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' });
  await until(async () => (await R.call('POST', '/terminals/lead', { terminal: lead.id })).status === 200, 'the Lead');
  const leadT = await tokenOf(lead);
  await R.call('POST', '/settings', { values: { leadUnstick: true } });
  const items = async () => (await R.call('GET', '/needs-you')).body.items.filter((i) => i.kind === 'lead-stuck');
  const say = (why) => R.call('POST', '/stuck', { item: PR(7), why, kind: 'person-merge' }, leadT);

  assert.strictEqual((await say('CI will not rerun')).body.passes, 1);
  assert.strictEqual((await say('CI will not rerun')).body.passes, 2);
  assert.deepStrictEqual(await items(), [], 'two passes are not enough');
  const third = await say('I cannot rerun CI: it is not a known flaky check');
  assert.deepStrictEqual([third.body.passes, third.body.onNeedsYou], [3, true]);
  const [line] = await items();
  assert.match(line.line, /The Lead cannot unstick https:\/\/github.com\/acme\/widgets\/pull\/7: I cannot rerun CI: it is not a known flaky check\. It named it on 3 passes in a row and did not act\./);
  assert.strictEqual(line.pr, PR(7));
  assert.strictEqual((await say('same')).body.onNeedsYou, true, 'a fourth report does not take it off');
  const jams = (await R.call('GET', '/jams')).body.jams;
  assert.deepStrictEqual(jams.map((j) => [j.by, j.outcome, j.kind]), [['Lead', 'passed', 'person-merge']], 'one jam passed to the person, not one for each report');
  const lead2 = (await R.call('GET', '/metrics')).body.lead;
  assert.deepStrictEqual([lead2.passed.total, lead2.fixed.total], [1, 0]);

  assert.strictEqual((await R.call('POST', '/jams', { kind: 'person-merge', fix: 'Asked the person to merge', pr: PR(7) }, leadT)).status, 201);
  assert.deepStrictEqual(await items(), [], 'acting on it takes it off');
  const after = (await R.call('GET', '/metrics')).body.lead;
  assert.deepStrictEqual([after.fixed.total, after.timeToAct.count], [1, 1], 'time to act counts from when the Lead first saw it');
});
