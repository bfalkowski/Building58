'use strict';
// An empty or broken review is not a merge verdict: only a comment with a verdict line and words on what was
// checked counts, and a reviewer that leaves without one gets one new review, then the person (PR 425).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { countsAsReview, reviewPostFor } = require('../autopilot-plan.js');
const { listOf } = require('../needs-you-plan.js');

const REAL = '## Review of 04fe778\n\nI read the diff and ran the tests; the route answers.\n\nVerdict: merge\n';

test('a comment of a dash, of whitespace, or with no verdict line does not count', () => {
  for (const body of ['-', ' \n\t ', '', null, undefined, '## Review of 04fe778\n\nI read the diff and ran the tests.\n', 'Verdict: merge', '## Review of 04fe778\n\nVerdict: fix\n']) {
    assert.strictEqual(countsAsReview(body), false, JSON.stringify(body));
  }
  assert.strictEqual(countsAsReview(REAL), true);
  assert.strictEqual(countsAsReview('Verdict: merge. I read the diff and ran the tests, all green.'), true, 'words on the verdict line count');
  assert.strictEqual(countsAsReview(REAL, 'merge'), true);
  assert.strictEqual(countsAsReview(REAL, 'fix'), false, 'a comment that says merge does not match a kept fix, nor the reverse');
  assert.strictEqual(countsAsReview('## Review of 04fe778\n\nOne bug in the route, see below.\n\n**Verdict: fix.**\n'), true);
});

test('the lookup for an unseen post skips a dash and a comment with no verdict', () => {
  const head = '04fe778091e19b67dc60a782f083d704434a7c31', since = Date.parse('2026-11-08T22:09:05Z');
  const c = (body, n) => ({ html_url: 'https://github.com/a/b/pull/1#issuecomment-' + n, user: { login: 'me' }, created_at: '2026-11-08T22:51:50Z', body });
  const find = (comments) => reviewPostFor(comments, { login: 'me', since, commit: head });
  assert.strictEqual(find([c('-', 1)]), null);
  assert.strictEqual(find([c('## Review of 04fe778\n\nI looked at it all and found nothing wrong.\n', 2)]), null);
  assert.strictEqual(find([c(REAL, 3), c('-', 4)]), 'https://github.com/a/b/pull/1#issuecomment-3');
});

test('after an empty review a new one starts once, and a second empty one fails the PR to the person', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-empty-'));
  process.env.RELAY_REVIEWS_FILE = path.join(dir, 'reviews.json');
  const pr = 'https://github.com/a/b/pull/9', queued = 'https://github.com/a/b/pull/10';
  fs.writeFileSync(process.env.RELAY_REVIEWS_FILE, JSON.stringify({ c: { prs: { [pr]: { count: 1, head: 'abc', pending: null, waits: false, from: '/work/b' }, [queued]: { count: 1, head: 'abc', pending: { from: '/work/b', tries: 2, notBefore: 5 }, waits: false } } } }));
  const reviews = require('../reviews.js');
  assert.strictEqual(reviews.reviewEmpty('c', pr), true);
  const rec = JSON.parse(fs.readFileSync(process.env.RELAY_REVIEWS_FILE, 'utf8')).c.prs[pr];
  assert.ok(rec.pending && rec.pending.again && rec.pending.watch, 'a review is queued');
  assert.strictEqual(rec.count, 1, 'the restart does not change the count');
  assert.strictEqual(reviews.failedOf('c', pr), null);
  assert.strictEqual(reviews.reviewEmpty('c', queued), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(process.env.RELAY_REVIEWS_FILE, 'utf8')).c.prs[queued].pending, { from: '/work/b', tries: 2, notBefore: 5 }, 'a review already queued is kept as it was');
  assert.strictEqual(reviews.reviewEmpty('c', pr), false);
  assert.match(reviews.failedOf('c', pr), /came back empty/);
  const task = { id: 't1', ticket: 'T-9', title: 'x', state: 'in_review', pr, prOpen: true, owner: null, reviewRuns: false, reviewFailed: reviews.failedOf('c', pr) };
  const items = listOf({ tasks: [task] });
  assert.ok(items.some((i) => /came back empty/.test(i.line)), JSON.stringify(items));
  fs.rmSync(dir, { recursive: true, force: true });
});
