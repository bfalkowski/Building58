'use strict';
// Autopilot through a real relay, with a fake claude and a fake gh: it starts a Ready ticket, the
// first review says fix, the Dev pushes, the follow-up says merge, the relay merges, and the task is
// done. Nobody presses anything after turning it on.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep, sessionToken } = require('./helpers.js');
const { prBrief } = require('../../office/reviews.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/widgets/pull/7';
const GREEN = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
// The Dev's push: GitHub gets the commit as the PR's head, and the checkout has a remote branch that holds
// it, as a real push does, so nothing in it is unpushed (relay/merge-hold.js).
const pushPr = (wt, origin) => { sh(wt, 'push', '-qf', origin, 'HEAD:refs/pull/7/head'); sh(wt, 'update-ref', 'refs/remotes/origin/pr', 'HEAD'); };

test('Autopilot runs a ticket from Ready to merged', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' }, null, { autoReview: true });
  t.after(async () => { await R.stop(); fs.rmSync(ghDir, { recursive: true, force: true }); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const answer = (pr, files) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: pr }, api: { 'repos/acme/widgets/pulls/7/files': (files || ['a.txt']).map((f) => ({ filename: f })) } }));
  const merged = () => { try { return fs.readFileSync(path.join(ghDir, 'merged.log'), 'utf8'); } catch (e) { return ''; } };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  let n = 0, wt;
  // The Dev's commit on its branch, as GitHub has it once pushed: the PR's head.
  const devCommit = () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'change ' + (++n) + '\n');
    sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change ' + n);
    pushPr(wt, origin);
    return sh(wt, 'rev-parse', 'HEAD');
  };
  const seen = new Set();
  const reviewer = () => until(async () => (await terminals()).find((x) => x.role === 'reviewer' && x.pr === PR && !seen.has(x.id) && seen.add(x.id)), 'a reviewer');
  // A reviewer gives its verdict with its own token, then posts, then its turn ends.
  const review = async (r, kind) => {
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
    const v = await R.call('POST', '/autopilot/verdict', { kind }, token);
    assert.strictEqual(v.status, 200, JSON.stringify(v.body));
    await say(r, 'UserPromptSubmit');
    await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-' + (100 + seen.size) } });
    await say(r, 'Stop');
    await until(async () => !(await terminals()).some((x) => x.id === r.id), 'the reviewer to leave');
  };

  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', body: 'Change a.txt.', repo })).body.ticket;
  await R.call('POST', '/tickets', { title: 'Not this one', repo });

  await t.test('it is off until the person turns it on, and sessions cannot turn it on', async () => {
    const a = await ap();
    assert.strictEqual(a.on, false);
    assert.deepStrictEqual([a.atOnce, a.maxRounds, a.maxMerges], [1, 2, 10]);
    await sleep(800);
    assert.strictEqual((await R.call('GET', '/tasks')).body.tasks.length, 0, 'nothing starts while it is off');
  });

  await t.test('turning it off clears the ticket list, so a list from before does not come back', async () => {
    const on = await R.call('POST', '/autopilot', { on: true, only: 'T-999999' });
    assert.deepStrictEqual(on.body.only, ['T-999999']);
    const off = await R.call('POST', '/autopilot', { on: false });
    assert.strictEqual(off.body.only, null);
    assert.strictEqual((await ap()).only, null);
  });

  await t.test('on, it starts the next allowed Ready ticket, signed as Autopilot', async () => {
    const r = await R.call('POST', '/autopilot', { on: true, only: ticket.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.only, [ticket.id]);
    const x = await until(task, 'the task');
    assert.strictEqual(x.ticket, ticket.id);
    assert.strictEqual(x.by, 'Autopilot');
    wt = x.worktree;
    await sleep(1000);
    assert.strictEqual((await R.call('GET', '/tasks')).body.tasks.length, 1, 'one at a time, and only the allowed ticket');
    const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
    assert.strictEqual((await R.call('POST', '/autopilot', { on: false }, { 'X-Office-Token': sessionToken(dev.sessionId) })).status, 401);
  });

  let dev, h1;
  await t.test('the first review asks for a verdict, and fix sends it back to the Dev', async () => {
    const x = await task();
    dev = (await terminals()).find((y) => y.id === x.worker.terminal);
    h1 = devCommit();
    answer({ state: 'OPEN', headRefOid: h1, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN });
    await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
    const r1 = await reviewer();
    await until(async () => (await R.screen(r1.id)).includes('verdict merge'), 'the verdict ask in the brief').catch(async (e) => { console.log('SCREEN:', JSON.stringify(await R.screen(r1.id)), R.output().slice(-3000)); throw e; });
    const devToken = { 'X-Office-Token': sessionToken(dev.sessionId) };
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, devToken)).status, 401, 'a Dev cannot give its own PR a verdict');
    await review(r1, 'fix');
    await until(async () => (await ap()).prs.some((p) => p.verdict === 'fix' && p.rounds === 1), 'the fix verdict to count');
    await sleep(800);
    assert.strictEqual(merged(), '', 'no merge on a fix verdict');
  });

  await t.test('a push brings one follow-up that reviews only the new commits, and merge merges', async () => {
    await say(dev, 'UserPromptSubmit');
    const h2 = devCommit();
    answer({ state: 'OPEN', headRefOid: h2, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN });
    await say(dev, 'PostToolUse', { pushed: true });
    await say(dev, 'Stop');
    const r2 = await reviewer();
    await until(async () => (await R.screen(r2.id)).includes('review only what changed since'), 'the follow-up brief');
    assert.match(await R.screen(r2.id), new RegExp(h1.slice(0, 12)));
    await review(r2, 'merge');
    await until(() => merged().includes(PR + ' --merge --match-head-commit ' + h2), 'the merge, of the reviewed commit only');
    // GitHub can show the PR open for a while after it merged, even with a conflict as it settles. The looks
    // in that time overlap the merge: they must not merge it again, count it twice, or ask the Dev to merge main.
    await sleep(600);
    answer({ state: 'OPEN', headRefOid: h2, mergeStateStatus: 'DIRTY', statusCheckRollup: GREEN });
    await sleep(1200);
    assert.strictEqual(merged().split('\n').filter(Boolean).length, 1, 'merged once while GitHub still showed it open');
    const settling = await ap();
    assert.strictEqual(settling.mergedToday, 1, 'counted once while GitHub still showed it open');
    assert.ok(!settling.notes.some((x) => /conflicts with main/.test(x.text)), JSON.stringify(settling.notes));
    assert.deepStrictEqual(settling.prs.map((p) => [p.act, p.why]), [['wait', 'Merged, but GitHub still shows the PR open.']]);
    answer({ state: 'MERGED', headRefOid: h2, mergeStateStatus: 'UNKNOWN', statusCheckRollup: GREEN });
    await until(async () => (await task()).state === 'done', 'the task to be done');
    assert.strictEqual((await R.call('GET', '/tickets/' + ticket.id)).body.ticket.status, 'done');
    await until(async () => !(await terminals()).some((y) => y.id === dev.id), 'the Dev to be stopped');
    const a = await ap();
    assert.strictEqual(a.mergedToday, 1);
    assert.ok(a.notes.some((x) => /Merged PR #7/.test(x.text)), JSON.stringify(a.notes));
    await sleep(1000);
    assert.strictEqual((await R.call('GET', '/tasks')).body.tasks.filter((y) => y.state !== 'done').length, 0, 'the other ticket was not allowed, so nothing starts');
    assert.strictEqual(merged().split('\n').filter(Boolean).length, 1, 'merged once');
  });
});

