// The suite's own cleanup (T-184). Two relays on one home once left the second running when the
// first removed the folder under it, and that one test file then kept the whole run from ending.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const { relay } = require('./helpers.js');

test('removing a home stops every relay still on it first', async (t) => {
  const R = await relay(); t.after(R.stop);
  const second = await relay({}, R.home); t.after(second.stop);
  await R.stop();
  assert.ok(second.child.exitCode !== null || second.child.signalCode, 'the second relay is stopped');
  assert.ok(!fs.existsSync(R.home), 'and the home is gone');
});

test('a test file that never ends fails with a clear message, and does not hang the run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hang-'));
  const pidFile = path.join(dir, 'pid');
  try {
    const env = { ...process.env, TEST_FILE_SECONDS: '3', HANG_PID_FILE: pidFile };
    delete env.NODE_TEST_CONTEXT;  // or node --test inside this test skips the file
    const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), path.join(__dirname, 'hang.fixture.js')],
      { env, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 1, 'the run ends, and fails: ' + r.stdout + r.stderr);
    assert.match(r.stdout, /hang\.fixture\.js did not end within 3 seconds, so it was stopped/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
    assert.ok(!alive(), 'what the file left running is stopped too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
