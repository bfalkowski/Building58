'use strict';
// On 2026-11-23 Devs were stopped to free desks, their PRs then got reviews, and Autopilot handed PRs 339,
// 340 and 343 to the person: review news its Dev was never told, and its session had ended. Now it brings
// the Dev back, and the news is told on resume. With no free desk it waits. Through a real relay, with a
// fake claude and a fake gh.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, removeDir, until, sessionToken } = require('./helpers.js');
const { prBrief } = require('../../office/reviews.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PR = 'https://github.com/acme/widgets/pull/7';
const GREEN = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const DESKS = 9;
const NEWS = /GOT\[[^\]a-z]{0,8}There is news on your pull request/g;

async function rig(t) {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_POLL_SECONDS: '1', RELAY_REVIEW_GRACE_MS: '200', RELAY_WIP_LIMIT: '8' });
  t.after(async () => { await R.stop(); removeDir(gh); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/main');
  sh(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
  const taskOf = async () => (await R.call('GET', '/tasks')).body.tasks.find((x) => x.ticket === ticket.id);
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const say = (sessionId, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: sessionId.slice(0, 12) }, extra));
  const merged = () => { try { return fs.readFileSync(path.join(gh, 'merged.log'), 'utf8'); } catch (e) { return ''; } };
  await R.call('POST', '/autopilot', { on: true, only: [ticket.id] });
  const task = await until(taskOf, 'the ticket to start');
  const dev = task.owner.sessionId, wt = task.worktree;
  await until(async () => (await R.screen(task.owner.terminal)).includes('GOT['), 'the brief');
  await say(dev, 'UserPromptSubmit');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
  sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello');
  sh(wt, 'push', '-qf', origin, 'HEAD:refs/pull/7/head');
  sh(wt, 'update-ref', 'refs/remotes/origin/pr', 'HEAD');
  const head = sh(wt, 'rev-parse', 'HEAD');
  const comment = (id, body) => ({ id, html_url: PR + '#issuecomment-' + id, body, user: { login: 'me' } });
  fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify({
    prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } },
    api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }], 'repos/acme/widgets/issues/7/comments': [comment(1, 'Review: merge.'), comment(2, 'Finding: a.txt needs a newline.')], 'repos/acme/widgets/pulls/7/reviews': [], 'repos/acme/widgets/pulls/7/comments': [] } }));
  await say(dev, 'PostToolUse', { tool_name: 'Bash', pr_url: PR, cwd: wt });
  await say(dev, 'Stop');
  await R.call('POST', '/terminals/' + task.owner.terminal + '/stop', {});
  await until(async () => !(await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === task.owner.terminal), 'the Dev to stop');
  const reviewSaysMerge = async () => {
    const r = await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.body.sessionId); } catch (e) { return null; } }, 'its token') };
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);
    await say(r.body.sessionId, 'UserPromptSubmit');
    await say(r.body.sessionId, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-1' } });
    await say(r.body.sessionId, 'Stop');
    return r.body;
  };
  return { R, repo, dev, taskOf, ap, merged, head, reviewSaysMerge };
}

test('review news its Dev was never told, with the Dev stopped, brings the Dev back and tells it', async (t) => {
  const { R, dev, taskOf, ap, merged, reviewSaysMerge } = await rig(t);
  await reviewSaysMerge();
  const back = await until(async () => { const x = await taskOf(); return x.worker && x.worker.terminal !== undefined && x.history.some((h) => h.type === 'resumed' && h.by === 'Autopilot') && x; }, 'the Dev brought back');
  await until(async () => (await R.screen(back.worker.terminal)).includes('--resume'), 'the same conversation');
  await until(async () => ((await R.screen(back.worker.terminal)).match(NEWS) || []).length === 1, 'the Dev to be told the news');
  assert.ok((await ap()).notes.some((n) => /its Dev was not running, so Autopilot brought it back for the review news it was never told/.test(n.text)));
  assert.notStrictEqual((await taskOf()).state, 'waiting_on_you', 'nothing went to the person');
  assert.strictEqual(merged(), '', 'and nothing merged before the Dev answered');
  assert.ok(dev);
});

test('with no free desk the PR waits, is not handed over, and its Dev comes back once a desk is free', async (t) => {
  const { R, repo, taskOf, ap, reviewSaysMerge } = await rig(t);
  const plain = [];
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  while ((await terminals()).length < DESKS - 1) plain.push((await R.call('POST', '/terminals', { cwd: repo })).body);
  await reviewSaysMerge();
  assert.strictEqual((await terminals()).length, DESKS, 'every desk is taken');
  await until(async () => /for a free desk|room/.test((await ap()).prs && JSON.stringify((await ap()).prs) || ''), 'the PR to wait for a desk');
  const x = await taskOf();
  assert.notStrictEqual(x.state, 'waiting_on_you', 'not handed over');
  assert.ok(!x.history.some((h) => h.type === 'resumed'), 'not brought back yet');
  await R.call('POST', '/terminals/' + plain[0].id + '/stop', {});
  const back = await until(async () => { const y = await taskOf(); return y.history.some((h) => h.type === 'resumed' && h.by === 'Autopilot') && y; }, 'the Dev brought back once a desk is free');
  assert.notStrictEqual(back.state, 'waiting_on_you');
});
