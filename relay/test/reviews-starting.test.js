'use strict';
// A review that is starting (its checkout is being made) still goes before a new ticket: reviews.startingOf()
// lists it, so Autopilot does not hand its desk to a ticket in the moment between the start and the reviewer's seat.
// This was the race in relay/test/autopilot-review-first.test.js that failed on a loaded CI runner.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

test('a review whose checkout is being made is listed as starting until it ends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-starting-'));
  process.env.RELAY_REVIEWS_FILE = path.join(dir, 'reviews.json');
  process.env.RELAY_PIPELINE_POLL_SECONDS = '0';
  const pr = 'https://github.com/a/b/pull/1';
  fs.writeFileSync(process.env.RELAY_REVIEWS_FILE, JSON.stringify({ c: { prs: { [pr]: { count: 0, head: null, pending: null, waits: false, first: { at: 1, from: dir } } } } }));
  const checkouts = require('../checkouts.js');
  const reviews = require('../reviews.js');
  let finish;
  checkouts.create = () => new Promise((resolve) => { finish = resolve; });
  assert.deepStrictEqual(reviews.startingOf('c'), []);
  reviews.firstReviews('c', reviews.chOf('c'));
  assert.deepStrictEqual(reviews.waiting('c'), [], 'a review that is starting no longer waits to start');
  assert.deepStrictEqual(reviews.startingOf('c'), [pr]);
  finish([409, { ok: false, error: 'full', message: 'no desk' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(reviews.startingOf('c'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
