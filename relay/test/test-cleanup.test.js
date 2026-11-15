// The suite's own cleanup (T-184). Two relays on one home once left the second running when the
// first removed the folder under it, and that one test file then kept the whole run from ending.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
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

// A fake gh child, or the relay's last gh poll, can still write into its folder as a test ends, so a
// plain rmSync of that folder fails with ENOTEMPTY (T-140). Every test removes it with removeDir, which retries.
test('every fake gh folder is removed with removeDir, which retries while a writer finishes', () => {
  const plain = [];
  for (const name of fs.readdirSync(__dirname).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(__dirname, name), 'utf8');
    const folders = [...text.matchAll(/const (\w+) = [^\n]*mkdtempSync\([^\n]*'office-gh-'/g)].map((m) => m[1]);
    for (const v of new Set(folders)) if (new RegExp('fs\\.rmSync\\(' + v + '\\b').test(text)) plain.push(name + ': ' + v);
  }
  assert.deepStrictEqual(plain, [], 'these remove a fake gh folder with a plain fs.rmSync');
});

test('removeDir waits out a writer that is still adding files', async () => {
  const { removeDir } = require('./helpers.js');
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  // Another process, as a fake gh is, keeps adding to the folder for 400 ms while the folder is removed.
  const writer = "const fs = require('fs'), p = require('path'), d = process.argv[1], end = Date.now() + 400; console.log('go');" +
    "for (let n = 0; Date.now() < end; n++) { try { fs.mkdirSync(p.join(d, 'd' + n)); fs.writeFileSync(p.join(d, 'd' + n, 'f'), 'x'); } catch (e) { /* gone */ } }";
  const child = spawn(process.execPath, ['-e', writer, ghDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ended = new Promise((r) => child.once('exit', r));
  await new Promise((r) => child.stdout.once('data', r));
  await new Promise((r) => setTimeout(r, 50));
  try { removeDir(ghDir); } finally { await ended; }
  assert.ok(!fs.existsSync(ghDir), 'the folder is gone');
});
