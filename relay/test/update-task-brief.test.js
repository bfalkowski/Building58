'use strict';
// A task's brief goes in while an update waits for a quiet moment (T-299). On 2026-11-15 Autopilot
// merged T-244 at 15:22 and pulled main, so an update waited for every session to be quiet. It went on
// and started T-250 at 15:26 while other Devs were in a turn. The relay held the new Dev's brief for
// the whole wait, and the Dev sat idle until the restart at 16:28. T-266 waited 54 minutes the same
// way. Now only the restart itself holds a task's brief, as it does a reviewer's first prompt (T-147).
// Through a real relay, with a fake claude.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, message) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  sh(cwd, 'add', file);
  sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
};
const BRIEF = 'Fix the widget for T-299', GOT = 'GOT[Your task is to build this now: Widget.';

test('a Dev started while an update waits gets its brief then, and once', async (t) => {
  const R0 = await relay({});
  const home = R0.home;
  await R0.kill();
  const src = makeRepo(home, 'src'), relayOrigin = path.join(home, 'relay-origin.git'), dir = path.join(home, 'relay-folder');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, relayOrigin); sh(home, 'clone', '-q', relayOrigin, dir); sh(src, 'remote', 'add', 'origin', relayOrigin);
  const repo = makeRepo(home);

  const R = await relay({ RELAY_UPDATE_DIR: dir, RELAY_RESUME: '1' }, home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const say = (sessionId, event) => R.hook({ hook_event_name: event, session_id: sessionId.slice(0, 12) });
  const update = async () => (await R.call('GET', '/update')).body;
  const typed = async (id) => (await R.screen(id)).split(GOT).length - 1;
  const taskOf = async (id) => (await R.call('GET', '/tasks/' + id)).body.task;

  const busy = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await say(busy.sessionId, 'UserPromptSubmit');
  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
  const run = (await update()).run;
  const u = await R.call('POST', '/update', {});
  assert.strictEqual(u.status, 202, JSON.stringify(u.body));

  const created = await R.call('POST', '/tasks', { title: 'Widget', brief: BRIEF, repo });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const task = created.body.task, devId = task.worker.terminal;
  const dev = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === devId);

  await t.test('the brief goes in while the update waits', async () => {
    await until(async () => (await typed(devId)) === 1, 'the Dev to get its brief while the update waits');
    const view = (await update()).update;
    assert.strictEqual(view && view.state, 'waiting', 'the update still waits for the other session');
  });

  await t.test('the task is briefed once a turn begins, and the update waits for that turn', async () => {
    await say(dev.sessionId, 'UserPromptSubmit');
    await until(async () => (await taskOf(task.id)).briefed === true, 'the task to be briefed');
    await say(busy.sessionId, 'Stop');
    await sleep(1500);
    const view = (await update()).update;
    assert.ok(view && view.waitingOn.some((w) => w.terminal === devId && w.why === 'in a turn'), JSON.stringify(view));
  });

  await t.test('after the restart the Dev is back, and its brief is not typed again', async () => {
    await say(dev.sessionId, 'Stop');
    await until(async () => { try { return (await update()).run !== run; } catch (e) { return false; } }, 'the relay to restart');
    const back = await until(async () => { try { return (await R.call('GET', '/terminals')).body.terminals.find((x) => x.sessionId === dev.sessionId); } catch (e) { return null; } }, 'the Dev to come back');
    await sleep(2500);
    assert.strictEqual(await typed(back.id), 1, 'typed once');
  });
});
