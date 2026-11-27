// T-500: a PR red only on a known flaky test gets one rerun by the relay, a note on the flaky ticket and a flake-blocks
// jam. A second red on the same head is not rerun: it goes to Needs you, or to a shared failure channel while the
// Lead may unstick the board. Through a real relay with a fake `claude` and a fake `gh` (relay/flake.js,
// relay/flake-plan.js).
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, removeDir, sleep, until } = require('./helpers.js');
const plan = require('../flake-plan.js');
const { heldBy } = require('../held-words.js');

const url = (n) => 'https://github.com/acme/widgets/pull/' + n;
const run = (n) => 'https://github.com/acme/widgets/actions/runs/' + n + '/job/1';
const failed = (name, id) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: run(id) });
const RUNNING = { __typename: 'CheckRun', name: 'browser', status: 'IN_PROGRESS', conclusion: '' };
const TEST = 'the trailer\'s ping pong cue clears a game already going';
const LOG = (file) => '✖ ' + TEST + ' (30001.2ms)\n    at ' + file + ':40:3\n';

test('testsOf reads the failing tests and files of a job log, spec and TAP', () => {
  const spec = plan.testsOf(LOG('relay/test/browser/pingpong.test.js') + '✔ a test that passed (5ms)\n');
  assert.deepStrictEqual(spec, { names: [TEST], files: ['pingpong.test.js'] });
  const tap = plan.testsOf('not ok 3 - ' + TEST + '\nnot ok 4 - tests\n');
  assert.deepStrictEqual(tap.names, [TEST]);
  assert.deepStrictEqual(plan.testsOf(''), { names: [], files: [] });
});

test('knownBy needs an open ticket that names the failing test, as a flaky one or in its title', () => {
  const tests = { names: [TEST], files: ['pingpong.test.js'] };
  const flaky = { id: '368', status: 'ready', labels: ['flaky'], title: 'Ping pong flake', body: 'The test "' + TEST + '" times out.' };
  assert.strictEqual(plan.knownBy([flaky], tests).id, '368');
  assert.strictEqual(plan.knownBy([Object.assign({}, flaky, { status: 'done' })], tests), null, 'a closed ticket owns no flake');
  assert.strictEqual(plan.knownBy([Object.assign({}, flaky, { labels: [], body: 'mentions ' + TEST })], tests), null, 'a body alone, on a ticket that is not flaky, does not count');
  assert.strictEqual(plan.knownBy([{ id: '413', status: 'ready', title: 'pingpong.test.js fails in the browser job', body: '' }], tests).id, '413', 'its title names the file');
  assert.strictEqual(plan.knownBy([flaky], { names: [TEST, 'another test that fails'], files: [] }), null, 'every failing test must be known');
  assert.strictEqual(plan.knownBy([flaky], { names: [], files: [] }), null);
});

test('heldBy says which checks hold the review', () => {
  assert.strictEqual(heldBy(['browser']), 'held: check browser failed');
  assert.strictEqual(heldBy(['browser', 'lint', 'browser']), 'held: checks browser and lint failed');
  assert.strictEqual(heldBy([]), null);
});

test('Autopilot and the Floor say what holds the review', () => {
  const autopilot = require('../autopilot-plan.js'), { deskOf } = require('../desk.js');
  const pr = { state: 'OPEN', headRefOid: 'a'.repeat(40), mergeStateStatus: 'BLOCKED', statusCheckRollup: [failed('browser', 1)] };
  assert.strictEqual(autopilot.forReviewed(pr, null, 0, 3, false, undefined, null).why, 'held: check browser failed.');
  assert.strictEqual(autopilot.forReviewed(Object.assign({}, pr, { statusCheckRollup: [RUNNING] }), null, 0, 3, false, undefined, null).why, autopilot.WAITS_FOR_REVIEW);
  const t = { id: 't1', role: 'Dev', state: 'idle', hooked: true, lastActAt: Date.now(), cwd: '/x' };
  const task = { id: 'k1', state: 'in_review', pr: url(31), ticket: '31', title: 'x' };
  const desk = deskOf({ t, role: 'Dev', task, now: Date.now(), work: { pr: url(31) }, pipeline: { state: 'red' }, failed: ['browser'], review: { count: 0, held: true }, verdict: { safe: false, canStop: false, reason: 'x' } });
  assert.strictEqual(desk.review, 'held: check browser failed');
});

