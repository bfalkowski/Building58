// A session in a room runs the tests with the room's settings in its shell, and CI does not. Once,
// RELAY_ROLLBACK and RELAY_WORLD from an office shell failed 4 tests in relay/test/restart.test.js that
// passed in CI (T-222). So the test helpers start each relay, and the runner each file, without them.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const { relay, until } = require('./helpers.js');

const ROOM = { RELAY_ROLLBACK: '1', RELAY_WORLD: 'office', OFFICE_ROOM_TEST: 'from the room', CLAUDE_CODE_ROOM_TEST: 'from the room' };
const named = (text) => Object.entries(ROOM).filter(([k, v]) => new RegExp('^' + k + '=' + v + '$', 'm').test(text)).map(([k]) => k);

function inRoom(t) {
  const was = {};
  for (const [k, v] of Object.entries(ROOM)) { was[k] = process.env[k]; process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('a test relay ignores RELAY_ROLLBACK, RELAY_WORLD and the other room variables of the shell that runs it, but not those the test sets', async (t) => {
  inRoom(t);
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-room-env-')));
  const seen = path.join(tmp, 'env.txt'), cmd = path.join(tmp, 'claude');
  fs.writeFileSync(cmd, '#!/bin/sh\nenv > "' + seen + '"\nexec "' + path.join(__dirname, 'fake-claude.sh') + '" "$@"\n', { mode: 0o755 });
  const R = await relay({ CLAUDE_CMD: cmd, OFFICE_ROOM_SET: 'by the test' });
  t.after(async () => { await R.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });
  await R.start({ cwd: tmp });
  const env = await until(() => fs.existsSync(seen) && fs.readFileSync(seen, 'utf8'), 'the session to write down its environment');
  assert.deepStrictEqual(named(env), [], 'the relay passed the shell\'s room variables on to its session');
  assert.match(env, /^RELAY_ROLLBACK=0$/m, 'the helper\'s own RELAY_ROLLBACK=0 still holds');
  assert.match(env, /^OFFICE_ROOM_SET=by the test$/m, 'a room variable the test sets itself still reaches the relay');
});

test('the test runner gives each file none of the room variables of the shell that runs it', (t) => {
  inRoom(t);
  const env = { ...process.env, TEST_SLOTS: '0' };
  delete env.NODE_TEST_CONTEXT;  // or node --test inside this test skips the file
  const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), path.join(__dirname, 'room-env.fixture.js')], { env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /room variables: \[\]/);
});
