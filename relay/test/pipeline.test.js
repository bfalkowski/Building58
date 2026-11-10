'use strict';
// A clean pipeline before review or asking to merge (T-11). An automatic review waits until the PR's
// checks pass, using no desk while it waits. A red pipeline starts no reviewer and tells the Dev. A
// PR with no checks is reviewed after a short wait. The Board shows a task in review whose checks are
// running or failed as waiting on the pipeline.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');
const { stateOf, gate } = require('../pipeline.js');

const PASSED = { __typename: 'CheckRun', name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' };
const FAILED = { __typename: 'CheckRun', name: 'pipeline', status: 'COMPLETED', conclusion: 'FAILURE' };
const RUNNING = { __typename: 'CheckRun', name: 'pipeline', status: 'IN_PROGRESS', conclusion: '' };

test('what the checks on a commit say', () => {
  assert.strictEqual(stateOf([PASSED, { status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'green');
  assert.strictEqual(stateOf([PASSED, FAILED]), 'red');
  assert.strictEqual(stateOf([RUNNING, FAILED]), 'red', 'one failed check is enough, even with others still running');
  assert.strictEqual(stateOf([PASSED, RUNNING]), 'pending');
  assert.strictEqual(stateOf([{ __typename: 'StatusContext', state: 'PENDING' }]), 'pending', 'a commit status has only a state');
  assert.strictEqual(stateOf([{ __typename: 'StatusContext', state: 'ERROR' }]), 'red');
  assert.strictEqual(stateOf([]), 'none', 'no checks is not the same as checks still running');
  assert.strictEqual(stateOf(undefined), 'none');
});

test('when a waiting review may start', () => {
  const grace = 1000, at = 10000;
  const p = (state, extra) => Object.assign({ state, head: 'b'.repeat(40), since: at }, extra);
  assert.deepStrictEqual(gate(null, { heldAt: at, now: at + 5000, grace }).go, false, 'nothing heard yet');
  assert.strictEqual(gate(p('green'), { heldAt: at, now: at, grace }).go, true);
  assert.deepStrictEqual(gate(p('red'), { heldAt: at, now: at + 5000, grace }), { go: false, red: true, why: 'A check failed.' });
  assert.strictEqual(gate(p('pending'), { heldAt: at, now: at + 999999, grace }).go, false, 'running checks are waited on for as long as they run');
  assert.strictEqual(gate(p('none'), { heldAt: at, now: at + 500, grace }).go, false, 'GitHub may not have started them yet');
  assert.match(gate(p('none'), { heldAt: at, now: at + 1000, grace }).why, /no checks/, 'then it has none, and the review starts');
  assert.strictEqual(gate(p('none', { since: at + 800 }), { heldAt: at, now: at + 1500, grace }).go, false, 'the wait counts from when there were none on this commit');
  assert.strictEqual(gate(p('unknown', { error: 'gh is not installed' }), { heldAt: at, now: at + 500, grace }).go, false);
  assert.match(gate(p('unknown', { error: 'gh is not installed' }), { heldAt: at, now: at + 1000, grace }).why, /gh is not installed/);
  // A follow-up: GitHub still has the commit the last review read, so the push has not reached it yet.
  assert.strictEqual(gate(p('green'), { heldAt: at, lastHead: 'b'.repeat(40), now: at + 500, grace }).go, false);
  assert.strictEqual(gate(p('green'), { heldAt: at, lastHead: 'b'.repeat(40), now: at + 1000, grace }).go, true, 'a push that sent nothing does not wait for ever');
  assert.strictEqual(gate(p('green'), { heldAt: at, lastHead: 'c'.repeat(40), now: at, grace }).go, true);
  assert.deepStrictEqual(gate(p('green', { open: false, prState: 'CLOSED' }), { heldAt: at, now: at, grace }), { go: false, gone: true, why: 'It was closed before its review started.' });
});

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = (n) => 'https://github.com/acme/widgets/pull/' + n;
const QUIET = 3000;  // longer than the no-checks wait below, and the relay asks gh every second

test('automatic reviews wait for a green pipeline', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  t.after(() => fs.rmSync(ghDir, { recursive: true, force: true }));
  const prs = {};
  const answer = (pr, head, checks, state) => { prs[pr] = { state: state || 'OPEN', headRefOid: head, statusCheckRollup: checks }; fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs })); };
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_PIPELINE_POLL_SECONDS: '1', RELAY_PIPELINE_NO_CHECKS_MS: '2000' }, null, { autoReview: true });
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  let n = 0;
  const commit = (pr) => {  // a new commit on the PR's head, as a Dev's git push leaves it on GitHub
    fs.writeFileSync(path.join(repo, 'a.txt'), 'change ' + (++n) + '\n');
    sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change ' + n);
    sh(repo, 'push', '-qf', origin, 'HEAD:refs/pull/' + pr.split('/').pop() + '/head');
    return sh(repo, 'rev-parse', 'HEAD');
  };
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const opens = (s, pr) => say(s, 'PostToolUse', { pr_url: pr, cwd: repo });
  const pushes = (s) => say(s, 'PostToolUse', { pushed: true });
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const reviewersOf = async (pr) => (await terminals()).filter((x) => x.role === 'reviewer' && x.pr === pr);
  const reviewer = (pr) => until(async () => (await reviewersOf(pr))[0], 'a review of ' + pr);
  const noReviewer = async (pr, why) => { await sleep(QUIET); assert.deepStrictEqual(await reviewersOf(pr), [], why); };
  const stop = async (s) => { await R.call('POST', '/terminals/' + s.id + '/stop', {}); await until(async () => !(await terminals()).some((x) => x.id === s.id), 'it to stop'); };
  const commitOf = async (s) => (await R.call('GET', '/checkouts')).body.checkouts.find((c) => c.path === s.cwd).commit;
  const dev = async () => { const r = await R.call('POST', '/terminals', { cwd: repo }); assert.strictEqual(r.status, 201, JSON.stringify(r.body)); return r.body; };
  const reviews = async () => (await R.call('GET', '/reviews')).body;
  const rec = async (pr) => (await reviews()).prs.find((x) => x.pr === pr);
  const news = async () => (await reviews()).news.map((x) => x.text).join('\n');

  await t.test('green: the review starts', async () => {
    const d = await dev(), pr = PR(1);
    answer(pr, commit(pr), [PASSED]);
    await opens(d, pr);
    await stop(await reviewer(pr));
    await stop(d);
  });

  await t.test('pending: no reviewer, and no desk, until the checks pass', async () => {
    const d = await dev(), pr = PR(2), head = commit(pr);
    answer(pr, head, [RUNNING]);
    await opens(d, pr);
    await noReviewer(pr, 'its checks are running');
    const r = await rec(pr);
    assert.deepStrictEqual([r.held, r.count, r.pipeline.state, r.why], [true, 0, 'pending', 'Its checks are running.']);
    assert.strictEqual((await terminals()).length, 1, 'only the Dev has a desk while the review waits');
    answer(pr, head, [PASSED]);
    assert.strictEqual(await commitOf(await reviewer(pr)), head);
    assert.match(await news(), /PR #2 is open\. Its review starts once its pipeline passes\./);
    await stop((await reviewersOf(pr))[0]);
    await stop(d);
  });

  await t.test('red then green after a push: no review until the push, and the Dev is told once', async () => {
    const d = await dev(), pr = PR(3);
    answer(pr, commit(pr), [FAILED]);
    await opens(d, pr);
    await noReviewer(pr, 'its pipeline failed');
    assert.match(await news(), /The pipeline failed on PR #3, so no review started\. Its Dev was told\./);
    await until(async () => (await R.screen(d.id)).includes('GOT[The pipeline failed on ' + pr), 'the Dev to be told');
    assert.strictEqual((await news()).match(/pipeline failed on PR #3/g).length, 1, 'told once for that commit, though the relay asked again');
    const fixed = commit(pr);
    answer(pr, fixed, [RUNNING]);
    await pushes(d); await say(d, 'Stop');
    await noReviewer(pr, 'the fix is still being checked');
    answer(pr, fixed, [PASSED]);
    assert.strictEqual(await commitOf(await reviewer(pr)), fixed, 'the review reads the commit that passed');
    await stop((await reviewersOf(pr))[0]);
    await stop(d);
  });

  await t.test('red with the Dev gone: the panel says nobody could be told', async () => {
    const d = await dev(), pr = PR(4);
    answer(pr, commit(pr), [FAILED]);
    await opens(d, pr);
    await stop(d);
    await until(async () => /pipeline failed on PR #4, so no review started, and nobody could be told: its Dev's session has ended/.test(await news()), 'the panel to say so');
    assert.deepStrictEqual(await reviewersOf(pr), []);
  });

  await t.test('no checks configured: a short wait for them to appear, then the review starts', async () => {
    const d = await dev(), pr = PR(5);
    answer(pr, commit(pr), []);
    const at = Date.now();
    await opens(d, pr);
    await sleep(1000);
    assert.deepStrictEqual(await reviewersOf(pr), [], 'GitHub may not have started them yet');
    await stop(await reviewer(pr));
    assert.ok(Date.now() - at >= 2000, 'it waited for RELAY_PIPELINE_NO_CHECKS_MS');
    assert.match(await news(), /PR #5: It has no checks, so the review starts with no pipeline\./);
    await stop(d);
  });

  await t.test('a person\'s Get a review while the first review waits is its first review', async () => {
    const d = await dev(), pr = PR(7), head = commit(pr);
    answer(pr, head, [RUNNING]);
    await opens(d, pr);
    await until(async () => (await rec(pr)) && (await rec(pr)).held, 'the review to wait');
    const r = await R.call('POST', '/checkouts', { from: repo, pr });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    await until(async () => (await rec(pr)).head === head, 'the person\'s review to be recorded');
    assert.strictEqual((await rec(pr)).held, false, 'the automatic first review no longer waits');
    await stop((await reviewersOf(pr))[0]);
    answer(pr, head, [PASSED]);
    await noReviewer(pr, 'it already had its first review, from the person');
    assert.strictEqual((await rec(pr)).head, head, 'and the commit that review read is kept for the next follow-up');
    await stop(d);
  });

  await t.test('a PR merged or closed while its review waits gets none', async () => {
    const d = await dev(), pr = PR(8), head = commit(pr);
    answer(pr, head, [RUNNING]);
    await opens(d, pr);
    await until(async () => rec(pr), 'the review to wait');
    answer(pr, head, [PASSED], 'MERGED');
    await until(async () => !(await rec(pr)), 'the wait to end');
    assert.match(await news(), /No review of PR #8: It was merged before its review started\./);
    await noReviewer(pr, 'it is merged');
    await stop(d);
  });

  await t.test('a follow-up after a push waits for the pipeline too', async () => {
    assert.strictEqual((await R.call('POST', '/reviews', { again: true })).body.again, true);
    const d = await dev(), pr = PR(10);
    answer(pr, commit(pr), [PASSED]);
    await opens(d, pr);
    await stop(await reviewer(pr));
    const next = commit(pr);
    answer(pr, next, [FAILED]);
    await pushes(d); await say(d, 'Stop');
    await noReviewer(pr, 'the push turned it red');
    assert.match(await news(), /pipeline failed on PR #10/);
    answer(pr, next, [PASSED]);
    assert.strictEqual(await commitOf(await reviewer(pr)), next);
    await stop((await reviewersOf(pr))[0]);
    await stop(d);
  });

  // T-176: a push made while the relay restarts sends no hook. The relay compares the PR's head with the
  // head its last review read, so the follow-up starts anyway, once the Dev's turn ends.
  await t.test('a PR whose head moved with no push hook gets its follow-up', async () => {
    const d = await dev(), pr = PR(11);
    answer(pr, commit(pr), [PASSED]);
    await opens(d, pr);
    await stop(await reviewer(pr));
    await noReviewer(pr, 'the PR is at the head its review read');
    assert.strictEqual((await rec(pr)).count, 1);
    await say(d, 'UserPromptSubmit');
    const moved = commit(pr);
    answer(pr, moved, [PASSED]);  // no pushes(d): the hook was lost
    await noReviewer(pr, 'the Dev is still in its turn and may push again');
    await say(d, 'Stop');
    assert.strictEqual(await commitOf(await reviewer(pr)), moved, 'the follow-up reads the head GitHub has');
    const id = (await reviewersOf(pr))[0].id;
    await until(async () => (await R.screen(id)).includes('New commits were pushed'), 'the follow-up brief');
    await stop((await reviewersOf(pr))[0]);
    await noReviewer(pr, 'one follow-up for one head');
    assert.strictEqual((await rec(pr)).count, 2);
    await stop(d);
  });
});

test('the Board shows a task in review with a running or failed pipeline as waiting on it', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  t.after(() => fs.rmSync(ghDir, { recursive: true, force: true }));
  const answer = (checks, state) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR(9)]: { state: state || 'OPEN', headRefOid: 'a'.repeat(40), statusCheckRollup: checks } } }));
  answer([RUNNING]);
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_PIPELINE_POLL_SECONDS: '1' });
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const made = await R.call('POST', '/tasks', { title: 'Pipeline task', repo });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const id = made.body.task.id;
  const task = async () => (await R.call('GET', '/tasks/' + id)).body.task;
  const w = await task();
  await R.hook({ hook_event_name: 'PostToolUse', session_id: w.worker && (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === w.worker.terminal).sessionId.slice(0, 12), pr_url: PR(9), cwd: w.worktree });
  await until(async () => (await task()).pr === PR(9), 'the task to have its PR');
  assert.strictEqual((await R.call('POST', '/tasks/' + id + '/move', { to: 'in_review' })).status, 200);
  const p = await until(async () => (await task()).pipeline, 'the pipeline');
  assert.deepStrictEqual([p.state, p.waits], ['pending', true], 'in review, but waiting on the pipeline');
  answer([FAILED]);
  await until(async () => (await task()).pipeline.state === 'red', 'a red pipeline');
  assert.strictEqual((await task()).pipeline.waits, true);
  assert.strictEqual((await R.call('POST', '/tasks/' + id + '/move', { to: 'waiting_on_you' })).status, 200);
  assert.strictEqual((await task()).pipeline.waits, true, 'not Waiting on you while the pipeline is red');
  const tickets = await R.call('GET', '/tasks', null, { Authorization: 'Bearer test-key' });
  assert.ok(tickets.body.tasks.find((x) => x.id === id).pipeline.waits);
  answer([PASSED]);
  await until(async () => (await task()).pipeline.state === 'green', 'a green pipeline');
  assert.strictEqual((await task()).pipeline.waits, false, 'now it really waits on you');
  answer([FAILED], 'MERGED');
  await until(async () => (await task()).pipeline.open === false, 'the merge to be seen');
  assert.strictEqual((await task()).pipeline.waits, false, 'a merged PR waits on no pipeline');
  assert.strictEqual((await R.call('POST', '/tasks/' + id + '/move', { to: 'building' })).status, 200);
  answer([FAILED]);
  await until(async () => (await task()).pipeline.state === 'red', 'red again');
  assert.strictEqual((await task()).pipeline.waits, false, 'a task still building is not waiting on the pipeline');
});
