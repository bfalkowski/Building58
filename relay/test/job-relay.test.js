'use strict';
// A session running a job is busy, not idle. On 2026-11-08 three Devs started npm test in the background,
// ended their turn to wait for it, and looked idle. Update restarted under two of them and their test runs
// were lost, and Autopilot parked all three as "its Dev is gone and there is no PR" while they were alive.
// Through a real relay, with a fake claude (relay/test/fake-claude.sh: /job, /nojob, /helper) and a fake gh.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');

// Without relay/jobs.js nothing here can pass, so each test fails at once and says why, rather than
// waiting out its limits.
const HAS_JOBS = fs.existsSync(path.join(__dirname, '..', 'jobs.js'));
const need = () => assert.ok(HAS_JOBS, 'relay/jobs.js is missing, so no session host looks for jobs');
const SCAN = '200';  // RELAY_JOB_SCAN_MS: how often the session host looks for jobs
// What the fake claude says it got, once per message, apart from the echo of the typing itself.
const NUDGE = /GOT\[Your task has no PR yet\. If a test run was lost, run it again in the foreground and open the PR\. If you are blocked, say why\.\]/g;
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, message) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  sh(cwd, 'add', file);
  sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
};

function helpers(R) {
  const say = (sessionId, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: sessionId.slice(0, 12) }, extra));
  const keys = (id, data) => R.call('POST', '/terminals/' + id + '/input', { data });
  const rowOf = async (id) => (await R.call('GET', '/floor')).body.sessions.find((r) => r.terminal === id);
  const prompt = (id) => until(async () => (await R.screen(id)).includes('❯'), 'its prompt');
  return { say, keys, rowOf, prompt };
}

test('a session that ends its turn with a job running is busy until the job ends, and a helper does not count', async (t) => {
  need();
  const R = await relay({ RELAY_JOB_SCAN_MS: SCAN });
  t.after(() => R.stop());
  const { say, keys, rowOf, prompt } = helpers(R);
  const repo = makeRepo(R.home);
  const testing = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const helped = (await R.call('POST', '/terminals', { cwd: repo })).body;
  for (const s of [testing, helped]) await prompt(s.id);
  for (const s of [testing, helped]) await say(s.sessionId, 'UserPromptSubmit');
  await keys(testing.id, '/job\r');
  await keys(helped.id, '/helper\r');
  for (const s of [testing, helped]) await say(s.sessionId, 'Stop');

  const row = await until(async () => { const r = await rowOf(testing.id); return /^job/.test(r.state) && r; }, 'the Floor to show the job: the session host never reported it', 50);
  assert.match(row.state, /^job: its turn ended 0 min ago, and a command it started still runs$/);
  assert.deepStrictEqual(row.desk.doing, { state: 'job', words: 'running a job: a command it started still runs' });
  assert.strictEqual(row.safe, false, 'stopping it would end the job');
  assert.match(row.why, /a command it started still runs/);

  await sleep(Number(SCAN) * 4);
  assert.strictEqual((await rowOf(helped.id)).state, 'idle', 'a child that is not a shell from the Bash tool is a helper');

  await keys(testing.id, '/nojob\r');
  const done = await until(async () => { const r = await rowOf(testing.id); return r.state === 'idle' && r; }, 'idle once the job ends');
  assert.strictEqual(done.desk.doing.state, 'idle');
});

// The relay's folder, which Update pulls into from its own origin, and a session in it.
async function updateRig(t, env) {
  need();
  const R0 = await relay({});
  const home = R0.home;
  await R0.kill();
  const src = makeRepo(home, 'src'), relayOrigin = path.join(home, 'relay-origin.git'), dir = path.join(home, 'relay-folder');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, relayOrigin); sh(home, 'clone', '-q', relayOrigin, dir); sh(src, 'remote', 'add', 'origin', relayOrigin);
  const R = await relay(Object.assign({ RELAY_UPDATE_DIR: dir, RELAY_JOB_SCAN_MS: SCAN }, env), home);
  // Cleaned up before the first wait, so a wait that times out cannot leave the relay running.
  t.after(async () => { await R.kill().catch(() => {}); R.remove(); });
  const { say, keys, rowOf, prompt } = helpers(R);
  const s = (await R.call('POST', '/terminals', { cwd: dir })).body;
  await prompt(s.id);
  await say(s.sessionId, 'UserPromptSubmit');
  await keys(s.id, '/job\r');
  await say(s.sessionId, 'Stop');
  await until(async () => /^job/.test((await rowOf(s.id)).state), 'the job: the session host never reported it', 50);
  await sleep(5200);  // past the few seconds in which Enter alone holds an update ('just sent a prompt')
  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
  return { R, s, keys };
}
const restartOf = (R, run) => until(async () => {
  try { const g = (await R.call('GET', '/update')).body; return g.run !== run && g; } catch (e) { return null; }
}, 'the relay to restart', 100);

test('an update waits for a session running a job, and restarts once the job ends', async (t) => {
  const { R, s, keys } = await updateRig(t, {});
  const run = (await R.call('GET', '/update')).body.run;
  const u = await R.call('POST', '/update', {});
  assert.strictEqual(u.status, 202, JSON.stringify(u.body));
  assert.deepStrictEqual(u.body.update.waitingOn.map((w) => [w.terminal, w.why]), [[s.id, 'running a job']]);
  await sleep(1500);
  const still = (await R.call('GET', '/update')).body;
  assert.strictEqual(still.run, run, 'not restarted while the job runs');
  assert.strictEqual(still.update.state, 'waiting');
  await keys(s.id, '/nojob\r');
  assert.strictEqual((await restartOf(R, run)).update, null);
});

