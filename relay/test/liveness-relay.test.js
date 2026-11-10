'use strict';
// One answer to "is this session alive" (relay/liveness.js), through a real relay with a fake claude
// (relay/test/fake-claude.sh). A session whose hooks stop while its output goes on is quiet, not stuck.
// One with neither is stuck after the stall time. One whose process exits is gone. The Floor, the COO's
// stall count and Autopilot's stall check all ask the same module.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');

const STALL = 2000;

test('quiet, stuck and gone, on the Floor and in the COO\'s measures', async (t) => {
  const R = await relay({ RELAY_STALL_MS: String(STALL) });
  t.after(() => R.stop());
  const repo = makeRepo(R.home);
  const start = async () => (await R.call('POST', '/terminals', { cwd: repo })).body;
  const turn = (s) => R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12) });
  const keys = (s, data) => R.call('POST', '/terminals/' + s.id + '/input', { data });
  const rowOf = async (s) => (await R.call('GET', '/floor')).body.sessions.find((r) => r.terminal === s.id);
  const recovery = async () => (await R.call('GET', '/coo/measures')).body.measures.recovery;

  const spinning = await start(), silent = await start(), ending = await start();
  for (const s of [spinning, silent, ending]) await until(async () => (await R.screen(s.id)).includes('❯'), 'its prompt');
  await keys(spinning, '/spin\r');
  await until(async () => (await R.screen(spinning.id)).includes('Thinking'), 'the spinner');
  for (const s of [spinning, silent, ending]) await turn(s);

  await t.test('in a turn with a hook just now: working', async () => {
    for (const s of [spinning, silent]) {
      const row = await rowOf(s);
      assert.deepStrictEqual([row.state, row.desk.doing.state], ['working', 'working']);
    }
  });

  await t.test('hooks silent past the stall time, output still moving: quiet, not stuck', async () => {
    await sleep(STALL + 1500);
    const row = await rowOf(spinning);
    assert.match(row.state, /^quiet: no hook for 0 min, its screen still moves$/);
    assert.deepStrictEqual(row.desk.doing, { state: 'quiet', words: 'quiet: no hook for 0 min, output still moving' });
    assert.notStrictEqual(row.desk.next.owner, 'you', 'nothing for the person yet');
    const r = await recovery();
    assert.ok(!r.stalls.some((x) => x.who === row.name), 'the COO counts no stall for it');
    assert.ok(r.quiet.some((x) => x.who === row.name && /^still quiet: no hook for \d+ min$/.test(x.ended)), 'it lists it as quiet');
  });

  await t.test('no hook and no output past the stall time: stuck', async () => {
    const row = await rowOf(silent);
    assert.match(row.state, /^stuck: no hook and no output for 0 min$/);
    assert.deepStrictEqual(row.desk.doing, { state: 'stuck', words: 'stuck: no hook or output for 0 min' });
    assert.deepStrictEqual(row.desk.next, { text: 'Waiting on you: it has sent no hook and printed nothing for 0 min. Open its session, or stop it and Bring it back', owner: 'you' });
    assert.ok((await recovery()).stalls.some((x) => x.who === row.name && /^still stalled: no hook for \d+ min, and no output for \d+ min$/.test(x.ended)), 'the COO counts it');
  });

  await t.test('a hook ends the stall, and the COO keeps it', async () => {
    const name = (await rowOf(silent)).name;
    await turn(silent);
    await sleep(300);
    assert.strictEqual((await rowOf(silent)).state, 'working');
    const r = await recovery();
    assert.ok(r.stalls.some((x) => x.who === name && /^went on after \d+ min with no hook, and no output for \d+ min of it$/.test(x.ended)), JSON.stringify(r.stalls));
    assert.ok(!r.stalls.some((x) => x.who === name && /^still/.test(x.ended)));
  });

  await t.test('its process exits: gone, and the stall it was in ends with it', async () => {
    const name = (await rowOf(ending)).name;
    assert.match((await rowOf(ending)).state, /^stuck: /);
    await keys(ending, '/exit\r');
    await until(async () => !(await rowOf(ending)), 'it to leave the Floor');
    const r = await recovery();
    assert.ok(r.stalls.some((x) => x.who === name && x.ended === 'the session ended'), JSON.stringify(r.stalls));
    assert.ok(!r.crashes.some((x) => x.who === name), '/exit is not a crash');
  });
});

test('Autopilot: a quiet Dev keeps its task, a stuck one hands it to you, and it comes back when it moves', async (t) => {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_AUTOPILOT_STALL_MS: '3000', RELAY_STALL_MS: String(STALL) });
  t.after(async () => { await R.stop(); fs.rmSync(gh, { recursive: true, force: true }); });
  const repo = makeRepo(R.home);
  const ticket = (await R.call('POST', '/tickets', { title: 'Think for a long time', repo })).body.ticket;
  const taskOf = async () => (await R.call('GET', '/tasks')).body.tasks.find((x) => x.ticket === ticket.id);
  await R.call('POST', '/autopilot', { on: true, only: [ticket.id] });
  const task = await until(taskOf, 'the ticket to start');
  const dev = task.owner;
  const say = (event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: dev.sessionId.slice(0, 12) }, extra));
  await until(async () => (await R.screen(dev.terminal)).includes('GOT['), 'the brief');
  await say('UserPromptSubmit');
  await R.call('POST', '/terminals/' + dev.terminal + '/input', { data: '/spin\r' });

  // Quiet for longer than both stall times: it may be thinking, so its task stays.
  await sleep(STALL + 3000 + 2000);
  assert.strictEqual((await taskOf()).state, 'building', 'a quiet Dev keeps its task');

  // Its output stops too. Once it is stuck for Autopilot's stall time, the task waits on you.
  await R.call('POST', '/terminals/' + dev.terminal + '/input', { data: '/still\r' });
  const parked = await until(async () => { const x = await taskOf(); return x.state === 'waiting_on_you' && x; }, 'the stuck task to wait on you', 150);
  const move = parked.history.filter((h) => h.type === 'moved').pop();
  assert.strictEqual(move.by, 'Autopilot');
  assert.match(move.note, /Its Dev .* has sent no hook and printed nothing for \d+ minutes\. The session is still open at its desk: look at it there, and the task goes back to Building once it moves again\./);

  await say('PreToolUse', { tool_name: 'Bash' });
  const back = await until(async () => { const x = await taskOf(); return x.state === 'building' && x; }, 'the task to come back');
  assert.match(back.history.filter((h) => h.type === 'moved').pop().note, /moved again, so the task is back/);
});
