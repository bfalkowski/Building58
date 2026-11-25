// When one failing check shows on two PRs, the room opens one channel; when one fix merges the others are told
// and the channel closes once nobody waits on it, or after a day with no post (relay/failures-plan.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { plan, failing, keyOf, roomNameOf, QUIET_MS } = require('../failures-plan.js');

const PR = (n) => 'https://github.com/o/r/pull/' + n;
const pr = (n, extra) => Object.assign({ pr: PR(n), open: true, merged: false, closed: false, failed: [], green: false }, extra);
const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const room = (extra) => Object.assign({ key: 'browser', prs: [PR(1), PR(2)], fixedBy: null, lastAt: NOW - 1000 }, extra);

test('a check name becomes a channel name', () => {
  assert.strictEqual(keyOf('Browser tests (chrome)'), 'browser-tests-chrome');
  assert.strictEqual(roomNameOf('browser'), 'failure-browser');
  assert.strictEqual(keyOf('   '), '');
});

test('one failing check on two open PRs opens one channel, naming both', () => {
  const prs = [pr(1, { failed: ['browser'] }), pr(2, { failed: ['browser', 'lint'] }), pr(3, { failed: ['lint-other'] })];
  assert.deepStrictEqual([...failing(prs).keys()].sort(), ['browser', 'lint', 'lint-other']);
  assert.deepStrictEqual(plan({ rooms: [], prs, now: NOW }), [{ do: 'open', key: 'browser', prs: [PR(1), PR(2)] }]);
});

test('one PR alone, or a PR that is no longer open, opens nothing', () => {
  assert.deepStrictEqual(plan({ rooms: [], prs: [pr(1, { failed: ['browser'] })], now: NOW }), []);
  assert.deepStrictEqual(plan({ rooms: [], prs: [pr(1, { failed: ['browser'] }), pr(2, { failed: ['browser'], open: false, merged: true })], now: NOW }), []);
});

test('a third PR with the same failure joins the open channel, once', () => {
  const prs = [pr(1, { failed: ['browser'] }), pr(2, { failed: ['browser'] }), pr(3, { failed: ['browser'] })];
  assert.deepStrictEqual(plan({ rooms: [room()], prs, now: NOW }), [{ do: 'join', key: 'browser', pr: PR(3) }]);
});

test('the first PR of the channel to merge is the fix, and only once', () => {
  const prs = [pr(1, { open: false, merged: true }), pr(2, { failed: ['browser'] })];
  assert.deepStrictEqual(plan({ rooms: [room()], prs, now: NOW }), [{ do: 'fixed', key: 'browser', pr: PR(1) }]);
  assert.deepStrictEqual(plan({ rooms: [room({ fixedBy: PR(1) })], prs, now: NOW }), [], 'it still blocks PR 2, so the channel stays');
});

test('the channel is archived once the fix merged and every blocked PR merged, closed or passed the check', () => {
  const fixed = room({ fixedBy: PR(1) });
  const archive = (prs) => plan({ rooms: [fixed], prs, now: NOW }).filter((a) => a.do === 'archive').length;
  assert.strictEqual(archive([pr(1, { open: false, merged: true }), pr(2, { open: false, merged: true })]), 1, 'merged');
  assert.strictEqual(archive([pr(1, { open: false, merged: true }), pr(2, { open: false, closed: true })]), 1, 'closed');
  assert.strictEqual(archive([pr(1, { open: false, merged: true }), pr(2, { green: true })]), 1, 'passed the check');
  assert.strictEqual(archive([pr(1, { open: false, merged: true }), pr(2, { failed: ['browser'] })]), 0, 'still failing');
  assert.strictEqual(archive([pr(1, { open: false, merged: true }), pr(2, { failed: ['lint'] })]), 0, 'failing another check is not passing this one');
  assert.strictEqual(archive([pr(1, { open: false, merged: true })]), 1, 'a PR the relay no longer sees is done');
  assert.strictEqual(plan({ rooms: [room()], prs: [pr(1, { green: true }), pr(2, { failed: ['browser'] })], now: NOW }).filter((a) => a.do === 'archive').length, 0, 'one still fails');
});

test('a channel whose blocked PRs all pass with no merge, as after a rerun, is archived at once', () => {
  const out = plan({ rooms: [room()], prs: [pr(1, { green: true }), pr(2, { green: true })], now: NOW });
  assert.deepStrictEqual(out.map((a) => a.do), ['archive']);
  assert.match(out[0].why, /no fix merged/);
  assert.deepStrictEqual(plan({ rooms: [room()], prs: [pr(1, { open: false, closed: true }), pr(2, { open: false, closed: true })], now: NOW }), [], 'all closed unmerged: not a pass');
});

test('a channel with no post for 24 hours is archived, fixed or not', () => {
  const prs = [pr(1, { failed: ['browser'] }), pr(2, { failed: ['browser'] })];
  assert.deepStrictEqual(plan({ rooms: [room({ lastAt: NOW - QUIET_MS + 1000 })], prs, now: NOW }), []);
  const [a] = plan({ rooms: [room({ lastAt: NOW - QUIET_MS })], prs, now: NOW });
  assert.deepStrictEqual([a.do, a.key, a.why], ['archive', 'browser', 'it had no post for 24 hours']);
});
