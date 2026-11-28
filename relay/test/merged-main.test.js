// Whether a push added a merge of origin/main (relay/merged-main.js), in a real git repo.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { mergedMain, holdsAll, withHead, headsSince } = require('../merged-main.js');

test('a merge of origin/main counts, a merge of another branch or a missing commit does not (T-419)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-main-'));
  const sh = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t'].concat(a), { encoding: 'utf8' }).trim();
  const git = (args) => new Promise((resolve, reject) => execFile('git', ['-C', dir].concat(args), (e, out) => (e ? reject(e) : resolve(out.trim()))));
  try {
    sh('init', '-q', '-b', 'main');
    const commit = (f) => { fs.writeFileSync(path.join(dir, f), f); sh('add', f); sh('commit', '-qm', f); };
    commit('base');
    sh('checkout', '-q', '-b', 'task');
    commit('work');
    const from = sh('rev-parse', 'HEAD');
    sh('checkout', '-q', 'main'); commit('moved');
    sh('update-ref', 'refs/remotes/origin/main', 'main');
    sh('checkout', '-q', '-b', 'other', 'main~1'); commit('side');
    sh('checkout', '-q', 'task');
    sh('merge', '-q', '--no-ff', '-m', 'merge other', 'other');
    assert.strictEqual(await mergedMain(git, from, sh('rev-parse', 'HEAD')), false, 'a merge of another branch');
    sh('merge', '-q', '--no-ff', '-m', 'merge main', 'origin/main');
    assert.strictEqual(await mergedMain(git, from, sh('rev-parse', 'HEAD')), true, 'a merge of origin/main');
    assert.strictEqual(await mergedMain(git, from, from), false, 'no new commit');
    assert.strictEqual(await mergedMain(git, from, 'f'.repeat(40)), false, 'a missing commit');
    assert.strictEqual(await mergedMain(git, null, 'HEAD'), false, 'no earlier head');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a head holds every listed API merge only when each is an ancestor of it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holds-all-'));
  const sh = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t'].concat(a), { encoding: 'utf8' }).trim();
  const git = (args) => new Promise((resolve, reject) => execFile('git', ['-C', dir].concat(args), (e, out) => (e ? reject(e) : resolve(out.trim()))));
  try {
    sh('init', '-q', '-b', 'main');
    const commit = (f) => { fs.writeFileSync(path.join(dir, f), f); sh('add', f); sh('commit', '-qm', f); };
    commit('base');
    sh('checkout', '-q', '-b', 'task');
    commit('work');
    sh('checkout', '-q', 'main'); commit('api');
    const api = sh('rev-parse', 'HEAD');
    commit('other');
    sh('checkout', '-q', 'task');
    const before = sh('rev-parse', 'HEAD');
    assert.strictEqual(await holdsAll(git, [api], before), false, 'main not merged yet');
    sh('merge', '-q', '--no-ff', '-m', 'merge main', 'main');
    const after = sh('rev-parse', 'HEAD');
    assert.strictEqual(await holdsAll(git, [api], after), true, 'after merging main');
    assert.strictEqual(await holdsAll(git, [api, null], after), false, 'an unknown merge is not held');
    assert.strictEqual(await holdsAll(git, [], after), false, 'nothing listed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recorded API merge heads line up with the count, and a room saved before them reads as unknown', () => {
  assert.deepStrictEqual(withHead(undefined, 0, 'a'), ['a']);
  assert.deepStrictEqual(withHead(['a'], 1, 'b'), ['a', 'b']);
  const legacy = withHead(undefined, 3, 'd');
  assert.deepStrictEqual(legacy, [null, null, null, 'd'], 'the new head sits at index 3, the count it was made at');
  assert.deepStrictEqual(headsSince(legacy, 3, 4), ['d'], 'merges after the legacy ones are known');
  assert.deepStrictEqual(headsSince(legacy, 1, 4), [null, null, 'd'], 'a range with an older merge holds an unknown');
  assert.deepStrictEqual(headsSince(undefined, 0, 2), [null, null]);
});
