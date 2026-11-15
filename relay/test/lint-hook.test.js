// The pre-commit lint check (.githooks/lint-staged.js), run by real git commits in a throwaway repo
// with a small ESLint config of its own.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HOOKS = path.join(ROOT, '.githooks');
const CONFIG = "module.exports = [{ rules: { 'no-unused-vars': 'error' } }];\n";

function attempt(files, { eslint = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'office-lint-hook-'));
  try {
    const run = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
    execFileSync('git', ['init', '-q', repo]);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
    fs.writeFileSync(path.join(repo, 'eslint.config.js'), CONFIG);
    run('add', '-A');
    run('commit', '-q', '--no-verify', '-m', 'init');
    run('config', 'core.hooksPath', HOOKS);
    if (eslint) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(repo, 'node_modules'));
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), text);
    run('add', '-A');
    const r = run('commit', '-qm', 'try');
    return { ok: r.status === 0, out: r.stdout + r.stderr };
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}

test('a commit with a lint error is stopped, and the message says why', () => {
  const r = attempt({ 'a.js': 'const unused = 1;\n' });
  assert.strictEqual(r.ok, false);
  assert.match(r.out, /no-unused-vars/);
  assert.match(r.out, /Commit stopped: lint failed/);
});

test('a commit with clean JavaScript goes through', () => {
  assert.strictEqual(attempt({ 'a.js': 'module.exports = 1;\n' }).ok, true);
});

test('only staged JavaScript files are linted', () => {
  assert.strictEqual(attempt({ 'notes.md': 'const unused = 1;\n' }).ok, true);
});

test('with no ESLint installed, the commit goes through with a note', () => {
  const r = attempt({ 'a.js': 'const unused = 1;\n' }, { eslint: false });
  assert.strictEqual(r.ok, true);
  assert.match(r.out, /Lint check skipped/);
});

test('the secret check still runs first', () => {
  const r = attempt({ 'a.js': 'module.exports = "' + 'AKIA' + 'ABCDEFGHIJKLMNOP";\n' });
  assert.strictEqual(r.ok, false);
  assert.doesNotMatch(r.out, /Commit stopped: lint failed/);
});
