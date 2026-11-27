// Whether a PR holds all its Dev's work before a merge (relay/merge-hold.js, T-203), with real git checkouts.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
process.env.RELAY_SETTINGS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'merge-hold-settings-')), 'settings.json');
delete process.env.RELAY_REVIEW_POLL_SECONDS;
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

// T-221: a Dev that pushed and waits on npm test in the background is not done. Its turn ended, but
// the run may still fail and ask for a fix.
test('a Dev running a job: wait, even with uncommitted work', (t) => {
  const dir = checkout(t);
  assert.deepStrictEqual(holdOf(task(dir), dev('idle', { jobs: { count: 1 } }), now), { act: 'wait', why: 'Its Dev is running a job (a command it started still runs), maybe still answering the latest review, so the PR may not hold every fix yet.' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  assert.strictEqual(holdOf(task(dir), dev('idle', { jobs: { count: 2 } }), now).act, 'wait');
  assert.strictEqual(holdOf(task(dir), dev('idle', { jobs: { count: 0 } }), now).act, 'person', 'its job ended: the work left out goes to the person');
});

test('review news the Dev was not told yet: wait, or the person once its session has ended', (t) => {
  const dir = checkout(t);
  const told = task(dir, { reviews: { pending: { links: ['x'], count: 1 } } });
  assert.deepStrictEqual(holdOf(told, dev('idle'), now), { act: 'wait', why: 'Its Dev has not been told of the latest review yet.' });
  assert.deepStrictEqual(holdOf(told, null, now), { act: 'person', reason: 'news-untold', why: 'There is review news its Dev was never told, and its session has ended.' });
});

test('uncommitted changes or unpushed commits with the Dev idle or gone go to the person', (t) => {
  const dir = checkout(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  assert.deepStrictEqual(holdOf(task(dir), dev('idle'), now), { act: 'person', reason: 'work-left-out', why: 'Its Dev stopped, but its checkout has uncommitted changes, so the PR does not hold all its work.' });
  assert.match(holdOf(task(dir), null, now).why, /^Its Dev has ended, but its checkout has uncommitted changes/);
  sh(dir, 'commit', '-qam', 'two');
  assert.deepStrictEqual(holdOf(task(dir), dev('idle'), now), { act: 'person', reason: 'work-left-out', why: 'Its Dev stopped, but its checkout has 1 commit that is not pushed, so the PR does not hold all its work.' });
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

// T-229: a merge verdict is posted, but the comment check has not looked at the PR since, so its Dev was
// not told yet and task.reviews.pending is still empty. A merge now would leave the Dev's answer out.
test('a review posted that no comment check has listed yet: wait until one has', (t) => {
  const dir = checkout(t);
  const posted = (seen) => ({ url: 'https://github.com/a/b/pull/1#issuecomment-9', at: new Date(now - 30 * 1000).toISOString(), seen });
  const unseen = task(dir, { reviews: { pending: null, posted: posted(false), checkedAt: new Date(now - 10 * 1000).toISOString() } });
  const HOLD = { act: 'wait', why: 'No comment check has listed the latest posted review on the PR yet, so its Dev was not told of it.' };
  assert.deepStrictEqual(holdOf(unseen, dev('idle'), now), HOLD);
  assert.deepStrictEqual(holdOf(unseen, null, now), HOLD, 'a Dev that has ended too: the check still decides what is left');
  assert.strictEqual(holdOf(task(dir, { reviews: { pending: null, posted: posted(true) } }), dev('idle'), now), null, 'a check listed it and found nothing to tell');
  assert.strictEqual(holdOf(task(dir, { reviews: { pending: null } }), dev('idle'), now), null, 'no review posted by the room');
  process.env.RELAY_REVIEW_POLL_SECONDS = '0';
  t.after(() => { delete process.env.RELAY_REVIEW_POLL_SECONDS; });
  assert.strictEqual(holdOf(unseen, dev('idle'), now), null, 'with the comment check off, no check will come, and the Dev is never told of reviews');
});

// T-238: review news was typed to the Dev and delivered, so task.reviews.pending is empty, but the Dev's
// UserPromptSubmit hook has not come yet, so its hooks still say idle. A merge now would leave its answer out.
test('a Dev told something after its last turn began, with no hook since: wait', (t) => {
  const dir = checkout(t);
  const TOLD = { act: 'wait', why: 'Its Dev was told something and has not started on it yet, so the PR may not hold every fix yet.' };
  assert.deepStrictEqual(holdOf(task(dir), dev('idle', { turnAt: now - 60000, toldAt: now - 500 }), now), TOLD);
  assert.deepStrictEqual(holdOf(task(dir), dev('idle', { toldAt: now - 500 }), now), TOLD, 'no turn seen at all yet');
  assert.strictEqual(holdOf(task(dir), dev('idle', { turnAt: now - 400, toldAt: now - 500 }), now), null, 'a turn began after it was told, and has ended');
  assert.strictEqual(holdOf(task(dir), dev('idle', { exited: true, toldAt: now - 500 }), now), null, 'a Dev that has ended will not start on it');
  assert.strictEqual(holdOf(task(dir), dev('idle', { turnAt: now - 60000, toldAt: now - 16000 }), now), null, 'past RELAY_TOLD_HOLD_MS (15 seconds) the wait ends, so a note that never starts a turn cannot hold the merge for good');
});

test('a running job does not hold a merge while the push hold covers the reviewed head', (t) => {
  const dir = checkout(t);
  const head = sh(dir, 'rev-parse', 'HEAD');
  const gitDir = path.join(dir, '.git');
  const job = dev('idle', { jobs: { count: 1 } });
  assert.strictEqual(holdOf(task(dir), job, now, undefined, head).act, 'wait', 'push hold off: the job still holds');
  fs.writeFileSync(path.join(gitDir, 'office-push-hold.json'), JSON.stringify({ pr: 'x', commit: head, base: 'main' }) + '\n');
  assert.strictEqual(holdOf(task(dir), job, now, undefined, head), null, 'push hold on for this head');
  assert.strictEqual(holdOf(task(dir), job, now), null, 'head read from the checkout');
  assert.strictEqual(holdOf(task(dir), job, now, undefined, 'f'.repeat(40)).act, 'wait', 'the PR head is not the reviewed commit');
  assert.strictEqual(holdOf(task(dir), dev('working'), now, undefined, head).act, 'wait', 'a Dev in a turn still holds');
  assert.strictEqual(holdOf(task(dir), dev('waiting'), now, undefined, head).act, 'wait', 'a Dev at a question still holds');
  assert.strictEqual(holdOf(task(dir, { reviews: { pending: { links: ['x'], count: 1 } } }), job, now, undefined, head).act, 'wait', 'untold news still holds');
});