// On 2026-11-05 the person pressed Get a review on three of Autopilot's PRs. Each found nothing blocking but
// gave no verdict, so Autopilot waited for a push that never came. Get a review asks for a verdict now.
test('Get a review asks for a verdict, and its merge verdict merges, while one with no verdict does not count', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' });  // no automatic reviews
  t.after(async () => { await R.stop(); fs.rmSync(ghDir, { recursive: true, force: true }); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const merged = () => { try { return fs.readFileSync(path.join(ghDir, 'merged.log'), 'utf8'); } catch (e) { return ''; } };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(async () => (await R.call('GET', '/tasks')).body.tasks[0], 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
  sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello');
  pushPr(wt, origin);
  const head = sh(wt, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }] } }));
  await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  // What the page's Get a review sends for a Dev with a PR (office/terminal.js, reviewPr).
  let posts = 0;
  const getAReview = async () => {
    const r = await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const post = async (r) => {
    await say(r, 'UserPromptSubmit');
    await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-' + (100 + ++posts) } });
    await say(r, 'Stop');
    await until(async () => !(await terminals()).some((y) => y.id === r.id), 'the reviewer to leave');
  };
  const token = async (r) => ({ 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') });

  await t.test('a Get a review with no verdict does not count', async () => {
    const r1 = await getAReview();
    await post(r1);
    await until(async () => (await ap()).notes.some((n) => /PR #7 was posted without a verdict, so it does not count/.test(n.text)), 'the note that it does not count');
    await sleep(1000);
    assert.strictEqual(merged(), '', 'no merge without a verdict');
  });

  await t.test('a Get a review asks for a verdict with the automatic review\'s words, and merge merges', async () => {
    const r2 = await getAReview();
    await until(async () => (await R.screen(r2.id)).includes('verdict merge if nothing blocks'), 'the verdict ask in the brief')
      .catch(async (e) => { console.log('SCREEN:', JSON.stringify(await R.screen(r2.id))); throw e; });
    assert.match(await R.screen(r2.id), /Mark each finding blocking or not/);
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, await token(r2))).status, 200);
    await post(r2);
    await until(() => merged().includes(PR + ' --merge --match-head-commit ' + head), 'the merge');
    const reviews = (await R.call('GET', '/reviews')).body.prs.find((p) => p.pr === PR);
    assert.strictEqual(reviews.count, 0, 'Get a review is not counted toward the automatic review limit');
  });
});

