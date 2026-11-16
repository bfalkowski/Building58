// What Autopilot decides for one PR, and which ticket it starts next (relay/autopilot-plan.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { forPr, ciOf, nextTicket, heldBack, whyNoneAllowed } = require('../autopilot-plan.js');

const HEAD = 'a'.repeat(40);
const green = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const pr = (extra) => Object.assign({ state: 'OPEN', headRefOid: HEAD, mergeStateStatus: 'CLEAN', statusCheckRollup: green }, extra);
const FILES = ['relay/x.js'];
const merge = { kind: 'merge', commit: HEAD, posted: true };
const act = (p, v, rounds, max, files) => forPr(p, files === undefined ? FILES : files, v, rounds, max).act;

test('a reviewed, green, clean PR merges', () => {
  assert.strictEqual(act(pr(), merge, 1, 2), 'merge');
  assert.strictEqual(act(pr({ mergeStateStatus: 'BEHIND' }), merge, 1, 2), 'merge', 'main does not require an up to date branch, so no merge of main is needed');
});
test('it waits for a review, for the post, and for CI', () => {
  assert.strictEqual(act(pr(), null, 0, 2), 'wait');
  assert.strictEqual(act(pr(), { ...merge, posted: false }, 1, 2), 'wait', 'a verdict counts only once its review is on the PR');
  assert.strictEqual(act(pr({ statusCheckRollup: [] }), merge, 1, 2), 'wait');
  assert.strictEqual(act(pr({ statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] }), merge, 1, 2), 'wait');
  assert.strictEqual(act(null, merge, 1, 2), 'wait');
});
test('a merge verdict covers only the commit the reviewer read', () => {
  assert.strictEqual(act(pr({ headRefOid: 'b'.repeat(40) }), merge, 1, 2), 'wait');
});
test('fixes get one more round, then the person decides', () => {
  const fix = { kind: 'fix', commit: HEAD, posted: true };
  assert.strictEqual(act(pr(), fix, 1, 2), 'wait');
  const r = forPr(pr(), FILES, fix, 2, 2);
  assert.strictEqual(r.act, 'person');
  assert.match(r.why, /2 rounds/);
});
test('the person merges CLAUDE.md and the constitution, and a failed or closed PR', () => {
  assert.strictEqual(act(pr(), merge, 1, 2, ['CLAUDE.md']), 'person');
  assert.strictEqual(act(pr(), merge, 1, 2, ['a.js', 'eslint.config.js']), 'person', 'the lint rules are the person\'s too');
  assert.strictEqual(act(pr(), merge, 1, 2, ['eslint-local.js']), 'person');
  assert.strictEqual(act(pr(), merge, 1, 2, ['a.js', 'docs/constitution.md']), 'person');
  assert.strictEqual(act(pr(), merge, 1, 2, ['docs/rules.md', 'docs/constitution.md']), 'person', 'a rename lists the old name too');
  assert.strictEqual(act(pr(), merge, 1, 2, null), 'wait', 'no list of files, no merge');
  assert.strictEqual(act(pr({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }), merge, 1, 2), 'person');
  assert.strictEqual(act(pr({ state: 'CLOSED' }), merge, 1, 2), 'person');
});
// T-239: a code ticket leaves the wording to the grouped ticket, so its PR merges without the person.
test('a code-only PR merges while the grouped wording PR waits for the person', () => {
  const { WORDING_TICKET } = require('../autopilot-plan.js');
  assert.strictEqual(WORDING_TICKET, 'CLAUDE.md and constitution updates');
  assert.strictEqual(act(pr(), merge, 1, 2, ['relay/autopilot.js', 'relay/test/autopilot.test.js', 'docs/manual/roles.html']), 'merge');
  const wording = forPr(pr(), ['CLAUDE.md', 'docs/constitution.md'], merge, 1, 2);
  assert.strictEqual(wording.act, 'person');
  assert.match(wording.why, /CLAUDE\.md and docs\/constitution\.md, which only a person merges/);
});
test('a merged PR is done, and a conflict goes back to the Dev', () => {
  assert.strictEqual(act(pr({ state: 'MERGED' }), null, 0, 2, null), 'done');
  assert.strictEqual(act(pr({ mergeStateStatus: 'DIRTY' }), merge, 1, 2), 'conflict');
});
test('the checks', () => {
  assert.strictEqual(ciOf(green), 'green');
  assert.strictEqual(ciOf([...green, { status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'green');
  assert.strictEqual(ciOf([{ state: 'SUCCESS' }]), 'green', 'a status context has state, not conclusion');
  assert.strictEqual(ciOf([...green, { status: 'COMPLETED', conclusion: 'CANCELLED' }]), 'red');
  assert.strictEqual(ciOf(undefined), 'pending');
});
test('the next ticket: Ready, approved, unblocked, in Board order, and only the allowed ones', () => {
  const all = [
    { id: 'T-1', status: 'ready', repo: '/r', createdBy: 'you', priority: 'normal' },
    { id: 'T-2', status: 'ready', repo: '/r', createdBy: 'you', priority: 'high', blockedBy: ['T-9'] },
    { id: 'T-3', status: 'ready', repo: '/r', createdBy: 'you', priority: 'high' },
    { id: 'T-4', status: 'ready', repo: '/r', createdBy: 'lead', approvedBy: 'none', priority: 'high' },
    { id: 'T-5', status: 'triage', repo: '/r', createdBy: 'you', priority: 'high' },
    { id: 'T-9', status: 'started', repo: '/r', createdBy: 'you' }
  ];
  const none = () => false;
  assert.strictEqual(nextTicket(all, none, null).id, 'T-3');
  assert.strictEqual(nextTicket(all, (t) => t.id === 'T-3', null).id, 'T-1');
  assert.strictEqual(nextTicket(all, none, ['T-1']).id, 'T-1');
  assert.strictEqual(nextTicket(all, none, ['T-4', 'T-5']), null);
});
test('the next ticket can come from a label in the allowed list', () => {
  const all = [
    { id: 'T-1', status: 'ready', repo: '/r', createdBy: 'you', priority: 'high' },
    { id: 'T-2', status: 'ready', repo: '/r', createdBy: 'you', priority: 'normal', labels: ['flaky', 'ci'] },
    { id: 'T-3', status: 'ready', repo: '/r', createdBy: 'you', priority: 'low', labels: ['docs'] },
    { id: 'T-4', status: 'ready', repo: '/r', createdBy: 'lead', approvedBy: 'none', priority: 'high', labels: ['flaky'] }
  ];
  const none = () => false;
  assert.strictEqual(nextTicket(all, none, ['flaky']).id, 'T-2', 'a label lets in its approved tickets, not T-1 above it');
  assert.strictEqual(nextTicket(all, (t) => t.id === 'T-2', ['flaky']), null, 'an unapproved ticket stays out, label or not');
  assert.strictEqual(nextTicket(all, none, ['docs', 'T-1']).id, 'T-1', 'ids and labels together, in Board order');
  assert.strictEqual(nextTicket(all, none, ['games']), null);
});
test('it skips a ticket on hold, replaced, or shaped by an open design ticket (T-204)', () => {
  const ready = (id, extra) => Object.assign({ id, status: 'ready', repo: '/r', createdBy: 'you', priority: 'normal', rank: Number(id.slice(2)) }, extra);
  const none = () => false;
  const design = ready('T-15', { priority: 'low', shapes: ['T-7', 'T-9'] });
  const all = [ready('T-7'), ready('T-8', { mark: 'hold' }), ready('T-9'), ready('T-10', { mark: 'replaced', replacedBy: 'T-11' }), design];
  assert.strictEqual(nextTicket(all, none, null).id, 'T-15', 'T-7 and T-9 wait for the design, T-8 is on hold, T-10 is replaced');
  assert.strictEqual(nextTicket(all, none, ['T-7', 'T-8', 'T-9', 'T-10']), null, 'the allowed list does not get past a mark');
  assert.match(heldBack(all[0], all), /design ticket T-15/);
  assert.match(heldBack(all[1], all), /On hold/);
  assert.match(heldBack(all[3], all), /Replaced by T-11/);
  assert.strictEqual(heldBack(design, all), null);
  for (const status of ['done', 'rejected']) {
    const settled = all.map((t) => (t.id === 'T-15' ? { ...t, status } : t));
    assert.strictEqual(nextTicket(settled, none, null).id, 'T-7', 'a design ticket that is ' + status + ' frees what it shapes');
  }
  const started = all.map((t) => (t.id === 'T-15' ? { ...t, status: 'started' } : t));
  assert.strictEqual(nextTicket(started, none, null), null, 'a design ticket being built still holds what it shapes');
  const cleared = all.map((t) => (t.id === 'T-8' ? { ...t, mark: null } : t));
  assert.strictEqual(nextTicket(cleared, none, ['T-8']).id, 'T-8', 'clearing the mark lets it start');
});
test('with an allowed list and nothing to start, the idle note names why each allowed ticket waits (T-291)', () => {
  const ready = (id, extra) => Object.assign({ id, status: 'ready', repo: '/r', createdBy: 'you', priority: 'normal', rank: Number(id.slice(2)) }, extra);
  const none = () => false;
  const all = [
    ready('T-1', { status: 'done' }),
    ready('T-2', { status: 'started' }),
    ready('T-3', { status: 'triage' }),
    ready('T-4', { createdBy: 'lead', approvedBy: 'none' }),
    ready('T-5', { blockedBy: ['T-2'] }),
    ready('T-6', { mark: 'hold' }),
    ready('T-7', { mark: 'replaced', replacedBy: 'T-9' }),
    ready('T-8'),
    ready('T-9', { status: 'triage', shapes: ['T-8'] }),
    ready('T-10', { repo: null })
  ];
  const only = ['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6', 'T-7', 'T-8', 'T-10'];
  assert.strictEqual(nextTicket(all, none, only), null);
  assert.strictEqual(whyNoneAllowed(all, none, only), 'No ticket you allowed can start. T-3: In Triage. T-4: Not approved by you. T-5: Waiting for T-2. T-6: On hold. T-7: Replaced by T-9. T-8: Waiting on design ticket T-9, which shapes it. T-10: No repo.');
  assert.strictEqual(whyNoneAllowed(all, none, ['T-1', 'T-2']), 'Every ticket you allowed is started or done.');
  assert.strictEqual(whyNoneAllowed(all, (t) => t.id === 'T-8', ['T-1', 'T-8']), 'Every ticket you allowed is started or done.', 'a ticket with a task counts as started');
  const rejected = ready('T-11', { status: 'rejected' });
  assert.strictEqual(whyNoneAllowed([rejected], none, ['T-11']), 'No ticket you allowed can start. T-11: Rejected.', 'a rejected ticket is not started or done');
  assert.strictEqual(whyNoneAllowed([...all, rejected], none, ['T-1', 'T-11']), 'No ticket you allowed can start. T-11: Rejected.');
  assert.strictEqual(whyNoneAllowed(all, none, ['T-99', 'games']), 'No ticket on the Board has an id or label you allowed.');
  assert.strictEqual(whyNoneAllowed([ready('T-5', { labels: ['flaky'], mark: 'hold' })], none, ['flaky']), 'No ticket you allowed can start. T-5: On hold.', 'a label counts too');
});
