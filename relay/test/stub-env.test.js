'use strict';
// Each task checkout gets a stub .env with no keys and its own ports (T-205). On edd-platform (its
// T-34), browser tests run in a task checkout used the main checkout's real keys, and two checkouts
// could start servers on the same port. Through a real relay, with a fake claude.
const { execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until } = require('./helpers.js');
const stubEnv = require('../stub-env.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const MAIN_VALUE = 'main-checkout-value-0123';
function project(home, name, ignore) {
  const repo = makeRepo(home, name);
  fs.writeFileSync(path.join(repo, '.gitignore'), ignore + '\n');
  fs.writeFileSync(path.join(repo, '.env.example'), 'DATABASE_URL=postgres://localhost/dev\nPORT=3000\nE2E_PORT=3001\nAPI_TOKEN=paste-yours\n');
  sh(repo, 'add', '.gitignore', '.env.example');
  sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'env');
  fs.writeFileSync(path.join(repo, '.env'), 'DATABASE_URL=postgres://prod/db\nAPI_TOKEN=' + MAIN_VALUE + '\nexport STRIPE_SECRET=' + MAIN_VALUE + '\nPORT=3000\nE2E_PORT=3001\n');
  return repo;
}
const read = (folder) => fs.readFileSync(path.join(folder, '.env'), 'utf8');
const value = (text, key) => (text.match(new RegExp('^' + key + '=(.*)$', 'm')) || [])[1];

