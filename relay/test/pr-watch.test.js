'use strict';
// The PR watch through a real relay, with a fake claude and a fake gh (T-106): on a timer it reads an open
// task PR and moves it to its next step, with no hook to start it. Each row of the ticket: a review for a
// head none read, the Dev told once about findings, a conflict, a failed check and commits it did not push,
// the Lead told when it is ready, one line on the Floor, the Board and ticket.js floor, a wait that goes to
// the person, and each action done once, through a restart.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, removeDir, until, sleep, sessionToken, ROOT } = require('./helpers.js');

const CLI = path.join(ROOT, 'relay', 'ticket.js');
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/widgets/pull/7';
const GREEN = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const RED = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'FAILURE' }];
const RUNNING = [{ name: 'pipeline', status: 'IN_PROGRESS', conclusion: '' }];
const ENV = { RELAY_PR_WATCH_SECONDS: '1', RELAY_REVIEW_GRACE_MS: '200', RELAY_TOLD_CHECK_MS: '1500', RELAY_RESUME: '1' };

// A relay with a fake gh, a repo whose origin is a bare repo on disk, and a started ticket whose Dev has had its brief.
async function office(t, env, home) {
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const o = { ghDir, files: ['a.txt'] };
  o.R = await relay(Object.assign({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir }, ENV, env), home, { autoReview: true });
  t.after(async () => { await o.R.kill().catch(() => {}); await o.R.remove(); removeDir(ghDir); });
  const R = o.R;
  o.repo = makeRepo(R.home); o.origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', o.origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + o.origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(o.repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(o.repo, 'push', '-q', o.origin, 'HEAD:refs/heads/main');
  // After a restart o.R is the new relay, so these ask whichever relay runs now.
  o.say = (s, event, extra) => o.R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  o.finish = async (s) => { await o.say(s, 'UserPromptSubmit'); await o.say(s, 'Stop'); await sleep(150); };
  o.terminals = async () => (await o.R.call('GET', '/terminals')).body.terminals;
  // What gh pr view prints for the PR, and the files GitHub lists for it.
  o.answer = (pr) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: Object.assign({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN }, pr) },
    api: { 'repos/acme/widgets/pulls/7/files': o.files.map((f) => ({ filename: f })) } }));
  o.watch = async () => (await o.R.call('GET', '/pr-watch')).body;
  o.line = async () => (await o.watch()).prs.find((p) => p.pr === PR) || {};
  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', body: 'Change a.txt.', repo: o.repo })).body.ticket;
  o.ticket = ticket;
  const task = (await R.call('POST', '/tickets/' + ticket.id + '/start', {})).body.task;
  o.task = task; o.wt = task.worktree;
  o.dev = (await o.terminals()).find((x) => x.id === task.worker.terminal);
  await until(async () => (await R.screen(o.dev.id)).includes('GOT['), 'the brief');
  await o.finish(o.dev);
  await until(async () => (await R.call('GET', '/tasks/' + task.id)).body.task.briefed, 'the brief to be in');
  let n = 0;
  // A commit in the Dev's checkout. pushed: also on GitHub as the PR's head, with a remote branch that holds it.
  o.commit = (pushed) => {
    fs.writeFileSync(path.join(o.wt, 'a.txt'), 'change ' + (++n) + '\n');
    sh(o.wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change ' + n);
    if (pushed) o.push();
    return sh(o.wt, 'rev-parse', 'HEAD');
  };
  o.push = () => { sh(o.wt, 'push', '-qf', o.origin, 'HEAD:refs/pull/7/head'); sh(o.wt, 'update-ref', 'refs/remotes/origin/pr', 'HEAD'); };
  return o;
}
const told = async (o, words) => ((await o.R.screen(o.dev.id)).match(new RegExp('GOT\\[[^\\]]*' + words, 'g')) || []).length;

