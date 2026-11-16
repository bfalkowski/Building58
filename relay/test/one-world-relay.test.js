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
// A relay that starts when it should have refused is stopped at once, so the check fails and does not
// leave a live relay that keeps the test file from ending.
async function refused(env, reason, message) {
  const R = await relay(env).catch((e) => e);
  if (!(R instanceof Error)) { await R.stop(); assert.fail('The relay started with ' + JSON.stringify(env) + (message ? ', but ' + message : '')); }
  assert.match(R.message, reason, message);
}

test('a relay for a world without sessions serves it alone, and loads none of the room', async (t) => {
  const r = root(t);
  const R = { ...await relay({ RELAY_ROOT: r, RELAY_WORLD: 'garden' }), root: r };
  t.after(R.stop);
  assert.deepStrictEqual(R.output().split('\n').filter((l) => l.startsWith('Open ')), ['Open the garden: http://localhost:' + R.port + '/garden/?channel=yard&key=test-key'], 'one link, its own');
  assert.doesNotMatch(R.output(), /Claude Code panel/);
  assert.strictEqual((await get(R, '/garden/')).status, 200);
  assert.strictEqual((await get(R, '/shared/relay.js')).status, 200, 'what every page shares');
  assert.strictEqual((await get(R, '/hq/')).status, 404, 'another world is not here');
  assert.strictEqual((await get(R, '/hq/index.html')).status, 404);
  assert.strictEqual((await get(R, '/README.md')).status, 200, 'a file at the top, such as the README the manual links to');
  for (const p of ['/hq', '/HQ/', '/Hq/index.html']) assert.strictEqual((await get(R, p)).status, 404, p + ' does not reach another world');
  // The relay's new URL() tidies away a .. or %2e%2e segment, as fetch does, so only a .. with an
  // encoded slash (%2f) reaches serveStatic. These go as they are, as curl --path-as-is sends them.
  for (const p of ['/garden/..%2fhq/', '/garden/%2e%2e%2fhq/index.html']) assert.strictEqual(await raw(R, p), 404, p + ' does not reach another world');
  // A file next to the root, which a path that leaves the root would find, so a 404 is the check and not a missing file.
  const outside = path.basename(R.root) + '-outside.txt';
  fs.writeFileSync(path.join(R.root, '..', outside), 'outside');
  t.after(() => fs.rmSync(path.join(R.root, '..', outside), { force: true }));
  for (const p of ['/garden/..%2f..%2f' + outside, '/garden/%2E%2E%2F%2E%2E%2F' + outside, '/shared/%2e%2e%2f%2e%2e%2f' + outside]) assert.strictEqual(await raw(R, p), 404, p + ' does not leave the root');
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
  const R = await relay({ RELAY_ROOT: root(t), RELAY_WORLD: '' });
  t.after(R.stop);
  assert.strictEqual(R.output().split('\n').filter((l) => l.startsWith('Open ')).length, 2);
  for (const p of ['/garden/', '/hq/', '/']) assert.strictEqual((await get(R, p)).status, 200, p);
  assert.strictEqual((await R.call('GET', '/tickets')).status, 200);
});

test('a RELAY_WORLD with no world.json, or that is not one folder name, stops the relay with a reason', async (t) => {
  await refused({ RELAY_ROOT: root(t), RELAY_WORLD: 'nowhere' }, /RELAY_WORLD is nowhere, but .*world\.json is missing/);
  await refused({ RELAY_ROOT: root(t), RELAY_WORLD: 'garden/x' }, /RELAY_WORLD is garden\/x, but it must be one folder name/);
  await refused({ RELAY_ROOT: root(t), RELAY_WORLD: '..' }, /must be one folder name/);
  await refused({ RELAY_ROOT: root(t), RELAY_WORLD: '/' }, /must be one folder name/, 'not every world, which an empty name would mean');
});

test('a trailing slash on RELAY_WORLD, as tab completion gives, is the same world', async (t) => {
  const R = await relay({ RELAY_ROOT: root(t), RELAY_WORLD: 'garden/' });
  t.after(R.stop);
  assert.deepStrictEqual(R.output().split('\n').filter((l) => l.startsWith('Open ')), ['Open the garden: http://localhost:' + R.port + '/garden/?channel=yard&key=test-key']);
  assert.strictEqual((await get(R, '/garden/')).status, 200);
  assert.strictEqual((await get(R, '/')).headers.get('location'), '/garden/');
});

// npm run world -- <folder> (relay/world.js) with no PORT listens on the port in the world's world.json.
// A port can be taken between freePort and the listen, so a lost port is tried again with a new one.
test('relay/world.js starts the world on its own port', async (t) => {
  const { spawn } = require('child_process');
  const net = require('net');
  const r = root(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'one-world-home-'));
  const children = [];
  t.after(async () => { await Promise.all(children.map((stop) => stop())); fs.rmSync(home, { recursive: true, force: true }); });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PORT'));
  const freePort = () => new Promise((ok) => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => ok(p)); }); });
  const start = async (port) => {
    fs.writeFileSync(path.join(r, 'garden', 'world.json'), JSON.stringify({ name: 'the garden', channel: 'yard', port }));
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'world.js'), 'garden'], { env: { ...env, HOME: home, HOST: '127.0.0.1', RELAY_ROOT: r, RELAY_KEY: 'test-key', RELAY_RESUME: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const ended = new Promise((ok) => child.once('exit', ok));
    children.push(async () => {
      if (child.exitCode !== null || child.signalCode) return;
      child.kill('SIGTERM');
      const late = setTimeout(() => child.kill('SIGKILL'), 5000);
      await ended; clearTimeout(late);
    });
    let out = '';
    const listening = new Promise((ok) => { const read = (d) => { out += d; if (out.includes('Relay on')) ok('up'); }; child.stdout.on('data', read); child.stderr.on('data', read); });
    const gaveUp = new Promise((ok) => { const late = setTimeout(() => ok('slow'), 6000); ended.then(() => { clearTimeout(late); ok('gone'); }); });
    return { port, state: await Promise.race([listening, gaveUp]), out: () => out };
  };
  let run;
  for (let tries = 1; tries <= 5; tries++) {
    run = await start(await freePort());
    if (!(run.state === 'gone' && /already in use/.test(run.out()))) break;
  }
  assert.strictEqual(run.state, 'up', run.out());
  assert.match(run.out(), new RegExp('Relay on http://127\\.0\\.0\\.1:' + run.port + '\\b'), run.out());
  assert.strictEqual((await fetch('http://127.0.0.1:' + run.port + '/health').then((x) => x.json())).world, 'garden');
});
