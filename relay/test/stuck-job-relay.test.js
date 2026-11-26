// A job with no CPU and no new output for 30 minutes is stuck (relay/jobs.js, relay/stuck-jobs.js). Through a real
// relay with a fake claude (relay/test/fake-claude.sh: /job starts a job that sleeps) and times cut to
// seconds: the Floor and Needs you say so, the Dev is told once, the relay ends that one job after the second
// look and never the session, and the person and the Lead can end it sooner.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, removeDir, sleep, until, sessionToken } = require('./helpers.js');

const TIMES = { RELAY_JOB_SCAN_MS: '150', RELAY_JOB_STUCK_MS: '1500', RELAY_JOB_CPU_WINDOW_MS: '300', RELAY_STUCK_JOB_CHECK_MS: '150' };
const TOLD = /GOT\[Your command .* has done nothing for 30 minutes\. If it waits for a background command, Claude Code tells you when that ends, so end the loop\.\]/;

async function office(env) {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ RELAY_WIP_LIMIT: '8', RELAY_AUTOPILOT_STALL_MS: '3600000', GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh, ...TIMES, ...env });
  const repo = makeRepo(R.home);
  await R.call('POST', '/reviews', { auto: false });
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(100); };
  const rowOf = async (id) => (await R.call('GET', '/floor')).body.sessions.find((r) => r.terminal === id);
  const made = await R.call('POST', '/tasks', { title: 'A task', repo });
  const task = made.body.task, dev = { id: task.owner.terminal, sessionId: task.owner.sessionId };
  await until(async () => (await R.screen(dev.id)).includes('GOT['), 'the task brief');
  await hook(dev, { hook_event_name: 'UserPromptSubmit', title: '' });
  await R.call('POST', '/terminals/' + dev.id + '/input', { data: '/job\r' });
  await hook(dev, { hook_event_name: 'Stop' });
  const done = async () => { await R.kill().catch(() => {}); await R.remove(); removeDir(gh); };
  return { R, dev, task, rowOf, hook, done, repo };
}

test('a stuck job shows on the Floor and Needs you, the Dev is told once, and after the second look only the job ends', async (t) => {
  const o = await office({ RELAY_STUCK_JOB_SECOND_MS: '5000' });
  t.after(o.done);
  const { R, dev, rowOf } = o;
  const busy = await until(async () => { const r = await rowOf(dev.id); return /^job/.test(r.state) && r; }, 'the job to show as busy while it is young', 50);
  assert.strictEqual(busy.stuckJobs.length, 0);

  const row = await until(async () => { const r = await rowOf(dev.id); return r.stuckJobs.length && r; }, 'the job to be called stuck');
  assert.match(row.state, /^stuck job: .*sleep 60.*, quiet for 0 min$/);
  assert.deepStrictEqual(row.desk.doing.state, 'stuck');
  assert.match(row.desk.doing.words, /^stuck job: /);

  const needs = (await R.call('GET', '/needs-you')).body.items.find((i) => i.kind === 'stuck-job');
  assert.ok(needs, 'Needs you has a line for it');
  assert.match(needs.line, /^End the stuck job of .*: .*, quiet for 0 min, with no CPU and no new output\. Press End it\. The session runs on\.$/);
  assert.deepStrictEqual(needs.link, { terminal: dev.id, endJob: row.stuckJobs[0].pid });

  await until(async () => TOLD.test(await R.screen(dev.id)), 'the Dev to be told');
  await sleep(1500);
  assert.strictEqual(((await R.screen(dev.id)).match(/GOT\[Your command/g) || []).length, 1, 'told once');
  assert.ok((await rowOf(dev.id)).stuckJobs.length, 'still stuck before the second look');

  const ended = await until(async () => { const r = await rowOf(dev.id); return !r.stuckJobs.length && r; }, 'the relay to end the job at the second look', 100);
  assert.strictEqual(ended.state, 'idle', 'the session is idle: neither busy nor stuck');
  assert.ok((await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === dev.id), 'the session runs on');
  const jam = (await R.call('GET', '/jams')).body.jams.find((j) => j.kind === 'stuck-job');
  assert.ok(jam, 'a stuck-job jam is logged');
  assert.strictEqual(jam.by, 'room');
  assert.match(jam.fix, /^The relay ended the stuck job /);
});

test('the person ends a stuck job with End it, and a job that is not stuck is refused', async (t) => {
  const o = await office({ RELAY_STUCK_JOB_SECOND_MS: '3600000' });
  t.after(o.done);
  const { R, dev, rowOf } = o;
  const early = await R.call('POST', '/floor/end-job', { who: dev.id });
  assert.strictEqual(early.status, 409);
  assert.strictEqual(early.body.error, 'not_stuck');
  const row = await until(async () => { const r = await rowOf(dev.id); return r.stuckJobs.length && r; }, 'the job to be called stuck');
  const wrong = await R.call('POST', '/floor/end-job', { who: dev.id, pid: row.stuckJobs[0].pid + 1 });
  assert.strictEqual(wrong.status, 409, 'a process that is not its stuck job is refused');
  const r = await R.call('POST', '/floor/end-job', { who: dev.id, pid: row.stuckJobs[0].pid });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await until(async () => !(await rowOf(dev.id)).stuckJobs.length, 'the job to end');
  assert.ok((await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === dev.id), 'the session runs on');
});

test('the Lead ends a stuck job only with Let the Lead stop sessions on, and while Autopilot is on', async (t) => {
  const o = await office({ RELAY_STUCK_JOB_SECOND_MS: '3600000' });
  t.after(o.done);
  const { R, dev, rowOf, hook } = o;
  const lead = (await R.call('POST', '/terminals', { cwd: o.repo })).body;
  await hook(lead, { hook_event_name: 'UserPromptSubmit', title: '' }); await hook(lead, { hook_event_name: 'Stop' });
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true })).body.board, true);
  const token = await until(() => { try { return { 'X-Office-Token': sessionToken(lead.sessionId) }; } catch (e) { return null; } }, 'the token');
  const row = await until(async () => { const r = await rowOf(dev.id); return r.stuckJobs.length && r; }, 'the job to be called stuck');
  const off = await R.call('POST', '/floor/end-job', { who: row.name }, token);
  assert.strictEqual(off.status, 403);
  assert.strictEqual(off.body.error, 'lead_stops_off');
  assert.strictEqual((await R.call('POST', '/settings', { values: { leadStops: true } })).status, 200);
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true, only: [] })).status, 200);
  const r = await R.call('POST', '/floor/end-job', { who: row.name }, token);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await until(async () => !(await rowOf(dev.id)).stuckJobs.length, 'the job to end');
  const again = await R.call('POST', '/floor/end-job', { who: row.name }, token);
  assert.strictEqual(again.status, 409, 'nothing is stuck now');
});
