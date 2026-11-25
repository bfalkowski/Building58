'use strict';
// T-361: a PR with review news its Dev was never told, and an ended Dev, did not go to Autopilot's Dev
// again: it went to the person ("There is review news its Dev was never told, and its session has
// ended."). Now Autopilot brings the Dev back, and the saved news is told on resume. With no free desk it
// waits for one, as it does for a start, and hands the PR over only if the resume fails.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, removeDir, until, sessionToken } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(args), { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/widgets/pull/7';
const GREEN = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const NEWS = PR + '#issuecomment-102';

async function office(t) {
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200', RELAY_REVIEW_POLL_SECONDS: '3600' }, null, { autoReview: true });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const ticket = (await R.call('POST', '/tickets', { title: 'Untold news', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(task, 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  await until(async () => /GOT\[Your task is to build/.test(await R.screen(dev.id)), 'the brief');
  await say(dev, 'UserPromptSubmit');
  await until(async () => (await task()).history.some((h) => h.type === 'briefed'), 'the brief to land');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'change\n');
  sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change');
  sh(wt, 'push', '-qf', origin, 'HEAD:refs/pull/7/head'); sh(wt, 'update-ref', 'refs/remotes/origin/pr', 'HEAD');
  const head = sh(wt, 'rev-parse', 'HEAD');
  const comments = [{ id: 102, html_url: NEWS, body: 'Please also rename the helper.', created_at: new Date().toISOString(), user: { login: 'someone' } }];
  const answer = (list) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }], 'repos/acme/widgets/issues/7/comments': list } }));
  answer(comments);
  await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  await say(dev, 'Stop');
  const r = await until(async () => (await terminals()).find((y) => y.role === 'reviewer' && y.pr === PR), 'a reviewer');
  await R.call('POST', '/terminals/' + dev.id + '/stop', {});
  await until(async () => !(await terminals()).some((y) => y.id === dev.id), 'the Dev to stop');
  const review = { id: 101, html_url: PR + '#issuecomment-101', body: '## Review of ' + head + '\nVerdict: merge.', created_at: new Date().toISOString(), user: { login: 'reviewer' } };
  return { ticket: ticket.id, R, repo, dev, r, say, task, ap, terminals, ghDir, answer: () => answer([review].concat(comments)) };
}
async function told(o, back) {
  const dev = (await o.terminals()).find((y) => y.id === back.worker.terminal);
  await o.say(dev, 'Stop');
  await until(async () => (await o.task()).history.some((h) => h.type === 'review' && /^Told the Dev about \d+ new comments?/.test(h.note || '')), 'the news told on resume');
}
async function mergeVerdict(o) {
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(o.r.sessionId); } catch (e) { return null; } }, 'its token') };
  assert.strictEqual((await o.R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);
  await o.say(o.r, 'UserPromptSubmit');
  await o.say(o.r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-101' } });
  o.answer();
  await o.say(o.r, 'Stop');
}

test('review news its Dev was never told, and an ended Dev: Autopilot brings the Dev back, and it is told', async (t) => {
  const o = await office(t);
  await mergeVerdict(o);
  const back = await until(async () => { const y = await o.task(); return y.worker && y.worker.terminal !== o.dev.id && y; }, 'the Dev brought back');
  assert.ok(back.history.some((h) => h.type === 'resumed' && h.by === 'Autopilot'), JSON.stringify(back.history));
  await until(async () => (await o.R.screen(back.worker.terminal)).includes('--resume'), 'the same conversation');
  await told(o, back);
  const a = await o.ap();
  assert.ok(a.notes.some((n) => /its Dev was not running, so Autopilot brought it back for review news it was never told/.test(n.text)), JSON.stringify(a.notes));
  assert.notStrictEqual((await o.task()).state, 'waiting_on_you', 'nothing went to the person');
});

test('review news its Dev was never told, and no free desk: the PR waits for a desk and is not handed over', async (t) => {
  const o = await office(t);
  await o.R.call('POST', '/autopilot', { on: false });
  await mergeVerdict(o);
  await until(async () => !(await o.terminals()).some((y) => y.id === o.r.id), 'the reviewer to end');
  for (let i = 0; i < 12 && (await o.R.call('POST', '/terminals', { cwd: o.repo })).status < 400; i++);
  assert.ok((await o.R.call('POST', '/terminals', { cwd: o.repo })).status >= 400, 'every desk is taken');
  await o.R.call('POST', '/autopilot', { on: true, only: o.ticket });
  await until(async () => (await o.ap()).prs.some((p) => /All \d+ worker desks are taken/.test(p.why || '')), 'the wait for a desk');
  const waiting = await o.task();
  assert.notStrictEqual(waiting.state, 'waiting_on_you', 'not handed over');
  assert.ok(!waiting.history.some((h) => h.type === 'resumed'), 'no Dev yet');
  const free = (await o.terminals()).find((y) => !y.task && !y.role && !y.lead);
  await o.R.call('POST', '/terminals/' + free.id + '/stop', {});
  const back = await until(async () => { const y = await o.task(); return y.worker && y.worker.terminal !== o.dev.id && y; }, 'the Dev back on the freed desk');
  await told(o, back);
  assert.notStrictEqual((await o.task()).state, 'waiting_on_you');
});
