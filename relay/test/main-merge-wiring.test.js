// What the relay does with a push that may be only a merge of main (T-610): skip the review, or let it run.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, execFile } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'main-merge-wiring-'));
process.env.RELAY_STATE_DIR = home;
const PR = 'https://github.com/acme/app/pull/618';
fs.writeFileSync(path.join(home, 'reviews.json'), JSON.stringify({ c: { prs: {} } }));
const reviews = require('../reviews.js');

function repo() {
  const dir = fs.mkdtempSync(path.join(home, 'repo-'));
  const sh = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t'].concat(a), { encoding: 'utf8' }).trim();
  const git = (args) => new Promise((resolve, reject) => execFile('git', ['-C', dir].concat(args), (e, out) => (e ? reject(e) : resolve(out))));
  const commit = (f, text) => { fs.writeFileSync(path.join(dir, f), text || f); sh('add', f); sh('commit', '-qm', f + (text || '')); };
  sh('init', '-q', '-b', 'main'); commit('base', 'base' + Math.random());
  sh('checkout', '-q', '-b', 'task'); commit('work');
  const reviewed = sh('rev-parse', 'HEAD');
  sh('checkout', '-q', 'main'); commit('moved'); sh('update-ref', 'refs/remotes/origin/main', 'main');
  sh('checkout', '-q', 'task');
  return { sh, git, commit, reviewed, fetchOk: (args) => (args[0] === 'fetch' ? Promise.resolve('') : git(args)), fetchFails: (args) => (args[0] === 'fetch' ? Promise.reject(new Error('offline')) : git(args)) };
}
const fresh = (reviewed) => { const rec = { count: 2, head: reviewed, pending: null, waits: false }; reviews.chOf('c').prs[PR] = rec; return rec; };

test('a merge of main with the same own changes starts no review, is counted, and adds no round', async () => {
  const r = repo(), rec = fresh(r.reviewed);
  r.sh('merge', '-q', '--no-edit', 'main');
  const head = r.sh('rev-parse', 'HEAD');
  await reviews.checkMainMerge('c', PR, rec, home, head, r.fetchOk);
  assert.deepStrictEqual([rec.mainMerges, rec.head, rec.count, rec.queued], [1, head, 2, head]);
  assert.strictEqual(reviews.ownChangedAt(PR), undefined);
});

test('a push that changes the PR\'s own code is left to a review, and the next pass queues it', async () => {
  const r = repo(), rec = fresh(r.reviewed);
  r.commit('work', 'changed');
  const head = r.sh('rev-parse', 'HEAD');
  await reviews.checkMainMerge('c', PR, rec, home, head, r.fetchOk);
  assert.deepStrictEqual([rec.mainMerges, rec.head], [undefined, r.reviewed]);
  assert.strictEqual(reviews.ownChangedAt(PR), head);
});

test('a fetch that fails falls back to a review, never a skip', async () => {
  const r = repo(), rec = fresh(r.reviewed);
  r.sh('merge', '-q', '--no-edit', 'main');
  const head = r.sh('rev-parse', 'HEAD');
  await reviews.checkMainMerge('c', PR, rec, home, head, r.fetchFails);
  assert.deepStrictEqual([rec.mainMerges, rec.head], [undefined, r.reviewed]);
  assert.strictEqual(reviews.ownChangedAt(PR), head);
});
const { forPr } = require('../autopilot-plan.js');
const mainMerge = require('../main-merge.js');
const owed = (r, rec, head, over) => reviews.owedFollowUps('c', reviews.chOf('c'), { on: true, seen: () => ({ head, at: Date.now() + 1000, open: true }), git: () => over || r.fetchOk });
const ready = (r) => { reviews.chOf('c').again = true; const rec = fresh(r.reviewed); rec.from = home; rec.reviewedAt = 0; return rec; };

test('each pass: a same-diff merge of main queues no follow-up review', async () => {
  const r = repo(), rec = ready(r);
  r.sh('merge', '-q', '--no-edit', 'main');
  const head = r.sh('rev-parse', 'HEAD');
  await Promise.all(owed(r, rec, head));
  assert.deepStrictEqual([rec.pending, rec.mainMerges, rec.head], [null, 1, head]);
  assert.deepStrictEqual(owed(r, rec, head), [], 'the next pass finds nothing owed');
  assert.strictEqual(rec.pending, null);
});

test('each pass: a changed own diff queues a follow-up review on the pass after the check', async () => {
  const r = repo(), rec = ready(r);
  r.commit('work', 'changed');
  const head = r.sh('rev-parse', 'HEAD');
  await Promise.all(owed(r, rec, head));
  assert.strictEqual(rec.pending, null, 'the first pass only checks');
  owed(r, rec, head);
  assert.ok(rec.pending && rec.pending.from === home, 'the second pass queues the review');
  assert.strictEqual(rec.mainMerges, undefined);
});

test('Autopilot reads a merge verdict as covering a skipped merge of main, and a later real push as not covered', async () => {
  const r = repo(), rec = ready(r);
  r.sh('merge', '-q', '--no-edit', 'main');
  const head = r.sh('rev-parse', 'HEAD');
  await Promise.all(owed(r, rec, head));
  const green = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const pr = (oid) => ({ state: 'OPEN', headRefOid: oid, mergeStateStatus: 'CLEAN', statusCheckRollup: green });
  const verdict = { kind: 'merge', commit: r.reviewed, posted: true };
  const seen = () => mainMerge.coveredVerdict(verdict, reviews.coveredHead('c', PR, verdict.commit));
  assert.strictEqual(forPr(pr(head), ['relay/x.js'], seen(), 1, 6).act, 'merge');
  assert.strictEqual(forPr(pr('b'.repeat(40)), ['relay/x.js'], seen(), 1, 6).act, 'wait');
});
test.after(() => setImmediate(() => process.exit(process.exitCode || 0)));
