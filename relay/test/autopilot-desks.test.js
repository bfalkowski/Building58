'use strict';
// Autopilot frees a desk before it gives up on a start, through a real relay with a fake claude.
// When every desk is taken, it waits for a session that is already ending. With none, it stops the
// longest idle of its own sessions that the Lead may stop, only one, and starts the ticket. It never
// stops a session on a task it did not start (article 5). With nothing it may stop, it waits for a desk.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');

const DESKS = 9;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(args), { cwd, encoding: 'utf8' }).trim();

async function office(t, env) {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ RELAY_WIP_LIMIT: '8', RELAY_AUTOPILOT_TICK_MS: '300', GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh, ...env });
  t.after(async () => { await R.stop(); fs.rmSync(gh, { recursive: true, force: true }); });
  // An origin that main is pushed to, so a Dev's checkout has nothing unpushed.
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  git(R.home, 'init', '-q', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  await R.call('POST', '/reviews', { auto: false });
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(150); };
  const plain = async () => (await R.call('POST', '/terminals', { cwd: repo })).body;
  const ticket = async (title) => (await R.call('POST', '/tickets', { title, repo })).body.ticket;
  const canStop = async (s) => (await R.call('GET', '/floor')).body.sessions.find((r) => r.terminal === s.id).canStop;
  // A task's Dev, briefed and idle, with its task Done. The task is Autopilot's when it starts the
  // ticket, or the person's from New task.
  const doneDev = async (byAutopilot) => {
    let task;
    if (byAutopilot) {
      const tk = await ticket('Finished work');
      await R.call('POST', '/autopilot', { on: true, only: tk.id });
      task = await until(async () => (await R.call('GET', '/tasks')).body.tasks.find((x) => x.ticket === tk.id), 'Autopilot to start it');
      await R.call('POST', '/autopilot', { on: false });
      assert.strictEqual(task.by, 'Autopilot');
    } else task = (await R.call('POST', '/tasks', { title: 'Finished work', repo })).body.task;
    const s = { id: task.owner.terminal, sessionId: task.owner.sessionId, task };
    await until(async () => (await R.screen(s.id)).includes('GOT['), 'the task brief');
    await hook(s, { hook_event_name: 'UserPromptSubmit', title: '' });
    await hook(s, { hook_event_name: 'Stop' });
    assert.strictEqual((await R.call('POST', '/tasks/' + task.id + '/move', { to: 'done' })).status, 200);
    await until(() => canStop(s), 'the Dev to be safe for the Lead to stop');
    return s;
  };
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const started = (tk) => until(async () => (await R.call('GET', '/tasks')).body.tasks.find((x) => x.ticket === tk.id), 'the ticket to start');
  return { R, repo, terminals, plain, ticket, canStop, doneDev, ap, started };
}

test('every desk is taken and its own Done Dev is idle: Autopilot stops it and starts the ticket', async (t) => {
  const o = await office(t);
  const older = await o.doneDev(true);
  await sleep(1100);  // so the other Dev has been idle for less time
  const newer = await o.doneDev(true);
  for (let i = 0; i < DESKS - 2; i++) await o.plain();
  assert.strictEqual((await o.terminals()).length, DESKS, 'every desk is taken');
  const next = await o.ticket('Next one');
  await o.R.call('POST', '/autopilot', { on: true, only: next.id });
  const task = await o.started(next);
  assert.strictEqual(task.by, 'Autopilot');
  const now = await o.terminals();
  assert.ok(!now.some((x) => x.id === older.id), 'the longest idle Done Dev was stopped');
  assert.ok(now.some((x) => x.id === newer.id), 'only as many as the start needs');
  assert.strictEqual(now.length, DESKS, 'the new Dev took the freed desk');
  const a = await o.ap();
  assert.strictEqual(a.on, true);
  assert.ok(a.notes.some((x) => /^Stopped .*task \w+\) to free a desk: its task is Done, /.test(x.text)), JSON.stringify(a.notes));
  const history = (await o.R.call('GET', '/tasks/' + older.task.id)).body.task.history;
  assert.ok(history.some((h) => /^Autopilot stopped its worker to free a desk/.test(h.note || '')), JSON.stringify(history.slice(-3)));
});

