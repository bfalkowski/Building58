'use strict';
// On 2026-11-28 PR #567 merged at 04:15 and its update waited for a quiet moment. At 04:23:56 a new task
// started just before the restart, which called the update off, and the fix reached the room only when
// a person pressed Update again at 04:39. While an update waits, Autopilot starts no new task, and a restart
// called off that way waits again by itself, from the same first wait.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
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
const HOLD = /^An update waits for a quiet moment, so Autopilot starts no new task/;

test('an update that waits restarts first, and the ticket ready to start starts after', async (t) => {
  const R0 = await relay({});
  const home = R0.home;
  await R0.kill();
  const src = makeRepo(home, 'src'), relayOrigin = path.join(home, 'relay-origin.git'), dir = path.join(home, 'relay-folder');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, relayOrigin); sh(home, 'clone', '-q', relayOrigin, dir); sh(src, 'remote', 'add', 'origin', relayOrigin);
  const repo = makeRepo(home);
  let R = await relay({ RELAY_UPDATE_DIR: dir, RELAY_RESUME: '1', RELAY_AUTOPILOT_TICK_MS: '300' }, home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const say = (sid, event) => R.hook({ hook_event_name: event, session_id: sid.slice(0, 12) });
  const tasksNow = async () => (await R.call('GET', '/tasks')).body.tasks;

  const busy = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await say(busy.sessionId, 'UserPromptSubmit');
  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
  const run = (await R.call('GET', '/update')).body.run;
  assert.strictEqual((await R.call('POST', '/update', {})).status, 202);

  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  await until(async () => HOLD.test((await R.call('GET', '/autopilot')).body.idle || ''), 'Autopilot to say it holds its starts');
  assert.deepStrictEqual((await tasksNow()).filter((x) => x.ticket === ticket.id), [], 'nothing started while the update waits');

  await say(busy.sessionId, 'Stop');
  const back = await until(async () => {
    try { const g = (await R.call('GET', '/update')).body; return g.run !== run && g; } catch (e) { return null; }
  }, 'the relay to restart');
  assert.strictEqual(back.update, null);
  const started = await until(async () => (await tasksNow()).find((x) => x.ticket === ticket.id), 'Autopilot to start the ticket after the restart');
  assert.strictEqual(started.by, 'Autopilot');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'relay/x.js'), 'utf8'), '2\n');
});

test('a restart called off by a start waits again by itself, counting from its first wait', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const src = makeRepo(home, 'src'), relayOrigin = path.join(home, 'relay-origin.git'), dir = path.join(home, 'relay-folder');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, relayOrigin); sh(home, 'clone', '-q', relayOrigin, dir); sh(src, 'remote', 'add', 'origin', relayOrigin);
  Object.assign(process.env, { HOME: home, RELAY_STATE_DIR: path.join(home, 'state'), RELAY_TERMINAL: '1', RELAY_SUPERVISED: '1', RELAY_UPDATE_DIR: dir, RELAY_UPDATE_WAIT_MS: '3600000' });
  const tasks = require('../tasks.js');
  const update = require('../update.js');
  const { RESTART } = require('../supervisor.js');
  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');

  const realNow = Date.now;
  const exited = new Promise((resolve) => { process.exit = (code) => resolve(code); });
  const logs = [];
  const ctx = { log: (m) => logs.push(m), problem() {}, send() {} };
  let at = realNow();
  Date.now = () => at;
  t.after(() => { Date.now = realNow; });

  let late = true;
  tasks.busy = () => { const now = late && logs.some((m) => /^Restarting the relay/.test(m)); if (now) late = false; return now; };
  const [status] = await update.run(ctx);
  assert.strictEqual(status, 202);
  const code = await exited;
  assert.strictEqual(code, RESTART, 'the restart ran by itself after the call-off');
  assert.ok(logs.some((m) => /called off, since A new task \(starting\) started just before it/.test(m)), logs.join('\n'));
  assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), sh(relayOrigin, 'rev-parse', 'main'), 'pulled only at the second restart');
});
