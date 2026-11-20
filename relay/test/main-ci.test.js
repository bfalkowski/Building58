'use strict';
// A red main (T-397). Two PRs that each pass CI can break main when they merge minutes apart, so CI runs on
// each push to main. When main's latest run failed, Needs you shows one line that links the run, the Lead's
// Floor shows it, and Autopilot starts no new ticket. When a run on main passes again, the line clears and
// Autopilot starts work again.
process.env.RELAY_MAIN_CI_POLL_SECONDS = '0';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, removeDir, until } = require('./helpers.js');
const { stateOf } = require('../main-ci.js');
const { listOf } = require('../needs-you-plan.js');

const RUN = 'https://github.com/acme/widgets/actions/runs/42';
const run = (o) => Object.assign({ databaseId: 1, workflowName: 'CI', status: 'completed', conclusion: 'success', url: 'https://github.com/acme/widgets/actions/runs/1', headSha: 'a'.repeat(40), event: 'push', createdAt: '2026-11-20T10:00:00Z' }, o);
const FAILED = run({ databaseId: 42, conclusion: 'failure', url: RUN, headSha: 'b'.repeat(40), createdAt: '2026-11-20T11:00:00Z' });

test('what main\'s runs say', () => {
  assert.strictEqual(stateOf([]).state, 'none');
  assert.strictEqual(stateOf([run()]).state, 'green');
  assert.deepStrictEqual(stateOf([FAILED, run()]).run, { workflow: 'CI', sha: 'b'.repeat(40), url: RUN, conclusion: 'failure' });
  assert.strictEqual(stateOf([run({ createdAt: '2026-11-20T12:00:00Z' }), FAILED]).state, 'green', 'a newer run that passed clears it');
  assert.strictEqual(stateOf([run({ status: 'in_progress', conclusion: '', createdAt: '2026-11-20T12:00:00Z' }), FAILED]).state, 'red', 'a run still going changes nothing');
  assert.strictEqual(stateOf([run({ conclusion: 'cancelled', createdAt: '2026-11-20T12:00:00Z' }), FAILED]).state, 'red', 'a cancelled run is not a pass');
  assert.strictEqual(stateOf([run({ event: 'pull_request', createdAt: '2026-11-20T12:00:00Z' }), FAILED]).state, 'red', 'a pull request run does not test main');
  assert.strictEqual(stateOf([run({ event: 'schedule', conclusion: 'failure', createdAt: '2026-11-20T12:00:00Z' }), run()]).state, 'green', 'a weekly run tests Node 18 too, so its failure is not a red main');
  assert.strictEqual(stateOf([run({ event: 'workflow_dispatch', conclusion: 'failure', createdAt: '2026-11-20T12:00:00Z' }), run()]).state, 'green', 'nor is a by-hand run');
  assert.strictEqual(stateOf([run({ event: 'schedule', createdAt: '2026-11-20T12:00:00Z' }), FAILED]).state, 'red', 'and a weekly pass does not clear a failed push');
  assert.strictEqual(stateOf([run({ workflowName: 'Pages', createdAt: '2026-11-20T12:00:00Z' }), FAILED]).state, 'red', 'each workflow counts on its own');
  assert.strictEqual(stateOf([run({ conclusion: 'timed_out' })]).state, 'red');
  assert.strictEqual(stateOf({}).state, 'unknown');
});

test('Needs you puts a red main after desks and before a merge', () => {
  const items = listOf({ tasks: [{ id: 't1', ticket: 'T-1', state: 'in_review', pr: 'https://github.com/a/b/pull/3', prOpen: true, onlyYouMerge: 'It changes CLAUDE.md.' }], mains: [{ name: 'widgets', branch: 'main', run: stateOf([FAILED]).run }] });
  assert.deepStrictEqual(items.map((i) => i.kind), ['main', 'merge']);
  assert.deepStrictEqual(items[0].link, { url: RUN });
  assert.match(items[0].line, /^Look at the failed CI run on main of widgets: CI at bbbbbbb ended in failure\. Autopilot starts no new ticket on main there until a push run on main passes\. https:\/\/github\.com\/acme\/widgets\/actions\/runs\/42$/);
});

test('a red main holds Autopilot and shows in Needs you and on the Floor, and a pass clears it', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-main-ci-'));
  const answer = (runs) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ runs }));
  answer([FAILED, run()]);
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_MAIN_CI_POLL_SECONDS: '1' });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home);
  const ticket = (await R.call('POST', '/tickets', { title: 'Next work', body: 'Do it.', repo })).body.ticket;
  await R.call('POST', '/tickets/' + ticket.id + '/move', { to: 'ready' });
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const mains = async () => (await R.call('GET', '/needs-you')).body.items.filter((i) => i.kind === 'main');
  const began = Date.now();
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true })).status, 200);

  await t.test('Autopilot starts nothing and says main is red', async () => {
    const idle = await until(async () => { const a = await ap(); return /^Main is red/.test(a.idle || '') && a.idle; }, 'Autopilot to say main is red');
    assert.match(idle, new RegExp('^Main is red, so ' + ticket.id + ' waits: main of ' + path.basename(repo) + ': CI at bbbbbbb ended in failure\\.'));
    assert.strictEqual((await R.call('GET', '/tasks')).body.tasks.length, 0);
  });
  await t.test('Needs you shows one line with the run\'s link', async () => {
    const items = await mains();
    assert.strictEqual(items.length, 1);
    assert.deepStrictEqual(items[0].link, { url: RUN });
    assert.ok(items[0].line.endsWith(RUN), items[0].line);
  });
  await t.test('the Floor shows it too', async () => {
    const floor = (await R.call('GET', '/floor')).body;
    assert.deepStrictEqual(floor.mainRed.map((m) => [m.branch, m.url]), [['main', RUN]]);
    assert.match(floor.mainRed[0].says, /^Red: main of /);
  });
  await t.test('a run that passes clears the line, and Autopilot starts the ticket', async () => {
    answer([run({ databaseId: 43, createdAt: '2026-11-20T12:00:00Z' }), FAILED]);
    await until(async () => (await R.call('GET', '/tasks')).body.tasks.length === 1, 'Autopilot to start the ticket');
    assert.deepStrictEqual(await mains(), []);
    assert.doesNotMatch((await ap()).idle || '', /Main is red/);
  });
  await t.test('it asks GitHub about main once a setting\'s time at most', async () => {
    const seconds = (Date.now() - began) / 1000;
    const asked = fs.readFileSync(path.join(ghDir, 'calls.log'), 'utf8').split('\n').filter((l) => l.startsWith('run list'));
    assert.ok(asked.every((l) => l === 'run list --branch main --event push --limit 20 --json databaseId,workflowName,status,conclusion,url,headSha,event,createdAt'), asked.join('\n'));
    assert.ok(asked.length >= 2 && asked.length <= Math.ceil(seconds) + 1, asked.length + ' asks in ' + seconds + ' seconds');
  });
});
