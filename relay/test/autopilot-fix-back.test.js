'use strict';
// 499: On 2026-11-25 the relay stopped the Devs of two PRs to free desks for their reviews, and both reviews said
// fix. A stopped Dev held no WIP slot, so each freed slot went to a new ticket, and both tasks were handed
// to the person as stalled and waited 4.5 hours. Now a task owed a fix keeps its slot, Autopilot starts nothing
// new while a Dev is owed, and the task waits for its turn and is not handed over as stalled.
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

async function office(t) {
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_AUTOPILOT_STALL_MS: '2000', RELAY_REVIEW_GRACE_MS: '200', RELAY_REVIEW_POLL_SECONDS: '3600', RELAY_WIP_LIMIT: '1' }, null, { autoReview: true });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const tasks = async () => (await R.call('GET', '/tasks')).body.tasks;
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const first = (await R.call('POST', '/tickets', { title: 'Owed a fix', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: first.id });
  const x = await until(async () => (await tasks())[0], 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  await until(async () => /GOT\[Your task is to build/.test(await R.screen(dev.id)), 'the brief');
  await say(dev, 'UserPromptSubmit');
  await until(async () => (await tasks())[0].history.some((h) => h.type === 'briefed'), 'the brief to land');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'change\n');
  sh(wt, 'commit', '-qam', 'change');
  sh(wt, 'push', '-qf', origin, 'HEAD:refs/pull/7/head'); sh(wt, 'update-ref', 'refs/remotes/origin/pr', 'HEAD');
  const head = sh(wt, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }], 'repos/acme/widgets/issues/7/comments': [] } }));
  await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  await say(dev, 'Stop');
  const r = await until(async () => (await terminals()).find((y) => y.role === 'reviewer' && y.pr === PR), 'a reviewer');
  await R.call('POST', '/terminals/' + dev.id + '/stop', {});
  await until(async () => !(await terminals()).some((y) => y.id === dev.id), 'the Dev to stop');
  return { first, R, repo, dev, r, say, tasks, ap, terminals };
}
async function fixVerdict(o) {
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(o.r.sessionId); } catch (e) { return null; } }, 'its token') };
  assert.strictEqual((await o.R.call('POST', '/autopilot/verdict', { kind: 'fix' }, token)).status, 200);
  await o.say(o.r, 'UserPromptSubmit');
  await o.say(o.r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-101' } });
  await o.say(o.r, 'Stop');
  await until(async () => !(await o.terminals()).some((y) => y.id === o.r.id), 'the reviewer to end');
}
async function fillDesks(o) {
  for (let i = 0; i < 12 && (await o.R.call('POST', '/terminals', { cwd: o.repo })).status < 400; i++);
  assert.ok((await o.R.call('POST', '/terminals', { cwd: o.repo })).status >= 400, 'every desk is taken');
}

test('a task owed a fix keeps its slot: no new ticket starts first, and the Dev comes back on the freed desk', async (t) => {
  const o = await office(t);
  await o.R.call('POST', '/autopilot', { on: false });
  await fixVerdict(o);
  await fillDesks(o);
  const second = (await o.R.call('POST', '/tickets', { title: 'New work', repo: o.repo })).body.ticket;
  await o.R.call('POST', '/autopilot', { on: true, only: null });
  const a = await until(async () => { const y = await o.ap(); return /^Waiting to bring back/.test(y.idle || '') && y; }, 'the wait to bring back').catch(async (e) => { throw new Error(e.message + ' ' + JSON.stringify(await o.ap())); });
  assert.ok(!a.notes.some((n) => n.text.includes(second.id + ' starts once one is free')), 'no start is queued for the new ticket: ' + JSON.stringify(a.notes));
  assert.match(a.idle, new RegExp('^Waiting to bring back the Dev of ' + o.first.id + ' for fixes first: All \\d+ worker desks are taken'));
  const free = (await o.terminals()).find((y) => !y.task && !y.role && !y.lead);
  await o.R.call('POST', '/terminals/' + free.id + '/stop', {});
  const back = await until(async () => { const y = (await o.tasks())[0]; return y.worker && y.worker.terminal !== o.dev.id && y; }, 'the Dev back on the freed desk');
  assert.ok(back.history.some((h) => h.type === 'resumed' && h.by === 'Autopilot'));
  const all = await o.tasks();
  assert.strictEqual(all.length, 1, 'the new ticket did not start: ' + JSON.stringify(all.map((x) => x.ticket)));
});

test('a task waiting only to be brought back is not handed over as stalled, and Needs you says why once it waits too long', async (t) => {
  const o = await office(t);
  await o.R.call('POST', '/autopilot', { on: false });
  await fixVerdict(o);
  await fillDesks(o);
  await o.R.call('POST', '/autopilot', { on: true, only: null });
  const line = await until(async () => ((await o.R.call('GET', '/needs-you')).body.items || []).find((i) => i.task && /bring back/i.test(i.line)), 'the Needs you line', 15000);
  assert.match(line.line, /All \d+ worker desks are taken/);
  const x = (await o.tasks())[0];
  assert.notStrictEqual(x.state, 'waiting_on_you');
  assert.ok(!x.history.some((h) => h.type === 'moved' && h.to === 'waiting_on_you'), 'never handed over');
});
