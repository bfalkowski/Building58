'use strict';
// The manager's brake through a real relay (relay/trust-brake.js): a stall that work cannot get past lowers the trust
// level by one while the switch is on, never raises it, stops after two a day, and does nothing while it is off.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relay, makeRepo, until, removeDir } = require('./helpers.js');

const PR = 'https://github.com/acme/widgets/pull/7';

async function room(extra) {
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay(Object.assign({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_GH_FRESH_MS: '0', RELAY_MANAGER_WATCH_SECONDS: '1', RELAY_MANAGER_BUILDING_MS: '3600000000', RELAY_MANAGER_SLOT_MS: '3600000000', RELAY_MANAGER_CHECK_FAILS: '3' }, extra));
  const repo = makeRepo(R.home), { call } = R;
  const ticket = (await call('POST', '/tickets', { title: 'Make a.txt say hello', body: 'Change a.txt.', repo })).body.ticket;
  const task = (await call('POST', '/tickets/' + ticket.id + '/start', {})).body.task;
  const sid = task.worker.sessionId || (await call('GET', '/terminals')).body.terminals.find((x) => x.id === task.worker.terminal).sessionId;
  await R.hook({ hook_event_name: 'PostToolUse', session_id: sid.slice(0, 12), pr_url: PR });
  let n = 0, run = { name: '', count: 0 };
  const fail = async (name, times) => {
    if (run.name !== name) run = { name, count: 0 };
    for (let i = 0; i < times; i++) {
      const want = ++run.count;
      const head = String(++n).padStart(40, 'a');
      fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name, status: 'COMPLETED', conclusion: 'FAILURE' }] } } }));
      await until(async () => ((await call('GET', '/manager')).body.checks.find((c) => c.pr === PR && c.name === name) || { commits: 0 }).commits === want, 'the look at ' + head.slice(0, 3));
    }
  };
  const notes = async (kind) => (await call('GET', '/manager')).body.notes.filter((x) => x.kind === kind);
  const level = async () => { const r = (await call('GET', '/reviews')).body; return { auto: r.auto, again: r.again }; };
  return { R, call, fail, notes, level, stop: async () => { await R.stop(); removeDir(ghDir); } };
}

test('the brake lowers the level by one on a stall, says what it saw, and the next stall lowers again until the limit', async (t) => {
  const W = await room({});
  t.after(W.stop);
  const { call } = W;
  await call('POST', '/settings', { values: { managerLowersTrust: true } });
  await call('POST', '/reviews', { auto: true, again: true });
  await W.fail('pipeline', 3);
  const [n] = await until(async () => { const l = await W.notes('brake'); return l.length && l; }, 'the brake\'s note');
  assert.deepStrictEqual(await W.level(), { auto: true, again: false }, 'from level 1, Review loop, to level 0');
  assert.match(n.reason, /The manager saw: The check pipeline failed on 3 commits/);
  assert.match(n.reason, /lowered the trust level from 1, Review loop: turned off Review again after each push\. The room is at level 0, You drive\. Raising it again is yours\./);
  assert.match(n.say, /^Lowered the trust level to 0, You drive\./);
  assert.ok(n.say.length <= 140);
  const view = (await call('GET', '/manager')).body;
  assert.strictEqual(view.lowered.length, 1);
  assert.strictEqual(view.lowered[0].from, 1);
  assert.strictEqual(view.lowered[0].to, 0);
  assert.match(view.lowered[0].saw, /pipeline failed on 3 commits/);
  const task = (await call('GET', '/tasks')).body.tasks[0];
  assert.strictEqual(task.state, 'building', 'the task is where it was');

  await call('POST', '/reviews', { auto: true, again: true });
  await W.fail('pipeline', 1);
  await W.fail('pipeline', 1);
  assert.strictEqual((await W.notes('brake')).length, 1, 'one lowering for a stall that lasts');

  await W.fail('lint', 3);
  await until(async () => (await W.notes('brake')).length === 2, 'the second lowering');
  assert.deepStrictEqual(await W.level(), { auto: true, again: false });

  await call('POST', '/reviews', { auto: true, again: true });
  await W.fail('docs', 3);
  await until(async () => (await W.notes('check')).some((x) => /docs/.test(x.reason)), 'the third stall');
  assert.strictEqual((await W.notes('brake')).length, 2, 'two a day, and then the rest is the person\'s');
  assert.deepStrictEqual(await W.level(), { auto: true, again: true }, 'the person\'s level is left alone');
});

test('the brake does nothing while the switch is off, and never raises the level', async (t) => {
  const W = await room({});
  t.after(W.stop);
  const { call } = W;
  assert.strictEqual((await call('GET', '/settings')).body.settings.find((s) => s.name === 'managerLowersTrust').value, false);
  await call('POST', '/reviews', { auto: true, again: true });
  await W.fail('pipeline', 3);
  await until(async () => (await W.notes('check')).length === 1, 'the note about the check');
  assert.deepStrictEqual(await W.level(), { auto: true, again: true }, 'off: the level stays');
  assert.strictEqual((await W.notes('brake')).length, 0);

  await call('POST', '/settings', { values: { managerLowersTrust: true } });
  await call('POST', '/reviews', { auto: true, again: false });
  await W.fail('lint', 3);
  await until(async () => (await W.notes('check')).length === 2, 'the note about the second check');
  assert.deepStrictEqual(await W.level(), { auto: true, again: false }, 'at level 0 there is nothing to lower and nothing is raised');
  assert.strictEqual((await W.notes('brake')).length, 0);
  assert.strictEqual((await call('GET', '/manager')).body.lowered.length, 0);
});

test('from Autopilot the brake turns Autopilot off, leaves work where it is, and says what it could not set with no Lead', async (t) => {
  const W = await room({});
  t.after(W.stop);
  const { call } = W;
  await call('POST', '/settings', { values: { managerLowersTrust: true, leadStops: true } });
  await call('POST', '/reviews', { auto: true, again: true });
  await call('POST', '/autopilot', { on: true });
  const before = (await call('GET', '/tasks')).body.tasks.map((x) => [x.id, x.state]);
  await W.fail('pipeline', 3);
  const [n] = await until(async () => { const l = await W.notes('brake'); return l.length && l; }, 'the brake\'s note');
  assert.strictEqual((await call('GET', '/autopilot')).body.on, false);
  assert.match(n.reason, /from 5, Autopilot: turned off Autopilot\. The switches now match no level\. He could not change Let the Lead move the board, Let the Lead merge, Let the Lead start tickets\./);
  assert.deepStrictEqual((await call('GET', '/tasks')).body.tasks.map((x) => [x.id, x.state]), before);
});
