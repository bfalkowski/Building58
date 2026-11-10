'use strict';
// The way back from a relay that fails on new code (relay/rollback.js, relay/supervisor.js). The
// relay here is a copy of this one in a git folder of its own, so an Update really changes the code
// it runs, and a broken commit really breaks it.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, sleep, ROOT } = require('./helpers.js');
const rollback = require('../rollback.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitAll = (cwd, message) => { sh(cwd, 'add', '-A'); sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message); return sh(cwd, 'rev-parse', 'HEAD'); };
const waitFor = async (fn, what, ms) => {
  const end = Date.now() + (ms || 30000);
  while (Date.now() < end) { let v = null; try { v = await fn(); } catch (e) { /* between two relays */ } if (v) return v; await sleep(200); }
  throw new Error('Timed out waiting for ' + what);
};
const talk = (R, sid) => R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid.slice(0, 12) });
const idle = (R, sid) => R.hook({ hook_event_name: 'Stop', session_id: sid.slice(0, 12) });

test('plan: when a failed check rolls back', () => {
  const ok = { newCode: true, again: false, good: 'aaa', head: 'bbb', dirty: [] };
  assert.strictEqual(rollback.plan(ok).rollback, true);
  assert.match(rollback.plan(Object.assign({}, ok, { newCode: false })).why, /did not follow an Update/);
  assert.match(rollback.plan(Object.assign({}, ok, { again: true })).why, /only once in a row/);
  assert.match(rollback.plan(Object.assign({}, ok, { good: null })).why, /No commit has passed/);
  assert.match(rollback.plan(Object.assign({}, ok, { good: 'bbb' })).why, /nothing older/);
  assert.match(rollback.plan(Object.assign({}, ok, { dirty: ['relay/x.js'] })).why, /changes to tracked files \(relay\/x\.js\)/);
});

test('Update goes back to the last good commit when the new relay fails its check', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-test-')));
  // A copy of this relay, with the pages it serves, as the first commit of a repo on a remote.
  const src = path.join(home, 'src'), origin = path.join(home, 'origin.git'), dir = path.join(home, 'relay-folder');
  sh(home, 'init', '-q', '-b', 'main', src);
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'relay', 'office', 'shared', 'package.json'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(src, f));
  }
  const first = commitAll(src, 'the relay');
  sh(home, 'clone', '-q', '--bare', src, origin); sh(home, 'clone', '-q', origin, dir); sh(src, 'remote', 'add', 'origin', origin);
  const push = (file, text, message) => { fs.appendFileSync(path.join(src, file), text); const c = commitAll(src, message); sh(src, 'push', '-q', 'origin', 'main'); return c; };
  const goodFile = path.join(home, '.office-world', 'good-commit.json');
  const good = () => { try { return JSON.parse(fs.readFileSync(goodFile, 'utf8')); } catch (e) { return {}; } };

  const R = await relay({ RELAY_ROLLBACK: '1', RELAY_RESUME: '1', RELAY_ROLLBACK_SECONDS: '15' }, home, { root: dir });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;

  await t.test('the first start passes, and its commit is recorded outside the repo', async () => {
    await waitFor(() => good().commit === first, 'the first commit to be recorded');
    assert.match(R.output(), /passed its check/);
  });

  const s = (await R.call('POST', '/terminals', { cwd: dir })).body;
  await talk(R, s.sessionId); await idle(R, s.sessionId); await sleep(200);

  let second;
  await t.test('a pass: the new relay answers, serves the page and brings back the session, so its commit is recorded', async () => {
    second = push('relay/floor.js', '// a harmless change\n', 'a relay change');
    const r = await R.call('POST', '/update', {});
    assert.strictEqual(r.status, 202, r.body.message);
    await waitFor(() => good().commit === second, 'the new commit to be recorded');
    const back = await waitFor(async () => { const l = await terminals(); return l.length === 1 && l[0]; }, 'the session');
    assert.strictEqual(back.sessionId, s.sessionId);
    assert.strictEqual(sh(dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.strictEqual((await R.call('GET', '/update')).body.rollback, null);
    assert.strictEqual(R.child.exitCode, null, 'the supervisor kept running');
  });

  await t.test('a fail: the new relay does not start, so Update checks out the last good commit and restarts on it', async () => {
    await idle(R, s.sessionId);  // the session brought back is heard from, so the restart need not wait for it
    const broken = push('relay/floor.js', 'throw new Error(\'a broken relay\');\n', 'a broken relay');
    const r = await R.call('POST', '/update', {});
    assert.strictEqual(r.status, 202, r.body.message);
    const u = await waitFor(async () => { const g = (await R.call('GET', '/update')).body; return g.rollback && g; }, 'the relay to come back on the old commit');
    assert.strictEqual(u.rollback.failed, broken);
    assert.strictEqual(u.rollback.running, second);
    assert.match(u.rollback.why, /stopped with exit code 1/);
    assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), second, 'the folder is on the last good commit');
    assert.match(R.output(), /a broken relay/);
    assert.match(R.output(), new RegExp('Rolled back to ' + second.slice(0, 7)));
    const back = await waitFor(async () => { const l = await terminals(); return l.length === 1 && l[0]; }, 'the session');
    assert.strictEqual(back.sessionId, s.sessionId, 'the session came back on the old commit');
    await waitFor(() => /passed its check[\s\S]*passed its check[\s\S]*passed its check/.test(R.output()), 'the old commit to pass again');
    assert.strictEqual(good().commit, second);
    assert.strictEqual(good().rollback.failed, broken);
  });

  await t.test('and Update pulls nothing more until a person checks out main, and says why', async () => {
    const r = await R.call('POST', '/update', {});
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'not_main');
    assert.match(r.body.message, new RegExp('went back to ' + second.slice(0, 7) + ' when [0-9a-f]{7} failed its check'));
  });

  await t.test('once a person checks out main, the page no longer says it rolled back', async () => {
    sh(dir, 'checkout', '-q', 'main');
    assert.strictEqual((await R.call('GET', '/update')).body.rollback, null);
  });

  await t.test('a fail while the relay still runs: it is stopped, saves its sessions, and Update goes back', async () => {
    await idle(R, s.sessionId);
    // Main is fixed, but the new relay never finishes bringing back its sessions.
    fs.writeFileSync(path.join(src, 'relay/floor.js'), fs.readFileSync(path.join(src, 'relay/floor.js'), 'utf8').replace('throw new Error(\'a broken relay\');\n', ''));
    const stuck = push('relay/sessions.js', 'module.exports.restoreAll = () => {};\n', 'a relay that never brings its sessions back');
    const r = await R.call('POST', '/update', {});
    assert.strictEqual(r.status, 202, r.body.message);
    const u = await waitFor(async () => { const g = (await R.call('GET', '/update')).body; return g.rollback && g.rollback.failed === stuck && g; }, 'the relay to come back on the old commit', 60000);
    assert.strictEqual(u.rollback.running, second);
    assert.match(u.rollback.why, /had not finished bringing back its sessions/);
    assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), second);
    const back = await waitFor(async () => { const l = await terminals(); return l.length === 1 && l[0]; }, 'the session');
    assert.strictEqual(back.sessionId, s.sessionId, 'the session came back on the old commit');
  });
});

