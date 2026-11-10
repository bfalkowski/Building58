// What Autopilot decides for one PR, and which ticket it starts next (relay/autopilot-plan.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { forPr, ciOf, nextTicket } = require('../autopilot-plan.js');

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
