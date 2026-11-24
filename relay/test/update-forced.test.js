'use strict';
// An update that waits for a quiet moment restarts the relay anyway after a limit, at most once in a
// batch window, and still goes back to the last good commit when the new code fails (relay/update.js).
// Through a real relay, with a fake claude, so the session process is a real one.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, ROOT } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, message) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.appendFileSync(path.join(cwd, file), text);
  sh(cwd, 'add', file);
  sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
  return sh(cwd, 'rev-parse', 'HEAD');
};
const waitFor = async (fn, what, ms) => {
  const end = Date.now() + (ms || 30000);
  while (Date.now() < end) { let v = null; try { v = await fn(); } catch (e) { /* between two relays */ } if (v) return v; await sleep(100); }
  throw new Error('Timed out waiting for ' + what);
};
const pidNow = (home, sessionId) => fs.readFileSync(path.join(home, '.fake-claude-tokens'), 'utf8').split('\n').map((l) => l.split(' ')).filter(([id]) => id === sessionId).map((x) => Number(x[1])).pop();
const pidOf = (home, sessionId) => waitFor(() => pidNow(home, sessionId), 'the session process');
const forcedLog = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, '.office-world', 'update-forced.json'), 'utf8')); } catch (e) { return null; } };

// A relay whose update folder is a clone of an origin with one relay file. The running code is this
// checkout's, so a restart changes nothing about what runs.
async function room(t, env) {
  const R0 = await relay({});
  const home = R0.home;
  await R0.kill();
  const src = makeRepo(home, 'src'), origin = path.join(home, 'origin.git'), dir = path.join(home, 'relay-folder');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, origin); sh(home, 'clone', '-q', origin, dir); sh(src, 'remote', 'add', 'origin', origin);
  const repo = makeRepo(home);
  const R = await relay(Object.assign({ RELAY_UPDATE_DIR: dir, RELAY_RESUME: '1' }, env), home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const say = (sessionId, event) => R.hook({ hook_event_name: event, session_id: sessionId.slice(0, 12) });
  const session = async () => {
    const s = (await R.call('POST', '/terminals', { cwd: repo })).body;
    await say(s.sessionId, 'UserPromptSubmit'); await say(s.sessionId, 'Stop');
    return s;
  };
  const busy = (s) => say(s.sessionId, 'UserPromptSubmit');
  const push = (text) => { const c = commit(src, 'relay/x.js', text, 'relay change ' + text.trim()); sh(src, 'push', '-q', 'origin', 'main'); return c; };
  const run = async () => (await R.call('GET', '/update')).body.run;
  return { R, home, src, dir, session, busy, push, run, say };
}

test('with a session always in a turn, the update restarts after the limit and the session process lives on', async (t) => {
  const { R, home, dir, session, busy, push, run } = await room(t, { RELAY_UPDATE_WAIT_MS: '3000', RELAY_UPDATE_FORCED_MS: '600000' });
  const s = await session();
  await busy(s);
  const pid = await pidOf(home, s.sessionId), before = await run(), newest = push('2\n');
  const began = Date.now();
  const u = await R.call('POST', '/update', {});
  assert.strictEqual(u.status, 202, JSON.stringify(u.body));

  await t.test('it says how long it has waited and when it restarts anyway', async () => {
    const v = await waitFor(async () => { const u = (await R.call('GET', '/update')).body.update; return u && u.restartsAnywayAt && u; }, 'the view to say when it restarts anyway');
    assert.strictEqual(v.state, 'waiting');
    assert.strictEqual(typeof v.waitedMinutes, 'number');
    const at = Date.parse(v.restartsAnywayAt);
    assert.ok(at >= began + 2500 && at <= began + 6000, 'restarts anyway about 3 seconds after it began: ' + (at - began));
  });
  await t.test('it restarts only after the limit, on the new commit, and takes the session back', async () => {
    assert.strictEqual(await run(), before, 'not yet');
    await waitFor(async () => (await run()) !== before, 'the relay to restart');
    assert.ok(Date.now() - began >= 3000, 'not before the limit');
    assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), newest);
    const back = await waitFor(async () => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.sessionId === s.sessionId), 'the session');
    assert.ok(back);
    assert.strictEqual(await pidOf(home, s.sessionId), pid, 'the same session process');
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.ok(forcedLog(home) && forcedLog(home).to === newest, 'the forced restart is recorded');
  });
});

