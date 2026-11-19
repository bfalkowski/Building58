'use strict';
// A relay that stops while a Dev is in a turn cuts the turn short: the Dev comes back with claude --resume,
// idle, and nothing tells it to go on (T-348). So the relay types one short continue prompt into a Dev that
// was in a turn when it stopped and whose task has no PR, once it shows its prompt mark. A Dev that was idle,
// or whose task has a PR, gets nothing. If the Dev is still idle with no PR after that, Needs you says so.
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');

const CONTINUE = /GOT\[The relay restarted while you were in a turn/;
const times = (screen) => screen.split('GOT[The relay restarted while you were in a turn').length - 1;
const QUIET = 2500;
const PR = 'https://github.com/acme/widgets/pull/7';

test('after a restart, a Dev whose turn was cut short with no PR gets one continue prompt', async (t) => {
  let R = await relay({ RELAY_RESUME: '1' });
  const home = R.home, repo = makeRepo(home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const say = (sid, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: sid.slice(0, 12) }, extra));

  const made = {};
  for (const [name, title] of [['cut', 'Add a radio'], ['idle', 'Add a lamp'], ['pr', 'Add a rug']]) {
    const task = (await R.call('POST', '/tasks', { title, brief: 'Keep it small.', repo })).body.task;
    await until(async () => /GOT\[Your task is to build/.test(await R.screen(task.worker.terminal)), 'the brief');
    await say(task.owner.sessionId, 'UserPromptSubmit');
    await until(async () => (await R.call('GET', '/tasks/' + task.id)).body.task.briefed, 'the task brief');
    made[name] = task;
  }
  await say(made.idle.owner.sessionId, 'Stop');
  await say(made.pr.owner.sessionId, 'PostToolUse', { pr_url: PR, cwd: made.pr.worktree });
  await until(async () => (await R.call('GET', '/tasks/' + made.pr.id)).body.task.pr === PR, 'the PR on its task');
  await sleep(300);
  await R.kill();

  R = await relay({ RELAY_RESUME: '1' }, home);
  const back = await until(async () => {
    const l = (await R.call('GET', '/terminals')).body.terminals;
    return l.length === 3 && Object.fromEntries(Object.entries(made).map(([k, task]) => [k, l.find((x) => x.task === task.id)]));
  }, 'all three Devs back', 150);
  for (const k of Object.keys(made)) await say(made[k].owner.sessionId, 'SessionStart', { source: 'resume' });
  const needsYou = async () => (await R.call('GET', '/needs-you')).body.items;

  await t.test('the Dev whose turn was cut short gets the continue prompt once', async () => {
    await until(async () => CONTINUE.test(await R.screen(back.cut.id)), 'the continue prompt');
    await say(made.cut.owner.sessionId, 'UserPromptSubmit');
    await sleep(QUIET);
    assert.strictEqual(times(await R.screen(back.cut.id)), 1, 'typed once');
  });

  await t.test('a Dev that was idle, or whose task has a PR, gets nothing', async () => {
    assert.doesNotMatch(await R.screen(back.idle.id), CONTINUE);
    assert.doesNotMatch(await R.screen(back.pr.id), CONTINUE);
  });

  await t.test('still idle with no PR after the continue: Needs you says to prompt it', async () => {
    await say(made.cut.owner.sessionId, 'Stop');
    const item = await until(async () => (await needsYou()).find((i) => i.terminal === back.cut.id), 'its Needs you item');
    assert.strictEqual(item.kind, 'prompt');
    await sleep(QUIET);
    assert.strictEqual(times(await R.screen(back.cut.id)), 1, 'not typed again');
  });
});

test('a turn that begins before the continue goes in drops it', async (t) => {
  let R = await relay({ RELAY_RESUME: '1' });
  const home = R.home, repo = makeRepo(home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const say = (sid, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: sid.slice(0, 12) }, extra));

  const task = (await R.call('POST', '/tasks', { title: 'Add a radio', brief: 'Keep it small.', repo })).body.task;
  await until(async () => /GOT\[Your task is to build/.test(await R.screen(task.worker.terminal)), 'the brief');
  await say(task.owner.sessionId, 'UserPromptSubmit');
  await until(async () => (await R.call('GET', '/tasks/' + task.id)).body.task.briefed, 'the task brief');
  await sleep(300);
  await R.kill();

  R = await relay({ RELAY_RESUME: '1' }, home);
  const back = await until(async () => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.task === task.id), 'the Dev back', 150);
  await say(task.owner.sessionId, 'UserPromptSubmit');
  await say(task.owner.sessionId, 'Stop');
  await sleep(QUIET);
  assert.doesNotMatch(await R.screen(back.id), CONTINUE);
});
