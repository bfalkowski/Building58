// The round-3 gate and the merge-of-main rule (T-610): pure plans, and a real git repo for the diff compare.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { gateOf, GATE_MINUTES } = require('../round-gate.js');
const { sameOwnChanges, roundsOf, noteMerge, roundsLine } = require('../main-merge.js');

const F = [{ id: 'a', tag: 'technical' }, { id: 'b', tag: 'functional' }];
const base = { findings: F, answers: {}, askedAt: 0, now: 1000 };

test('rounds 1 and 2 have no gate', () => {
  for (const round of [1, 2]) assert.strictEqual(gateOf(Object.assign({ round }, base)).gated, false);
});

test('at round 3 a finding goes to the Lead or the PM by its tag', () => {
  assert.deepStrictEqual(gateOf(Object.assign({ round: 3 }, base)).open, [{ id: 'a', to: 'lead' }, { id: 'b', to: 'pm' }]);
});

test('follow-up answers let the PR merge; one fix answer keeps it from merging', () => {
  const all = gateOf(Object.assign({ round: 3 }, base, { answers: { a: 'follow-up', b: 'follow-up' } }));
  assert.strictEqual(all.mergeReady, true);
  const one = gateOf(Object.assign({ round: 3 }, base, { answers: { a: 'fix', b: 'follow-up' } }));
  assert.deepStrictEqual([one.mergeReady, one.fix], [false, ['a']]);
});

test('after 10 minutes with no answer, a finding that is not blocking becomes a follow-up; a blocking one stays open', () => {
  const late = { round: 4, findings: [{ id: 'a', tag: 'technical' }, { id: 'c', tag: 'technical', blocking: true }], answers: {}, askedAt: 0 };
  assert.strictEqual(gateOf(Object.assign({}, late, { now: GATE_MINUTES * 60000 - 1 })).followUp.length, 0);
  const g = gateOf(Object.assign({}, late, { now: GATE_MINUTES * 60000 }));
  assert.deepStrictEqual([g.followUp, g.open], [['a'], [{ id: 'c', to: 'lead' }]]);
});

test('a merge of main adds no round and is counted apart', () => {
  const rec = { count: 3, mainMerges: 0 };
  noteMerge(rec, 'abc');
  assert.deepStrictEqual([rec.mainMerges, rec.head, roundsOf(rec)], [1, 'abc', 2]);
  assert.strictEqual(roundsLine(2, 3), '2 rounds, plus 3 merges of main');
  assert.strictEqual(roundsLine(1, 0), '1 round');
});

test('own changes are the same after a merge of main, and differ after a real change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-merge-'));
  const sh = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t'].concat(a), { encoding: 'utf8' }).trim();
  const git = (args) => new Promise((resolve, reject) => execFile('git', ['-C', dir].concat(args), (e, out) => (e ? reject(e) : resolve(out))));
  try {
    sh('init', '-q', '-b', 'main');
    const commit = (f, text) => { fs.writeFileSync(path.join(dir, f), text || f); sh('add', f); sh('commit', '-qm', f + (text || '')); };
    commit('base');
    sh('checkout', '-q', '-b', 'task'); commit('work');
    const reviewed = sh('rev-parse', 'HEAD');
    sh('checkout', '-q', 'main'); commit('moved');
    sh('update-ref', 'refs/remotes/origin/main', 'main');
    sh('checkout', '-q', 'task'); sh('merge', '-q', '--no-edit', 'main');
    const merged = sh('rev-parse', 'HEAD');
    assert.strictEqual(await sameOwnChanges(git, reviewed, merged, 'origin/main'), true);
    commit('work', 'changed');
    assert.strictEqual(await sameOwnChanges(git, reviewed, sh('rev-parse', 'HEAD'), 'origin/main'), false);
    assert.strictEqual(await sameOwnChanges(git, 'nope', merged, 'origin/main'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