// T-186: June's fixes were still uncommitted when PR 141 merged, so they needed another PR. Before a merge,
// Autopilot waits while the Dev may still be answering the latest review, and hands work its PR does not
// hold to the person (relay/merge-hold.js).
test('a merge verdict waits while the Dev works, and work left unpushed goes to the person', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' });  // no automatic reviews
  t.after(async () => { await R.stop(); fs.rmSync(ghDir, { recursive: true, force: true }); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const merged = () => { try { return fs.readFileSync(path.join(ghDir, 'merged.log'), 'utf8'); } catch (e) { return ''; } };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(task, 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
  sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello');
  pushPr(wt, origin);
  const head = sh(wt, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }] } }));
  await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  const r = (await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) })).body;
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
  assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);

  await t.test('while the Dev is in a turn, a merge verdict on a green PR waits', async () => {
    await say(dev, 'UserPromptSubmit');  // the Dev starts on the review's findings
    await say(r, 'UserPromptSubmit');
    await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-101' } });
    await say(r, 'Stop');
    await until(async () => (await ap()).prs.some((p) => p.verdict === 'merge' && /^Its Dev is working, maybe still answering the latest review/.test(p.why || '')), 'the wait for the Dev');
    await sleep(1000);
    assert.strictEqual(merged(), '', 'no merge while the Dev may still push');
    assert.strictEqual((await task()).state !== 'waiting_on_you', true, 'a working Dev is waited for, not handed over');
  });

  await t.test('a Dev that stops with uncommitted fixes hands the task to the person, unmerged', async () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'hello, fixed\n');
    await say(dev, 'Stop');
    await until(async () => (await task()).state === 'waiting_on_you', 'the task to wait on the person');
    assert.ok((await task()).history.some((h) => /Its Dev stopped, but its checkout has uncommitted changes, so the PR does not hold all its work/.test(h.note || '')), 'the card says why');
    await sleep(1000);
    assert.strictEqual(merged(), '', 'the fixes were not on the PR, so it did not merge');
  });
});

