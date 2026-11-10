'use strict';
// A stuck task does not hold Autopilot up. On 2026-11-07 a Dev sat at a permission prompt for git commit
// from 06:40 to 08:52: Autopilot counted it as busy, so its task kept the only slot, and the update
// after a merge waited for that session, so Autopilot started nothing at all.
// Through a real relay, with a fake claude and a fake gh.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep, sessionToken } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, message) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  sh(cwd, 'add', file);
  sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
};
const PR = 'https://github.com/acme/widgets/pull/7';
const GREEN = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const ASKS = 'Claude needs your permission to use Bash';

function helpers(R) {
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (sessionId, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: sessionId.slice(0, 12) }, extra));
  const taskOf = async (tk) => (await R.call('GET', '/tasks')).body.tasks.find((x) => x.ticket === tk.id);
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  return { terminals, say, taskOf, ap };
}

test('a Dev at a question past the stuck time: its task waits on you, the session stays, and the next ticket starts', async (t) => {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_AUTOPILOT_STALL_MS: '3000', RELAY_WIP_LIMIT: '1' });
  t.after(async () => { await R.stop(); fs.rmSync(gh, { recursive: true, force: true }); });
  const { terminals, say, taskOf, ap } = helpers(R);
  const repo = makeRepo(R.home);
  const first = (await R.call('POST', '/tickets', { title: 'First one', repo })).body.ticket;
  const second = (await R.call('POST', '/tickets', { title: 'Second one', repo })).body.ticket;

  await R.call('POST', '/autopilot', { on: true, only: [first.id, second.id] });
  const task = await until(() => taskOf(first), 'the first ticket to start');
  const dev = task.owner.sessionId;
  await say(dev, 'UserPromptSubmit');
  await say(dev, 'Notification', { message: ASKS });
  await sleep(1500);
  assert.strictEqual(await taskOf(second), undefined, 'one at a time, and the Dev has not been at its question long yet');
  assert.strictEqual((await taskOf(first)).state, 'building');

  const parked = await until(async () => { const x = await taskOf(first); return x.state === 'waiting_on_you' && x; }, 'the stuck task to wait on you');
  const move = parked.history.filter((h) => h.type === 'moved').pop();
  assert.strictEqual(move.by, 'Autopilot');
  assert.match(move.note, /Its Dev .* at a question \(Claude needs your permission to use Bash\) for \d+ minutes\. The session is still open at its desk: answer it there/);
  const desk = (await terminals()).find((x) => x.sessionId === dev);
  assert.ok(desk && desk.running, 'the stuck session still runs');
  assert.strictEqual(desk.state, 'waiting');
  assert.ok((await ap()).notes.some((n) => /^T-\d+ waits on you: Its Dev/.test(n.text)));

  // Out of Autopilot's count and the WIP limit of 1, so the next ticket starts.
  const next = await until(() => taskOf(second), 'the next Ready ticket to start');
  assert.strictEqual(next.by, 'Autopilot');
  await say(next.owner.sessionId, 'UserPromptSubmit');  // at work, so the old stall rule leaves it alone
  assert.ok((await terminals()).some((x) => x.sessionId === dev && x.running), 'still at its desk');

  // The person answers it, and the task is back.
  await say(dev, 'PostToolUse', { tool_name: 'Bash' });
  await say(dev, 'PreToolUse', { tool_name: 'Bash' });
  const back = await until(async () => { const x = await taskOf(first); return x.state === 'building' && x; }, 'the task to go back to Building');
  assert.match(back.history.filter((h) => h.type === 'moved').pop().note, /moved again, so the task is back/);
  assert.ok((await ap()).notes.some((n) => /is back from Waiting on you/.test(n.text)));
});

