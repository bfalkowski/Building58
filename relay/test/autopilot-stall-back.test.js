'use strict';
// A task that Autopilot parked because nothing moved it comes back by itself once something does. On
// 2026-11-08 Autopilot parked T-181 at 17:25Z with no PR. Its Dev opened PR 153 five minutes later and the
// review said merge at 17:40Z, but Autopilot watched only for a merge, so the task sat with the person
// until they merged it at 18:30Z.
// Through a real relay, with a fake claude and a fake gh.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sessionToken } = require('./helpers.js');
const { prBrief } = require('../../office/reviews.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PR = 'https://github.com/acme/widgets/pull/7';
const GREEN = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const STALL = 2000;

async function rig(t) {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_AUTOPILOT_STALL_MS: String(STALL), RELAY_REVIEW_GRACE_MS: '200' });
  t.after(async () => { await R.stop(); fs.rmSync(gh, { recursive: true, force: true }); });
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
  // The Dev's commit, pushed as the PR's head, so nothing in its checkout is unpushed (relay/merge-hold.js).
  const openPr = async () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
    sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello');
    sh(wt, 'push', '-qf', origin, 'HEAD:refs/pull/7/head');
    sh(wt, 'update-ref', 'refs/remotes/origin/pr', 'HEAD');
    const head = sh(wt, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }] } }));
    await say(dev, 'PostToolUse', { tool_name: 'Bash', pr_url: PR, cwd: wt });
    return head;
  };
  // What the page's Get a review sends. Its reviewer gives a merge verdict and posts.
  const reviewSaysMerge = async () => {
    const r = await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.body.sessionId); } catch (e) { return null; } }, 'its token') };
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);
    await say(r.body.sessionId, 'UserPromptSubmit');
    await say(r.body.sessionId, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-1' } });
    await say(r.body.sessionId, 'Stop');
  };
  const parked = () => until(async () => { const x = await taskOf(); return x.state === 'waiting_on_you' && x; }, 'the task to wait on you', 200);
  const lastMove = (x) => x.history.filter((h) => h.type === 'moved').pop();
  return { R, dev, taskOf, ap, say, merged, openPr, reviewSaysMerge, parked, lastMove };
}

test('a task parked with no PR comes back once its Dev opens one, and then merges', async (t) => {
  const { dev, taskOf, ap, say, merged, openPr, reviewSaysMerge, parked, lastMove } = await rig(t);
  await say(dev, 'Stop');
  const p = await parked();  // after the nudge and one more stall time
  // The reason says what Autopilot saw: an open session, idle, with no PR.
  assert.match(lastMove(p).note, /^Autopilot: Nothing moved it for \d+ minutes: its Dev has been idle for \d+ minutes with no PR, and (took|did not start) a turn after Autopilot nudged it \d+ minutes ago\.$/);
  assert.ok((await ap()).notes.some((n) => /waits on you: Nothing moved it .*idle for \d+ minutes with no PR/.test(n.text)), 'and the Autopilot view says it too');

  const head = await openPr();
  const back = await until(async () => { const x = await taskOf(); return x.state === 'building' && x; }, 'the task to go back to Building');
  const move = lastMove(back);
  assert.strictEqual(move.by, 'Autopilot');
  assert.strictEqual(move.note, 'Autopilot: its Dev opened PR #7, so the task is back.');
  assert.ok((await ap()).notes.some((n) => /is back from Waiting on you: its Dev opened PR #7\./.test(n.text)));

  await reviewSaysMerge();
  await until(() => merged().includes(PR + ' --merge --match-head-commit ' + head), 'Autopilot to merge it');
});

test('a task parked with a PR comes back once a review is posted with a verdict, and then merges', async (t) => {
  const { taskOf, say, dev, merged, openPr, reviewSaysMerge, parked, lastMove } = await rig(t);
  const head = await openPr();
  await say(dev, 'Stop');
  const p = await parked();  // no reviewer, and its Dev idle: nothing moves it
  assert.match(lastMove(p).note, /^Autopilot: Nothing moved it for \d+ minutes \(Waiting for the review\.\)\.$/);
  assert.strictEqual(merged(), '');

  await reviewSaysMerge();
  await until(() => merged().includes(PR + ' --merge --match-head-commit ' + head), 'Autopilot to merge it');
  const x = await taskOf();
  const back = x.history.find((h) => h.type === 'moved' && h.from === 'waiting_on_you');
  assert.deepStrictEqual([back.to, back.by, back.note], ['building', 'Autopilot', 'Autopilot: a review of PR #7 was posted with the verdict merge, so the task is back.']);
});

test('a task parked with a PR comes back once its Dev sends a hook', async (t) => {
  const { taskOf, say, dev, openPr, parked, lastMove } = await rig(t);
  await openPr();
  await say(dev, 'Stop');
  await parked();
  await say(dev, 'UserPromptSubmit');
  const back = await until(async () => { const x = await taskOf(); return x.state === 'building' && x; }, 'the task to go back to Building');
  assert.match(lastMove(back).note, /^Autopilot: its Dev \S+ moved again, so the task is back\.$/);
});

test('a card the person moved after the park stays with them when the task moves again', async (t) => {
  const { R, taskOf, say, dev, openPr, parked, lastMove } = await rig(t);
  await openPr();
  await say(dev, 'Stop');
  const p = await parked();
  assert.strictEqual((await R.call('POST', '/tasks/' + p.id + '/move', { to: 'waiting_on_you' })).status, 200);  // already there: no move
  assert.strictEqual((await R.call('POST', '/tasks/' + p.id + '/move', { to: 'changes_requested' })).status, 200);
  assert.strictEqual((await R.call('POST', '/tasks/' + p.id + '/move', { to: 'waiting_on_you' })).status, 200);
  await say(dev, 'UserPromptSubmit');
  await new Promise((r) => setTimeout(r, 1500));
  const x = await taskOf();
  assert.strictEqual(x.state, 'waiting_on_you', 'the person put it there, so it stays');
  assert.strictEqual(lastMove(x).by, 'you');
});

// The reason a task with no PR goes to Waiting on you counts the Dev's idle time from its last hook, or
// from when its session started if it never sent one, never from now.
const { noPrWhy } = require('../nudge.js');

const now = Date.parse('2026-11-08T17:25:00Z');
const task = { id: 'task-1' };

test('a Dev with no hook is idle since its session started, not for 0 minutes', () => {
  const dev = { state: 'idle', startedAt: new Date(now - 31 * 60000).toISOString() };
  assert.strictEqual(noPrWhy('office', {}, task, dev, now), 'its Dev has been idle for 31 minutes with no PR');
});

test('a Dev with a hook is idle since that hook', () => {
  const dev = { state: 'idle', lastActAt: now - 40 * 60000, startedAt: new Date(now - 90 * 60000).toISOString() };
  assert.strictEqual(noPrWhy('office', {}, task, dev, now), 'its Dev has been idle for 40 minutes with no PR');
});

test('a Dev whose session ended says so', () => {
  assert.strictEqual(noPrWhy('office', {}, task, { exited: true }, now), 'its Dev\'s session ended, and there is no PR');
});
