'use strict';
// The Needs you route (relay/needs-you.js) on a real relay with the fake claude: what it lists from the
// sessions and tasks the relay keeps, and who may read it. The rules for each kind are in needs-you-plan.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until, sessionToken } = require('./helpers.js');

test('the Needs you route', async (t) => {
  const R = await relay({ RELAY_WIP_LIMIT: '5' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const start = async (extra) => (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(150); };
  const finish = async (s) => { await hook(s, { hook_event_name: 'UserPromptSubmit', title: '' }); await hook(s, { hook_event_name: 'Stop' }); };
  const needs = async () => (await R.call('GET', '/needs-you')).body;
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;

  await t.test('nothing runs: an empty list', async () => {
    const s = await needs();
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.count, 0);
    assert.deepStrictEqual(s.items, []);
  });

  const asker = await start();
  await finish(asker);
  await hook(asker, { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
  const task = (await R.call('POST', '/tasks', { title: 'A task', repo })).body.task;
  const dev = (await terminals()).find((x) => x.id === task.owner.terminal);
  await until(async () => (await R.screen(dev.id)).includes('GOT['), 'the task brief');
  await finish(dev);

  await t.test('a session asking for permission, and a Dev that stopped with no PR, each with the name the relay gave it', async () => {
    const s = await needs(), names = Object.fromEntries((await terminals()).map((x) => [x.id, x.who]));
    assert.deepStrictEqual(s.items.map((i) => [i.kind, i.terminal]), [['permission', asker.id], ['prompt', dev.id]]);
    assert.strictEqual(s.count, 2);
    assert.strictEqual(s.items[0].line, 'Approve or deny the request from ' + names[asker.id] + ': Claude needs your permission to use Bash');
    assert.deepStrictEqual(s.items[0].link, { terminal: asker.id });
    assert.strictEqual(s.items[1].line, 'Prompt ' + names[dev.id] + ': it stopped on task ' + task.id + ' with no PR.');
  });

  await t.test('a task in Waiting on you gives one item, not a second one for its Dev', async () => {
    await R.call('POST', '/tasks/' + task.id + '/move', { to: 'waiting_on_you' });
    const s = await needs();
    assert.deepStrictEqual(s.items.map((i) => i.kind), ['permission', 'waiting']);
    assert.strictEqual(s.items[1].task, task.id);
    assert.deepStrictEqual(s.items[1].link, { terminal: dev.id });
  });

  await t.test('once the session moves on, its item goes', async () => {
    await hook(asker, { hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    assert.deepStrictEqual((await needs()).items.map((i) => i.kind), ['waiting']);
  });

  await t.test('it answers the person on the room page only', async () => {
    const r = await fetch(R.base + '/needs-you', { headers: { Authorization: 'Bearer test-key', Host: 'example.com', Origin: 'https://evil.example' } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await R.call('GET', '/needs-you', null, { 'X-Office-Token': 'nope' })).status, 401);
    const token = await until(() => { try { return sessionToken(asker.sessionId); } catch (e) { return null; } }, 'the token');
    assert.strictEqual((await R.call('GET', '/needs-you', null, { 'X-Office-Token': token })).status, 401, 'a session\'s own token does not read it');
    assert.strictEqual((await R.call('POST', '/needs-you', {})).status, 404);
  });
});
