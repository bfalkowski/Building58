'use strict';
// Update waits for a refresh of the Lead to finish. The refresh lives only in the relay's memory, and
// the Lead is idle between its steps, so a restart there, say after the notes and before /clear,
// would lose it. Through a real relay, with a fake claude.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, message) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  sh(cwd, 'add', file);
  sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
};
const BRIEF = 'GOT[You are the Lead of this room.', NOTES = 'GOT[Your conversation is about to be cleared', CLEAR = 'GOT[/clear]', READ = 'GOT[You were just cleared';
const count = (text, what) => text.split(what).length - 1;

test('an update waits for a refresh of the Lead, and the refresh still finishes', async (t) => {
  const R0 = await relay({});
  const home = R0.home;
  await R0.kill();
  const src = makeRepo(home, 'src'), relayOrigin = path.join(home, 'relay-origin.git'), dir = path.join(home, 'relay-folder');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, relayOrigin); sh(home, 'clone', '-q', relayOrigin, dir); sh(src, 'remote', 'add', 'origin', relayOrigin);
  const R = await relay({ RELAY_UPDATE_DIR: dir, RELAY_RESUME: '1' }, home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const hook = (event, sid, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: sid.slice(0, 12) }, extra));
  const update = async () => (await R.call('GET', '/update')).body;
  const a = (await R.call('POST', '/terminals', { cwd: dir })).body;
  let sid = a.sessionId;
  await R.call('POST', '/terminals/lead', { terminal: a.id });
  await until(async () => (await R.screen(a.id)).includes(BRIEF), 'the brief');
  await hook('UserPromptSubmit', sid); await hook('Stop', sid); await sleep(3200);  // past ENTER_SETTLES after the brief's Enter

  assert.strictEqual((await R.call('POST', '/terminals/lead', { refresh: true })).status, 200);
  await until(async () => (await R.screen(a.id)).includes(NOTES), 'the notes prompt');
  await hook('UserPromptSubmit', sid);  // the notes turn
  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
  const run = (await update()).run;
  const u = await R.call('POST', '/update', {});
  assert.strictEqual(u.status, 202, JSON.stringify(u.body));

  // At a question, a refreshing Lead is still waited for, and only named once.
  await hook('Notification', sid, { message: 'Claude needs your permission to use Write' });
  await sleep(1500);
  let now = await update();
  assert.deepStrictEqual(now.update.waitingOn.map((w) => [w.terminal, w.why]), [[a.id, 'refreshing']]);

  // The notes turn ends. The Lead is idle now, but its refresh is not done, so the update still waits.
  await hook('Stop', sid);
  await sleep(1500);  // three of the update's looks
  now = await update();
  assert.strictEqual(now.run, run, 'the relay did not restart between the notes and /clear');
  assert.deepStrictEqual(now.update.waitingOn.map((w) => [w.terminal, w.title, w.why]), [[a.id, 'The Lead', 'refreshing']]);

  // While the update waits, the relay types into no session, except the Lead's refresh steps, or neither would ever end.
  await until(async () => (await R.screen(a.id)).includes(CLEAR), '/clear, during the update');
  sid = '11111111-2222-4333-8444-555555555555';
  await R.hook({ hook_event_name: 'SessionStart', source: 'clear', session_id: sid.slice(0, 12), full_session_id: sid, terminal: a.id });
  await until(async () => count(await R.screen(a.id), BRIEF) === 2, 'the brief again, during the update');
  await hook('UserPromptSubmit', sid); await sleep(300); await hook('Stop', sid);
  await until(async () => (await R.screen(a.id)).includes(READ), 'the read prompt, during the update');
  now = await update();
  assert.strictEqual(now.run, run, 'the relay did not restart before the read prompt went in');

  // The refresh is done, so the update goes on once the read prompt's turn ends.
  await hook('UserPromptSubmit', sid); await hook('Stop', sid);
  const restarted = await until(async () => {
    try { const g = await update(); return g.run !== run && g; } catch (e) { return null; }
  }, 'the relay to restart', 200);
  assert.strictEqual(restarted.update, null);
});