test('an update stops waiting for a job that has run past the stall time, and the job runs on through the restart', async (t) => {
  const { R, s } = await updateRig(t, { RELAY_AUTOPILOT_STALL_MS: '3000', RELAY_RESUME: '1' });
  const run = (await R.call('GET', '/update')).body.run;
  const u = await R.call('POST', '/update', {});
  assert.strictEqual(u.status, 202, JSON.stringify(u.body));
  await restartOf(R, run);
  // The session ran on in the session host, so the new relay takes it back with its job still running.
  const back = await until(async () => { try { return (await R.call('GET', '/floor')).body.sessions.find((r) => r.terminal === s.id && /^job/.test(r.state)); } catch (e) { return null; } }, 'the session back, still running its job', 100);
  assert.ok(back);
});

async function autopilotRig(t) {
  need();
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_AUTOPILOT_STALL_MS: '3000', RELAY_JOB_SCAN_MS: SCAN });
  t.after(async () => { await R.stop(); fs.rmSync(gh, { recursive: true, force: true }); });
  const repo = makeRepo(R.home);
  const ticket = (await R.call('POST', '/tickets', { title: 'Run the tests', repo })).body.ticket;
  const taskOf = async () => (await R.call('GET', '/tasks')).body.tasks.find((x) => x.ticket === ticket.id);
  await R.call('POST', '/autopilot', { on: true, only: [ticket.id] });
  const dev = (await until(taskOf, 'the ticket to start')).owner;
  const h = helpers(R);
  await until(async () => (await R.screen(dev.terminal)).includes('GOT['), 'the brief');
  await h.say(dev.sessionId, 'UserPromptSubmit');
  const nudges = async () => ((await R.screen(dev.terminal)).match(NUDGE) || []).length;
  const notes = async () => (await R.call('GET', '/autopilot')).body.notes.map((n) => n.text);
  return Object.assign({ R, dev, taskOf, nudges, notes }, h);
}

test('Autopilot neither parks nor nudges a Dev with a job, and nudges once it ends', async (t) => {
  const { dev, taskOf, nudges, notes, say, keys } = await autopilotRig(t);
  await keys(dev.terminal, '/job\r');
  await say(dev.sessionId, 'Stop');
  // Past twice the stall time with its job running and no PR: busy, so nothing happens.
  await sleep(3000 * 2 + 1500);
  assert.strictEqual((await taskOf()).state, 'building', 'a Dev with a job keeps its task');
  assert.strictEqual(await nudges(), 0, 'and is not nudged');
  assert.ok(!(await notes()).some((n) => /waits on you|nudged/.test(n)), JSON.stringify(await notes()));
  // The job ends. Now it is idle with no PR, and after the stall time it is nudged.
  await keys(dev.terminal, '/nojob\r');
  await until(async () => (await nudges()) === 1, 'the nudge', 100);
});

test('an idle Dev with no PR is nudged once, then parked with what is true if nothing comes of it', async (t) => {
  const { dev, taskOf, nudges, notes, say } = await autopilotRig(t);
  await say(dev.sessionId, 'Stop');
  await until(async () => (await nudges()) === 1, 'the nudge', 100);
  assert.strictEqual((await taskOf()).state, 'building', 'nudged, not parked');
  assert.ok((await notes()).some((n) => /nudged its Dev/.test(n)), JSON.stringify(await notes()));
  const parked = await until(async () => { const x = await taskOf(); return x.state === 'waiting_on_you' && x; }, 'the task to wait on you', 100);
  const move = parked.history.filter((h) => h.type === 'moved').pop();
  assert.strictEqual(move.by, 'Autopilot');
  assert.match(move.note, /^Autopilot: Nothing moved it for \d+ minutes: its Dev has been idle for \d+ minutes with no PR, and did not start a turn after Autopilot nudged it \d+ minutes ago\.$/);
  assert.doesNotMatch(move.note, /gone/);
  assert.strictEqual(await nudges(), 1, 'exactly one nudge');
});

test('a Dev that takes a turn after the nudge and stops again with no PR is parked, not nudged again', async (t) => {
  const { dev, taskOf, nudges, say } = await autopilotRig(t);
  await say(dev.sessionId, 'Stop');
  await until(async () => (await nudges()) === 1, 'the nudge', 100);
  await say(dev.sessionId, 'UserPromptSubmit');
  await sleep(500);
  await say(dev.sessionId, 'Stop');
  const parked = await until(async () => { const x = await taskOf(); return x.state === 'waiting_on_you' && x; }, 'the task to wait on you', 100);
  assert.match(parked.history.filter((h) => h.type === 'moved').pop().note, /its Dev has been idle for \d+ minutes with no PR, and took a turn after Autopilot nudged it \d+ minutes ago\.$/);
  assert.strictEqual(await nudges(), 1, 'one nudge per stall');
});

test('a Dev whose session ended is parked as session ended, and is not nudged', async (t) => {
  const { dev, taskOf, notes, say, keys } = await autopilotRig(t);
  await say(dev.sessionId, 'Stop');
  await keys(dev.terminal, '/exit\r');
  const parked = await until(async () => { const x = await taskOf(); return x.state === 'waiting_on_you' && x; }, 'the task to wait on you', 100);
  assert.match(parked.history.filter((h) => h.type === 'moved').pop().note, /its Dev's session ended, and there is no PR\.$/);
  assert.ok(!(await notes()).some((n) => /nudged/.test(n)), 'nobody to nudge');
});