test('the PR watch moves an open task PR to its next step, once for each head and cause', async (t) => {
  const o = await office(t);
  let R = o.R;
  const seen = new Set();
  const reviewer = () => until(async () => (await o.terminals()).find((x) => x.role === 'reviewer' && x.pr === PR && !seen.has(x.id) && seen.add(x.id)), 'a reviewer');
  const noReviewer = async (why) => { await sleep(2500); assert.ok(!(await o.terminals()).some((x) => x.role === 'reviewer' && x.pr === PR && !seen.has(x.id)), why); };
  // A reviewer gives its verdict with its own token, posts, and its turn ends.
  const review = async (r, kind) => {
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind }, token)).status, 200);
    await o.say(r, 'UserPromptSubmit');
    await o.say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-' + (100 + seen.size) } });
    await o.say(r, 'Stop');
    await until(async () => !(await o.terminals()).some((x) => x.id === r.id), 'the reviewer to leave');
  };
  let h1;

  await t.test('it is off by default, and does nothing then', async () => {
    const setting = (await R.call('GET', '/settings')).body.settings.find((s) => s.name === 'prWatch');
    assert.deepStrictEqual([setting.value, setting.def], [false, false]);
    // The PR's hook comes while Review PRs automatically is off, so the reviews never hear of it: a missed hook.
    assert.strictEqual((await R.call('POST', '/reviews', { auto: false })).body.auto, false);
    h1 = o.commit(true);
    o.answer({ headRefOid: h1 });
    await o.say(o.dev, 'PostToolUse', { pr_url: PR, cwd: o.wt });
    await until(async () => (await R.call('GET', '/tasks/' + o.task.id)).body.task.pr === PR, 'the task to have its PR');
    assert.strictEqual((await R.call('POST', '/reviews', { auto: true })).body.auto, true);
    assert.deepStrictEqual((await R.call('GET', '/reviews')).body.prs, [], 'the reviews have no record of the PR');
    await noReviewer('the watch is off, and nothing else starts a review of a PR whose hook was missed');
    assert.strictEqual((await o.watch()).on, false);
    assert.strictEqual((await R.call('GET', '/floor')).body.sessions.find((x) => x.terminal === o.dev.id).waitsOn, null);
    const dev = { 'X-Office-Token': sessionToken(o.dev.sessionId) };
    assert.strictEqual((await R.call('POST', '/settings', { values: { prWatch: true } }, dev)).status, 401, 'a session cannot turn it on');
  });

  await t.test('row 1: a PR with no review of its head, and no record of one, gets one', async () => {
    assert.strictEqual((await R.call('POST', '/settings', { values: { prWatch: true } })).status, 200);
    const r1 = await reviewer();
    assert.match(R.output(), /PR watch: PR #7 had no review of [0-9a-f]{7}: its first review\./);
    // The Dev is told the review started. The fake sends no hooks, so the test says a turn began, or it is stuck.
    await until(async () => (await R.screen(o.dev.id)).includes('GOT[A review of your PR'), 'the Dev to hear the review started');
    await o.finish(o.dev);
    await until(async () => (await o.line()).owner === 'reviewer', 'the line to say it waits on the reviewer');
    await review(r1, 'fix');
  });

  await t.test('row 2: blocking findings are told to the Dev once, and a Dev that does not start shows as stuck', async () => {
    await until(async () => (await told(o, 'has blocking or fix-now findings')) === 1, 'the Dev to be told');
    const row = await until(async () => { const r = (await R.call('GET', '/floor')).body.sessions.find((x) => x.terminal === o.dev.id); return r.stuck && r; }, 'the Dev to show as stuck');
    assert.match(row.state, /^stuck: told/);
    // A turn that begins clears stuck. The watch does not tell it again for the same head and cause.
    await o.finish(o.dev);
    // The watch looks again on its own clock, so a line from while the turn ran (Its Dev is at work) can come first.
    const line = await until(async () => { const l = await o.line(); return l.owner === 'Dev' && /fix-now findings/.test(l.words) && l; }, 'the line to say it waits on the Dev for the findings');
    assert.match(line.words, /^waits on the Dev for 0 min: The review of [0-9a-f]{7} has blocking or fix-now findings\.$/);
    await sleep(3000);
    assert.strictEqual(await told(o, 'has blocking or fix-now findings'), 1, 'told once for this head and cause');
  });

  await t.test('row 5: one line on the Floor, the Board and ticket.js floor', async () => {
    const lead = (await R.call('POST', '/terminals', { cwd: o.repo })).body;
    await o.finish(lead);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
    const row = (await R.call('GET', '/floor')).body.sessions.find((x) => x.terminal === o.dev.id);
    assert.strictEqual(row.waitsOn.owner, 'Dev');
    const card = (await R.call('GET', '/tickets')).body.tickets.find((x) => x.id === o.ticket.id);
    assert.strictEqual(card.task.waitsOn.owner, 'Dev');
    const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: await until(() => { try { return sessionToken(lead.sessionId); } catch (e) { return null; } }, 'the Lead\'s token') };
    const out = execFileSync('node', [CLI, 'floor'], { env, encoding: 'utf8' });
    assert.ok(out.split('\n').some((l) => l.includes(' · PR waits on the Dev for ') && l.includes('has blocking or fix-now findings')), out);
  });

  await t.test('a restart keeps what was done: the Dev is not told again', async () => {
    const before = fs.readFileSync(path.join(R.home, '.office-world', 'pr-watch.json'), 'utf8');
    assert.match(before, new RegExp(h1 + ' fix'));
    await R.kill();
    o.R = R = await relay(Object.assign({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: o.ghDir }, ENV), R.home, { autoReview: true });
    o.dev = await until(async () => (await o.terminals()).find((x) => x.task === o.task.id && x.running), 'the Dev to come back');
    await o.finish(o.dev);
    // It waits on the idle Dev for the same findings, the move that tells it, and the kept key stops a second telling.
    await until(async () => /has blocking or fix-now findings/.test((await o.line()).why || '') && (await o.line()).owner === 'Dev', 'the watch to look again');
    await sleep(2500);
    assert.doesNotMatch(R.output(), /PR watch: Told the Dev/, 'the same head and cause is not told twice, across a restart');
  });

  await t.test('row 3: commits in the Dev\'s checkout that the PR does not have, with the Dev idle: push', async () => {
    o.commit(false);
    await until(async () => (await told(o, 'Push them with a plain git push')) === 1, 'the Dev to be told to push');
    await o.finish(o.dev);
    await until(async () => (await o.line()).owner === 'Dev', 'the line to say it waits on the Dev');
  });

  let h2;
  await t.test('row 2: a conflict with main, then a failed check, each told once', async () => {
    o.push(); h2 = sh(o.wt, 'rev-parse', 'HEAD');
    o.answer({ headRefOid: h2, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    await until(async () => (await told(o, 'conflicts with main')) === 1, 'the Dev to be told of the conflict');
    await o.finish(o.dev);
    o.answer({ headRefOid: h2, statusCheckRollup: RED });
    await until(async () => (await told(o, 'A check failed on your PR')) === 1, 'the Dev to be told of the failed check');
    await o.finish(o.dev);
    o.answer({ headRefOid: h2, statusCheckRollup: RUNNING });
    await until(async () => (await o.line()).owner === 'CI', 'the line to say it waits on CI');
    await sleep(2000);
    assert.deepStrictEqual([await told(o, 'conflicts with main'), await told(o, 'A check failed on your PR')], [1, 1], 'once for each head and cause');
  });

  await t.test('row 1 again, then row 4: a new head gets a follow-up, and reviewed, green and clean tells the Lead', async () => {
    o.files = ['a.txt', 'CLAUDE.md'];
    o.answer({ headRefOid: h2 });
    const r2 = await reviewer();
    assert.strictEqual((await R.call('GET', '/reviews')).body.prs.find((p) => p.pr === PR).count, 2, 'within the limit on automatic reviews');
    await review(r2, 'merge');
    const line = await until(async () => { const l = await o.line(); return l.owner === 'you' && l; }, 'a PR that changes CLAUDE.md to wait on you');
    assert.match(line.why, /CLAUDE\.md, which only you merge/);
    // A restart does not make a session the Lead again by itself, so the person makes one the Lead now.
    const lead = (await R.call('POST', '/terminals', { cwd: o.repo })).body;
    await o.finish(lead);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
    await until(async () => (await R.screen(lead.id)).includes('GOT['), 'the Lead\'s brief');
    await o.finish(lead);
    o.files = ['a.txt'];
    o.answer({ headRefOid: h2 });
    await until(async () => (await R.screen(lead.id)).includes('is reviewed at its head ' + h2.slice(0, 7)), 'the Lead to be told');
    assert.strictEqual((R.output().match(/PR watch: Told the Lead/g) || []).length, 1);
    await noReviewer('a head that a review read gets no other review');
  });
});

