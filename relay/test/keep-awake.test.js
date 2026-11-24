'use strict';
// The room keeps the Mac awake while it has work (relay/awake.js). Here the relay runs a fake caffeinate
// (relay/test/fake-caffeinate.sh) that logs when it starts and ends. After a wake, a session whose turn the
// sleep cut off gets one carry-on note, and one waiting on the person gets none.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');

const FAST = { RELAY_AWAKE_EVERY_MS: '100', RELAY_WAKE_GAP_MS: '800' };
const logOf = (home) => path.join(home, 'caffeinate.log');
const env = (home, more) => ({ ...FAST, RELAY_CAFFEINATE: path.join(__dirname, 'fake-caffeinate.sh'), FAKE_CAFFEINATE_LOG: logOf(home), ...(more || {}) });
const lines = (home) => { try { return fs.readFileSync(logOf(home), 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } };
const starts = (home) => lines(home).filter((l) => l.startsWith('start'));
const live = (home) => { const l = lines(home); return starts(home).length - l.filter((x) => x.startsWith('end')).length; };
const homeNeeded = () => fs.mkdtempSync(path.join(require('os').tmpdir(), 'awake-'));
const workerOf = (R) => Number(execFileSync('pgrep', ['-P', String(R.child.pid), '-f', 'server.js'], { encoding: 'utf8' }).trim().split('\n')[0]);
const CARRY = /GOT\[The computer went to sleep during your turn/;
const times = (screen) => screen.split('GOT[The computer went to sleep').length - 1;

async function building(R, repo, title) {
  const task = (await R.call('POST', '/tasks', { title, brief: 'Keep it small.', repo })).body.task;
  await until(async () => /GOT\[Your task is to build/.test(await R.screen(task.worker.terminal)), 'the brief');
  return task;
}

test('a building task holds the keep-awake process, and no work releases it', async (t) => {
  const home = homeNeeded();
  const R = await relay(env(home), undefined);
  t.after(async () => { await R.stop().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); });
  const repo = makeRepo(R.home);

  await sleep(500);
  assert.strictEqual(starts(home).length, 0, 'no work, no hold');
  const task = await building(R, repo, 'Add a radio');
  await until(() => starts(home).length === 1, 'the hold');
  assert.match(starts(home)[0], new RegExp('^start \\d+ -i -w ' + workerOf(R) + '$'), 'tied to the relay worker');
  await sleep(500);
  assert.strictEqual(starts(home).length, 1, 'one hold, not one a look');

  await R.call('POST', '/tasks/' + task.id + '/move', { to: 'in_review' });
  await sleep(500);
  assert.strictEqual(live(home), 1, 'a task in review still holds');

  await R.call('POST', '/tasks/' + task.id + '/move', { to: 'waiting_on_you' });
  await until(() => live(home) === 0, 'the hold to end with no work');
});

test('the switch off holds none, and turning it off ends the hold', async (t) => {
  const home = homeNeeded();
  const R = await relay(env(home, { RELAY_KEEP_AWAKE: '0' }));
  t.after(async () => { await R.stop().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); });
  const repo = makeRepo(R.home);
  await building(R, repo, 'Add a radio');
  await sleep(800);
  assert.strictEqual(starts(home).length, 0, 'switch off, no hold');
  await R.call('POST', '/settings', { values: { keepAwake: true } });
  await until(() => live(home) === 1, 'the hold once the switch is on');
  await R.call('POST', '/settings', { values: { keepAwake: false } });
  await until(() => live(home) === 0, 'the hold to end once the switch is off');
});

test('Autopilot on holds it with no task', async (t) => {
  const home = homeNeeded();
  const R = await relay(env(home));
  t.after(async () => { await R.stop().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); });
  await sleep(400);
  assert.strictEqual(starts(home).length, 0);
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true })).status, 200);
  await until(() => live(home) === 1, 'the hold while Autopilot is on');
  await R.call('POST', '/autopilot', { on: false });
  await until(() => live(home) === 0, 'the hold to end when Autopilot is off');
});

test('the hold ends when the relay stops, and when it is killed', async (t) => {
  for (const how of ['SIGTERM', 'SIGKILL']) {
    const home = homeNeeded();
    const R = await relay(env(home));
    t.after(async () => { await R.stop().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); });
    await R.call('POST', '/autopilot', { on: true });
    await until(() => live(home) === 1, 'the hold');
    if (how === 'SIGKILL') process.kill(workerOf(R), 'SIGKILL'); else await R.kill();
    await until(() => live(home) === 0, 'the hold to end after ' + how);
  }
});

test('a Mac that is not told which tool to use, and is not a Mac, holds none', async (t) => {
  if (process.platform === 'darwin') return t.skip('this one is a Mac');
  const home = homeNeeded();
  const R = await relay({ ...FAST });
  t.after(async () => { await R.stop().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); });
  await R.call('POST', '/autopilot', { on: true });
  await sleep(600);
  assert.ok(!/could not keep the computer awake/.test(R.output()), 'it says nothing and does nothing');
});

test('after a wake, a session cut off by the sleep gets one carry-on note, and one waiting on you none', async (t) => {
  const home = homeNeeded();
  const R = await relay({ ...FAST, RELAY_KEEP_AWAKE: '0' });
  t.after(async () => { await R.stop().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); });
  const say = (sid, event) => R.hook({ hook_event_name: event, session_id: sid.slice(0, 12) });
  const repo = makeRepo(R.home);
  const old = await R.start({ cwd: repo, title: 'Old' }), cut = await R.start({ cwd: repo, title: 'Cut' }), waiting = await R.start({ cwd: repo, title: 'Waiting' }), fine = await R.start({ cwd: repo, title: 'Fine' });
  for (const s of [old, cut, waiting, fine]) { await say(s.sessionId, 'UserPromptSubmit'); await say(s.sessionId, 'Stop'); }
  await sleep(300);
  const slept = (s) => R.call('POST', '/terminals/' + s.id + '/input', { data: '/slept\r' });
  await slept(old);
  await until(async () => /went to sleep mid-response/.test(await R.screen(old.id)), 'the old sleep message');
  await sleep(500);
  assert.doesNotMatch(await R.screen(cut.id), CARRY, 'nothing before a wake');

  const pid = workerOf(R);
  process.kill(pid, 'SIGSTOP');
  await sleep(1500);
  process.kill(pid, 'SIGCONT');
  await say(waiting.sessionId, 'Notification');
  await slept(cut); await slept(waiting);
  await R.call('POST', '/terminals/' + old.id + '/input', { data: 'hello\r' });
  await until(async () => CARRY.test(await R.screen(cut.id)), 'the carry-on note');
  await say(cut.sessionId, 'UserPromptSubmit');
  await say(cut.sessionId, 'Stop');
  await sleep(2000);
  assert.strictEqual(times(await R.screen(cut.id)), 1, 'once, though the message is still on its screen when its turn ends');
  assert.doesNotMatch(await R.screen(old.id), CARRY, 'a message from an earlier sleep gets none');
  assert.doesNotMatch(await R.screen(waiting.id), CARRY, 'a session waiting on the person gets none');
  assert.doesNotMatch(await R.screen(fine.id), CARRY, 'a session that was not cut gets none');
});
