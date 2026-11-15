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
const SAID = /Push refused: The review of [0-9a-f]{7} says merge\. Do not push\. Reply on the PR and file one follow-up ticket for the findings\./;

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
