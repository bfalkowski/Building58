'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function withModules(home, name, ignore) {
  const repo = makeRepo(home, name);
  fs.writeFileSync(path.join(repo, '.gitignore'), ignore + '\n');
  sh(repo, 'add', '.gitignore');
  sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ignore');
  fs.mkdirSync(path.join(repo, 'node_modules', 'eslint'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'eslint', 'index.js'), 'x\n');
  return repo;
}

test('checkouts come with node_modules', async (t) => {
  const R = await relay(), { call } = R;
  t.after(R.stop);
  const stop = async (id) => { await call('POST', '/terminals/' + id + '/stop', {}); await until(async () => !(await call('GET', '/terminals')).body.terminals.some((x) => x.id === id), 'it to stop'); };
  const kept = path.join('node_modules', 'eslint', 'index.js');

  await t.test('a task checkout links the main checkout node_modules, git status stays clean, and Clean up leaves the main one', async () => {
    const repo = withModules(R.home, 'linked', 'node_modules');
    const task = (await call('POST', '/tasks', { title: 'Lint it', repo })).body.task;
    const link = path.join(task.worktree, 'node_modules');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'node_modules is a link');
    assert.strictEqual(fs.realpathSync(link), fs.realpathSync(path.join(repo, 'node_modules')));
    assert.ok(fs.existsSync(path.join(task.worktree, kept)), 'lint and tests find their tools');
    assert.strictEqual(sh(task.worktree, 'status', '--porcelain'), '', 'git does not show the link');
    await stop(task.worker.terminal);
    await call('POST', '/tasks/' + task.id + '/move', { to: 'done' });
    const r = await call('POST', '/tasks/' + task.id + '/clean', {});
    assert.strictEqual(r.status, 200, 'the link is not an ignored file to ask about: ' + JSON.stringify(r.body));
    assert.ok(!fs.existsSync(task.worktree));
    assert.ok(fs.existsSync(path.join(repo, kept)), 'the main checkout keeps its node_modules');
  });

  await t.test('no link where git would show it, or where the main checkout has none', async () => {
    const slash = withModules(R.home, 'slash', 'node_modules/');
    const plain = makeRepo(R.home, 'plain');
    for (const repo of [slash, plain]) {
      const task = (await call('POST', '/tasks', { title: 'No link', repo })).body.task;
      assert.ok(!fs.existsSync(path.join(task.worktree, 'node_modules')), repo);
      assert.strictEqual(sh(task.worktree, 'status', '--porcelain'), '');
      await stop(task.worker.terminal);
    }
  });

  await t.test('a worker checkout gets the link, and still goes when its session ends untouched', async () => {
    const repo = withModules(R.home, 'worker', 'node_modules');
    const w = (await call('POST', '/checkouts', { from: repo })).body;
    assert.ok(fs.lstatSync(path.join(w.cwd, 'node_modules')).isSymbolicLink());
    await stop(w.id);
    await until(async () => !(await call('GET', '/checkouts')).body.checkouts.some((c) => c.id === w.checkout.id), 'the checkout to go');
    assert.ok(!fs.existsSync(w.cwd));
    assert.ok(fs.existsSync(path.join(repo, kept)), 'the main checkout keeps its node_modules');
  });
});