test('a PR red only on a known flake is rerun once, noted, logged, and a second red goes to Needs you', async (t) => {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ RELAY_WIP_LIMIT: '8', RELAY_REVIEW_GRACE_MS: '600000', RELAY_CHAT_POLL_SECONDS: '1', RELAY_PIPELINE_POLL_SECONDS: '1', GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); removeDir(gh); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(args), { cwd, encoding: 'utf8' }).trim();
  git(R.home, 'init', '-q', '--bare', origin);
  git(repo, 'config', 'url.' + origin + '.insteadOf', 'https://github.com/acme/widgets.git');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  git(repo, 'push', '-q', 'origin', 'main');
  await R.call('POST', '/reviews', { auto: false });
  const logs = {}, files = {};
  const answers = (prs) => fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify({ prs, logs, api: files }));
  const pr = (n, checks, head) => ({ [url(n)]: { state: 'OPEN', headRefOid: head || String(n).repeat(40).slice(0, 40), statusCheckRollup: checks } });
  const started = async (title, link) => {
    const ticket = (await R.call('POST', '/tickets', { title, body: 'Do it.', repo })).body.ticket;
    const task = (await R.call('POST', '/tickets/' + ticket.id + '/start', {})).body.task;
    await sleep(300);
    await R.hook({ session_id: task.owner.sessionId.slice(0, 12), hook_event_name: 'PostToolUse', tool_name: 'Bash', pr_url: link });
    await until(async () => (await R.call('GET', '/tasks/' + task.id)).body.task.pr === link, 'the PR link');
    return ticket;
  };
  const flaky = (await R.call('POST', '/tickets', { title: 'pingpong.test.js fails in the browser job on a PR that does not touch office/', body: 'The test "' + TEST + '" times out.', repo, labels: ['flaky'] })).body.ticket;
  const reruns = () => (fs.existsSync(path.join(gh, 'rerun.log')) ? fs.readFileSync(path.join(gh, 'rerun.log'), 'utf8').trim().split('\n') : []);
  const needs = async () => (await R.call('GET', '/needs-you')).body.items.filter((i) => i.kind === 'flake');

  await started('Unrelated change', url(1));
  files['repos/acme/widgets/pulls/1/files'] = [{ filename: 'docs/manual/relay.html' }];

  await t.test('red on a test no flaky ticket names is not rerun', async () => {
    logs['1'] = '✖ some other test that fails (10ms)\n';
    answers(pr(1, [failed('browser', 1)]));
    await sleep(3500);
    assert.deepStrictEqual(reruns(), []);
  });

  await t.test('red only on the known flake is rerun once, noted on the flaky ticket, and logged as a jam', async () => {
    logs['1'] = LOG('relay/test/browser/pingpong.test.js');
    answers(pr(1, [failed('browser', 1)], 'b'.repeat(40)));
    await until(() => reruns().length === 1, 'the rerun');
    assert.strictEqual(reruns()[0], '1 --failed -R acme/widgets');
    await until(async () => ((await R.call('GET', '/tickets/' + flaky.id)).body.ticket.notes || []).length === 1, 'the note');
    const note = (await R.call('GET', '/tickets/' + flaky.id)).body.ticket.notes[0];
    assert.strictEqual(note.by, 'the relay');
    assert.match(note.text, /PR #1 went red on bbbbbbb only on this known flake: check browser/);
    const jam = (await R.call('GET', '/jams')).body.jams.find((j) => j.kind === 'flake-blocks');
    assert.ok(jam, 'a flake-blocks jam');
    assert.deepStrictEqual([jam.pr, jam.ticket, jam.by], [url(1), flaky.id, 'the relay']);
    await sleep(3000);
    assert.strictEqual(reruns().length, 1, 'not again on the next look');
    assert.deepStrictEqual(await needs(), [], 'nothing for the person yet');
  });

  await t.test('a second red on the same head is not rerun, and goes to Needs you', async () => {
    answers(pr(1, [RUNNING], 'b'.repeat(40)));
    await sleep(2500);
    answers(pr(1, [failed('browser', 1)], 'b'.repeat(40)));
    await until(async () => (await needs()).length === 1, 'the Needs you item');
    const item = (await needs())[0];
    assert.strictEqual(item.pr, url(1));
    assert.match(item.line, /^Look at PR #1: the check browser failed again on the same commit after the relay reran it once, so it does not rerun it again\. It matches the known flake on ticket /);
    await sleep(3000);
    assert.strictEqual(reruns().length, 1, 'no second rerun');
    assert.strictEqual((await R.call('GET', '/tickets/' + flaky.id)).body.ticket.notes.length, 2, 'the failure is noted too');
  });

  await t.test('a new head gets its own single rerun', async () => {
    answers(pr(1, [failed('browser', 1)], 'c'.repeat(40)));
    await until(() => reruns().length === 2, 'the rerun of the new head');
    assert.deepStrictEqual(await needs(), []);
  });

  await t.test('with Let the Lead unstick the board on, a second red opens the shared failure channel', async () => {
    assert.strictEqual((await R.call('POST', '/settings', { values: { leadUnstick: true } })).status, 200);
    answers(pr(1, [RUNNING], 'c'.repeat(40)));
    await sleep(2500);
    answers(pr(1, [failed('browser', 1)], 'c'.repeat(40)));
    await until(async () => (await R.call('GET', '/chat')).body.rooms.some((r) => r.name === 'failure-browser'), 'the failure channel');
    assert.strictEqual(reruns().length, 2, 'no third rerun');
    assert.deepStrictEqual(await needs(), [], 'it is in the channel, not on Needs you');
  });

  await t.test('a PR that changes the flaky test\'s file is not rerun: the failure is its own', async () => {
    await started('Changes the ping pong test', url(2));
    files['repos/acme/widgets/pulls/2/files'] = [{ filename: 'relay/test/browser/pingpong.test.js' }];
    logs['2'] = LOG('relay/test/browser/pingpong.test.js');
    answers(Object.assign(pr(1, [RUNNING], 'c'.repeat(40)), pr(2, [failed('browser', 2)])));
    await sleep(3500);
    assert.strictEqual(reruns().length, 2);
  });
});
