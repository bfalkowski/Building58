// The test slots every npm test on this computer shares (T-351). Four Devs ran the full suite at once,
// 24 test files at a time, and each run took 20 minutes instead of 6. These tests use a folder of
// their own, not the shared one, and start runs as separate processes, as Devs do.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const { slots, STALE_MS } = require('./slots.js');
const { until } = require('./helpers.js');

const tempDir = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'office-slots-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const settled = (p) => { let done = false; p.then(() => { done = true; }); return () => done; };

test('a run takes a free slot at once, and waits while every slot is taken', async (t) => {
  const dir = tempDir(t);
  const a = slots({ dir, size: 2 }), b = slots({ dir, size: 2 });
  t.after(() => { a.close(); b.close(); });
  const one = await a.take(), two = await a.take();
  const third = b.take(), got = settled(third);
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(got(), false, 'the third file waits: both slots are taken');
  one();
  const release = await third;
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('slot-')).length, 2, 'it took the slot that was let go');
  two(); release();
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('slot-')), [], 'every slot is free again');
});

test('a slot held by a run that died is taken back', async (t) => {
  const dir = tempDir(t);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'slot-0'), dead.stdout);
  const p = slots({ dir, size: 1 }); t.after(p.close);
  const release = await p.take();
  assert.strictEqual(fs.readFileSync(path.join(dir, 'slot-0'), 'utf8'), String(process.pid), 'the slot is now this run\'s');
  release();
});

test('the run that waited longest gets the next free slot', async (t) => {
  const dir = tempDir(t);
  const holder = slots({ dir, size: 1 }), older = slots({ dir, size: 1, started: 1000 }), younger = slots({ dir, size: 1, started: 2000 });
  t.after(() => { holder.close(); older.close(); younger.close(); });
  const held = await holder.take();
  const y = younger.take(), yGot = settled(y);
  const o = older.take(), oGot = settled(o);
  await until(() => fs.readdirSync(dir).filter((f) => f.startsWith('wait-')).length === 2, 'both runs to say they wait');
  held();
  const first = await o;
  assert.strictEqual(yGot(), false, 'the younger run still waits');
  assert.strictEqual(oGot(), true);
  first();
  (await y)();
});

test('a run that is stopped lets go of its slots', async (t) => {
  const dir = tempDir(t);
  const script = 'const p = require(' + JSON.stringify(path.join(__dirname, 'slots.js')) + ').slots({ dir: process.argv[1], size: 1 });'
    + 'process.on("SIGTERM", () => process.exit(1)); p.take().then(() => console.log("held"));';
  const child = spawn(process.execPath, ['-e', script, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((r) => child.stdout.on('data', r));
  const p = slots({ dir, size: 1 }); t.after(p.close);
  const next = p.take();
  child.kill('SIGTERM');
  (await next)();
});

test('npm test waits for a slot, says so, and tells each file it runs to skip the slots', async (t) => {
  const dir = tempDir(t), files = tempDir(t);
  const fixture = path.join(files, 'nested.test.js');
  fs.writeFileSync(fixture, 'process.exitCode = process.env.TEST_SLOTS === "0" ? 0 : 1;');
  const p = slots({ dir, size: 1 }); t.after(p.close);
  const held = await p.take();
  const env = { ...process.env, TEST_SLOTS: '1', TEST_SLOTS_DIR: dir };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [path.join(__dirname, 'run.js'), fixture], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await until(() => /waiting for a test slot/.test(out), 'the run to say it waits');
  assert.doesNotMatch(out, /nested\.test\.js \(/, 'the file has not run');
  held();
  const code = await new Promise((r) => child.on('close', r));
  assert.strictEqual(code, 0, 'a file inside a run sees TEST_SLOTS=0, so a nested run never waits behind its own parent: ' + out);
  assert.match(out, /# nested\.test\.js \(\d+s, pass\)/);
});

test('a run knows when an older run waits, so it lets its slot go after the file it runs now', async (t) => {
  const dir = tempDir(t);
  const younger = slots({ dir, size: 1, started: 2000 }), older = slots({ dir, size: 1, started: 1000 });
  t.after(() => { younger.close(); older.close(); });
  const held = await younger.take();
  assert.strictEqual(younger.olderWaiting(), false, 'nobody waits, so it keeps the slot for its next file');
  const next = older.take();
  assert.strictEqual(younger.olderWaiting(), true);
  assert.strictEqual(older.olderWaiting(), false, 'its own wait does not count');
  held();
  (await next)();
});

test('a slot or wait file that nobody touched for a while is taken back, even when its pid is alive', async (t) => {
  const dir = tempDir(t);
  const old = new Date(Date.now() - STALE_MS - 1000);
  for (const f of ['wait-000000000001000-1', 'slot-0']) {
    fs.writeFileSync(path.join(dir, f), '1');
    fs.utimesSync(path.join(dir, f), old, old);
  }
  const p = slots({ dir, size: 1 }); t.after(p.close);
  let waited = false;
  const release = await p.take(() => { waited = true; });
  assert.strictEqual(waited, false, 'pid 1 is alive, but another process could have its pid after the run that wrote the files died');
  assert.deepStrictEqual(fs.readdirSync(dir), ['slot-0']);
  release();
});

test('a run that waits keeps its wait file fresh, so the order holds while it waits', async (t) => {
  const dir = tempDir(t);
  const holder = slots({ dir, size: 1 }), waiter = slots({ dir, size: 1, started: 1000 });
  t.after(() => { holder.close(); waiter.close(); });
  const held = await holder.take();
  const next = waiter.take();
  const file = path.join(dir, 'wait-000000000001000-' + process.pid);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file, old, old);
  await until(() => fs.statSync(file).mtimeMs > Date.now() - 10000, 'the waiting run to touch its wait file');
  assert.ok(fs.statSync(path.join(dir, 'slot-0')).mtimeMs > Date.now() - 10000, 'and the holder touched its slot');
  held();
  (await next)();
});