// A full Floor is a wait, not a failure: sessions end by themselves, and the next look finds the desk.
// Seen on 2026-11-07 and 2026-11-08: Autopilot turned itself off for a full Floor, and the person had
// to notice and turn it on again, though a desk freed itself later.
test('every desk is taken and nothing is Autopilot\'s to stop: it waits, then starts the ticket once a desk frees', async (t) => {
  const o = await office(t);
  const theirs = await o.doneDev(false);  // the Lead may stop it, but its task is the person's
  const busy = await o.doneDev(true);
  await o.R.hook({ session_id: busy.sessionId.slice(0, 12), hook_event_name: 'UserPromptSubmit', title: '' });  // in a turn, so not safe
  const plain = [];
  for (let i = 0; i < DESKS - 2; i++) plain.push(await o.plain());
  assert.ok(await o.canStop(theirs));
  const next = await o.ticket('Next one');
  await o.R.call('POST', '/autopilot', { on: true, only: next.id });
  await until(async () => /^Waiting for a free desk: 9 of 9 taken, none safe to stop/.test((await o.ap()).idle || ''), 'Autopilot to say it waits for a desk');
  await sleep(1500);  // a few more looks
  let a = await o.ap();
  assert.strictEqual(a.on, true, 'Autopilot stayed on: ' + JSON.stringify(a.notes));
  assert.ok(!a.notes.some((x) => /Could not start|turned itself off|to free a desk/.test(x.text)), JSON.stringify(a.notes));
  assert.strictEqual(a.notes.filter((x) => /^Waiting for a free desk/.test(x.text)).length, 1, 'one note when the wait starts: ' + JSON.stringify(a.notes));
  assert.strictEqual((await o.terminals()).length, DESKS, 'every session still runs');
  assert.ok(!(await o.R.call('GET', '/tasks')).body.tasks.some((x) => x.ticket === next.id), 'the ticket did not start');
  // A desk frees as a session ends, with nothing from the person to Autopilot.
  await o.R.call('POST', '/terminals/' + plain[0].id + '/stop', {});
  assert.strictEqual((await o.started(next)).by, 'Autopilot');
  a = await o.ap();
  assert.strictEqual(a.on, true);
  assert.strictEqual(a.idle, null, 'the wait is over');
});

// Only a full Floor is a wait. A start that fails for any other reason turns Autopilot off, as before.
test('a start fails for another reason: Autopilot turns itself off and says why', async (t) => {
  const o = await office(t);
  const elsewhere = makeRepo(o.R.home, 'gone');
  const next = await o.R.call('POST', '/tickets', { title: 'In a repo that goes', repo: elsewhere }).then((r) => r.body.ticket);
  assert.ok(next, 'the ticket was filed');
  fs.rmSync(elsewhere, { recursive: true, force: true });
  await o.R.call('POST', '/autopilot', { on: true, only: next.id });
  await until(async () => (await o.ap()).on === false, 'Autopilot to turn itself off');
  const a = await o.ap();
  assert.ok(a.notes.some((x) => /^Could not start /.test(x.text) && !/desk/.test(x.text)), JSON.stringify(a.notes));
  assert.ok(a.notes.some((x) => /^Autopilot turned itself off/.test(x.text)), JSON.stringify(a.notes));
});

test('every desk is taken and one session is still ending: Autopilot waits for it and starts the ticket', async (t) => {
  const o = await office(t, { FAKE_CLAUDE_SLOW_EXIT: '1' });
  const all = [];
  for (let i = 0; i < DESKS; i++) all.push(await o.plain());
  const next = await o.ticket('Next one');
  await o.R.call('POST', '/terminals/' + all[0].id + '/stop', {});  // it takes a second to end
  await o.R.call('POST', '/autopilot', { on: true, only: next.id });
  await o.started(next);
  const a = await o.ap();
  assert.strictEqual(a.on, true, JSON.stringify(a.notes));
  assert.ok(!a.notes.some((x) => /to free a desk|Could not start/.test(x.text)), JSON.stringify(a.notes));
  const now = await o.terminals();
  assert.strictEqual(now.length, DESKS);
  assert.ok(all.slice(1).every((s) => now.some((x) => x.id === s.id)), 'nobody else was stopped');
});

