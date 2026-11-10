// Which review starts, from office/reviews.js: Get a review on the page, and the relay's automatic
// reviews. Nothing here runs a browser. relay/test/auto-review.test.js runs the relay's side.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { manualReview, PR_URL } = require('../../office/reviews.js');

const PR = 'https://github.com/bfalkowski/3d/pull/28';
const dev = (pr) => ({ id: 't1', cwd: '/repo/.worktrees/task-a', running: true, work: { role: 'dev', ticket: 'T-14', pr, label: 'T-14 · x' } });

test('Get a review on a Dev with an open PR reviews the PR and posts, like the automatic review', () => {
  const r = manualReview(dev(PR));
  assert.strictEqual(r.pr, PR);
  assert.strictEqual(r.from, '/repo/.worktrees/task-a', 'the checkout of the PR is made from the Dev\'s repo');
  assert.match(r.prompt, /Post your findings as a PR comment/);
  assert.doesNotMatch(r.prompt, /Report your findings here/, 'so the reviewer does not wait for a yes');
  assert.ok(r.prompt.includes(PR));
});
test('Get a review with no PR stays in the session\'s folder and reports there', () => {
  for (const t of [dev(null), { id: 't2', cwd: '/repo', running: true, work: null }, { id: 't3', cwd: '/repo', running: true }]) {
    const r = manualReview(t);
    assert.strictEqual(r.pr, undefined);
    assert.strictEqual(r.cwd, t.cwd);
    assert.match(r.prompt, /Report your findings here/);
  }
});
test('any session with a PR gets the posting review: a task with no ticket, or one that opened a PR', () => {
  const plain = { id: 't5', cwd: '/repo/.worktrees/worker-1', running: true, work: null };
  const r = manualReview(plain, PR);
  assert.strictEqual(r.pr, PR, 'the PR the page saw it open, or its task\'s PR');
  assert.strictEqual(r.from, plain.cwd);
  assert.match(r.prompt, /Post your findings as a PR comment/);
  assert.strictEqual(manualReview(dev(PR), 'https://github.com/o/r/pull/9').pr, PR, 'the relay\'s record of the Dev\'s PR comes first');
});
test('only a real PR link counts, and a reviewer is not reviewed', () => {
  const reviewer = { id: 't4', cwd: '/repo/.worktrees/review-1', work: { role: 'reviewer', pr: PR } };
  assert.strictEqual(manualReview(reviewer).pr, undefined, 'a reviewer is not reviewed again');
  assert.strictEqual(manualReview({ id: 't6', cwd: '/r', role: 'reviewer', pr: PR, work: null }, PR).pr, undefined);
  assert.strictEqual(manualReview(dev('https://example.com/pull/1')).pr, undefined);
  assert.ok(PR_URL.test(PR));
});

// ---------- a push to a Dev's PR brings a follow-up review (T-54, step 1) ----------
const { followUps, followBrief, MAX_AUTO_REVIEWS } = require('../../office/reviews.js');
const { pushedIn } = require('../office-hook.js');

