'use strict';
// T-297, through a real relay with a fake claude and a fake gh. Just before it merges, Autopilot reads the
// PR's comments once more (checkNow in relay/pr-comments.js), so a Dev's reply with the hold mark stops the
// merge. Under load a poll had read the issue comments, still empty, and was still reading the reviews when
// the Dev posted its hold reply and stopped. The check before the merge joined that poll, used its old read,
// and Autopilot merged PR 7. Here the fake gh keeps that poll on the reviews until the test lets it go, so the
// check before the merge must wait for it and then read the comments again.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, removeDir, until, sleep, sessionToken } = require('./helpers.js');
const { prBrief } = require('../../office/reviews.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/widgets/pull/7';
const GREEN = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const COMMENTS = 'repos/acme/widgets/issues/7/comments', REVIEWS = 'repos/acme/widgets/pulls/7/reviews';

test('a hold reply posted while a poll is reading the PR stops the merge', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const gate = path.join(ghDir, 'let-reviews-go');
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200', RELAY_REVIEW_POLL_SECONDS: '0' });
  t.after(async () => { fs.writeFileSync(gate, ''); await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const merged = () => { try { return fs.readFileSync(path.join(ghDir, 'merged.log'), 'utf8'); } catch (e) { return ''; } };
  const asked = (where) => { try { return fs.readFileSync(path.join(ghDir, 'calls.log'), 'utf8').split('\n').filter((c) => c.includes(where)).length; } catch (e) { return 0; } };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(task, 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
  sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello');
  sh(wt, 'push', '-qf', origin, 'HEAD:refs/pull/7/head'); sh(wt, 'update-ref', 'refs/remotes/origin/pr', 'HEAD');
  const head = sh(wt, 'rev-parse', 'HEAD');
  const answer = (comments) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }], [COMMENTS]: comments }, gateApi: { [REVIEWS]: gate } }));
  answer([]);
  await say(dev, 'UserPromptSubmit');
  await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  const r = (await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) })).body;
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
  assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);
  await say(r, 'UserPromptSubmit');
  await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-101' } });
  await say(r, 'Stop');
  await until(async () => (await ap()).prs.some((p) => p.verdict === 'merge' && /^Its Dev is working/.test(p.why || '')), 'the wait for the Dev');

  assert.strictEqual((await R.call('POST', '/settings', { values: { reviewPollSeconds: 3600 } })).status, 200);
  await until(() => asked(REVIEWS) >= 1, 'the poll to read the issue comments and reach the reviews');
  assert.strictEqual(asked(COMMENTS), 1, 'the poll read the issue comments before the reply');
  answer([{ id: 102, html_url: PR + '#issuecomment-102', body: '<!-- office:dev -->\n<!-- office:hold -->\nFinding 2 is a bug.', created_at: new Date().toISOString() }]);
  await say(dev, 'Stop');
  await until(async () => (await ap()).prs.some((p) => p.act === 'merge'), 'Autopilot to start its merge while the poll still runs');
  assert.strictEqual(asked(COMMENTS), 1, 'the check before the merge has not read the comments yet');
  assert.strictEqual(((await task()).reviews || {}).checkedAt || null, null, 'the poll is still under way');
  fs.writeFileSync(gate, '');

  await until(async () => (await task()).state === 'waiting_on_you', 'the task to wait on the person');
  assert.strictEqual(asked(COMMENTS), 2, 'the check before the merge read the comments again, after the poll');
  assert.ok((await task()).history.some((h) => /Its Dev says a finding the review marked non-blocking is a bug: https:\/\/github\.com\/acme\/widgets\/pull\/7#issuecomment-102/.test(h.note || '')), 'the card says why');
  await sleep(1000);
  assert.strictEqual(merged(), '', 'no merge on the verdict the Dev disputed');
});
