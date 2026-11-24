'use strict';
// reviews.waiting() lists the reviews that wait to start, and reviews.owes() says a review of a PR is starting,
// running or waiting to start. A review that failed, waits on the person or is held by its pipeline is neither,
// so Autopilot still starts tickets and still hands such a PR to the person (PR 354).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

test('a failed, held or person-owned review does not wait to start; a free one does', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-reviews-'));
  process.env.RELAY_REVIEWS_FILE = path.join(dir, 'reviews.json');
  const rec = (extra) => Object.assign({ count: 0, head: null, pending: null, waits: false, first: { at: 1 } }, extra);
  fs.writeFileSync(process.env.RELAY_REVIEWS_FILE, JSON.stringify({ c: { prs: {
    'https://github.com/a/b/pull/1': rec({}),
    'https://github.com/a/b/pull/2': rec({ failed: 'gh said no' }),
    'https://github.com/a/b/pull/3': rec({ waits: true }),
    'https://github.com/a/b/pull/4': rec({ why: 'Waiting for CI.' }),
    'https://github.com/a/b/pull/5': rec({ first: { at: 2, desk: true } }),
  } } }));
  const reviews = require('../reviews.js');
  const n = (x) => 'https://github.com/a/b/pull/' + x;
  assert.deepStrictEqual(reviews.waiting('c'), [n(1), n(5)]);
  assert.deepStrictEqual([1, 2, 3, 4, 5].map((x) => reviews.owes('c', n(x))), [true, false, false, false, true]);
  assert.deepStrictEqual(reviews.deskQueue('c'), [n(5)]);
  fs.rmSync(dir, { recursive: true, force: true });
});
