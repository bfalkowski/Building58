'use strict';
// Who owes the next move on an open task PR (relay/pr-watch-plan.js), one row at a time.
const test = require('node:test');
const assert = require('node:assert');
const { nextMove, lateness, lineOf } = require('../pr-watch-plan.js');

const H = 'a'.repeat(40), OLD = 'b'.repeat(40);
const GREEN = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const RED = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'FAILURE' }];
const RUNNING = [{ name: 'pipeline', status: 'IN_PROGRESS', conclusion: '' }];
// An open PR at H, green and clean, its Dev idle, reviewed at H with a posted merge verdict.
const base = (o) => Object.assign({
  pr: { state: 'OPEN', headRefOid: H, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN },
  task: { state: 'in_review', autopilot: false }, dev: { state: 'idle' }, unpushed: null,
  review: { head: H, running: false }, verdict: { kind: 'merge', commit: H, posted: 'https://x' }, files: ['a.txt'], leadMerges: true,
}, o);
const pr = (o) => Object.assign({}, base().pr, o);
const pick = (m) => [m.owner, m.cause, m.act];

test('no review of the current head: it asks for one', () => {
  assert.deepStrictEqual(pick(nextMove(base({ review: { head: OLD, running: false }, verdict: { kind: 'fix', commit: OLD, posted: 'u' } }))), ['reviewer', 'review', 'review']);
});

test('a PR the relay has no review record of still gets one', () => {
  assert.deepStrictEqual(pick(nextMove(base({ review: null, verdict: null }))), ['reviewer', 'review', 'review']);
});

test('past the review limit, off, failed or already waiting, it asks for none', () => {
  const at = (review) => pick(nextMove(base({ review, verdict: null })));
  assert.deepStrictEqual(at({ head: OLD, waits: true }), ['you', 'review', null]);
  assert.deepStrictEqual(at({ head: OLD, failed: true }), ['you', 'review', null]);
  assert.deepStrictEqual(at({ head: null, off: true }), ['you', 'review', null]);
  assert.deepStrictEqual(at({ head: OLD, held: true }), ['reviewer', 'review', null]);
  assert.deepStrictEqual(at({ head: OLD, running: true }), ['reviewer', 'reviewing', null]);
});

test('blocking findings, a conflict and a failed check go to the Dev', () => {
  assert.deepStrictEqual(pick(nextMove(base({ verdict: { kind: 'fix', commit: H, posted: 'u' } }))), ['Dev', 'fix', 'tell-dev']);
  assert.deepStrictEqual(pick(nextMove(base({ pr: pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }) }))), ['Dev', 'conflict', 'tell-dev']);
  assert.deepStrictEqual(pick(nextMove(base({ pr: pr({ statusCheckRollup: RED }) }))), ['Dev', 'red', 'tell-dev']);
});

test('with its Dev gone, nobody can be told, so it is the person\'s', () => {
  assert.deepStrictEqual(pick(nextMove(base({ dev: null, verdict: { kind: 'fix', commit: H, posted: 'u' } }))), ['you', 'fix', null]);
});

test('a Dev at work, at a question or stuck is not told again', () => {
  const fix = { kind: 'fix', commit: H, posted: 'u' };
  assert.deepStrictEqual(pick(nextMove(base({ verdict: fix, dev: { state: 'working' } }))), ['Dev', 'working', null]);
  assert.deepStrictEqual(pick(nextMove(base({ verdict: fix, dev: { state: 'waiting' } }))), ['you', 'question', null]);
  assert.deepStrictEqual(pick(nextMove(base({ verdict: fix, dev: { state: 'stuck', cause: 'told' } }))), ['you', 'stuck', null]);
});

test('commits the PR does not have, with the Dev idle: it tells the Dev to push, before any review', () => {
  assert.deepStrictEqual(pick(nextMove(base({ unpushed: 2, review: null, verdict: null }))), ['Dev', 'push', 'tell-dev']);
  assert.deepStrictEqual(pick(nextMove(base({ unpushed: 2, dev: { state: 'working' } }))), ['Dev', 'working', null], 'a Dev at work may still push');
  assert.deepStrictEqual(pick(nextMove(base({ unpushed: 1, dev: null }))), ['you', 'push', null]);
});

test('reviewed at the head, green and clean: it tells the Lead', () => {
  assert.deepStrictEqual(pick(nextMove(base())), ['Lead', 'ready', 'tell-lead']);
  assert.deepStrictEqual(pick(nextMove(base({ leadMerges: false }))), ['you', 'ready', 'tell-lead'], 'with no Lead that may merge, it waits on you, and a Lead is still told');
  assert.deepStrictEqual(pick(nextMove(base({ pr: pr({ mergeStateStatus: 'BEHIND' }) }))), ['Lead', 'ready', 'tell-lead'], 'behind main still merges');
});

test('one that changes the constitution or CLAUDE.md waits on you', () => {
  const m = nextMove(base({ files: ['a.txt', 'docs/constitution.md'] }));
  assert.deepStrictEqual(pick(m), ['you', 'protected', null]);
  assert.match(m.why, /docs\/constitution\.md/);
});

test('CI running, a verdict not posted, a review with no verdict', () => {
  assert.deepStrictEqual(pick(nextMove(base({ pr: pr({ statusCheckRollup: RUNNING }) }))), ['CI', 'ci', null]);
  assert.deepStrictEqual(pick(nextMove(base({ verdict: { kind: 'merge', commit: H, posted: null } }))), ['reviewer', 'verdict', null]);
  assert.deepStrictEqual(pick(nextMove(base({ verdict: null }))), ['you', 'verdict', null]);
});

test('Waiting on you and Autopilot\'s own tasks are left alone', () => {
  assert.deepStrictEqual(pick(nextMove(base({ task: { state: 'waiting_on_you' }, review: null }))), ['you', 'waiting', null]);
  assert.deepStrictEqual(pick(nextMove(base({ task: { state: 'in_review', autopilot: true }, review: null }))), ['Autopilot', 'autopilot', null]);
});

test('waiting past the set time goes to the person, and the line says who and how long', () => {
  const move = nextMove(base({ verdict: { kind: 'fix', commit: H, posted: 'u' } }));
  const hour = 60 * 60 * 1000;
  assert.strictEqual(lateness(move, 0, hour - 1, hour), null);
  const late = lateness(move, 0, hour, hour);
  assert.strictEqual(late.owner, 'you');
  assert.match(late.why, /^the Dev has owed the next move for 60 min\. The review/);
  assert.strictEqual(lateness(nextMove(base({ task: { state: 'waiting_on_you' } })), 0, 10 * hour, hour), null, 'the person\'s own wait is not late');
  const line = lineOf({ owner: 'Dev', why: 'It conflicts with main.', since: 0 }, 5 * 60000);
  assert.deepStrictEqual([line.owner, line.minutes, line.words], ['Dev', 5, 'waits on the Dev for 5 min: It conflicts with main.']);
});