test('the hook tells a git push that may have sent commits from one that did not', () => {
  const sent = { stdout: 'To github.com:o/r.git\n   1234567..89abcde  HEAD -> task/a', stderr: '' };
  for (const cmd of ['git push', 'git push -q', 'git push -u origin HEAD', 'cd x && git push', 'git add -A && git commit -m "fix" && git push', 'git -C /repo push',
    'GIT_TRACE=0 git push origin task/a', 'if true; then git push; fi', 'env X=1 git push', 'git -c push.default=current push', 'command git push', 'git push && gh pr view',
    // T-70: quiet, piped or blocked pushes may have sent commits too. The relay checks whether the PR moved.
    'git push -q 2>&1 | tail -1; git log --oneline -1', 'git push -q -u origin HEAD 2>&1 | tail -2', 'git push || true', 'git push 2>&1 | tail -3', 'git push; echo done', 'git push &',
    '{ git push; }', 'if git push; then echo ok; fi', 'for r in a b; do git push origin $r; done', 'while ! git push; do sleep 1; done']) {
    assert.strictEqual(pushedIn(cmd, sent), true, cmd);
    assert.strictEqual(pushedIn(cmd, { stdout: '', stderr: '' }), true, cmd + ', with nothing printed');
  }
  assert.strictEqual(pushedIn('git push', { stdout: 'Everything up-to-date' }), false, 'nothing new went up');
  assert.strictEqual(pushedIn('git push -q 2>&1 | tail -1', { stdout: 'Everything up-to-date' }), false, 'nothing new went up, piped');
  for (const cmd of ['git status', 'echo git push', 'git commit -m "then git push"', 'git log --grep push', 'git push --dry-run', 'git push -n', "git commit -F - <<'M'\nsee; git push\nM",
    'git push origin --delete task/a', 'git push-all',
    // T-59: these send no commits to a branch.
    'git push --tags', 'git push origin --tags', 'git push --mirror', 'git push origin :task/a', 'git push origin :task/a :task/b > out.txt', 'if true; then git push --tags; fi']) {
    assert.strictEqual(pushedIn(cmd, sent), false, cmd);
  }
  assert.strictEqual(pushedIn('git push || true', { stdout: '', gitOperation: { push: { branch: 'task/a' } } }), true, 'Claude Code saw the push itself');
  assert.strictEqual(pushedIn('git push', { stdout: 'Everything up-to-date', gitOperation: { push: { branch: 'task/a' } } }), false, 'up to date, even when Claude Code saw a push');
  // Review of PR 149: one of two pushes sent commits while the other was up to date.
  assert.strictEqual(pushedIn('git push origin a && git push origin b', { stdout: 'Everything up-to-date\nTo github.com:o/r.git\n   1234567..89abcde  b -> b', gitOperation: { push: { branch: 'b' } } }), true, 'one push was up to date, the other sent commits');
  // Second review of PR 149: only a ref line of a branch that moved counts against "Everything up-to-date".
  for (const [out, want] of [[' = [up to date]  main -> main\nEverything up-to-date', false], [' * [new tag]  v1 -> v1\nEverything up-to-date', false],
    ['lrwxr-x  1 me  link -> target\nEverything up-to-date', false], ['Everything up-to-date\n + 1234567...89abcde  HEAD -> b (forced update)', true],
    ['Everything up-to-date\n * [new branch]  HEAD -> b', true],
    // Third review of PR 149: --porcelain lines, as git 2 prints them, and a ref outside refs/heads.
    ['Everything up-to-date\nTo ../o.git\n \tHEAD:refs/heads/main\tb1d0206..197cbea\nDone', true], ['Everything up-to-date\n*\tHEAD:refs/heads/b\t[new branch]', true],
    ['Everything up-to-date\n=\tHEAD:refs/heads/main\t[up to date]', false], ['Everything up-to-date\n * [new reference]   HEAD -> refs/pull/8/head', true]]) assert.strictEqual(pushedIn('git push -v', { stderr: out }), want, out);
  for (const cmd of ['git push origin --tags task/a', 'git push origin +HEAD:task/a', 'git push -o ci.skip origin task/a', 'git push > log.txt', 'git push origin task/a :old', 'git push origin :', 'git push origin +:'])
    assert.strictEqual(pushedIn(cmd, sent), true, cmd);
});
test('a push waits for the Dev\'s turn to end, and for any review of that PR to finish', () => {
  const pending = new Map([[PR, { from: '/repo/.worktrees/task-a', dev: 't1' }]]);
  const devAt = (state) => Object.assign(dev(PR), { state });
  const reviewer = { id: 't9', running: true, role: 'reviewer', pr: PR };
  assert.deepStrictEqual(followUps(pending, [devAt('working')], {}).start, [], 'the Dev may push again this turn');
  assert.deepStrictEqual(followUps(pending, [devAt('idle'), reviewer], {}).start, [], 'a review is running');
  const r = followUps(pending, [devAt('idle'), Object.assign({}, reviewer, { running: false })], {});
  assert.deepStrictEqual(r.start, [{ pr: PR, from: '/repo/.worktrees/task-a' }]);
  assert.deepStrictEqual(followUps(pending, [devAt('waiting')], {}).start, [], 'a Dev waiting on the person is still in its turn');
  assert.deepStrictEqual(followUps(pending, [], {}).start.length, 1, 'a Dev that has ended has finished pushing');
});
test('a push saved before a restart still waits for its Dev, brought back under a new desk id (T-61)', () => {
  const pending = new Map([[PR, { from: '/repo', dev: 'old-desk', session: 'sess-1' }]]);
  const back = (state) => [Object.assign(dev(PR), { id: 'new-desk', sessionId: 'sess-1', state })];
  assert.deepStrictEqual(followUps(pending, back('working'), {}).start, [], 'the same Dev, at a new desk, is still in its turn');
  assert.deepStrictEqual(followUps(pending, back('waiting'), {}).start, [], 'and at a question');
  assert.strictEqual(followUps(pending, back('idle'), {}).start.length, 1, 'its turn ended');
  const other = [Object.assign(dev(PR), { id: 'new-desk', sessionId: 'sess-2', state: 'working' })];
  assert.strictEqual(followUps(pending, other, {}).start.length, 1, 'another session in a turn does not hold it');
});
test('a PR gets at most a few automatic reviews, then it waits on the person', () => {
  const pending = new Map([[PR, { from: '/repo', dev: 't1' }]]);
  const idle = [Object.assign(dev(PR), { state: 'idle' })];
  assert.strictEqual(followUps(pending, idle, { [PR]: MAX_AUTO_REVIEWS - 1 }).start.length, 1);
  const r = followUps(pending, idle, { [PR]: MAX_AUTO_REVIEWS });
  assert.deepStrictEqual(r.start, []);
  assert.deepStrictEqual(r.full, [PR]);
  assert.strictEqual(MAX_AUTO_REVIEWS, 3);
});
test('a follow-up review posts, and checks the earlier findings', () => {
  const b = followBrief(PR);
  assert.match(b, /Post your findings as a PR comment/);
  assert.match(b, /earlier review/);
  assert.ok(b.includes(PR));
});
test('a follow-up that could not start waits a while before it tries again', () => {
  const idle = [Object.assign(dev(PR), { state: 'idle' })];
  const pending = new Map([[PR, { from: '/repo', dev: 't1', notBefore: 2000 }]]);
  assert.deepStrictEqual(followUps(pending, idle, {}, 1000).start, []);
  assert.strictEqual(followUps(pending, idle, {}, 2000).start.length, 1);
});

