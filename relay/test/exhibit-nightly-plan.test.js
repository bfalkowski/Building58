// Which PRs the nightly Exhibit run checks (relay/exhibit-nightly-plan.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const { pick } = require('../exhibit-nightly-plan');

const NOW = Date.parse('2026-11-26T03:00:00Z');
const sha = (c) => c.repeat(40);
const pr = (number, over) => ({ number, headRefOid: sha('a'), state: 'MERGED', isCrossRepository: false, updatedAt: '2026-11-26T01:00:00Z', ...over });
const run = (prs, extra) => pick({ prs, stored: [], now: NOW, hours: 48, max: 30, ...extra });

test('a merged or open PR of this repo, updated lately, is picked, the newest first', () => {
  const got = run([pr(1, { updatedAt: '2026-11-25T10:00:00Z' }), pr(2, { state: 'OPEN', headRefOid: sha('b') }), pr(3, { updatedAt: '2026-11-26T02:00:00Z', headRefOid: sha('c') })]);
  assert.deepStrictEqual(got, [{ pr: 3, head: sha('c') }, { pr: 2, head: sha('b') }, { pr: 1, head: sha('a') }]);
});

test('a PR from a fork, a closed one and one not updated within the hours are left out', () => {
  const got = run([pr(1, { isCrossRepository: true }), pr(2, { state: 'CLOSED' }), pr(3, { updatedAt: '2026-11-23T02:59:00Z' }), pr(4)]);
  assert.deepStrictEqual(got.map((p) => p.pr), [4]);
});

test('a PR whose head has a stored exhibit is left out, and one with a new head is checked again', () => {
  const stored = ['prs/1/' + sha('a') + '.json', 'prs/2/' + sha('a') + '.json'];
  const got = run([pr(1), pr(2, { headRefOid: sha('b') })], { stored });
  assert.deepStrictEqual(got, [{ pr: 2, head: sha('b') }]);
});

test('no more than max PRs go in one night, the newest ones', () => {
  const got = run([pr(1, { updatedAt: '2026-11-26T00:00:00Z' }), pr(2, { updatedAt: '2026-11-26T02:00:00Z' }), pr(3, { updatedAt: '2026-11-26T01:00:00Z' })], { max: 2 });
  assert.deepStrictEqual(got.map((p) => p.pr), [2, 3]);
});

test('a row with a number or a head that is not what GitHub gives is dropped, so nothing odd reaches a shell', () => {
  const got = run([pr('1; rm -rf /'), pr(0), pr(5, { headRefOid: 'main' }), pr(6, { headRefOid: sha('A') }), null, pr(7)]);
  assert.deepStrictEqual(got.map((p) => p.pr), [7]);
});

test('as a command it reads the list on stdin and prints JSON, and refuses a bad number', () => {
  const file = path.join(__dirname, '..', 'exhibit-nightly-plan.js');
  const recent = pr(9, { updatedAt: new Date().toISOString() });
  const ok = spawnSync(process.execPath, [file, '--hours', '2', '--max', '5'], { input: JSON.stringify([recent]), encoding: 'utf8' });
  assert.strictEqual(ok.status, 0);
  assert.deepStrictEqual(JSON.parse(ok.stdout), [{ pr: 9, head: sha('a') }]);
  const bad = spawnSync(process.execPath, [file, '--hours', '0'], { input: '[]', encoding: 'utf8' });
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /--hours must be a whole number/);
});
