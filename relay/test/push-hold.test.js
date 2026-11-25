// The push hold (relay/push-hold.js and .githooks/pre-push), run with real git pushes from a task
// worktree to a bare remote. On 2026-11-09 three Devs pushed after a merge verdict, and one push broke
// what was reviewed (T-253).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const hold = require('../push-hold.js');

const HOOKS = path.resolve(__dirname, '..', '..', '.githooks');
const PR = 'https://github.com/acme/widgets/pull/7';
const SAID = /Push refused: The review of [0-9a-f]{7} says merge\. Do not push\. Reply on the PR, and file a ticket only for a finding that is a real bug or risk outside this PR\./;

function setup() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-push-hold-')));
  const origin = path.join(home, 'origin.git'), repo = path.join(home, 'repo'), wt = path.join(repo, '.worktrees', 'x');
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'main\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'config', 'core.hooksPath', HOOKS);
  git(repo, 'worktree', 'add', '-q', '-b', 'task/x', wt, 'main');
  let n = 0;
  const commit = (cwd, file) => { fs.writeFileSync(path.join(cwd, file || 'a.txt'), 'change ' + (++n) + '\n'); git(cwd, 'commit', '-qam', 'change ' + n); return git(cwd, 'rev-parse', 'HEAD'); };
  const push = () => { const r = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/task/x'], { cwd: wt, encoding: 'utf8' }); return { ok: r.status === 0, out: r.stdout + r.stderr }; };
  const task = { pr: PR, state: 'in_review', base: 'main', worktree: wt };
  const say = (kind, commit) => hold.sync(task, { kind, commit, posted: PR + '#issuecomment-1' });
  return { home, repo, wt, git, commit, push, task, say, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('after a merge verdict, a push of new work is refused with the message', (t) => {
  const s = setup();
  t.after(s.done);
  const reviewed = s.commit(s.wt);
  assert.ok(s.push().ok);
  assert.strictEqual(s.say('merge', reviewed), true, 'the mark is written');
  assert.ok(fs.existsSync(path.join(hold.gitDirOf(s.wt), hold.MARK)));
  assert.strictEqual(s.git(s.wt, 'status', '--porcelain'), '', 'git does not see the mark');
  s.commit(s.wt);
  const r = s.push();
  assert.strictEqual(r.ok, false, r.out);
  assert.match(r.out, SAID);
  assert.match(r.out, new RegExp(reviewed.slice(0, 7)));
  assert.strictEqual(s.git(path.join(s.home, 'origin.git'), 'rev-parse', 'task/x'), reviewed, 'the remote keeps the reviewed commit');
});

test('after a merge verdict, a push of a merge of main is allowed, and new work after it is still refused', (t) => {
  const s = setup();
  t.after(s.done);
  const reviewed = s.commit(s.wt);
  assert.ok(s.push().ok);
  s.say('merge', reviewed);
  s.commit(s.repo, 'b.txt');
  s.git(s.repo, 'push', '-q', 'origin', 'main');
  s.git(s.wt, 'fetch', '-q', 'origin');
  s.git(s.wt, 'merge', '-q', '--no-edit', 'origin/main');
  const r = s.push();
  assert.strictEqual(r.ok, true, r.out);
  s.commit(s.wt);
  const again = s.push();
  assert.strictEqual(again.ok, false, again.out);
  assert.match(again.out, SAID);
});

test('a merge of another branch is refused', (t) => {
  const s = setup();
  t.after(s.done);
  const reviewed = s.commit(s.wt);
  assert.ok(s.push().ok);
  s.say('merge', reviewed);
  s.git(s.repo, 'checkout', '-q', '-b', 'side', 'main');
  s.commit(s.repo, 'b.txt');
  s.git(s.wt, 'merge', '-q', '--no-edit', 'side');
  const r = s.push();
  assert.strictEqual(r.ok, false, r.out);
  assert.match(r.out, SAID);
});

test('after a fix verdict, the mark is gone and a push works', (t) => {
  const s = setup();
  t.after(s.done);
  const reviewed = s.commit(s.wt);
  assert.ok(s.push().ok);
  s.say('merge', reviewed);
  assert.strictEqual(s.say('fix', reviewed), true, 'the mark is removed');
  assert.ok(!fs.existsSync(path.join(hold.gitDirOf(s.wt), hold.MARK)));
  s.commit(s.wt);
  const r = s.push();
  assert.strictEqual(r.ok, true, r.out);
});

test('a merge verdict on a commit older than the PR head does not hold the push', (t) => {
  const s = setup();
  t.after(s.done);
  const reviewed = s.commit(s.wt);
  assert.ok(s.push().ok);
  s.commit(s.wt);
  assert.ok(s.push().ok, 'the Dev pushed while the review ran');
  s.say('merge', reviewed);
  s.commit(s.wt);
  const r = s.push();
  assert.strictEqual(r.ok, true, r.out);
});

test('the mark follows the latest posted verdict, and goes once the PR merges or the task is Done', () => {
  const task = { pr: PR, state: 'in_review', base: 'main', worktree: '/x' };
  const merge = { kind: 'merge', commit: 'abc1234', posted: PR + '#issuecomment-1' };
  assert.deepStrictEqual(hold.markOf(task, merge, null), { pr: PR, commit: 'abc1234', base: 'main' });
  assert.strictEqual(hold.markOf(task, Object.assign({}, merge, { posted: null }), null), null, 'a verdict counts once posted');
  assert.strictEqual(hold.markOf(task, Object.assign({}, merge, { kind: 'fix' }), null), null);
  assert.strictEqual(hold.markOf(task, merge, { open: false }), null, 'the PR merged or closed');
  assert.strictEqual(hold.markOf(Object.assign({}, task, { state: 'done' }), merge, null), null);
  assert.strictEqual(hold.markOf(Object.assign({}, task, { pr: null }), merge, null), null);
  assert.strictEqual(hold.sync(task, merge, null), false, 'no checkout, no mark');
});

// 2026-11-24, PR #402: main moved after a merge verdict, and the merge needed two more commits (an API version
// bump and a test fix). The merge alone failed CI, and the hold refused the merge with its fixes (T-424).
function mergeMain(s, file) {
  s.commit(s.repo, file || 'b.txt');
  s.git(s.repo, 'push', '-q', 'origin', 'main');
  s.git(s.wt, 'fetch', '-q', 'origin');
  s.git(s.wt, 'merge', '-q', '--no-edit', 'origin/main');
}
const refusedOf = (s) => hold.refusalsOf(s.task).list;

test('under a push hold, a merge of main plus a commit that changes only a file the merge changed is allowed', (t) => {
  const s = setup();
  t.after(s.done);
  const reviewed = s.commit(s.wt);
  assert.ok(s.push().ok);
  s.say('merge', reviewed);
  mergeMain(s);
  s.commit(s.wt, 'b.txt');
  const r = s.push();
  assert.strictEqual(r.ok, true, r.out);
  assert.strictEqual(s.git(path.join(s.home, 'origin.git'), 'rev-parse', 'task/x'), s.git(s.wt, 'rev-parse', 'HEAD'));
  assert.deepStrictEqual(refusedOf(s), [], 'nothing was refused');
  s.commit(s.wt, 'b.txt');
  assert.strictEqual(s.push().ok, true, 'a second fix on the same file in a later push is allowed too');
});

test('under a push hold, a merge of main plus a commit that changes an unrelated file is refused, with what and why', (t) => {
  const s = setup();
  t.after(s.done);
  const reviewed = s.commit(s.wt);
  assert.ok(s.push().ok);
  s.say('merge', reviewed);
  mergeMain(s);
  s.commit(s.wt, 'b.txt');
  const unrelated = s.commit(s.wt, 'a.txt');
  const r = s.push();
  assert.strictEqual(r.ok, false, r.out);
  assert.match(r.out, SAID);
  assert.match(r.out, new RegExp('Refused: commit ' + unrelated.slice(0, 7) + ' changes a\\.txt, which the merge did not change\\.'));
  assert.match(r.out, /only commits that change files the merge changed/);
  const [line] = refusedOf(s);
  assert.deepStrictEqual([line.pr, line.commit, line.tip, line.why], [PR, reviewed, unrelated, 'commit ' + unrelated.slice(0, 7) + ' changes a.txt, which the merge did not change.']);
  assert.strictEqual(hold.refusalsOf(s.task).seen, 0, 'the relay has not logged it yet');
});

test('a fix before the merge, or on a new file, is refused', (t) => {
  const s = setup();
  t.after(s.done);
  const reviewed = s.commit(s.wt);
  assert.ok(s.push().ok);
  s.say('merge', reviewed);
  s.commit(s.wt, 'a.txt');
  mergeMain(s);
  const before = s.push();
  assert.strictEqual(before.ok, false, 'new work before the merge: ' + before.out);
  assert.match(before.out, /is new work, not a merge of the base or a fix after one/);
  s.git(s.wt, 'reset', '-q', '--hard', reviewed);
  mergeMain(s, 'b.txt');
  fs.writeFileSync(path.join(s.wt, 'c.txt'), 'new\n');
  s.git(s.wt, 'add', 'c.txt');
  s.git(s.wt, 'commit', '-qm', 'new file');
  const added = s.push();
  assert.strictEqual(added.ok, false, 'a file the merge did not touch: ' + added.out);
  assert.match(added.out, /changes c\.txt, which the merge did not change/);
});

test('a refused push is noted, a later allowed push is noted after it, and the notes go with the mark', (t) => {
  const s = setup();
  t.after(s.done);
  const reviewed = s.commit(s.wt);
  assert.ok(s.push().ok);
  s.say('merge', reviewed);
  mergeMain(s);
  s.commit(s.wt, 'a.txt');
  assert.strictEqual(s.push().ok, false);
  s.git(s.wt, 'reset', '-q', '--hard', 'HEAD~1');
  s.commit(s.wt, 'b.txt');
  assert.strictEqual(s.push().ok, true);
  assert.deepStrictEqual(refusedOf(s).map((l) => !!l.allowed), [false, true]);
  hold.markSeen(s.task, 2);
  assert.strictEqual(hold.refusalsOf(s.task).seen, 2);
  s.say('fix', reviewed);
  assert.deepStrictEqual(hold.refusalsOf(s.task), { list: [], seen: 0 });
});

test('a merge verdict on a red PR has no mark, and the Dev push goes through', (t) => {
  const s = setup();
  t.after(s.done);
  const reviewed = s.commit(s.wt);
  assert.ok(s.push().ok);
  const mark = path.join(hold.gitDirOf(s.wt), hold.MARK);
  const verdict = { kind: 'merge', commit: reviewed, posted: PR + '#issuecomment-1' };
  assert.strictEqual(hold.sync(s.task, verdict, { state: 'red', failing: true, open: true }), true, 'the lift is written');
  assert.ok(!fs.existsSync(mark));
  assert.strictEqual(hold.untoldLift(s.task).commit, reviewed, 'the lift is kept for the relay to tell the Dev and log the jam');
  s.commit(s.wt);
  const r = s.push();
  assert.ok(r.ok, r.out);
  assert.doesNotMatch(r.out, SAID);
  for (const state of ['pending', 'green']) {
    hold.sync(s.task, verdict, { state, open: true });
    assert.ok(!fs.existsSync(mark), state + ' on the same verdict keeps the hold off until a newer verdict');
  }
  assert.strictEqual(hold.sync(s.task, { kind: 'merge', commit: s.commit(s.wt), posted: PR + '#issuecomment-2' }, { state: 'green', open: true }), true);
  assert.ok(fs.existsSync(mark), 'the follow-up review says merge, so the hold is back on the new commit');
  assert.strictEqual(hold.untoldLift(s.task), null);
});

test('a merge verdict on a green, pending or unread pipeline still has the hold', (t) => {
  const s = setup();
  t.after(s.done);
  const reviewed = s.commit(s.wt);
  const verdict = { kind: 'merge', commit: reviewed, posted: PR + '#issuecomment-1' };
  for (const seen of [{ state: 'green', open: true }, { state: 'pending', open: true }, { state: 'unknown', open: true }, undefined]) {
    fs.rmSync(path.join(hold.gitDirOf(s.wt), hold.MARK), { force: true });
    assert.strictEqual(hold.sync(s.task, verdict, seen), true);
    s.commit(s.wt);
    assert.strictEqual(s.push().ok, false);
    s.git(s.wt, 'reset', '-q', '--hard', reviewed);
  }
});

test('the Dev is told CI is red, not that a finding must be fixed', () => {
  assert.strictEqual(hold.RED_CI_TEXT, 'CI is red on your PR. Fix the failure in this PR, run the tests, and push. A follow-up review checks the fix.');
  assert.doesNotMatch(hold.RED_CI_TEXT, /finding/);
});

test('a cancelled run reads as red but lifts nothing, and a failed one lifts', () => {
  const pipeline = require('../pipeline.js');
  const cancelled = [{ conclusion: 'CANCELLED', status: 'COMPLETED' }], failed = [{ conclusion: 'FAILURE', status: 'COMPLETED' }];
  assert.strictEqual(pipeline.failingOf(cancelled), false);
  assert.strictEqual(pipeline.failingOf(failed), true);
  const s = setup();
  const reviewed = s.commit(s.wt);
  const verdict = { kind: 'merge', commit: reviewed, posted: PR + '#issuecomment-1' };
  const seen = (rollup) => ({ state: pipeline.stateOf(rollup), failing: pipeline.failingOf(rollup), open: true });
  assert.strictEqual(hold.sync(s.task, verdict, seen(cancelled)), true);
  assert.ok(fs.existsSync(path.join(hold.gitDirOf(s.wt), hold.MARK)), 'the hold stays');
  assert.strictEqual(hold.untoldLift(s.task), null);
  hold.sync(s.task, verdict, seen(failed));
  assert.ok(!fs.existsSync(path.join(hold.gitDirOf(s.wt), hold.MARK)), 'the hold lifts');
  s.done();
});
