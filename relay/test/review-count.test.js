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
fs.writeFileSync(path.join(home, 'reviews.json'), JSON.stringify({ c: { prs: { [PR]: { count: 3, head: 'a', pending: null, waits: true } } } }));
const reviews = require('../reviews.js');

test('a PR at 3 of 3 has no review to wait for, and a hand-back gives it one more', () => {
  assert.strictEqual(reviews.noReview('c', PR), 'out of automatic reviews: start one with Get a review, or merge or close it');
  reviews.giveReview('c', PR);
  assert.strictEqual(reviews.noReview('c', PR), '');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'reviews.json'), 'utf8')).c.prs[PR].count, 2);
  assert.strictEqual(reviews.noReview('c', 'https://github.com/acme/app/pull/9'), '', 'a PR with no record gets its first review');
});
test.after(() => setImmediate(() => process.exit(process.exitCode || 0)));