// ---------- a follow-up is owed from what the relay knows, with no hook (T-176) ----------
const { followUpOwed } = require('../../office/reviews.js');

test('a reviewed PR whose head moved owes a follow-up, with no push hook needed', () => {
  const A = 'a'.repeat(40), B = 'b'.repeat(40);
  const rec = (extra) => Object.assign({ count: 1, head: A, pending: null, waits: false, reviewedAt: 1000 }, extra);
  const seen = (extra) => Object.assign({ state: 'green', head: B, open: true, at: 2000 }, extra);
  const o = (extra) => Object.assign({ follows: true, reviewing: false, max: 3 }, extra);
  assert.strictEqual(followUpOwed(rec(), seen(), o()), 'review', 'the head moved since the last review');
  assert.strictEqual(followUpOwed(rec(), seen({ head: A }), o()), '', 'the PR is at the head its last review read');
  assert.strictEqual(followUpOwed(rec(), seen(), o({ follows: false })), '', 'Review again after each push is off');
  assert.strictEqual(followUpOwed(null, seen(), o()), '', 'a PR the relay never reviewed');
  assert.strictEqual(followUpOwed(rec({ head: null, first: { from: '/r' } }), seen(), o()), '', 'its first review still waits');
  assert.strictEqual(followUpOwed(rec(), null, o()), '', 'the pipeline has not asked about it yet');
  assert.strictEqual(followUpOwed(rec(), seen({ at: 900 }), o()), '', 'heard before the last review began, so it may not know that commit');
  assert.strictEqual(followUpOwed(rec(), seen({ open: false }), o()), '', 'merged or closed');
  assert.strictEqual(followUpOwed(rec({ pending: { from: '/r' } }), seen(), o()), '', 'one is already queued');
  assert.strictEqual(followUpOwed(rec(), seen(), o({ reviewing: true })), '', 'a review of it is running');
  assert.strictEqual(followUpOwed(rec({ queued: B }), seen(), o()), '', 'this head was queued before, and could not start or moved nothing');
  assert.strictEqual(followUpOwed(rec({ count: 3 }), seen(), o()), 'person', 'the limit is used up');
  assert.strictEqual(followUpOwed(rec({ count: 3, waits: true }), seen(), o()), '', 'the person was told already');
  assert.strictEqual(followUpOwed(rec({ count: 3 }), seen(), o({ max: 4 })), 'review', 'a higher limit in Settings');
  // A red head is owed too: it waits in the pipeline gate, which tells the Dev once and starts nothing until it is green.
  assert.strictEqual(followUpOwed(rec(), seen({ state: 'red' }), o()), 'review');
});
