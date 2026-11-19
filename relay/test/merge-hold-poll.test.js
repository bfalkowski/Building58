'use strict';
// T-229, through a real relay with a fake claude and a fake gh. Office B's PR 48 merged 52 seconds after
// its merge verdict was posted, before the comment check (every 60 seconds) had told the Dev of the
// review, so the Dev's fixes landed on a branch that had already merged. Here the poll runs once an
// hour, so only the post itself starts a check, and the merge waits until a check has seen the review.
// The reviewer stays a minute after its turn (REVIEW_GRACE), so the hold must start when the verdict
// counts, as the post is seen (T-230), not when the reviewer's session ends.
// The comment check reads the PR's reviews, and Autopilot's look for a post the hook never reported does
// not, so failing that one list stops every check while that look still works. GitHub may also list a
// new comment late: then the checks work but do not list the review, and the hold must stay until one does.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep, sessionToken, removeDir } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/widgets/pull/7';
const GREEN = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const HOLD = 'No comment check has listed the latest posted review on the PR yet, so its Dev was not told of it.';
const REVIEWS = 'repos/acme/widgets/pulls/7/reviews';

async function ready(t, env) {
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '60000', RELAY_REVIEW_POLL_SECONDS: '3600', ...env }, null, { autoReview: true });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const c = { R, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }], user: { login: 'office-bot' } }, head: null, failApi: null };
  c.answer = () => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: c.head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: c.api, failApi: c.failApi }));
  c.checks = () => { try { return fs.readFileSync(path.join(ghDir, 'calls.log'), 'utf8').split('\n').filter((l) => l.includes(REVIEWS)).length; } catch (e) { return 0; } };
  c.merged = () => { try { return fs.readFileSync(path.join(ghDir, 'merged.log'), 'utf8'); } catch (e) { return ''; } };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  c.say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  c.task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  c.ap = async () => (await R.call('GET', '/autopilot')).body;
  c.answer();

  const ticket = (await R.call('POST', '/tickets', { title: 'Easy one', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(c.task, 'the task'), wt = x.worktree;
  c.dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  c.floorHold = async () => (await R.call('GET', '/floor')).body.sessions.find((s) => s.terminal === c.dev.id).mergeHold;
  await until(async () => /GOT\[Your task is to build/.test(await R.screen(c.dev.id)), 'the brief');
  await c.say(c.dev, 'UserPromptSubmit');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
  sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello');
  sh(wt, 'push', '-qf', origin, 'HEAD:refs/pull/7/head'); sh(wt, 'update-ref', 'refs/remotes/origin/pr', 'HEAD');
  c.head = sh(wt, 'rev-parse', 'HEAD'); c.answer();
  await c.say(c.dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  await c.say(c.dev, 'Stop');

  c.r = await until(async () => (await terminals()).find((y) => y.role === 'reviewer' && y.pr === PR), 'a reviewer');
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(c.r.sessionId); } catch (e) { return null; } }, 'its token') };
  assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);
  c.failApi = { [REVIEWS]: 'HTTP 502' };
  c.api['repos/acme/widgets/issues/7/comments'] = [{ id: 201, html_url: PR + '#issuecomment-201', user: { login: 'office-bot' }, body: '## Review of ' + c.head.slice(0, 7) + '\n\nNot blocking: rename b. **Verdict: merge.**', created_at: new Date(Date.now() + 1000).toISOString() }];
  c.review = c.api['repos/acme/widgets/issues/7/comments'];
  c.answer();
  c.asked = c.checks();
  await c.say(c.r, 'UserPromptSubmit');
  return c;
}

async function held(c) {
  await until(() => c.checks() > c.asked, 'a check right after the post, an hour before the next poll');
  await sleep(1500);
  assert.strictEqual(c.merged(), '', 'merged a review its Dev was not told of');
  assert.strictEqual((await c.ap()).prs[0].why, HOLD);
  assert.strictEqual(await c.floorHold(), HOLD, 'the Lead sees the hold too');
}

test('a merge verdict does not merge before the comment check has told the Dev of its review', async (t) => {
  const c = await ready(t);
  await c.say(c.r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-201' } });
  await c.say(c.r, 'Stop');

  await t.test('the post starts a check at once, and until one has seen the review there is no merge', async () => {
    await until(async () => (await c.ap()).prs.some((p) => p.verdict === 'merge' && p.why === HOLD), 'the merge verdict to count, and the hold');
    await held(c);
  });

  await t.test('once a check sees it, the Dev is told, and the merge comes only after that', async () => {
    c.failApi = null; c.answer();
    assert.strictEqual((await c.R.call('POST', '/settings', { values: { reviewPollSeconds: 1 } })).status, 200);
    await until(() => c.merged().includes(PR + ' --merge --match-head-commit ' + c.head), 'the merge');
    assert.ok((await c.task()).history.some((h) => h.type === 'review' && /^Told the Dev/.test(h.note || '')), 'the Dev was told before the merge');
  });
});

test('a review GitHub lists late holds the merge until a check lists it', async (t) => {
  const c = await ready(t);
  c.failApi = null; delete c.api['repos/acme/widgets/issues/7/comments']; c.answer();
  await c.say(c.r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-201' } });
  await c.say(c.r, 'Stop');
  await until(async () => (await c.ap()).prs.some((p) => p.verdict === 'merge'), 'the merge verdict to count');
  await held(c);
  c.api['repos/acme/widgets/issues/7/comments'] = c.review; c.answer();
  assert.strictEqual((await c.R.call('POST', '/settings', { values: { reviewPollSeconds: 1 } })).status, 200);
  await until(() => c.merged().includes(PR + ' --merge --match-head-commit ' + c.head), 'the merge');
  assert.ok((await c.task()).history.some((h) => h.type === 'review' && /^Told the Dev/.test(h.note || '')), 'the Dev was told before the merge');
});

test('a post the hook never reported holds the merge from when Autopilot finds it on the PR', async (t) => {
  const c = await ready(t);
  await c.say(c.r, 'Stop');
  await until(async () => (await c.ap()).notes.some((n) => /though its post was not seen, so its verdict counts/.test(n.text)), 'the post found on the PR');
  await held(c);
});

// T-374: a reviewer whose post only this look found stayed at its desk, since only a post the hook saw
// ended it. Ada, a reviewer of PR 107, held a desk for a day that way.
test('a post the hook never reported still ends its reviewer once its turn is over', async (t) => {
  const c = await ready(t, { RELAY_REVIEW_GRACE_MS: '1000' });
  await c.say(c.r, 'Stop');
  await until(async () => (await c.ap()).notes.some((n) => /though its post was not seen, so its verdict counts/.test(n.text)), 'the post found on the PR');
  await until(async () => !(await c.R.call('GET', '/terminals')).body.terminals.some((x) => x.id === c.r.id), 'the reviewer to leave');
});