test('a PR that waits past the set time goes to the person', async (t) => {
  const o = await office(t, { RELAY_PR_WATCH_WAIT_MS: '3000' });
  const R = o.R;
  const h = o.commit(true);
  o.answer({ headRefOid: h, statusCheckRollup: RUNNING });
  await o.say(o.dev, 'PostToolUse', { pr_url: PR, cwd: o.wt });
  assert.strictEqual((await R.call('POST', '/settings', { values: { prWatch: true } })).status, 200);
  await until(async () => (await o.line()).owner === 'CI', 'the line to say it waits on CI');
  const line = await until(async () => { const l = await o.line(); return l.owner === 'you' && l; }, 'the wait to go to the person');
  assert.strictEqual(line.late, true);
  assert.match(line.words, /^waits on you for \d+ min: CI has owed the next move for \d+ min\. Its checks run on /);
  const posts = async () => ((await R.call('GET', '/chat/' + o.ticket.id)).body.posts || []).map((p) => p.text);
  await until(async () => (await posts()).some((x) => /^PR #7 \(T-\d+\) waits on you: CI has owed/.test(x)), 'the chat board to say so');
  await sleep(2500);
  assert.strictEqual((await posts()).filter((x) => /waits on you: CI has owed/.test(x)).length, 1, 'said once');
});

test('a task with no PR finds the open PR whose head is its branch, and no other. It asks no more once it has one, with the setting at 0, or with its folder gone', async (t) => {
  const o = await office(t, { RELAY_REVIEW_POLL_SECONDS: '1' });
  const R = o.R, branch = o.task.branch;
  const prOf = async () => (await R.call('GET', '/tasks/' + o.task.id)).body.task.pr;
  const OTHER = 'https://github.com/acme/widgets/pull/9', MINE = PR;
  const list = (lists) => fs.writeFileSync(path.join(o.ghDir, 'answers.json'), JSON.stringify({ lists }));
  list({ [branch]: [{ url: OTHER, headRefName: 'someone-elses', isCrossRepository: false }, { url: 'https://github.com/acme/widgets/pull/8', headRefName: branch, isCrossRepository: true }], other: [{ url: MINE, headRefName: 'other', isCrossRepository: false }] });
  await sleep(2500);
  assert.strictEqual(await prOf(), null, 'a PR on another branch, or from a fork, is not taken');
  list({ [branch]: [{ url: MINE, headRefName: branch, isCrossRepository: false }] });
  await until(async () => (await prOf()) === MINE, 'the task to find its PR by its branch');
  list({ [branch]: [{ url: OTHER, headRefName: branch, isCrossRepository: false }] });
  await sleep(2500);
  assert.strictEqual(await prOf(), MINE, 'a task that has a PR keeps it');
  const asks = () => (fs.readFileSync(path.join(o.ghDir, 'calls.log'), 'utf8').match(/^pr list /gm) || []).length;
  const before = asks();
  await sleep(2500);
  assert.strictEqual(asks(), before, 'a task with a PR is not looked up');
  const bare = (await R.call('POST', '/tickets', { title: 'Another', body: 'x', repo: o.repo })).body.ticket;
  const second = (await R.call('POST', '/tickets/' + bare.id + '/start', {})).body.task;
  assert.strictEqual((await R.call('POST', '/settings', { values: { reviewPollSeconds: 0 } })).status, 200);
  await sleep(6000);
  const quiet = asks();
  await sleep(2500);
  assert.strictEqual(asks(), quiet, 'with the setting at 0 nothing is looked up');
  assert.strictEqual((await R.call('POST', '/settings', { values: { reviewPollSeconds: 1 } })).status, 200);
  const resumed = asks();
  await until(async () => asks() > resumed, 'the second task to be looked up again');
  removeDir(o.repo);
  await sleep(1500);
  const gone = asks();
  await sleep(2500);
  assert.strictEqual(asks(), gone, 'a task whose repo folder is gone is not looked up in the relay\'s own folder');
  assert.strictEqual((await R.call('GET', '/tasks/' + second.id)).body.task.pr, null, 'the second task, with no PR on its branch, still has none');
});

test('a task with no PR is not looked up while the hourly GitHub budget is used up', async (t) => {
  const o = await office(t, { RELAY_REVIEW_POLL_SECONDS: '1' });
  const reset = Math.floor(Date.now() / 1000) + 3600, bucket = { limit: 5000, remaining: 10, reset };
  fs.writeFileSync(path.join(o.ghDir, 'answers.json'), JSON.stringify({ api: { rate_limit: { resources: { core: bucket, graphql: bucket } } } }));
  const asks = () => (fs.readFileSync(path.join(o.ghDir, 'calls.log'), 'utf8').match(/^pr list /gm) || []).length;
  await until(async () => /rate_limit/.test(fs.readFileSync(path.join(o.ghDir, 'calls.log'), 'utf8')), 'the relay to read its limit', 900);
  await sleep(1500);
  const paused = asks();
  await sleep(3000);
  assert.strictEqual(asks(), paused, 'nothing is looked up while paused');
});

test('a PR found by its branch gets its first review, with the PR watch off', async (t) => {
  const o = await office(t, { RELAY_REVIEW_POLL_SECONDS: '1' });
  const R = o.R, branch = o.task.branch;
  o.commit(true);
  fs.writeFileSync(path.join(o.ghDir, 'answers.json'), JSON.stringify({ lists: { [branch]: [{ url: PR, headRefName: branch, isCrossRepository: false }] } }));
  await until(async () => (await R.call('GET', '/tasks/' + o.task.id)).body.task.pr === PR, 'the task to find its PR by its branch');
  assert.strictEqual((await o.watch()).on, false);
  await until(async () => (await o.terminals()).find((x) => x.role === 'reviewer' && x.pr === PR), 'a reviewer for the PR found by its branch');
  assert.match(R.output(), /found by its branch: its first review\./);
});

test('a PR found by its branch that already has a review record gets no second review', async (t) => {
  const o = await office(t, { RELAY_REVIEW_POLL_SECONDS: '1' });
  const R = o.R, branch = o.task.branch;
  o.commit(true);
  const lists = (...tasks) => fs.writeFileSync(path.join(o.ghDir, 'answers.json'), JSON.stringify({ lists: Object.fromEntries(tasks.map((b) => [b, [{ url: PR, headRefName: b, isCrossRepository: false }]])) }));
  lists(branch);
  const r1 = await until(async () => (await o.terminals()).find((x) => x.role === 'reviewer' && x.pr === PR), 'the first review');
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r1.sessionId); } catch (e) { return null; } }, 'its token') };
  assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'fix' }, token)).status, 200);
  await o.say(r1, 'UserPromptSubmit');
  await o.say(r1, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-100' } });
  await o.say(r1, 'Stop');
  await until(async () => !(await o.terminals()).some((x) => x.id === r1.id), 'the reviewer to leave');
  assert.strictEqual((await R.call('GET', '/reviews')).body.prs.length, 1, 'the PR has a review record');
  const other = (await R.call('POST', '/tickets', { title: 'Another', body: 'x', repo: o.repo })).body.ticket;
  const second = (await R.call('POST', '/tickets/' + other.id + '/start', {})).body.task;
  lists(branch, second.branch);
  await until(async () => (await R.call('GET', '/tasks/' + second.id)).body.task.pr === PR, 'the second task to find the PR');
  await until(async () => /found by its branch already has a review record/.test(R.output()), 'the log to say the PR has a record');
  await sleep(2500);
  assert.ok(!(await o.terminals()).some((x) => x.role === 'reviewer' && x.pr === PR), 'no second review starts');
});