// T-226: after a merge verdict the Dev does not push. If it thinks a finding marked non-blocking is a bug, its
// reply has <!-- office:hold -->, and the PR goes to the person. Autopilot reads the comments once more just
// before it merges, so a reply posted after the last poll still stops the merge.
test('a Dev reply with the hold mark sends a merge-verdict PR to the person, even between polls', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  // Comment checks on, but after the first one (5 seconds in) the next is an hour away.
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200', RELAY_REVIEW_POLL_SECONDS: '3600' });
  t.after(async () => { await R.stop(); fs.rmSync(ghDir, { recursive: true, force: true }); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const merged = () => { try { return fs.readFileSync(path.join(ghDir, 'merged.log'), 'utf8'); } catch (e) { return ''; } };
  const asked = () => { try { return fs.readFileSync(path.join(ghDir, 'calls.log'), 'utf8').split('\n').filter((c) => c.includes('repos/acme/widgets/issues/7/comments')).length; } catch (e) { return 0; } };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(task, 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
  sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello');
  pushPr(wt, origin);
  const head = sh(wt, 'rev-parse', 'HEAD');
  const answer = (comments) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }], 'repos/acme/widgets/issues/7/comments': comments } }));
  answer([]);
  await say(dev, 'UserPromptSubmit');  // the Dev is in a turn, so the merge waits for it
  await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  const r = (await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) })).body;
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
  assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);
  await say(r, 'UserPromptSubmit');
  await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-101' } });
  await say(r, 'Stop');
  await until(async () => (await ap()).prs.some((p) => p.verdict === 'merge' && /^Its Dev is working/.test(p.why || '')), 'the wait for the Dev');
  await until(() => asked() >= 1, 'the first comment check', 150);
  // The Dev's reply, after the last poll: a finding marked non-blocking is a bug. It pushes nothing, and stops.
  const n = asked();
  answer([{ id: 102, html_url: PR + '#issuecomment-102', body: '<!-- office:dev -->\n<!-- office:hold -->\nFinding 2 is a bug.', created_at: new Date().toISOString() }]);
  await say(dev, 'Stop');
  await until(async () => (await task()).state === 'waiting_on_you', 'the task to wait on the person');
  assert.ok(asked() > n, 'the comments were read again before the merge');
  assert.ok((await task()).history.some((h) => /Its Dev says a finding the review marked non-blocking is a bug: https:\/\/github\.com\/acme\/widgets\/pull\/7#issuecomment-102/.test(h.note || '')), 'the card says why');
  await sleep(1000);
  assert.strictEqual(merged(), '', 'no merge on the verdict the Dev disputed');
});

test('a PR that changes CLAUDE.md waits on the person, and is done once the person merges it', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300' });
  t.after(async () => { await R.stop(); fs.rmSync(ghDir, { recursive: true, force: true }); });
  const repo = makeRepo(R.home);
  const ticket = (await R.call('POST', '/tickets', { title: 'Change the rules', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: [ticket.id] });
  const x = await until(async () => (await R.call('GET', '/tasks')).body.tasks[0], 'the task');
  fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: 'a'.repeat(40), mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } },
    api: { 'repos/acme/widgets/pulls/7/files': Array.from({ length: 120 }, (x, i) => ({ filename: 'f' + i })).concat([{ filename: 'RULES.md', previous_filename: 'CLAUDE.md' }]) } }));
  const dev = (await R.call('GET', '/terminals')).body.terminals.find((y) => y.id === x.worker.terminal);
  await R.hook({ hook_event_name: 'PostToolUse', session_id: dev.sessionId.slice(0, 12), pr_url: PR, cwd: x.worktree });
  await until(async () => (await R.call('GET', '/tasks/' + x.id)).body.task.state === 'waiting_on_you', 'Waiting on you');
  const why = (await R.call('GET', '/tasks/' + x.id)).body.task.history.slice(-1)[0].note;
  assert.match(why, /CLAUDE\.md, which only a person merges/);
  await R.hook({ hook_event_name: 'Stop', session_id: dev.sessionId.slice(0, 12) });
  // The person merges it, as only they may: the next look marks it done and frees the Dev's desk.
  fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'MERGED', headRefOid: 'a'.repeat(40), mergeStateStatus: 'UNKNOWN', statusCheckRollup: GREEN } } }));
  await until(async () => (await R.call('GET', '/tasks/' + x.id)).body.task.state === 'done', 'the handed-over task to be done once its PR merged');
  await until(async () => !(await R.call('GET', '/terminals')).body.terminals.some((y) => y.id === dev.id), 'the Dev\'s desk to be free');
  assert.strictEqual(fs.readFileSync(path.join(ghDir, 'calls.log'), 'utf8').includes('pr merge'), false, 'Autopilot did not merge it');
});

