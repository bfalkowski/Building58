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
fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: 'abc', statusCheckRollup: [] } } }));
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
