// One relay per world (RELAY_WORLD, relay/server.js): a relay started for one world serves that
// world alone, and a world without sessions never loads the room's parts, so it keeps no room
// files and answers none of the room's routes. Made-up worlds in a scratch RELAY_ROOT, so the test
// does not depend on the real ones.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relay } = require('./helpers.js');

function root(t) {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'one-world-')));
  t.after(() => fs.rmSync(r, { recursive: true, force: true }));
  const world = (dir, w) => { fs.mkdirSync(path.join(r, dir)); fs.writeFileSync(path.join(r, dir, 'world.json'), JSON.stringify(w)); fs.writeFileSync(path.join(r, dir, 'index.html'), '<html>' + dir + '</html>'); };
  world('garden', { name: 'the garden', channel: 'yard', port: 9101 });
  world('hq', { name: 'the hq', channel: 'hq', port: 9102, sessions: true });
  fs.mkdirSync(path.join(r, 'shared')); fs.writeFileSync(path.join(r, 'shared', 'relay.js'), '// shared');
  fs.writeFileSync(path.join(r, 'index.html'), '<html>all</html>');
  fs.writeFileSync(path.join(r, 'README.md'), '# readme');
  return r;
}
const raw = (R, p) => new Promise((ok, no) => require('http').get({ host: '127.0.0.1', port: R.port, path: p }, (res) => { res.resume(); ok(res.statusCode); }).on('error', no));
const get = (R, p) => fetch('http://127.0.0.1:' + R.port + p, { redirect: 'manual', headers: { Authorization: 'Bearer test-key' } });

test('a relay for a world without sessions serves it alone, and loads none of the room', async (t) => {
  const R = await relay({ RELAY_ROOT: root(t), RELAY_WORLD: 'garden' });
  t.after(R.stop);
  assert.deepStrictEqual(R.output().split('\n').filter((l) => l.startsWith('Open ')), ['Open the garden: http://localhost:' + R.port + '/garden/?channel=yard&key=test-key'], 'one link, its own');
  assert.doesNotMatch(R.output(), /Claude Code panel/);
  assert.strictEqual((await get(R, '/garden/')).status, 200);
  assert.strictEqual((await get(R, '/shared/relay.js')).status, 200, 'what every page shares');
  assert.strictEqual((await get(R, '/hq/')).status, 404, 'another world is not here');
  assert.strictEqual((await get(R, '/hq/index.html')).status, 404);
  assert.strictEqual((await get(R, '/README.md')).status, 200, 'a file at the top, such as the README the manual links to');
  for (const p of ['/hq', '/HQ/', '/Hq/index.html']) assert.strictEqual((await get(R, p)).status, 404, p + ' does not reach another world');
  // fetch would turn %2e%2e into .. and tidy it away, so these go as they are, as curl --path-as-is sends them.
  for (const p of ['/garden/%2e%2e/hq/', '/%2e%2e/%2e%2e/etc/hosts', '/garden/..%2fhq/']) assert.strictEqual(await raw(R, p), 404, p + ' does not reach another world or leave the root');
  for (const p of ['/garden', '/shared']) assert.deepStrictEqual([(await get(R, p)).status, (await get(R, p)).headers.get('location')], [301, p + '/'], p + ' goes on to its folder');
  const home = await get(R, '/?channel=yard');
  assert.deepStrictEqual([home.status, home.headers.get('location')], [302, '/garden/?channel=yard'], 'the root goes to its world');
  assert.strictEqual((await (await get(R, '/health')).json()).world, 'garden');
  // The relay's own calls work. The room's are not here.
  const cmd = await R.call('POST', '/commands', { action: 'look' });
  assert.strictEqual(cmd.body.error, 'no_page', 'commands go to the world\'s page');
  for (const route of ['/tickets', '/tasks', '/terminals', '/autopilot', '/chat']) assert.strictEqual((await R.call('GET', route)).status, 404, route);
  assert.ok(!fs.existsSync(path.join(R.home, '.office-world')), 'it keeps no room files');
});

test('a relay for a world with sessions has the room, and still serves only its world', async (t) => {
  const R = await relay({ RELAY_ROOT: root(t), RELAY_WORLD: 'hq' });
  t.after(R.stop);
  assert.strictEqual((await R.call('GET', '/tickets')).status, 200);
  assert.strictEqual((await get(R, '/hq/')).status, 200);
  assert.strictEqual((await get(R, '/garden/')).status, 404);
});

test('with no RELAY_WORLD, one relay serves every world, as before', async (t) => {
  const R = await relay({ RELAY_ROOT: root(t) });
  t.after(R.stop);
  assert.strictEqual(R.output().split('\n').filter((l) => l.startsWith('Open ')).length, 2);
  for (const p of ['/garden/', '/hq/', '/']) assert.strictEqual((await get(R, p)).status, 200, p);
  assert.strictEqual((await R.call('GET', '/tickets')).status, 200);
});

test('a RELAY_WORLD with no world.json, or that is not one folder name, stops the relay with a reason', async (t) => {
  await assert.rejects(relay({ RELAY_ROOT: root(t), RELAY_WORLD: 'nowhere' }), /RELAY_WORLD is nowhere, but .*world\.json is missing/);
  await assert.rejects(relay({ RELAY_ROOT: root(t), RELAY_WORLD: 'garden/x' }), /RELAY_WORLD is garden\/x, but it must be one folder name/);
  await assert.rejects(relay({ RELAY_ROOT: root(t), RELAY_WORLD: '..' }), /must be one folder name/);
  await assert.rejects(relay({ RELAY_ROOT: root(t), RELAY_WORLD: '/' }), /must be one folder name/, 'not every world, which an empty name would mean');
});

test('a trailing slash on RELAY_WORLD, as tab completion gives, is the same world', async (t) => {
  const R = await relay({ RELAY_ROOT: root(t), RELAY_WORLD: 'garden/' });
  t.after(R.stop);
  assert.deepStrictEqual(R.output().split('\n').filter((l) => l.startsWith('Open ')), ['Open the garden: http://localhost:' + R.port + '/garden/?channel=yard&key=test-key']);
  assert.strictEqual((await get(R, '/garden/')).status, 200);
  assert.strictEqual((await get(R, '/')).headers.get('location'), '/garden/');
});

// npm run world -- <folder> (relay/world.js) with no PORT listens on the port in the world's world.json.
test('relay/world.js starts the world on its own port', async (t) => {
  const { spawn } = require('child_process');
  const net = require('net');
  const port = await new Promise((ok) => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => ok(p)); }); });
  const r = root(t);
  fs.writeFileSync(path.join(r, 'garden', 'world.json'), JSON.stringify({ name: 'the garden', channel: 'yard', port }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'one-world-home-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PORT'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'world.js'), 'garden'], { env: { ...env, HOME: home, HOST: '127.0.0.1', RELAY_ROOT: r, RELAY_KEY: 'test-key', RELAY_RESUME: '0' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  t.after(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } fs.rmSync(home, { recursive: true, force: true }); });
  for (let i = 0; i < 60 && !out.includes('Relay on'); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.match(out, new RegExp('Relay on http://127\\.0\\.0\\.1:' + port + '\\b'), out);
  assert.strictEqual((await fetch('http://127.0.0.1:' + port + '/health').then((x) => x.json())).world, 'garden');
});