test('the record of the last good commit belongs to one folder', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-test-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const was = { dir: process.env.RELAY_UPDATE_DIR, file: process.env.RELAY_GOOD_FILE };
  t.after(() => { for (const [k, v] of [['RELAY_UPDATE_DIR', was.dir], ['RELAY_GOOD_FILE', was.file]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.RELAY_GOOD_FILE = path.join(home, 'good-commit.json');
  process.env.RELAY_UPDATE_DIR = path.join(home, 'one');
  rollback.passed('aaa');
  assert.strictEqual(rollback.read().commit, 'aaa');
  process.env.RELAY_UPDATE_DIR = path.join(home, 'two');
  assert.strictEqual(rollback.read().commit, undefined, 'another folder\'s record is not this one\'s');
});

test('a rollback never touches changes to tracked files', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-test-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  sh(home, 'init', '-q', '-b', 'main', 'r');
  const r = path.join(home, 'r');
  fs.writeFileSync(path.join(r, 'a.txt'), '1\n'); const a = commitAll(r, 'a');
  fs.writeFileSync(path.join(r, 'a.txt'), '2\n'); commitAll(r, 'b');
  fs.writeFileSync(path.join(r, 'a.txt'), 'by hand\n');
  const was = process.env.RELAY_UPDATE_DIR;
  process.env.RELAY_UPDATE_DIR = r;
  t.after(() => { if (was === undefined) delete process.env.RELAY_UPDATE_DIR; else process.env.RELAY_UPDATE_DIR = was; });
  assert.deepStrictEqual(rollback.changed(), ['a.txt']);
  assert.strictEqual(rollback.plan({ newCode: true, again: false, good: a, head: rollback.head(), dirty: rollback.changed() }).rollback, false);
  assert.throws(() => rollback.checkout(a), 'git refuses to check out over it');
  assert.strictEqual(fs.readFileSync(path.join(r, 'a.txt'), 'utf8'), 'by hand\n');
});
