'use strict';
// Why a worker's session ended before its brief landed (T-173). On 2026-11-07 Autopilot merged PR 127 at
// 19:18 UTC and an update began to wait for a quiet moment. One session had text typed in its prompt, so
// the wait lasted until 20:35. The relay held every new session's first message for that whole wait, so
// T-53's Dev (started 19:18) and T-58's Dev (started 19:48) sat with an empty screen. The person stopped
// them as stuck at 19:28 and 20:20, and each task noted "the session ended first". T-299 now types a
// task's brief while an update waits. This test stops the Dev at that point and checks that its brief
// had gone in. Through a real relay, with a fake claude.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, message) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  sh(cwd, 'add', file);
  sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
};
const GOT = 'GOT[Your task is to build this now: Sessions survive a relay restart.';
const NOT_DELIVERED = /was not delivered/;

test('a Dev stopped while an update waits on text in a prompt had its brief first', async (t) => {
  const R0 = await relay({});
  const home = R0.home;
  await R0.kill();
  const src = makeRepo(home, 'src'), relayOrigin = path.join(home, 'relay-origin.git'), dir = path.join(home, 'relay-folder');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, relayOrigin); sh(home, 'clone', '-q', relayOrigin, dir); sh(src, 'remote', 'add', 'origin', relayOrigin);
  const repo = makeRepo(home);

  const R = await relay({ RELAY_UPDATE_DIR: dir }, home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const say = (sessionId, event) => R.hook({ hook_event_name: event, session_id: sessionId.slice(0, 12) });
  const update = async () => (await R.call('GET', '/update')).body.update;
  const typed = async (id) => (await R.screen(id)).split(GOT).length - 1;
  const taskOf = async (id) => (await R.call('GET', '/tasks/' + id)).body.task;
  const listed = async (id) => (await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === id);

  const drafting = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await say(drafting.sessionId, 'UserPromptSubmit'); await say(drafting.sessionId, 'Stop');
  await R.call('POST', '/terminals/' + drafting.id + '/input', { data: 'half a thought' });
  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
  const u = await R.call('POST', '/update', {});
  assert.strictEqual(u.status, 202, JSON.stringify(u.body));
  await until(async () => { const v = await update(); return v && v.waitingOn.some((w) => w.terminal === drafting.id && w.why === 'has text in its prompt'); }, 'the update to wait on the text in a prompt');

  const created = await R.call('POST', '/tasks', { title: 'Sessions survive a relay restart', brief: 'Keep sessions through a restart', repo });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const task = created.body.task, devId = task.worker.terminal;
  const dev = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === devId);

  await until(async () => (await typed(devId)) === 1, 'the Dev to get its brief while the update waits', 100).catch(() => {});
  const briefs = await typed(devId);
  if (briefs) {
    await say(dev.sessionId, 'UserPromptSubmit');
    await until(async () => (await taskOf(task.id)).briefed === true, 'the task to be briefed');
  }
  const view = await update();
  assert.strictEqual(view && view.state, 'waiting', 'the update still waits, as it did for an hour on 2026-11-07');
  await R.call('POST', '/terminals/' + devId + '/stop', {});
  await until(async () => !(await listed(devId)), 'the Dev to stop');

  const notes = (await taskOf(task.id)).history.filter((x) => x.type === 'note' && NOT_DELIVERED.test(x.note || ''));
  assert.deepStrictEqual(notes.map((x) => x.note), [], 'the brief was typed before the stop, so no note says it was not delivered');
  assert.strictEqual(briefs, 1, 'the brief was typed once');
});
