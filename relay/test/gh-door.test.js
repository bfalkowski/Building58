'use strict';
// GitHub's hourly limit (T-264): one PR lookup is shared, a PR waiting on the person is asked about less, and
// the relay backs off as the count runs low. See docs/manual/how-it-works.html#github-polling.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-door-'));
process.env.FAKE_GH_DIR = dir;
process.env.GH_CMD = path.join(__dirname, 'fake-gh.js');
process.env.RELAY_GH_BUDGET = 'off';
const PR = 'https://github.com/o/r/pull/7';
const say = (more) => fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(Object.assign({ prs: { [PR]: { state: 'OPEN', headRefOid: 'abc', statusCheckRollup: [] } } }, more)));
say({});
const door = require('../gh.js');
const calls = () => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '').split('\n').filter((l) => l.startsWith('pr view'));

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('checks that ask about one PR together make one gh call', async () => {
  door.forget(PR);
  const before = calls().length;
  const all = await Promise.all([door.pr(PR), door.pr(PR), door.pr(PR)]);
  await door.pr(PR);
  assert.strictEqual(calls().length - before, 1);
  assert.strictEqual(all[0].headRefOid, 'abc');
  await door.pr(PR, undefined, { fresh: true });
  assert.strictEqual(calls().length - before, 2, 'a fresh ask goes to GitHub');
});

test('a PR that waits on the person is kept for minutes', async () => {
  door.forget(PR);
  await door.pr(PR);
  door.waiting((pr) => pr === PR);
  assert.ok(door.onPerson(PR));
  const before = calls().length;
  await new Promise((r) => setTimeout(r, 20));
  await door.pr(PR);
  assert.strictEqual(calls().length, before);
});

test('calls are counted by kind and by PR', async () => {
  await door.pr(PR, undefined, { fresh: true });
  const u = door.usage(5);
  assert.ok(u.kinds['pr view'] >= 1);
  assert.ok(u.prs['#7'] >= 1);
});

test('the relay backs off as the count runs low, and pauses under 100', () => {
  const set = (remaining) => Object.assign(door.budget, { remaining, limit: 5000, reset: Date.now() + 60000 });
  set(4000); assert.strictEqual(door.spacing(), 1); assert.ok(!door.paused());
  set(2000); assert.strictEqual(door.spacing(), 2);
  set(1000); assert.strictEqual(door.spacing(), 4);
  set(300); assert.strictEqual(door.spacing(), 8);
  set(50); assert.ok(door.paused());
  Object.assign(door.budget, { reset: Date.now() - 1 });
  assert.ok(!door.paused(), 'after the reset it polls again');
  assert.strictEqual(door.spacing(), 1);
});

test('while paused, a PR already read is answered from what was kept and an unread one waits', async () => {
  Object.assign(door.budget, { remaining: 10, limit: 5000, reset: Date.now() + 60000 });
  const before = calls().length;
  assert.strictEqual((await door.pr(PR)).headRefOid, 'abc');
  await assert.rejects(door.pr('https://github.com/o/r/pull/8'), /hourly limit/);
  assert.strictEqual(calls().length, before);
});

test('the budget is the lower share of core and GraphQL', async () => {
  const bucket = (remaining) => ({ limit: 5000, remaining, reset: Math.floor(Date.now() / 1000) + 600 });
  say({ api: { rate_limit: { resources: { core: bucket(4900), graphql: bucket(400) } } } });
  await door.readLimit();
  assert.strictEqual(door.budget.remaining, 400, 'GraphQL is the tighter one, and gh pr view spends it');
  assert.strictEqual(door.spacing(), 8);
  say({ api: { rate_limit: { resources: { core: bucket(1000), graphql: bucket(4900) } } } });
  await door.readLimit();
  assert.strictEqual(door.budget.remaining, 1000);
  Object.assign(door.budget, { remaining: null });
  say({});
});

test('a quiet PR is due on every fourth poll, and a slower one when the count is low', () => {
  const link = 'https://github.com/o/r/pull/99', ago = (ms) => Date.now() - ms;
  assert.ok(door.due(ago(20000), 60000, link) === false, 'under half a poll is too soon');
  assert.ok(door.due(ago(60000), 60000, link), 'a PR no one waits on is due each poll');
  door.waiting((pr) => pr === link);
  assert.ok(!door.due(ago(180000), 60000, link), 'a quiet PR is not due after three polls');
  assert.ok(door.due(ago(240000), 60000, link), 'it is due after four');
  Object.assign(door.budget, { remaining: 2000, limit: 5000, reset: Date.now() + 60000 });
  assert.ok(!door.due(ago(240000), 60000, link), 'and later still when the count is low');
  assert.ok(door.due(ago(480000), 60000, link));
  Object.assign(door.budget, { remaining: null });
});

test('the files of a PR are listed once for a head', async () => {
  say({ api: { 'repos/o/r/pulls/7/files': [{ filename: 'a.txt' }] } });
  const listed = () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter((l) => l.includes('pulls/7/files')).length;
  const before = listed();
  assert.deepStrictEqual(await door.files(PR, 'h1'), ['a.txt']);
  await door.files(PR, 'h1');
  assert.strictEqual(listed() - before, 1);
  await door.files(PR, 'h2');
  assert.strictEqual(listed() - before, 2, 'a new head lists again');
});

const open = { prs: { [PR]: { state: 'OPEN', headRefOid: 'abc', statusCheckRollup: [] } } };
const merged = { prs: { [PR]: { state: 'MERGED', headRefOid: 'abc', statusCheckRollup: [] } } };
const kept = async () => {
  say(open);
  door.forget(PR);
  await door.pr(PR);
  door.waiting((pr) => pr === PR);
  say(merged);
  assert.strictEqual((await door.pr(PR)).state, 'OPEN', 'kept before the write');
};

test('a write to a PR drops its kept view, so the next look reads GitHub again', async () => {
  for (const write of [['merge', '--merge'], ['close'], ['reopen'], ['comment', '--body-file', '-'], ['edit', '--add-label', 'x'], ['ready'], ['review', '--approve']]) {
    for (const call of ['run', 'exec']) {
      await kept();
      await door[call](['pr', write[0], PR].concat(write.slice(1)));
      assert.strictEqual((await door.pr(PR)).state, 'MERGED', call + ' of gh pr ' + write[0] + ' drops the view');
    }
  }
});

test('a write that fails still drops the view, since a merge can land despite an error', async () => {
  await kept();
  say(Object.assign({ fail: 'boom' }, merged));
  await assert.rejects(door.run(['pr', 'merge', PR, '--merge']), /boom/);
  say(merged);
  assert.strictEqual((await door.pr(PR)).state, 'MERGED');
});

test('a read that began before a write does not store its old answer after it', async () => {
  say(open);
  door.forget(PR);
  const early = door.pr(PR, undefined, { fresh: true });
  await door.exec(['pr', 'merge', PR, '--merge']);
  say(merged);
  await early;
  assert.strictEqual((await door.pr(PR)).state, 'MERGED');
});

test('a read of a PR is not a write', async () => {
  await kept();
  await door.run(['pr', 'view', PR]);
  assert.strictEqual((await door.pr(PR)).state, 'OPEN');
});
