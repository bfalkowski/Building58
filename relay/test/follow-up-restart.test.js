'use strict';
// A push waiting for its follow-up review still gets it after the relay restarts and brings its Dev back
// at a new desk (T-61). The relay keeps the push in RELAY_REVIEWS_FILE with the Dev's session id, so the
// review still waits for that Dev's turn to end, and starts once.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/widgets/pull/12';
const ENV = { RELAY_RESUME: '1', RELAY_REVIEW_RETRY_MS: '500' };
const QUIET = 2500;  // long enough for the relay's one-second check to have run twice

test('a push waiting for its follow-up keeps it through a restart that moves its Dev to a new desk', async (t) => {
  let R = await relay(ENV, null, { autoReview: true });
  const home = R.home, repo = makeRepo(home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const origin = path.join(home, 'origin.git');
  sh(home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  let n = 0;
  const commit = () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'change ' + (++n) + '\n');
    sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change ' + n);
    sh(repo, 'push', '-qf', origin, 'HEAD:refs/pull/12/head');
    return sh(repo, 'rev-parse', 'HEAD');
  };
  const say = (sid, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: sid.slice(0, 12) }, extra));
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const reviewers = async () => (await terminals()).filter((x) => x.role === 'reviewer' && x.pr === PR);
  const count = async () => (await R.call('GET', '/reviews')).body.prs.find((p) => p.pr === PR).count;

  assert.strictEqual((await R.call('POST', '/reviews', { again: true })).body.again, true);
  const dev = (await R.call('POST', '/terminals', { cwd: repo })).body;
  commit();
  await say(dev.sessionId, 'PostToolUse', { pr_url: PR, cwd: repo });
  const first = await until(async () => (await reviewers())[0], 'the first review');
  // The Dev pushes in a turn, while the first review still runs, and the relay stops.
  await say(dev.sessionId, 'UserPromptSubmit');
  const head = commit();
  await say(dev.sessionId, 'PostToolUse', { pushed: true });
  await sleep(1200);
  assert.strictEqual((await reviewers()).length, 1, 'nothing new while the first review runs');
  await R.kill();

  R = await relay(ENV, home, { autoReview: true });
  const back = await until(async () => (await terminals()).find((x) => x.sessionId === dev.sessionId && x.role !== 'reviewer'), 'the Dev back');
  const reviewerBack = await until(async () => (await reviewers())[0], 'the first reviewer back');

  await t.test('the Dev is back at a new desk, and the push still waits', async () => {
    assert.notStrictEqual(back.id, dev.id, 'a new desk');
    const rec = (await R.call('GET', '/reviews')).body.prs.find((p) => p.pr === PR);
    assert.deepStrictEqual([rec.pending, rec.count], [true, 1]);
  });

  await t.test('the follow-up waits for that Dev\'s turn, found by its session id', async () => {
    await say(dev.sessionId, 'UserPromptSubmit');  // the Dev, at its new desk, is in a turn again
    await R.call('POST', '/terminals/' + reviewerBack.id + '/stop', {});
    await until(async () => !(await terminals()).some((x) => x.id === reviewerBack.id), 'the first reviewer to stop');
    await sleep(QUIET);
    assert.deepStrictEqual(await reviewers(), [], 'the Dev may still push this turn');
    assert.strictEqual(await count(), 1, 'nothing spent yet');
  });

  await t.test('its turn ends: one follow-up starts, of the pushed head, counted once', async () => {
    await say(dev.sessionId, 'Stop');
    const second = await until(async () => (await reviewers())[0], 'the follow-up');
    assert.notStrictEqual(second.id, first.id);
    const at = (await R.call('GET', '/checkouts')).body.checkouts.find((c) => c.path === second.cwd).commit;
    assert.strictEqual(at, head);
    await sleep(QUIET);
    assert.strictEqual((await reviewers()).length, 1, 'one follow-up');
    assert.strictEqual(await count(), 2, 'the automatic review count is spent once');
  });
});
