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
const { until, relay, makeRepo } = require('./helpers.js');

const tempDir = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'office-slots-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const runEnv = (extra) => { const env = { ...process.env, ...extra }; delete env.NODE_TEST_CONTEXT; return env; };
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

test('the pool is as big as the computer has cores, unless TEST_SLOTS says otherwise', () => {
  const { sizeOf } = require('./slots.js');
  assert.strictEqual(sizeOf(undefined), os.availableParallelism());
  assert.strictEqual(sizeOf(''), os.availableParallelism());
  assert.strictEqual(sizeOf('lots'), os.availableParallelism(), 'a value that is not a whole number counts as the default');
  assert.strictEqual(sizeOf('4'), 4);
  assert.strictEqual(sizeOf('0'), 0, '0 turns the limit off');
});

test('on a Node with no os.availableParallelism, any node a session runs still starts, and a test file counts the cores another way', (t) => {
  const dir = tempDir(t), old = path.join(dir, 'old-node.js'), gate = path.join(__dirname, 'slot-gate.js');
  fs.writeFileSync(old, 'delete require("os").availableParallelism;\n');
  const node = (extra) => spawnSync(process.execPath, ['--require', old, '--require', gate, '-e', 'console.log(require("./relay/test/slots.js").sizeOf(undefined))'],
    { cwd: path.join(__dirname, '..', '..'), env: runEnv({ TEST_SLOTS: '', TEST_SLOTS_DIR: path.join(dir, 'slots'), ...extra }), encoding: 'utf8' });
  const plain = node({});
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert.strictEqual(Number(plain.stdout), os.cpus().length);
  const inTest = node({ NODE_TEST_CONTEXT: 'child-v8' });
  assert.strictEqual(inTest.status, 0, inTest.stderr);
});

test('the slot gate makes the test files of any node --test run share the slots', async (t) => {
  const dir = tempDir(t), project = path.join(dir, 'project'), slotDir = path.join(dir, 'slots'), log = path.join(dir, 'times.log');
  fs.mkdirSync(project);
  const body = 'const fs = require("fs"); const test = require("node:test");\n'
    + 'test("works", async () => { const s = Date.now(); await new Promise((r) => setTimeout(r, 400)); fs.appendFileSync(process.env.TIMES, s + " " + Date.now() + "\\n"); });\n';
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(project, n + '.test.js'), body);
  const run = (slotsSetting) => {
    fs.writeFileSync(log, '');
    const r = spawnSync(process.execPath, ['--test'], { cwd: project, encoding: 'utf8', env: runEnv({ NODE_OPTIONS: '--require=' + JSON.stringify(path.join(__dirname, 'slot-gate.js')), TEST_SLOTS: slotsSetting, TEST_SLOTS_DIR: slotDir, TIMES: log }) });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const spans = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ').map(Number)).sort((x, y) => x[0] - y[0]);
    assert.strictEqual(spans.length, 3);
    return spans.slice(1).some((s, i) => s[0] < spans[i][1]);
  };
  assert.strictEqual(run('1'), false, 'with one slot, no two files run at the same time');
  assert.strictEqual(run('3'), true, 'with three slots, they do');
  assert.deepStrictEqual(fs.readdirSync(slotDir).filter((f) => f.startsWith('slot-') || f.startsWith('wait-')), [], 'every slot and wait file is gone after the run');
});

test('a node --test run inside a test file that holds the last slot does not wait behind it', async (t) => {
  const dir = tempDir(t), outer = path.join(dir, 'outer'), inner = path.join(dir, 'inner');
  fs.mkdirSync(outer); fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'inner.test.js'), 'require("node:test")("inner", () => {});\n');
  fs.writeFileSync(path.join(outer, 'outer.test.js'), 'const { spawnSync } = require("child_process"); const assert = require("node:assert");\n'
    + 'require("node:test")("runs the inner tests", () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; const r = spawnSync(process.execPath, ["--test"], { cwd: ' + JSON.stringify(inner) + ', env, encoding: "utf8", timeout: 20000 }); assert.strictEqual(r.status, 0, r.stdout + r.stderr); });\n');
  const r = spawnSync(process.execPath, ['--test'], { cwd: outer, encoding: 'utf8', timeout: 30000, env: runEnv({ NODE_OPTIONS: '--require=' + JSON.stringify(path.join(__dirname, 'slot-gate.js')), TEST_SLOTS: '1', TEST_SLOTS_DIR: path.join(dir, 'slots') }) });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('a session the room starts gets the slot gate through NODE_OPTIONS, unless TEST_SLOTS is 0', (t) => {
  const { slotGate } = require('../session-env.js');
  const state = tempDir(t);
  const stub = path.join(state, 'slot-gate.js');
  const set = slotGate({ NODE_OPTIONS: '--max-old-space-size=4096' }, state);
  assert.strictEqual(set.NODE_OPTIONS, '--max-old-space-size=4096 --require=' + JSON.stringify(stub), 'the person\'s own NODE_OPTIONS are kept');
  assert.ok(fs.existsSync(stub), 'the stub is written to the room\'s state folder');
  assert.deepStrictEqual(slotGate({}, state), { NODE_OPTIONS: '--require=' + JSON.stringify(stub) });
  assert.deepStrictEqual(slotGate({ TEST_SLOTS: '0' }, state), {}, 'TEST_SLOTS=0 leaves sessions as they were');
  const ok = spawnSync(process.execPath, ['-e', 'process.stdout.write("started")'], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--require=' + JSON.stringify(stub) } });
  assert.strictEqual(ok.stdout, 'started', 'node starts with the stub');
  fs.writeFileSync(stub, fs.readFileSync(stub, 'utf8').replace(path.join(__dirname, 'slot-gate.js'), path.join(state, 'gone', 'slot-gate.js')));
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write("started")'], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--require=' + JSON.stringify(stub) } });
  assert.strictEqual(gone.stdout, 'started', 'node still starts when the gate is gone, as after a rollback to code without it');
});

test('a session the relay starts gets NODE_OPTIONS with the stub in its state folder', async (t) => {
  for (const [setting, has] of [[undefined, true], ['0', false]]) {
    const R = await relay({ TEST_SLOTS: setting === undefined ? '' : setting });
    t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
    const term = (await R.call('POST', '/terminals', { cwd: makeRepo(R.home) })).body;
    await R.call('POST', '/terminals/' + term.id + '/input', { data: '/env\r' });
    const screen = (await until(async () => { const text = await R.screen(term.id); return /ENV-END/.test(text) && text; }, 'the session to print its environment')).replace(/\s+/g, '');
    assert.strictEqual(screen.includes('NODE_OPTIONS=--require="' + path.join(R.home, '.office-world', 'slot-gate.js') + '"'), has, setting === '0' ? 'TEST_SLOTS=0 adds nothing' : 'the gate is added');
    await R.kill(); await R.remove();
  }
});
