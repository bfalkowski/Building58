// The one-command PM-brief eval (relay/pm-brief-eval-run.js): it starts the API, runs the eval, stops the API,
// and keeps every key out of the eval's environment.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { options, withoutSecrets, main } = require('../pm-brief-eval-run.js');

const SHOWN = 'never-on-screen';
const HERE = path.join(__dirname, '..', '..');

test('the options come from flags or the environment, and a half-set run is refused', () => {
  const o = options(['--kit', 'k', '--edd', 'e', '--start', 's', '--branch', 'task/x', '--push'], {});
  assert.deepStrictEqual([o.kit, o.edd, o.start, o.branch, o.push], [path.resolve('k'), path.resolve('e'), 's', 'task/x', true]);
  assert.strictEqual(options([], { PM_BRIEF_KIT: 'k', EDD_DIR: 'e', EDD_START: 's' }).start, 's');
  assert.throws(() => options(['--edd', 'e', '--start', 's'], {}), /Name the eval kit/);
  assert.throws(() => options(['--kit', 'k'], {}), /how to start edd-platform/);
  assert.throws(() => options(['--kit', 'k', '--edd', 'e', '--start', 's', '--push'], {}), /--push needs --branch/);
  assert.throws(() => options(['--kit', 'k', '--edd', 'e', '--start', 's', '--branch', 'a;b'], {}), /not a branch name/);
});

test('the eval gets no key, token or secret', () => {
  const env = withoutSecrets({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', GH_TOKEN: 't', MY_SECRET: 's', HOME: '/h' });
  assert.deepStrictEqual(env, { PATH: '/bin', HOME: '/h' });
});

test('it starts the API, runs the eval on a brief already judged, and stops the API', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-eval-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const probe = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => probe.once('listening', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  fs.writeFileSync(path.join(dir, 'api.js'), "require('http').createServer((q, s) => s.end('{}')).listen(" + port + ", '127.0.0.1');\n");
  const logs = [], was = console.log;
  console.log = (l) => logs.push(l);
  let code;
  try {
    code = await main(['--kit', dir, '--edd', dir, '--start', 'node api.js', '--api', 'http://127.0.0.1:' + port + '/api'], { PATH: process.env.PATH, ['FAKE_' + 'API_KEY']: SHOWN }, HERE);
  } finally { console.log = was; }
  assert.strictEqual(code, 0);
  const closed = await new Promise((r) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(false); }); s.once('error', () => r(true)); });
  assert.ok(closed, 'the API is stopped after the run');
  assert.ok(!JSON.stringify(logs).includes(SHOWN));
});

test('an API that stops before it answers is an error that names its log, not its output', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-eval-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(main(['--kit', dir, '--edd', dir, '--start', 'exit 3', '--api', 'http://127.0.0.1:1/api'], { PATH: process.env.PATH }, HERE), /stopped with 3 before it answered/);
});

const sh = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr); return r.stdout.trim(); };
const freePort = async () => {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => probe.once('listening', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
};
const isDown = (port) => new Promise((r) => { const c = net.connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); r(false); }); c.once('error', () => r(true)); });

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-eval-branch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git'), clone = path.join(dir, 'clone'), kit = path.join(dir, 'kit');
  fs.mkdirSync(kit);
  sh(dir, 'init', '--bare', '-q', remote);
  sh(dir, 'clone', '-q', remote, clone);
  sh(clone, 'config', 'user.name', 'Test');
  sh(clone, 'config', 'user.email', 'test@example.com');
  fs.mkdirSync(path.join(clone, 'relay'));
  fs.writeFileSync(path.join(clone, 'relay', 'pm-brief-eval.js'), "require('fs').writeFileSync('relay/pm-brief-eval.json', process.argv.slice(2).join(' ') + '\\n');\n");
  sh(clone, 'add', '-A');
  sh(clone, 'commit', '-q', '-m', 'start');
  sh(clone, 'push', '-q', 'origin', 'HEAD:feature');
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'api.js'), "require('http').createServer((q, s) => s.end('{}')).listen(" + port + ", '127.0.0.1');\n");
  const args = ['--kit', 'kit', '--edd', dir, '--start', 'node api.js', '--api', 'http://127.0.0.1:' + port + '/api'];
  return { dir, remote, clone, kit, port, args, env: { PATH: process.env.PATH } };
}

test('with a branch, it runs the eval in a temporary checkout, pushes the new file, and cleans up', async (t) => {
  const f = await fixture(t);
  const was = process.cwd(), log = console.log;
  console.log = () => {};
  let code;
  try {
    process.chdir(f.dir);
    code = await main([...f.args, '--branch', 'feature', '--push'], f.env, f.clone);
  } finally { console.log = log; process.chdir(was); }
  assert.strictEqual(code, 0);
  assert.ok(await isDown(f.port), 'the API is stopped');
  assert.strictEqual(sh(f.remote, 'log', '-1', '--format=%s', 'feature'), 'Rerun the PM-brief eval');
  assert.match(sh(f.remote, 'show', 'feature:relay/pm-brief-eval.json'), new RegExp('--kit ' + path.join(f.dir, 'kit').replace(/[\\/]/g, '.')), 'a relative --kit is resolved against where you ran it');
  assert.ok(!sh(f.clone, 'worktree', 'list').includes('pm-brief-eval-'), 'the temporary checkout is gone');
});

test('a branch that does not exist stops before edd-platform starts, and leaves nothing running', async (t) => {
  const f = await fixture(t);
  await assert.rejects(main([...f.args, '--branch', 'nope'], f.env, f.clone), /git fetch failed/);
  assert.ok(await isDown(f.port));
});

test('an API port that already answers is refused before anything starts', async (t) => {
  const f = await fixture(t);
  const busy = net.createServer().listen(f.port, '127.0.0.1');
  await new Promise((r) => busy.once('listening', r));
  t.after(() => busy.close());
  await assert.rejects(main(f.args, f.env, f.clone), /already answers/);
});