// A PR linked with no review record, as after a restart onto code that did not queue one: the switch is off while the hook links it.
async function linkedUnreviewed(o) {
  const R = o.R;
  assert.strictEqual((await R.call('POST', '/reviews', { auto: false })).status, 200);
  const h = o.commit(true);
  o.answer({ headRefOid: h });
  await o.say(o.dev, 'PostToolUse', { pr_url: PR, cwd: o.wt });
  await until(async () => (await R.call('GET', '/tasks/' + o.task.id)).body.task.pr === PR, 'the PR to be linked');
  assert.strictEqual((await R.call('GET', '/reviews')).body.prs.length, 0, 'no review record');
  assert.strictEqual((await R.call('POST', '/settings', { values: { prWatch: true } })).status, 200);
}
const reviewerOf = (o) => until(async () => (await o.terminals()).find((x) => x.role === 'reviewer' && x.pr === PR), 'a reviewer for the PR');

test('a linked PR with no review record gets its first review within one PR watch pass', async (t) => {
  const o = await office(t);
  await linkedUnreviewed(o);
  assert.strictEqual((await o.R.call('POST', '/reviews', { auto: true })).status, 200);
  await reviewerOf(o);
  assert.match(o.R.output(), /PR watch: PR #7 had no review of [0-9a-f]{7}: its first review\./);
});

test('a linked PR in Waiting on you with a protected file gets its first review', async (t) => {
  const o = await office(t);
  o.files = ['CLAUDE.md'];
  await linkedUnreviewed(o);
  const moved = await o.R.call('POST', '/tasks/' + o.task.id + '/move', { to: 'waiting_on_you' });
  assert.strictEqual(moved.status, 200);
  assert.strictEqual((await o.R.call('POST', '/reviews', { auto: true })).status, 200);
  await reviewerOf(o);
});

test('a linked PR with no review record and all desks full waits in the desk queue', async (t) => {
  const o = await office(t);
  await linkedUnreviewed(o);
  while ((await o.terminals()).length < 9) assert.ok((await o.R.call('POST', '/terminals', { cwd: o.repo })).status < 300);
  assert.strictEqual((await o.R.call('POST', '/reviews', { auto: true })).status, 200);
  await until(async () => ((await o.R.call('GET', '/reviews')).body.prs.find((p) => p.pr === PR) || {}).desk === true, 'the review to wait for a desk');
  assert.ok(!(await o.terminals()).some((x) => x.role === 'reviewer'), 'no reviewer yet');
});
