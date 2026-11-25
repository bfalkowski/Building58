'use strict';
// The one GitHub pass (467): with ten open PRs one pass makes one call, the checks that ask gh.pr() for a
// PR get it from the pass with no call of their own, and an unchanged PR costs no call.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-pass-'));
process.env.FAKE_GH_DIR = dir;
process.env.GH_CMD = path.join(__dirname, 'fake-gh.js');
process.env.RELAY_GH_BUDGET = 'off';
process.env.RELAY_STATE_DIR = dir;
const door = require('../gh.js');
const pass = require('../github-pass.js');

const link = (n) => 'https://github.com/o/r/pull/' + n;
const node = (n, head) => ({ url: link(n), state: 'OPEN', headRefOid: head || 'h' + n, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', updatedAt: '2026-11-25T10:00:00Z', mergedAt: null, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } } }] } });
const say = (nodes) => fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify({ api: { graphql: { data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes } } } } } }));
const log = () => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '').split('\n').filter(Boolean);
const ten = Array.from({ length: 10 }, (_, i) => i + 1);

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('with ten open PRs, a pass makes one call, and reading each PR makes none', async () => {
  say(ten.map((n) => node(n)));
  const before = log().length;
  const r = await pass.once(new Map([['o/r', undefined]]));
  assert.strictEqual(r.prs, 10);
  assert.ok(r.calls <= 2, 'a small fixed number of calls, got ' + r.calls);
  assert.strictEqual(log().length - before, 1);
  const got = await Promise.all(ten.map((n) => door.pr(link(n))));
  assert.strictEqual(log().length - before, 1, 'gh.pr read all ten from the pass');
  assert.strictEqual(got[3].headRefOid, 'h4');
  assert.deepStrictEqual(got[3].statusCheckRollup[0], { __typename: 'CheckRun', name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' });
});

test('a pass with nothing changed costs the same one call, and keeps the same answer', async () => {
  const first = await door.pr(link(2));
  const before = log().length;
  await pass.once(new Map([['o/r', undefined]]));
  assert.strictEqual(log().length - before, 1);
  assert.strictEqual(await door.pr(link(2)), first, 'the unchanged PR is the same object');
  assert.strictEqual(log().length - before, 1);
});

test('a changed head is read from the next pass, and a fresh ask still goes to GitHub', async () => {
  say(ten.map((n) => node(n, n === 5 ? 'new5' : undefined)).map((x, i) => (i === 4 ? Object.assign(x, { updatedAt: '2026-11-25T11:00:00Z' }) : x)));
  await pass.once(new Map([['o/r', undefined]]));
  assert.strictEqual((await door.pr(link(5))).headRefOid, 'new5');
  const before = log().length;
  await door.pr(link(5), undefined, { fresh: true }).catch(() => {});
  assert.strictEqual(log().length - before, 1);
  assert.ok(log().pop().startsWith('pr view'));
});

test('Autopilot, PR comments, the PR watch and chat ask the pass, not their own gh pr view', () => {
  for (const file of ['autopilot.js', 'pr-comments.js', 'pr-watch.js', 'chat.js', 'pipeline.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(/\b(gh|ghDoor|door)\.pr\(/.test(text), file + ' reads PRs with gh.pr()');
    assert.ok(!/\[\s*'pr',\s*'view'/.test(text), file + ' has no gh pr view of its own');
  }
});
