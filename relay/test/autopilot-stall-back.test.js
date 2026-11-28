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
const { relay, makeRepo, removeDir, until, sessionToken } = require('./helpers.js');
const { prBrief } = require('../../office/reviews.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PR = 'https://github.com/acme/widgets/pull/7';
const GREEN = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const STALL = 2000;

async function rig(t) {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_AUTOPILOT_STALL_MS: String(STALL), RELAY_REVIEW_GRACE_MS: '200' });
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
  // What the page's Get a review sends. Its reviewer gives a verdict and posts.
  const reviewSays = async (kind) => {
    const r = await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.body.sessionId); } catch (e) { return null; } }, 'its token') };
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind }, token)).status, 200);
    await say(r.body.sessionId, 'UserPromptSubmit');
    await say(r.body.sessionId, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-1' } });
    await say(r.body.sessionId, 'Stop');
  };
  const parked = () => until(async () => { const x = await taskOf(); return x.state === 'waiting_on_you' && x; }, 'the task to wait on you');
  const lastMove = (x) => x.history.filter((h) => h.type === 'moved').pop();
  const reviewSaysMerge = () => reviewSays('merge');
  return { R, dev, taskOf, ap, say, merged, openPr, reviewSays, reviewSaysMerge, parked, lastMove };
}

test('a task parked with no PR comes back once its Dev opens one, and then merges', async (t) => {
  const { dev, taskOf, ap, say, merged, openPr, reviewSaysMerge, parked, lastMove } = await rig(t);
  await say(dev, 'Stop');
  const p = await parked();  // after the nudge and one more stall time
  // The reason says what Autopilot saw: an open session, idle, with no PR.
  // With a stall time of 2 s the nudge may not be typed in before it expires (T-221), and the reason says which.
  assert.match(lastMove(p).note, /^Autopilot: Nothing moved it for \d+ minutes: its Dev has been idle for \d+ minutes with no PR, and ((took|did not start) a turn after Autopilot nudged it|the nudge Autopilot saved for it) \d+ minutes ago( was never typed in)?\.$/);
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
  assert.deepStrictEqual([back.to, back.by], ['building', 'Autopilot']);
  assert.match(back.note, /^Autopilot: a review of PR #7 (started|was posted with the verdict merge), so the task is back\.$/);
});

// On 2026-11-23 Autopilot handed PRs #338 to #342 to the person as "Waiting for the review." while the reviews
// waited for a desk. A review that starts takes such a PR back, before it posts.
test('a task parked only for a review that did not start comes back once a review starts', async (t) => {
  const { dev, taskOf, say, openPr, parked, lastMove, R } = await rig(t);
  const { prBrief: brief } = require('../../office/reviews.js');
  const wt = (await taskOf()).worktree;
  await openPr();
  await say(dev, 'Stop');
  const p = await parked();
  assert.match(lastMove(p).note, /\(Waiting for the review\.\)\.$/);
  const r = await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: brief(PR) });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const back = await until(async () => { const x = await taskOf(); return x.state === 'building' && x; }, 'the task to come back when the review started');
  assert.strictEqual(lastMove(back).note, 'Autopilot: a review of PR #7 started, so the task is back.');
});

// On 2026-11-19 Needs you said Waiting for the review for #113 to #115 for hours after their reviews were
// posted. Autopilot had parked them, then was off, so nothing took them back, and the line kept the old reason.
test('with Autopilot off, a fix verdict posted after the park makes Needs you say to bring back the stopped Dev', async (t) => {
  const { R, taskOf, say, dev, openPr, reviewSays, parked } = await rig(t);
  const head = await openPr();
  await say(dev, 'Stop');
  const p = await parked();
  const needs = async () => (await R.call('GET', '/needs-you')).body.items.filter((i) => i.task === p.id);
  assert.match((await needs())[0].line, /^Decide on PR #7 \(T-\d+\): Nothing moved it for \d+ minutes \(Waiting for the review\.\)\.$/);
  await R.call('POST', '/autopilot', { on: false });
  await R.call('POST', '/terminals/' + p.owner.terminal + '/stop', {});
  await until(async () => !(await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === p.owner.terminal), 'the Dev to stop');
  await reviewSays('fix');
  const items = await until(async () => { const x = await needs(); return x.length && /says fix/.test(x[0].line) && x; }, 'Needs you to read the verdict');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'handed-over');
  assert.strictEqual(items[0].line, 'Bring back the worker on ' + p.ticket + ' to fix PR #7: the review of ' + head.slice(0, 7) + ' says fix, and its session has ended. ' + PR + '#issuecomment-1');
  assert.deepStrictEqual(items[0].link, { ticket: p.ticket });
  assert.strictEqual((await taskOf()).state, 'waiting_on_you', 'Autopilot is off, so the card stays where it was');
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

// T-221: the reason says a nudge reached the Dev only when the delivery queue typed it in.
const typed = (min) => ({ at: now - 30 * 60000, typedAt: min === null ? null : now - min * 60000 });
const idleDev = (extra) => Object.assign({ state: 'idle', lastActAt: now - 60 * 60000 }, extra);

test('a nudge saved but never typed in says so, not that the Dev ignored it', () => {
  assert.strictEqual(noPrWhy('office', { nudged: { 'task-1': typed(null) } }, task, idleDev(), now),
    'its Dev has been idle for 60 minutes with no PR, and the nudge Autopilot saved for it 30 minutes ago was never typed in');
});

test('a nudge typed in counts its turn and its minutes from when it went in', () => {
  assert.strictEqual(noPrWhy('office', { nudged: { 'task-1': typed(20) } }, task, idleDev({ turnAt: now - 25 * 60000 }), now),
    'its Dev has been idle for 60 minutes with no PR, and did not start a turn after Autopilot nudged it 20 minutes ago');
  assert.strictEqual(noPrWhy('office', { nudged: { 'task-1': typed(20) } }, task, idleDev({ turnAt: now - 10 * 60000 }), now),
    'its Dev has been idle for 60 minutes with no PR, and took a turn after Autopilot nudged it 20 minutes ago');
});

test('working out the reason does not forget the nudge: only a park or a hand-over does', () => {
  const c = { nudged: { 'task-1': typed(20) } };
  noPrWhy('office', c, task, idleDev(), now);
  assert.ok(c.nudged['task-1']);
});

// Ticket 520: a Dev that says its work is on main with a commit is not nudged and not counted as stalled.
test('a Dev that says its work is on main with a commit is handed over with that reason, and the task comes back when it moves', async (t) => {
  const { dev, taskOf, say, parked, lastMove } = await rig(t);
  await say(dev, 'Stop', { on_main: '7db2737' });
  const p = await parked();
  assert.match(lastMove(p).note, /^Autopilot: Its Dev says the work is already on main in commit 7db2737, so this is not a stall: it can close the ticket with ticket\.js not-needed T-\d+ --commit 7db2737 --why\.$/);
  await say(dev, 'UserPromptSubmit');
  const back = await until(async () => { const x = await taskOf(); return x.state === 'building' && x; }, 'the task to go back to Building');
  assert.match(lastMove(back).note, /^Autopilot: \S+ moved again, so the task is back\.$/);
});
