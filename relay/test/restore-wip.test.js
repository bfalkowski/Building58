'use strict';
// A restart brings back every task that was building, even when more are building than the WIP limit
// allows now (it was lowered in Settings, or a moved-back task was moved on). The limit stops new work,
// not work that was already running: a refused session failed the supervisor's check and rolled back
// a good commit.
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');

const talk = (R, sid) => R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid.slice(0, 12) });

test('a restart brings back tasks past a lowered WIP limit', async (t) => {
  let R = await relay({ RELAY_RESUME: '1', RELAY_WIP_LIMIT: '2' });
  const home = R.home, repo = makeRepo(home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });

  const tasks = [];
  for (const title of ['Add a radio', 'Add a lamp']) {
    const task = (await R.call('POST', '/tasks', { title, brief: 'Keep it small.', repo })).body.task;
    await until(async () => /GOT\[Your task is to build/.test(await R.screen(task.worker.terminal)), 'the brief');
    await talk(R, task.owner.sessionId); await sleep(200);
    await until(async () => (await R.call('GET', '/tasks/' + task.id)).body.task.briefed, 'the task brief');
    tasks.push(task);
  }

  await R.kill();
  R = await relay({ RELAY_RESUME: '1', RELAY_WIP_LIMIT: '1' }, home);
  const back = await until(async () => {
    const l = (await R.call('GET', '/terminals')).body.terminals;
    return l.length === 2 && l;
  }, 'both workers back', 150);
  for (const task of tasks) assert.ok(back.some((x) => x.task === task.id), 'came back: ' + task.title);

  await t.test('a new task is still refused while that many are building', async () => {
    const r = await R.call('POST', '/tasks', { title: 'Add a rug', brief: 'Keep it small.', repo });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'wip_limit');
  });
});
