'use strict';
// A session the relay takes back from the session host after a restart keeps the time of its last
// hook (T-236). Before, the new relay set it to the moment of the restart, so an idle Dev looked as if
// it had just acted: the Floor's minutes since its hook, the liveness time that Autopilot's stall check
// reads, and the no-PR park reason ("idle for N minutes") all counted from the restart.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');
const { livenessOf } = require('../liveness.js');
const { noPrWhy } = require('../nudge.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, message) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  sh(cwd, 'add', file);
  sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
};
const RESUME = { RELAY_RESUME: '1', RELAY_WIP_LIMIT: '5' };

test('an idle session taken back after a restart keeps the time of its last hook', async (t) => {
  const R0 = await relay(RESUME);
  const home = R0.home;
  await R0.kill();
  const origin = path.join(home, 'origin.git'), src = makeRepo(home, 'src'), dir = path.join(home, 'relay-folder');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, origin);
  sh(home, 'clone', '-q', origin, dir);
  sh(src, 'remote', 'add', 'origin', origin);
  const R = await relay(Object.assign({ RELAY_UPDATE_DIR: dir }, RESUME), home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;

  const s = await R.start({ cwd: dir });
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12) });
  await R.hook({ hook_event_name: 'Stop', session_id: s.sessionId.slice(0, 12) });
  const before = await until(async () => { const x = (await terminals()).find((y) => y.id === s.id); return x && x.state === 'idle' && x.lastActAt && x; }, 'the session idle');
  await sleep(1500);  // so a clock set at the restart differs from the last hook

  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
  const run = (await R.call('GET', '/update')).body.run;
  const restartAt = Date.now();
  assert.strictEqual((await R.call('POST', '/update', {})).body.restart, true);
  const after = await until(async () => {
    try {
      const u = (await R.call('GET', '/update')).body;
      if (u.update || u.run === run) return null;
      return (await terminals()).find((x) => x.id === s.id) || null;
    } catch (e) { return null; }  // between the two relays
  }, 'the relay to restart with the session');
  assert.match(R.output(), /Took back .* still running/, 'the same process, taken back from the host');

  await t.test('the time of its last hook is the one from before the restart', () => {
    assert.ok(before.lastActAt < restartAt);
    assert.strictEqual(after.lastActAt, before.lastActAt);
  });
  await t.test('the stall time and the no-PR park reason count from that hook, not the restart', () => {
    const later = before.lastActAt + 45 * 60 * 1000;
    assert.strictEqual(livenessOf(after, later).since, before.lastActAt);
    assert.strictEqual(noPrWhy('t', {}, { id: 'task-1' }, after, later), 'its Dev has been idle for 45 minutes with no PR');
  });
});