test('merges every few seconds with sessions always busy: forced restarts keep the batch gap, and each runs the newest commit', async (t) => {
  const { R, home, dir, session, busy, push, run } = await room(t, { RELAY_UPDATE_WAIT_MS: '2000', RELAY_UPDATE_FORCED_MS: '14000' });
  const s = await session();
  await busy(s);
  push('2\n');
  assert.strictEqual((await R.call('POST', '/update', {})).status, 202);
  const first = await run();
  await waitFor(async () => (await run()) !== first, 'the first forced restart');
  const firstAt = Date.parse(forcedLog(home).at);
  await waitFor(async () => (await R.call('GET', '/terminals')).body.terminals.length === 1, 'the session back');
  await busy(s);

  const b = push('3\n');
  assert.strictEqual((await R.call('POST', '/update', {})).status, 202);
  const second = await run();
  const v = (await R.call('GET', '/update')).body.update;
  assert.ok(Date.parse(v.restartsAnywayAt) >= firstAt + 14000, 'the second waits for the batch gap');
  await waitFor(() => Date.now() > Date.parse(v.startedAt) + 2500, 'the limit to pass');
  assert.strictEqual((await R.call('GET', '/update')).body.update.state, 'waiting');
  assert.strictEqual(await run(), second, 'no restart inside the gap, though the limit has passed');
  const newest = push('4\n');
  assert.ok(newest !== b);
  await waitFor(async () => (await run()) !== second, 'the second forced restart', 30000);
  assert.ok(Date.parse(forcedLog(home).at) >= firstAt + 14000, 'at least the gap after the first');
  assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), newest, 'it ran the newest fetched commit, both merges in one restart');
});

test('with no session in a turn, the update restarts at once, as before', async (t) => {
  const { R, home, session, push, run } = await room(t, { RELAY_UPDATE_WAIT_MS: '600000' });
  const s = await session();
  const before = await run();
  push('2\n');
  const began = Date.now();
  assert.strictEqual((await R.call('POST', '/update', {})).status, 202);
  await waitFor(async () => (await run()) !== before, 'the relay to restart', 20000);
  assert.ok(Date.now() - began < 20000);
  assert.strictEqual(forcedLog(home), null, 'it was not a forced restart');
  await waitFor(async () => (await R.call('GET', '/terminals')).body.terminals.some((x) => x.sessionId === s.sessionId), 'the session back');
});

test('a forced restart goes back to the last good commit when the new code fails its check', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
  const src = path.join(home, 'src'), origin = path.join(home, 'origin.git'), dir = path.join(home, 'relay-folder');
  sh(home, 'init', '-q', '-b', 'main', src);
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'relay', 'office', 'shared', 'package.json'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(src, f));
  }
  sh(src, 'add', '-A'); sh(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'the relay');
  const first = sh(src, 'rev-parse', 'HEAD');
  sh(home, 'clone', '-q', '--bare', src, origin); sh(home, 'clone', '-q', origin, dir); sh(src, 'remote', 'add', 'origin', origin);
  const R = await relay({ RELAY_ROLLBACK: '1', RELAY_RESUME: '1', RELAY_ROLLBACK_SECONDS: '15', RELAY_UPDATE_WAIT_MS: '3000' }, home, { root: dir });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const good = () => { try { return JSON.parse(fs.readFileSync(path.join(home, '.office-world', 'good-commit.json'), 'utf8')); } catch (e) { return {}; } };
  await waitFor(() => good().commit === first, 'the first commit to pass');
  const s = (await R.call('POST', '/terminals', { cwd: dir })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12) });
  const pid = await pidOf(home, s.sessionId);

  fs.appendFileSync(path.join(src, 'relay/floor.js'), 'throw new Error(\'a broken relay\');\n');
  sh(src, 'add', '-A'); sh(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a broken relay');
  const broken = sh(src, 'rev-parse', 'HEAD'); sh(src, 'push', '-q', 'origin', 'main');
  assert.strictEqual((await R.call('POST', '/update', {})).status, 202);
  const u = await waitFor(async () => { const g = (await R.call('GET', '/update')).body; return g.rollback && g; }, 'the relay to come back on the old commit', 60000);
  assert.strictEqual(u.rollback.failed, broken);
  assert.strictEqual(u.rollback.running, first);
  assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), first);
  const back = await waitFor(async () => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.sessionId === s.sessionId), 'the session');
  assert.ok(back);
  assert.strictEqual(await pidOf(home, s.sessionId), pid, 'the same session process');
  assert.ok(forcedLog(home), 'the restart was forced');
});