test('two rounds that say fix hand the task to the person, and a later merge verdict does not merge it', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' }, null, { autoReview: true });
  t.after(async () => { await R.stop(); fs.rmSync(ghDir, { recursive: true, force: true }); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const answer = (head) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }] } }));
  const merged = () => { try { return fs.readFileSync(path.join(ghDir, 'merged.log'), 'utf8'); } catch (e) { return ''; } };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  let n = 0;
  const seen = new Set();
  const reviewer = () => until(async () => (await terminals()).find((x) => x.role === 'reviewer' && x.pr === PR && !seen.has(x.id) && seen.add(x.id)), 'a reviewer');
  const review = async (r, kind) => {
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind }, token)).status, 200);
    await say(r, 'UserPromptSubmit');
    await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-' + (100 + seen.size) } });
    await say(r, 'Stop');
    await until(async () => !(await terminals()).some((x) => x.id === r.id), 'the reviewer to leave');
  };
  const ticket = (await R.call('POST', '/tickets', { title: 'Hard one', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(task, 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  const push = async (first) => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'change ' + (++n) + '\n');
    sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change ' + n);
    pushPr(wt, origin);
    answer(sh(wt, 'rev-parse', 'HEAD'));
    if (first) { await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt }); return; }
    await say(dev, 'UserPromptSubmit'); await say(dev, 'PostToolUse', { pushed: true }); await say(dev, 'Stop');
  };
  await push(true);
  await review(await reviewer(), 'fix');
  await push(false);
  await review(await reviewer(), 'fix');
  await until(async () => (await task()).state === 'waiting_on_you', 'Waiting on you after 2 rounds');
  // The hand-off note, wherever it is: on node 18 CI once saw another entry land after it (PR 60).
  assert.ok((await task()).history.some((h) => /Review 2 still asks for fixes/.test(h.note || '')), 'the hand-off says why');
  await push(false);
  await review(await reviewer(), 'merge');  // the follow-up still runs, as with Review again after each push
  await sleep(1500);
  assert.strictEqual(merged(), '', 'a task with the person is theirs: no merge');
  assert.strictEqual((await task()).state, 'waiting_on_you');
  await R.call('POST', '/tasks/' + x.id + '/move', { to: 'in_review' });  // the person gives it back
  await until(() => merged().includes(PR + ' --merge'), 'the merge once the person gave it back');
});

// A merge review reaches the Dev before its reviewer's session has ended (the comment check runs every
// second here, and the reviewer stays 60 seconds after its turn), so its verdict is not yet marked posted.
// The card stays. Once with gh pr comment, which prints the comment's link, and once with gh pr review,
// which prints nothing, so only the time ties the review on GitHub to the verdict.
for (const how of ['comment', 'review']) {
  test('a merge review posted with gh pr ' + how + ' leaves the card, even before its reviewer has left', async (t) => {
    const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
    const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '60000', RELAY_REVIEW_POLL_SECONDS: '1' }, null, { autoReview: true });
    t.after(async () => { await R.stop(); fs.rmSync(ghDir, { recursive: true, force: true }); });
    const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
    sh(R.home, 'init', '-q', '--bare', origin);
    fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
    sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
    const api = { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }] };
    let head = null;
    const answer = () => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api }));
    const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
    const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
    const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
    const ticket = (await R.call('POST', '/tickets', { title: 'Easy one', repo })).body.ticket;
    await R.call('POST', '/autopilot', { on: true, only: ticket.id });
    const x = await until(task, 'the task'), wt = x.worktree;
    const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
    // Its brief is in once a turn begins after it (relay/delivery.js), and only then can the Dev be told more.
    await until(async () => /GOT\[Your task is to build/.test(await R.screen(dev.id)), 'the brief');
    await say(dev, 'UserPromptSubmit');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
    sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello');
    pushPr(wt, origin);
    head = sh(wt, 'rev-parse', 'HEAD'); answer();
    await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
    await say(dev, 'Stop');
    const r = await until(async () => (await terminals()).find((y) => y.role === 'reviewer' && y.pr === PR), 'a reviewer');
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);
    await say(r, 'UserPromptSubmit');
    const now = new Date().toISOString();
    if (how === 'comment') {
      await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-201' } });
      api['repos/acme/widgets/issues/7/comments'] = [{ id: 201, html_url: PR + '#issuecomment-201', body: 'No findings. Verdict: merge.', created_at: now }];
    } else {
      await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'review', url: null } });
      api['repos/acme/widgets/pulls/7/reviews'] = [{ id: 301, html_url: PR + '#pullrequestreview-301', body: 'No findings. Verdict: merge.', state: 'COMMENTED', submitted_at: now }];
    }
    answer();
    await say(r, 'Stop');
    await until(async () => (await task()).history.some((h) => h.type === 'review' && /^Told the Dev/.test(h.note || '')), 'the Dev to be told');
    assert.ok((await terminals()).some((y) => y.id === r.id), 'the reviewer has not left yet, so its verdict is not marked posted');
    const now2 = await task();
    assert.strictEqual(now2.state, 'building', 'a merge review blocks nothing: ' + JSON.stringify(now2.history.slice(-3)));
    assert.match(now2.history.filter((h) => h.type === 'review').slice(-1)[0].note, /verdict says merge/);
  });
}
