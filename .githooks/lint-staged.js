#!/usr/bin/env node
// Runs ESLint on the JavaScript files a commit changes, so a lint error stops the commit
// instead of failing CI later. It lints each file as it is in the working tree.
// A Dev worktree has no node_modules of its own, so ESLint is found by Node's usual search up the
// folders, which reaches the main checkout. With no ESLint installed, the commit goes through.
// Skip it once: git commit --no-verify. CI runs lint on every pull request anyway.
'use strict';
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter((f) => /\.(c|m)?js$/.test(f));
if (!files.length) process.exit(0);

let bin;
try { bin = path.join(path.dirname(require.resolve('eslint/package.json', { paths: [root] })), 'bin', 'eslint.js'); } catch (e) {
  console.error('Lint check skipped: ESLint is not installed. Run npm ci to turn it on.');
  process.exit(0);
}
const run = spawnSync(process.execPath, [bin, '--no-warn-ignored', '--', ...files], { cwd: root, stdio: 'inherit' });
if (run.status === 0) process.exit(0);
console.error('\nCommit stopped: lint failed on the files above. Fix what each message says, then commit again.');
console.error('Do not change eslint.config.js, eslint-local.js or eslint-suppressions.json to pass it.');
process.exit(1);
