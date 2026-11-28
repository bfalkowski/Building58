'use strict';
// A hand-over clears itself when its reason no longer holds (569). On 2026-11-27 and 28 PRs handed over for
// red CI or a conflict stayed in Needs you after the cause cleared, until a person moved each card.
const test = require('node:test');
const assert = require('node:assert');
const { handedStillHolds } = require('../autopilot-plan.js');

const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);
const green = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const red = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'FAILURE' }];
const pr = (extra) => Object.assign({ state: 'OPEN', url: 'https://github.com/a/b/pull/7', headRefOid: OLD, mergeStateStatus: 'CLEAN', statusCheckRollup: green }, extra);
const check = (reason, p, extra) => handedStillHolds({ reason, head: OLD, pr: p, devRunning: false, ...extra });

test('stalled clears after a push, not before', () => {
  assert.match(check('stalled', pr({ headRefOid: NEW })), /^its Dev pushed bbbbbbb$/);
  assert.strictEqual(check('stalled', pr()), null);
});
test('ci-red clears when CI is green on a newer head, not on the same head or a red one', () => {
  assert.match(check('ci-red', pr({ headRefOid: NEW })), /^CI is green on bbbbbbb/);
  assert.strictEqual(check('ci-red', pr()), null);
  assert.strictEqual(check('ci-red', pr({ headRefOid: NEW, statusCheckRollup: red })), null);
  assert.strictEqual(check('ci-red', pr({ headRefOid: NEW, statusCheckRollup: [] })), null, 'CI still pending');
});
test('conflict-dropped clears when the conflict is gone', () => {
  assert.match(check('conflict-dropped', pr()), /^PR 7 no longer conflicts with main$/);
  assert.strictEqual(check('conflict-dropped', pr({ mergeStateStatus: 'DIRTY' })), null);
  assert.strictEqual(check('conflict-dropped', pr({ mergeStateStatus: 'UNKNOWN' })), null);
});
test('dev-gone clears when the Dev runs again', () => {
  assert.strictEqual(check('dev-gone', pr(), { devRunning: true }), 'its Dev is running again');
  assert.strictEqual(check('dev-gone', pr()), null);
});
test('rounds, protected-file and pr-closed stay with the person', () => {
  const fixed = pr({ headRefOid: NEW });
  for (const reason of ['rounds', 'protected-file', 'pr-closed', 'merge-failed']) assert.strictEqual(check(reason, fixed, { devRunning: true }), null, reason);
  assert.strictEqual(check('ci-red', pr({ headRefOid: NEW, state: 'CLOSED' })), null);
});
