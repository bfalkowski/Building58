// One count of automatic reviews serves the review starter and Autopilot (relay/reviews.js).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const PR = 'https://github.com/acme/app/pull/402';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'review-count-'));
process.env.RELAY_STATE_DIR = home;
const at = (n) => 'https://github.com/acme/app/pull/' + n;
const rec = (o) => Object.assign({ count: 1, head: 'a', pending: null, waits: false }, o);
fs.writeFileSync(path.join(home, 'reviews.json'), JSON.stringify({
  c: { prs: { [PR]: rec({ count: 6, waits: true }), [at(1)]: rec({ failed: 'it broke' }), [at(2)]: rec({ count: 6, first: { from: '/x' } }), [at(3)]: rec({ count: 6, pending: { from: '/x' } }), [at(4)]: rec({ count: 6 }) } },
  off: { auto: false, prs: { [PR]: rec() } },
}));
const reviews = require('../reviews.js');

test('a PR at 6 of 6 has no review to wait for, and a hand-back gives it one more', () => {
  assert.strictEqual(reviews.noReview('c', PR), 'it is out of automatic reviews');
  reviews.giveReview('c', PR);
  assert.strictEqual(reviews.noReview('c', PR), '');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'reviews.json'), 'utf8')).c.prs[PR].count, 5);
  assert.strictEqual(reviews.noReview('c', 'https://github.com/acme/app/pull/9'), '', 'a PR with no record gets its first review');
});
test('no review is owed when the switch is off, a start failed, or one waits', () => {
  assert.match(reviews.noReview('off', PR), /^Review PRs automatically is off$/);
  assert.match(reviews.noReview('c', at(1)), /^its automatic review could not start$/);
  assert.strictEqual(reviews.noReview('c', at(2)), '', 'a first review waits to start');
  assert.strictEqual(reviews.noReview('c', at(3)), '', 'a follow-up waits to start');
});
test('a hand-back clears a failed start and gives a used-up PR one more, and a PR with no record is left alone', () => {
  reviews.giveReview('c', at(1));
  assert.strictEqual(reviews.noReview('c', at(1)), '');
  reviews.giveReview('c', at(4));
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'reviews.json'), 'utf8')).c.prs;
  assert.strictEqual(saved[at(4)].count, 5);
  assert.doesNotThrow(() => reviews.giveReview('c', at(99)));
});
test.after(() => setImmediate(() => process.exit(process.exitCode || 0)));
