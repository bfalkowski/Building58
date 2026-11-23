// The room keeps the Mac awake while it has work (relay/keep-awake.js). The relay holds one
// `caffeinate -i -w <its pid>` while the switch is on and a task is building or in review, or Autopilot is
// on, and none otherwise. A fake caffeinate in this folder stands in, and says it ran in a file. After the
// computer wakes, a session whose screen ends with the sleep message gets one carry-on note, and one waiting
// on the person gets none. Stopping the relay with SIGSTOP and then SIGCONT makes its timer late, as a sleep does.
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');

const FAKE = path.join(__dirname, 'fake-caffeinate.sh');
const ENV = { RELAY_KEEP_AWAKE: '1', RELAY_KEEP_AWAKE_PLATFORM: 'darwin', RELAY_KEEP_AWAKE_CMD: FAKE, RELAY_KEEP_AWAKE_TICK_MS: '200' };
const held = (R) => { try { return fs.readFileSync(path.join(R.home, '.keep-awake'), 'utf8').trim(); } catch (e) { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
// The relay runs as a worker under the supervisor the test started, so the worker's pid is its child's.
const workerOf = (R) => Number(execFileSync('pgrep', ['-P', String(R.child.pid), '-f', 'relay/server.js']).toString().trim().split('\n')[0]);
const setSwitch = (R, on) => R.call('POST', '/settings', { values: { keepAwake: on } });

test('the relay holds the keep-awake process while a task is building, and none with no work or the switch off', async (t) => {
  const R = await relay(ENV);
  t.after(() => R.stop());
  const repo = makeRepo(R.home);

  await sleep(800);
  assert.strictEqual(held(R), null, 'no work, no hold');

  const task = (await R.call('POST', '/tasks', { title: 'Build a thing', repo })).body.task;
  const line = await until(() => held(R), 'the hold');
  assert.match(line, new RegExp('^\\d+ -i -w ' + workerOf(R) + '$'), 'it waits on the relay\'s pid');

  assert.strictEqual((await setSwitch(R, false)).status, 200);
  await until(() => held(R) === null, 'the hold to end with the switch off');
  await sleep(600);
  assert.strictEqual(held(R), null, 'the switch off holds none');

  await setSwitch(R, true);
  await until(() => held(R), 'the hold again');

  assert.strictEqual((await R.call('POST', '/tasks/' + task.id + '/move', { to: 'done' })).status, 200);
  await until(() => held(R) === null, 'the hold to end with no work');
});

test('the hold ends when the relay crashes', async (t) => {
  const R = await relay(ENV);
  t.after(() => R.stop());
  await R.call('POST', '/tasks', { title: 'Build a thing', repo: makeRepo(R.home) });
  const pid = Number((await until(() => held(R), 'the hold')).split(' ')[0]);
  process.kill(workerOf(R), 'SIGKILL');
  await until(() => !alive(pid), 'the keep-awake process to end');
});

test('with the system not macOS, the relay holds nothing', async (t) => {
  const R = await relay({ ...ENV, RELAY_KEEP_AWAKE_PLATFORM: 'linux' });
  t.after(() => R.stop());
  await R.call('POST', '/tasks', { title: 'Build a thing', repo: makeRepo(R.home) });
  await sleep(1000);
  assert.strictEqual(held(R), null);
});

test('after a wake, a session cut short by the sleep gets one carry-on note, and one waiting on the person gets none', async (t) => {
  const R = await relay({ ...ENV, RELAY_WAKE_GAP_MS: '1500' });
  t.after(() => R.stop());
  const repo = makeRepo(R.home);
  const CARRY = /GOT\[The computer went to sleep while you were in a turn/;
  const sid = (x) => x.sessionId.slice(0, 12);
  const count = (screen) => screen.split('GOT[The computer went to sleep while you were in a turn').length - 1;
  const mk = async () => {
    const s = await R.start({ cwd: repo });
    await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid(s) });
    await R.hook({ hook_event_name: 'Stop', session_id: sid(s) });
    return s;
  };
  const cutOne = await mk(), asking = await mk(), fine = await mk();
  for (const s of [cutOne, asking]) {
    await R.call('POST', '/terminals/' + s.id + '/input', { data: 'Your computer went to sleep mid-response\r' });
  }
  await until(async () => (await R.screen(asking.id)).includes('went to sleep mid-response'), 'the sleep message');
  await R.hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow it?', session_id: sid(asking) });
  await sleep(500);

  const worker = workerOf(R);
  process.kill(worker, 'SIGSTOP');
  await sleep(2500);
  process.kill(worker, 'SIGCONT');

  await until(async () => CARRY.test(await R.screen(cutOne.id)), 'the carry-on note');
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid(cutOne) });
  await sleep(2000);
  assert.strictEqual(count(await R.screen(cutOne.id)), 1, 'typed once');
  assert.doesNotMatch(await R.screen(asking.id), CARRY, 'a session waiting on the person gets none');
  assert.doesNotMatch(await R.screen(fine.id), CARRY, 'a session with no sleep message gets none');
});
