// The lint rules hold only while nobody loosens them: eslint-suppressions.json may only go down.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FILE = 'eslint-suppressions.json';
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function raised(before, after) {
  const out = [];
  for (const [file, rules] of Object.entries(after)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      const was = (before[file] && before[file][rule] && before[file][rule].count) || 0;
      if (count > was) out.push(file + ' ' + rule + ': ' + was + ' to ' + count);
    }
  }
  return out;
}

test('a count that went up or a new file is found, and a count that went down is not', () => {
  const before = { 'a.js': { 'local/no-comments': { count: 3 } }, 'b.js': { 'local/no-comments': { count: 2 } } };
  assert.deepStrictEqual(raised(before, { 'a.js': { 'local/no-comments': { count: 2 } } }), []);
  assert.deepStrictEqual(raised(before, before), []);
  assert.deepStrictEqual(raised(before, { 'a.js': { 'local/no-comments': { count: 4 } } }), ['a.js local/no-comments: 3 to 4']);
  assert.deepStrictEqual(raised(before, { 'c.js': { 'local/no-comments': { count: 1 } } }), ['c.js local/no-comments: 0 to 1']);
  assert.deepStrictEqual(raised(before, { 'a.js': { 'no-undef': { count: 1 } } }), ['a.js no-undef: 0 to 1']);
});

test('no count in eslint-suppressions.json is higher than at the merge base with main', (t) => {
  let base;
  try { base = git('merge-base', 'HEAD', 'origin/main'); } catch (e) {
    if (process.env.CI) assert.fail('CI has no origin/main to compare ' + FILE + ' with. Check out with fetch-depth: 0.');
    t.skip('no origin/main here to compare with');
    return;
  }
  let before;
  try { before = JSON.parse(git('show', base + ':' + FILE)); } catch (e) { t.skip('the merge base has no ' + FILE); return; }
  const after = JSON.parse(fs.readFileSync(path.join(ROOT, FILE), 'utf8'));
  assert.deepStrictEqual(raised(before, after), [], 'Do not raise a count in ' + FILE + ' or run --suppress-all to pass lint. Delete the new comment, or fix the problem lint names.');
});

test('the lint script is plain eslint ., so no flag skips the suppressions check', () => {
  assert.strictEqual(require('../../package.json').scripts.lint, 'eslint .');
});