test('an update waits on a session in a turn, and Autopilot still starts and merges other tasks', async (t) => {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R0 = await relay({});
  const home = R0.home;
  await R0.kill();
  // The relay's folder, which Update pulls into from its own origin.
  const src = makeRepo(home, 'src'), relayOrigin = path.join(home, 'relay-origin.git'), dir = path.join(home, 'relay-folder');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, relayOrigin); sh(home, 'clone', '-q', relayOrigin, dir); sh(src, 'remote', 'add', 'origin', relayOrigin);
  // The repo the tickets are for, with its PR 7 on a fake GitHub.
  const repo = makeRepo(home), origin = path.join(home, 'origin.git');
  sh(home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/main');
  const R = await relay({ RELAY_UPDATE_DIR: dir, GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' }, home, { autoReview: true });
  t.after(async () => { await R.kill(); await R.remove(); fs.rmSync(gh, { recursive: true, force: true }); });
  await R.call('POST', '/reviews', { auto: true });  // the first relay in this home turned it off
  const { terminals, say, taskOf, ap } = helpers(R);
  const merged = () => { try { return fs.readFileSync(path.join(gh, 'merged.log'), 'utf8'); } catch (e) { return ''; } };

  // A session of the person's is in a turn, so the update waits for it.
  const busy = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await say(busy.sessionId, 'UserPromptSubmit');
  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
  const u = await R.call('POST', '/update', {});
  assert.strictEqual(u.status, 202, JSON.stringify(u.body));
  assert.deepStrictEqual(u.body.update.waitingOn.map((w) => w.why), ['in a turn']);

  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const task = await until(() => taskOf(ticket), 'Autopilot to start the ticket while the update waits');
  assert.strictEqual(task.by, 'Autopilot');

  // The Dev pushes its PR, a review says merge, and Autopilot merges it.
  fs.writeFileSync(path.join(task.worktree, 'a.txt'), 'hello\n');
  sh(task.worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello');
  sh(task.worktree, 'push', '-qf', origin, 'HEAD:refs/pull/7/head');
  sh(task.worktree, 'update-ref', 'refs/remotes/origin/pr', 'HEAD');  // as a real push records it, so nothing is unpushed (relay/merge-hold.js)
  const head = sh(task.worktree, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }] } }));
  await say(task.owner.sessionId, 'UserPromptSubmit');
  await say(task.owner.sessionId, 'PostToolUse', { pr_url: PR, cwd: task.worktree });
  await say(task.owner.sessionId, 'Stop');
  const r = await until(async () => (await terminals()).find((x) => x.role === 'reviewer' && x.pr === PR), 'a reviewer');
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
  // The fake gh does not move main, so the merge lands on the relay's origin here, as GitHub would put it there.
  commit(src, 'relay/x.js', '3\n', 'the merged PR'); sh(src, 'push', '-q', 'origin', 'main');
  const mergedMain = sh(src, 'rev-parse', 'HEAD');
  assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);
  await say(r.sessionId, 'UserPromptSubmit');
  await say(r.sessionId, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-1' } });
  await say(r.sessionId, 'Stop');
  await until(() => merged().includes(PR + ' --merge --match-head-commit ' + head), 'Autopilot to merge while the update waits');

  // Once GitHub shows it merged, the task is done, and the merge made while the update waits is fetched
  // into that same update, so its restart pulls and runs it.
  fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'MERGED', headRefOid: head, mergeStateStatus: 'UNKNOWN', statusCheckRollup: GREEN } } }));
  await until(async () => (await taskOf(ticket)).state === 'done', 'the task to be done');
  const still = await until(async () => { const u = (await R.call('GET', '/update')).body.update; return u && u.to === mergedMain && u; }, 'the restart to run the merged commit');
  // Fetched, not pulled: the folder moves only just before the restart.
  assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), u.body.from, 'the relay\'s folder is as it was while the update waits');
  sh(dir, 'cat-file', '-e', mergedMain + '^{commit}');
  assert.ok(!(await ap()).notes.some((n) => /Could not pull main/.test(n.text)), JSON.stringify((await ap()).notes));
  assert.strictEqual(still.state, 'waiting', 'the update still waits for the session in its turn');
  assert.ok(still.waitingOn.some((w) => w.terminal === busy.id && w.why === 'in a turn'), 'and names it: ' + JSON.stringify(still.waitingOn));
  assert.strictEqual((await ap()).on, true);
});

test('an update does not wait for a session at a question, and the session comes back still at it', async (t) => {
  const R0 = await relay({});
  const home = R0.home;
  await R0.kill();
  const src = makeRepo(home, 'src'), relayOrigin = path.join(home, 'relay-origin.git'), dir = path.join(home, 'relay-folder');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, relayOrigin); sh(home, 'clone', '-q', relayOrigin, dir); sh(src, 'remote', 'add', 'origin', relayOrigin);
  // RELAY_RESUME brings the session back after the restart.
  const R = await relay({ RELAY_UPDATE_DIR: dir, RELAY_RESUME: '1' }, home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const { say } = helpers(R);
  const asking = (await R.call('POST', '/terminals', { cwd: dir })).body;
  const busy = (await R.call('POST', '/terminals', { cwd: dir })).body;
  await say(asking.sessionId, 'UserPromptSubmit');
  await say(asking.sessionId, 'Notification', { message: ASKS });
  await say(busy.sessionId, 'UserPromptSubmit');  // in a turn, so the update waits for it
  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
  const run = (await R.call('GET', '/update')).body.run;
  const u = await R.call('POST', '/update', {});
  assert.strictEqual(u.status, 202, JSON.stringify(u.body));
  // Only the relay can answer a question, so the one at it is not named.
  assert.deepStrictEqual(u.body.update.waitingOn.map((w) => [w.terminal, w.why]), [[busy.id, 'in a turn']]);
  // Once the other turn ends, the relay restarts with the question still open.
  await say(busy.sessionId, 'Stop');
  const restarted = await until(async () => {
    try { const g = (await R.call('GET', '/update')).body; return g.run !== run && g; } catch (e) { return null; }
  }, 'the relay to restart', 200);
  assert.strictEqual(restarted.update, null);
  const back = await until(async () => { try { return (await R.call('GET', '/terminals')).body.terminals.find((x) => x.sessionId === asking.sessionId); } catch (e) { return null; } }, 'the session to come back');
  assert.ok(back.running, 'the session came back after the restart');
  assert.strictEqual(back.id, asking.id, 'taken back, not started again');
  assert.strictEqual(back.state, 'waiting', 'still at its question');
  assert.strictEqual(back.message, ASKS);
});
