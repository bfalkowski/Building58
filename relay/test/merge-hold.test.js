// Whether a PR holds all its Dev's work before a merge (relay/merge-hold.js, T-203), with real git checkouts.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { holdOf, unsavedWork } = require('../merge-hold.js');

const now = 10 * 60 * 60 * 1000;
const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(args), { cwd, encoding: 'utf8' }).trim();
function checkout(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-hold-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  sh(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', 'a.txt'); sh(dir, 'commit', '-qm', 'one');
  sh(dir, 'update-ref', 'refs/remotes/origin/pr', 'HEAD');  // pushed
  return dir;
}
const dev = (state, extra) => Object.assign({ state, lastActAt: now - 1000, lastOutAt: now - 1000 }, extra);
const task = (worktree, extra) => Object.assign({ id: 'abc123', pr: 'https://github.com/a/b/pull/1', worktree }, extra);

test('a clean, pushed checkout and an idle or ended Dev hold nothing back', (t) => {
  const dir = checkout(t);
  assert.strictEqual(unsavedWork(dir), null);
  assert.strictEqual(holdOf(task(dir), dev('idle'), now), null);
  assert.strictEqual(holdOf(task(dir), null, now), null, 'a Dev whose session is gone');
  assert.strictEqual(holdOf(task(dir), dev('idle', { exited: true }), now), null);
});

test('a Dev in a turn, at a question, or told news it has not started on: wait', (t) => {
  const dir = checkout(t);
  assert.deepStrictEqual(holdOf(task(dir), dev('working'), now), { act: 'wait', why: 'Its Dev is working, maybe still answering the latest review, so the PR may not hold every fix yet.' });
  assert.match(holdOf(task(dir), dev('waiting'), now).why, /^Its Dev is at a question/);
  assert.match(holdOf(task(dir), dev('working', { lastActAt: 0, lastOutAt: now - 1000 }), now).why, /^Its Dev is in a turn,/, 'quiet');
  assert.match(holdOf(task(dir), dev('working', { lastActAt: 0, lastOutAt: 0 }), now).why, /^Its Dev is in a turn with no hook/, 'stuck, silent');
  assert.match(holdOf(task(dir), dev('idle', { stuck: { at: now - 1000, why: 'x' } }), now).why, /^Its Dev has not started on what it was told/);
  // A Dev in a turn is waited for even with uncommitted work: it may be about to commit it.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  assert.strictEqual(holdOf(task(dir), dev('working'), now).act, 'wait');
});

test('review news the Dev was not told yet: wait, or the person once its session has ended', (t) => {
  const dir = checkout(t);
  const told = task(dir, { reviews: { pending: { links: ['x'], count: 1 } } });
  assert.deepStrictEqual(holdOf(told, dev('idle'), now), { act: 'wait', why: 'Its Dev has not been told of the latest review yet.' });
  assert.deepStrictEqual(holdOf(told, null, now), { act: 'person', why: 'There is review news its Dev was never told, and its session has ended.' });
});

test('uncommitted changes or unpushed commits with the Dev idle or gone go to the person', (t) => {
  const dir = checkout(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  assert.deepStrictEqual(holdOf(task(dir), dev('idle'), now), { act: 'person', why: 'Its Dev stopped, but its checkout has uncommitted changes, so the PR does not hold all its work.' });
  assert.match(holdOf(task(dir), null, now).why, /^Its Dev has ended, but its checkout has uncommitted changes/);
  sh(dir, 'commit', '-qam', 'two');
  assert.deepStrictEqual(holdOf(task(dir), dev('idle'), now), { act: 'person', why: 'Its Dev stopped, but its checkout has 1 commit that is not pushed, so the PR does not hold all its work.' });
  sh(dir, 'update-ref', 'refs/remotes/origin/pr', 'HEAD');
  assert.strictEqual(holdOf(task(dir), dev('idle'), now), null, 'pushed now');
});

test('a checkout that is gone holds nothing, and with no checkout on the task the Dev\'s folder counts', (t) => {
  const dir = checkout(t);
  assert.strictEqual(holdOf(task(path.join(dir, 'gone')), dev('idle'), now), null);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
  assert.strictEqual(holdOf(task(null), dev('idle', { cwd: dir }), now).act, 'person');
  assert.strictEqual(holdOf(task(null), null, now), null, 'no checkout and no Dev: nothing to look at');
});
