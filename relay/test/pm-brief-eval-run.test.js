// The one-command PM-brief eval (relay/pm-brief-eval-run.js): it starts the API, runs the eval, stops the API,
// and keeps every key out of the eval's environment.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { options, withoutSecrets, main } = require('../pm-brief-eval-run.js');

const SHOWN = 'never-on-screen';
const HERE = path.join(__dirname, '..', '..');

test('the options come from flags or the environment, and a half-set run is refused', () => {
  const o = options(['--kit', 'k', '--edd', 'e', '--start', 's', '--branch', 'task/x', '--push'], {});
  assert.deepStrictEqual([o.kit, o.edd, o.start, o.branch, o.push], ['k', 'e', 's', 'task/x', true]);
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