test('task checkouts get a stub .env', async (t) => {
  const R = await relay(), { call } = R;
  t.after(R.stop);
  const stop = async (id) => { await call('POST', '/terminals/' + id + '/stop', {}); await until(async () => !(await call('GET', '/terminals')).body.terminals.some((x) => x.id === id), 'it to stop'); };

  await t.test('with the names the project uses, no real key, its own pair of ports, and the ports in the brief', async () => {
    const repo = project(R.home, 'keys', '.env');
    const a = (await call('POST', '/tasks', { title: 'First', repo })).body.task;
    const b = (await call('POST', '/tasks', { title: 'Second', repo })).body.task;
    for (const task of [a, b]) {
      const text = read(task.worktree);
      assert.ok(!text.includes(MAIN_VALUE) && !text.includes('prod'), 'no value of the main .env: ' + text);
      assert.strictEqual(value(text, 'DATABASE_URL'), 'postgres://localhost/dev', 'a committed example value stays');
      assert.strictEqual(value(text, 'API_TOKEN'), 'stub', 'a key-like name gets a placeholder, even with an example');
      assert.strictEqual(value(text, 'STRIPE_SECRET'), 'stub', 'a name only the main .env has comes too');
      assert.deepStrictEqual([value(text, 'PORT'), value(text, 'E2E_PORT')].map(Number), task.env.ports);
      assert.strictEqual(task.env.ports[1], task.env.ports[0] + 1);
      assert.strictEqual(sh(task.worktree, 'status', '--porcelain'), '', 'git does not show it');
    }
    assert.notDeepStrictEqual(a.env.ports, b.env.ports, 'two checkouts never share a port');
    assert.ok(!a.env.ports.includes(3000) && !b.env.ports.includes(3000));
    await until(async () => (await R.screen(a.worker.terminal)).replace(/\s+/g, ' ').includes('its own ports, ' + a.env.ports.join(' and ')), 'the brief to name the ports');
    for (const task of [a, b]) await stop(task.worker.terminal);
  });

  await t.test('Clean up does not ask about the stub, but asks once a session changed it', async () => {
    const repo = project(R.home, 'clean', '.env');
    const kept = (await call('POST', '/tasks', { title: 'Untouched', repo })).body.task;
    const edited = (await call('POST', '/tasks', { title: 'Edited', repo })).body.task;
    fs.appendFileSync(path.join(edited.worktree, '.env'), 'API_TOKEN=' + MAIN_VALUE + '\n');
    for (const task of [kept, edited]) { await stop(task.worker.terminal); await call('POST', '/tasks/' + task.id + '/move', { to: 'done' }); }
    const r = await call('POST', '/tasks/' + kept.id + '/clean', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(!fs.existsSync(kept.worktree));
    const asked = await call('POST', '/tasks/' + edited.id + '/clean', {});
    assert.strictEqual(asked.status, 409);
    assert.deepStrictEqual(asked.body.ignored, ['.env']);
  });

  await t.test('no stub where git would show it, and a placeholder PORT where the project names none', async () => {
    const shown = project(R.home, 'shown', 'node_modules');
    const task = (await call('POST', '/tasks', { title: 'Shown', repo: shown })).body.task;
    assert.ok(!fs.existsSync(path.join(task.worktree, '.env')));
    assert.strictEqual(task.env, null);
    const plain = makeRepo(R.home, 'plain');
    fs.writeFileSync(path.join(plain, '.gitignore'), '.env\n');
    sh(plain, 'add', '.gitignore');
    sh(plain, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ignore');
    const bare = (await call('POST', '/tasks', { title: 'Plain', repo: plain })).body.task;
    assert.strictEqual(Number(value(read(bare.worktree), 'PORT')), bare.env.ports[0]);
    for (const x of [task, bare]) await stop(x.worker.terminal);
  });
});

test('a port something listens on is passed over', async (t) => {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stub-env-')));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const folder = path.join(top, '.worktrees', 'one');
  fs.mkdirSync(folder, { recursive: true });
  const first = await stubEnv.write(top, folder, '.worktrees');
  assert.deepStrictEqual(stubEnv.ours(folder), first.ports);
  assert.strictEqual(await stubEnv.write(top, folder, '.worktrees'), null, 'an existing .env is never replaced');
  fs.unlinkSync(path.join(folder, '.env'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(first.ports[0], '127.0.0.1', resolve));
  t.after(() => server.close());
  const second = await stubEnv.write(top, folder, '.worktrees');
  assert.ok(!second.ports.includes(first.ports[0]), JSON.stringify(second));
});

function scratch(t, names) {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stub-env-')));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  return names.map((name) => { const folder = path.join(top, '.worktrees', name); fs.mkdirSync(folder, { recursive: true }); return { top, folder }; });
}

test('a stub a session changed still holds its ports', async (t) => {
  const [a, b] = scratch(t, ['a', 'b']);
  const first = await stubEnv.write(a.top, a.folder, '.worktrees');
  fs.appendFileSync(path.join(a.folder, '.env'), 'DEBUG=1\n');
  assert.strictEqual(stubEnv.ours(a.folder), null, 'the seal is broken');
  const second = await stubEnv.write(b.top, b.folder, '.worktrees');
  assert.ok(!second.ports.some((p) => first.ports.includes(p)), JSON.stringify([first, second]));
});

test('a port of an outside service keeps its example, and each own port name gets its own port', async (t) => {
  const [a] = scratch(t, ['a']);
  fs.writeFileSync(path.join(a.folder, '.env.example'), 'DB_PORT=5432\nREDIS_PORT=6379\nPORT=3000\nVITE_PORT=5173\nE2E_PORT=9000\n');
  const got = await stubEnv.write(a.top, a.folder, '.worktrees');
  const text = read(a.folder);
  assert.strictEqual(value(text, 'DB_PORT'), '5432');
  assert.strictEqual(value(text, 'REDIS_PORT'), '6379');
  assert.deepStrictEqual(['PORT', 'VITE_PORT', 'E2E_PORT'].map((k) => Number(value(text, k))), got.ports);
  assert.strictEqual(new Set(got.ports).size, 3);
});

test('stubs written at the same moment get different ports', async (t) => {
  const folders = scratch(t, ['a', 'b', 'c', 'd']);
  const got = await Promise.all(folders.map((f) => stubEnv.write(f.top, f.folder, '.worktrees')));
  const all = got.flatMap((g) => g.ports);
  assert.strictEqual(new Set(all).size, all.length, JSON.stringify(got));
});
