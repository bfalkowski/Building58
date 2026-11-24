// Whether a push added a merge of origin/main (relay/merged-main.js), in a real git repo.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { mergedMain } = require('../merged-main.js');

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