// A session that is ending but hangs, as when the computer is too busy for its process to run. Its
// terminal bridge is paused with SIGSTOP, so the relay's hang-up and SIGTERM wait until it resumes.
// It resumes before the test ends either way, or stopping the relay would wait for it.
test('every desk is taken and an ending session hangs: Autopilot stops its own Done Dev instead, and starts the ticket', async (t) => {
  const o = await office(t);
  const mine = await o.doneDev(true);
  const others = [];
  for (let i = 0; i < DESKS - 1; i++) others.push(await o.plain());
  const stuck = others[0];
  // The bridge is the pty-bridge.py process whose command names this session. Pausing anything else,
  // such as the relay, would hang the test.
  const rows = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).split('\n');
  const row = rows.find((r) => r.includes('pty-bridge.py') && r.includes('--session-id ' + stuck.sessionId));
  assert.ok(row, 'the session\'s terminal bridge is running');
  const bridge = Number(row.trim().split(/\s+/)[0]);
  process.kill(bridge, 'SIGSTOP');
  try {
    await o.R.call('POST', '/terminals/' + stuck.id + '/stop', {});  // ending, and it cannot end
    const next = await o.ticket('Next one');
    await o.R.call('POST', '/autopilot', { on: true, only: next.id });
    // Started, or Autopilot gave up: either ends the wait, so old code fails here and does not time out.
    await until(async () => (await o.ap()).on === false || (await o.R.call('GET', '/tasks')).body.tasks.some((x) => x.ticket === next.id), 'Autopilot to start the ticket or give up');
    const a = await o.ap();
    assert.strictEqual(a.on, true, 'Autopilot stayed on: ' + JSON.stringify(a.notes.slice(-3)));
    assert.ok(a.notes.some((x) => /^Stopped .*task \w+\) to free a desk: its task is Done, /.test(x.text)), JSON.stringify(a.notes));
    assert.ok(!(await o.terminals()).some((x) => x.id === mine.id), 'its own Done Dev was stopped');
    assert.strictEqual((await o.started(next)).by, 'Autopilot');
  } finally { process.kill(bridge, 'SIGCONT'); }
});

// The WIP limit counts every task being built, Autopilot's or not, while Autopilot's own limit counts
// only its tasks. So a start can be refused for the WIP limit while Autopilot has room. That is a wait,
// not a failure: Autopilot stays on, says why it waits, and starts once a task finishes. Seen on
// 2026-11-07: a ticket the person started filled the third slot, and Autopilot turned itself off.
test('the WIP limit is full with a task Autopilot did not start: it waits, then starts the ticket', async (t) => {
  const o = await office(t, { RELAY_WIP_LIMIT: '1' });
  const theirs = (await o.R.call('POST', '/tasks', { title: 'The person\'s own work', repo: o.repo })).body.task;
  assert.strictEqual(theirs.state, 'building');
  const next = await o.ticket('Next one');
  await o.R.call('POST', '/autopilot', { on: true, only: next.id });
  await until(async () => /WIP limit/.test((await o.ap()).idle || ''), 'Autopilot to say it waits for the WIP limit');
  await sleep(1000);  // a few more ticks
  const a = await o.ap();
  assert.strictEqual(a.on, true, 'Autopilot stayed on: ' + JSON.stringify(a.notes));
  assert.ok(!a.notes.some((x) => /Could not start|turned itself off/.test(x.text)), JSON.stringify(a.notes));
  assert.ok(!(await o.R.call('GET', '/tasks')).body.tasks.some((x) => x.ticket === next.id), 'nothing started past the limit');
  assert.strictEqual((await o.R.call('POST', '/tasks/' + theirs.id + '/move', { to: 'done' })).status, 200);
  assert.strictEqual((await o.started(next)).by, 'Autopilot');
  assert.strictEqual((await o.ap()).idle, null, 'the wait is over');
});
