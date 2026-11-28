'use strict';
// Autopilot through a real relay, with a fake claude and a fake gh: it starts a Ready ticket, the
// first review says fix, the Dev pushes, the follow-up says merge, the relay merges, and the task is
// done. Nobody presses anything after turning it on.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, removeDir, until, sleep, sessionToken } = require('./helpers.js');
const { prBrief } = require('../../office/reviews.js');
const pushHold = require('../push-hold.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/widgets/pull/7';
const GREEN = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
// The Dev's push: GitHub gets the commit as the PR's head, and the checkout has a remote branch that holds
// it, as a real push does, so nothing in it is unpushed (relay/merge-hold.js).
const markOf = (wt) => { try { return JSON.parse(fs.readFileSync(path.join(pushHold.gitDirOf(wt), pushHold.MARK), 'utf8')); } catch (e) { return null; } };
const pushPr = (wt, origin) => { sh(wt, 'push', '-qf', origin, 'HEAD:refs/pull/7/head'); sh(wt, 'update-ref', 'refs/remotes/origin/pr', 'HEAD'); };

test('Autopilot runs a ticket from Ready to merged', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const env = { GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' };
  let R = await relay(env, null, { autoReview: true });
  const first = R;
  t.after(async () => { await R.stop(); await first.stop(); removeDir(ghDir); });
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

  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', body: 'Change a.txt, said only in the body.', repo, kind: 'feature' })).body.ticket;
  const run = async () => (await ap()).runs.recent.find((x) => x.ticket === ticket.id);
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
    await until(async () => (await ap()).idle === 'No ticket on the Board has an id or label you allowed.', 'the idle note names why (T-291)');
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
    const started = await until(run, 'its run record');
    assert.deepStrictEqual([started.task, started.kind, started.startedAt, started.outcome], [x.id, 'feature', x.createdAt, null]);
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
    const fixed = await until(async () => { const y = await run(); return y.verdicts.length && y; }, 'the fix verdict in the run record');
    assert.deepStrictEqual([fixed.prAt, fixed.pr], [(await task()).history.find((y) => y.type === 'pr').at, PR]);
    assert.deepStrictEqual(fixed.verdicts.map((y) => [y.kind, y.commit]), [['fix', h1.slice(0, 12)]]);
    assert.strictEqual(fixed.outcome, 'flawed', 'a review round said fix');
    await sleep(800);
    assert.strictEqual(merged(), '', 'no merge on a fix verdict');
    assert.strictEqual(markOf(wt), null, 'a fix verdict leaves the Dev free to push');
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
    assert.strictEqual(markOf(wt), null, 'the push hold goes once the task is Done');
    await sleep(1000);
    assert.strictEqual((await R.call('GET', '/tasks')).body.tasks.filter((y) => y.state !== 'done').length, 0, 'the other ticket was not allowed, so nothing starts');
    assert.strictEqual(merged().split('\n').filter(Boolean).length, 1, 'merged once');
  });

  let kept;
  await t.test('the run record has each step once, and the view counts the day', async () => {
    kept = await run();
    assert.deepStrictEqual(kept.verdicts.map((y) => y.kind), ['fix', 'merge'], 'each review once, in order');
    assert.strictEqual(kept.mergedBy, 'Autopilot');
    const history = (await task()).history, at = (type) => history.find((y) => y.type === type).at;
    assert.deepStrictEqual([kept.startedAt, kept.briefedAt, kept.prAt], [at('created'), at('briefed'), at('pr')], 'each step at its own time, from the task history');
    assert.ok(kept.prAt <= kept.mergedAt && kept.mergedAt <= at('merged'), JSON.stringify(kept));
    assert.deepStrictEqual([kept.handed, kept.blocked, kept.fixAfter, kept.outcome], [null, null, null, 'flawed']);
    const d = (await ap()).runs.today;
    assert.deepStrictEqual([d.runs, d.byOutcome, d.byKind], [1, { success: 0, flawed: 1, blocked: 0, manual: 0, open: 0 }, { feature: { success: 0, flawed: 1, blocked: 0, manual: 0, open: 0 } }]);
    assert.strictEqual(d.medianStartToMergeMinutes, Math.round((Date.parse(kept.mergedAt) - Date.parse(kept.startedAt)) / 60000));
    await sleep(1000);
    assert.deepStrictEqual(await run(), kept, 'later looks add nothing');
  });

  await t.test('a relay restart keeps the record, which holds no ticket words, prompt or key', async () => {
    await R.call('POST', '/autopilot', { on: false });
    await R.kill();
    R = await relay(env, first.home, { autoReview: true });
    assert.deepStrictEqual(await run(), kept);
    const file = fs.readFileSync(path.join(R.home, '.office-world', 'autopilot.json'), 'utf8');
    const record = JSON.stringify(JSON.parse(file).t.runs);
    assert.doesNotMatch(record, /said only in the body|test-key|Make a\.txt|Review|verdict merge/);
  });

  await t.test('a bug ticket filed after the merge that names the ticket marks a fix after the merge', async () => {
    await R.call('POST', '/tickets', { title: 'Unrelated bug', body: 'Not ' + ticket.id + '0.', repo, kind: 'bug' });
    assert.strictEqual((await run()).fixAfter, null, 'a ticket that does not name it');
    const fix = (await R.call('POST', '/tickets', { title: 'a.txt says hello twice', body: 'Since ' + ticket.id + ' merged, a.txt is wrong.', repo, kind: 'bug' })).body.ticket;
    assert.deepStrictEqual((await run()).fixAfter, { ticket: fix.id, at: fix.createdAt });
  });
});

test('a ticket filed before the merge and made a bug after it marks a fix after the merge at the time of the change', async (t) => {
  let R = await relay();
  const first = R;
  t.after(async () => { await R.stop(); await first.stop(); });
  const repo = makeRepo(R.home);
  const early = (await R.call('POST', '/tickets', { title: 'a.txt looks odd', body: 'Since T-12, a.txt looks odd.', repo })).body.ticket;
  assert.strictEqual(early.kind || null, null);
  await R.kill();
  const mergedAt = new Date().toISOString();
  assert.ok(early.createdAt < mergedAt, 'the ticket is filed before the merge');
  const kept = { task: 'a1b2c3', ticket: 'T-12', kind: 'feature', pr: PR, startedAt: early.createdAt, briefedAt: null, prAt: null, verdicts: [], mergedAt, mergedBy: 'Autopilot', handed: null, blocked: null, fixAfter: null };
  fs.writeFileSync(path.join(R.home, '.office-world', 'autopilot.json'), JSON.stringify({ t: { on: false, only: null, day: null, merged: 0, prs: {}, notes: [], runs: { a1b2c3: kept } } }));
  R = await relay(null, first.home);
  const run = async () => (await R.call('GET', '/autopilot')).body.runs.recent.find((x) => x.task === 'a1b2c3');
  assert.deepStrictEqual([(await run()).fixAfter, (await run()).outcome], [null, 'success']);
  const before = new Date().toISOString();
  assert.strictEqual((await R.call('POST', '/tickets/' + early.id + '/edit', { kind: 'bug' })).status, 200);
  const after = new Date().toISOString();
  const marked = await run();
  assert.strictEqual(marked.fixAfter.ticket, early.id);
  assert.ok(before <= marked.fixAfter.at && marked.fixAfter.at <= after, 'the time of the change, not the time the ticket was filed: ' + JSON.stringify(marked.fixAfter));
  assert.strictEqual(marked.outcome, 'flawed');
});

// On 2026-11-05 the person pressed Get a review on three of Autopilot's PRs. Each found nothing blocking but
// gave no verdict, so Autopilot waited for a push that never came. Get a review asks for a verdict now.
test('Get a review asks for a verdict, and its merge verdict merges, while one with no verdict does not count', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' });  // no automatic reviews
  t.after(async () => { await R.stop(); removeDir(ghDir); });
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
    await until(async () => (await ap()).notes.some((n) => /PR #7 came back empty/.test(n.text)), 'the note that it does not count');
    await sleep(1000);
    assert.strictEqual(merged(), '', 'no merge without a verdict');
  });

  await t.test('a Get a review asks for a verdict with the automatic review\'s words, and merge merges', async () => {
    const r2 = await getAReview();
    await until(async () => (await R.screen(r2.id)).includes('verdict merge only if no finding is blocking or fix now'), 'the verdict ask in the brief')
      .catch(async (e) => { console.log('SCREEN:', JSON.stringify(await R.screen(r2.id))); throw e; });
    const ask = (await R.screen(r2.id)).replace(/\s+/g, ' ');
    assert.match(ask, /Mark each finding blocking, fix now or follow-up\./);
    assert.match(ask, /Fix now: small and safe to fix in this PR, such as a wording fix, a missing test case, a named const or a doc line\./);
    assert.match(ask, /or verdict fix if one is, so the Dev fixes it in this PR\./);
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, await token(r2))).status, 200);
    await post(r2);
    await until(() => merged().includes(PR + ' --merge --match-head-commit ' + head), 'the merge');
    const reviews = (await R.call('GET', '/reviews')).body.prs.find((p) => p.pr === PR);
    assert.strictEqual(reviews.count, 0, 'Get a review is not counted toward the automatic review limit, and nor is the new review after one with no verdict');
  });

  await t.test('a review whose comment says only a dash gives a merge verdict that does not count, and no merge follows', async () => {
    const answers = JSON.parse(fs.readFileSync(path.join(ghDir, 'answers.json'), 'utf8'));
    answers.api['repos/acme/widgets/issues/comments/101'] = { body: '-' };
    fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify(answers));
    const before = merged();
    const r0 = await getAReview();
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, await token(r0))).status, 200);
    await post(r0);
    await until(async () => (await ap()).notes.some((n) => /PR #7 came back empty/.test(n.text)), 'the note that the review came back empty');
    await sleep(1000);
    assert.strictEqual(merged(), before, 'a dash is not a merge verdict');
  });

  await t.test('the brief and the ask do not count toward the prompt limit, which is only for what the page sends', async () => {
    const r = await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: 'x'.repeat(8000) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual((await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: 'x'.repeat(8001) })).status, 400);
  });
});

// T-186: June's fixes were still uncommitted when PR 141 merged, so they needed another PR. Before a merge,
// Autopilot waits while the Dev may still be answering the latest review, and hands work its PR does not
// hold to the person (relay/merge-hold.js).
test('a merge verdict waits while the Dev works, and work left unpushed goes to the person', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' });  // no automatic reviews
  t.after(async () => { await R.stop(); removeDir(ghDir); });
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
    assert.deepStrictEqual(await until(() => markOf(wt), 'the push hold on the Dev\'s checkout'), { pr: PR, commit: head, base: 'main' });
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

test('Autopilot reads the PR again just before it merges, so a check that went red on the same head stops the merge', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_GH_FRESH_MS: '600000', RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const log = (name) => { try { return fs.readFileSync(path.join(ghDir, name), 'utf8'); } catch (e) { return ''; } };
  const views = () => log('calls.log').split('\n').filter((l) => l.startsWith('pr view ' + PR)).length;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(task, 'the task'), wt = x.worktree;
  const dev = (await R.call('GET', '/terminals')).body.terminals.find((y) => y.id === x.worker.terminal);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
  sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello');
  pushPr(wt, origin);
  const head = sh(wt, 'rev-parse', 'HEAD');
  const answer = (rollup) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: rollup } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }] } }));
  answer(GREEN);
  await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  await say(dev, 'UserPromptSubmit');
  const r = (await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) })).body;
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
  assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);
  await say(r, 'UserPromptSubmit');
  await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-101' } });
  await say(r, 'Stop');
  await until(async () => (await ap()).prs.some((p) => p.verdict === 'merge' && /^Its Dev is working/.test(p.why || '')), 'Autopilot to read the green PR and wait for the Dev');
  const before = views();
  answer([{ name: 'pipeline', status: 'COMPLETED', conclusion: 'FAILURE' }]);
  await say(dev, 'Stop');
  await until(() => views() > before, 'the read just before the merge, past the kept answer');
  await sleep(1500);
  assert.strictEqual(log('merged.log'), '', 'the kept answer said green, the fresh one said red, and nothing merged');
});

for (const [name, after, merged] of [['a stored meets_policy lets level 6 merge', 'meets_policy', true], ['a stored verdict that turns needs_person before the re-read stops the merge and hands the PR over', 'needs_person', false]]) {
  test('level 6: ' + name, async (t) => {
    const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
    const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200', RELAY_REVIEW_POLL_SECONDS: '0' });
    t.after(async () => { await R.stop(); removeDir(ghDir); });
    const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
    sh(R.home, 'init', '-q', '--bare', origin);
    fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
    sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
    const log = (n) => { try { return fs.readFileSync(path.join(ghDir, n), 'utf8'); } catch (e) { return ''; } };
    const gate = path.join(ghDir, 'gate');
    const reads = () => log('calls.log').split('\n').filter((l) => l.includes('contents/prs/7/')).length;
    const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
    const ap = async () => (await R.call('GET', '/autopilot')).body;
    const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
    assert.strictEqual((await R.call('POST', '/settings', { values: { autopilotExhibit: true } })).body.ok, true);
    const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
    await R.call('POST', '/autopilot', { on: true, only: ticket.id });
    const x = await until(task, 'the task'), wt = x.worktree;
    const dev = (await R.call('GET', '/terminals')).body.terminals.find((y) => y.id === x.worker.terminal);
    fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
    sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello');
    pushPr(wt, origin);
    const head = sh(wt, 'rev-parse', 'HEAD');
    const STORED = 'repos/acme/widgets/contents/prs/7/' + head + '.json';
    const summary = (verdict) => ({ pr: 7, head, repo: 'acme/widgets', verdict });
    const answer = (verdict, gated) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } },
      api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }], [STORED]: summary(verdict) }, gateApi: gated ? { [STORED]: gate } : {} }));
    answer('meets_policy', false);
    await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
    await say(dev, 'UserPromptSubmit');
    const r = (await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) })).body;
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);
    await say(r, 'UserPromptSubmit');
    await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-101' } });
    await say(r, 'Stop');
    await until(async () => (await ap()).prs.some((p) => p.verdict === 'merge' && /^Its Dev is working/.test(p.why || '')), 'Autopilot to wait for the Dev');
    assert.strictEqual(reads(), 0, 'while the plan still waits, it does not read the stored exhibit');
    const before = reads();
    if (!merged) answer('meets_policy', true);
    await say(dev, 'Stop');
    if (!merged) {
      await until(() => reads() > before, 'the first read of the stored exhibit, held at the gate');
      answer(after, false);
      fs.writeFileSync(gate, '');
    }
    if (merged) await until(() => log('merged.log'), 'the merge');
    else {
      await until(async () => (await ap()).prs.some((p) => /Exhibit says needs_person/.test(p.why || '')), 'the hand-over for Exhibit');
      await sleep(1000);
      assert.strictEqual(log('merged.log'), '', 'the re-read saw needs_person, so nothing merged');
    }
  });
}

// T-226: after a merge verdict the Dev does not push. If it thinks a finding marked non-blocking is a bug, its
// reply has <!-- office:hold -->, and the PR goes to the person. Autopilot reads the comments once more just
// before it merges, so a reply posted after the last poll still stops the merge.
test('a Dev reply with the hold mark sends a merge-verdict PR to the person, even between polls', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  // Comment checks start off. The test turns them on once the task has its PR, so the one check that comes
  // 5 seconds later sees the PR however slow the start was, and the next is an hour away.
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200', RELAY_REVIEW_POLL_SECONDS: '0' });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
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
  assert.strictEqual(asked(), 0, 'no comment check while they are off');
  assert.strictEqual((await R.call('POST', '/settings', { values: { reviewPollSeconds: 3600 } })).status, 200);
  await until(async () => ((await task()).reviews || {}).checkedAt, 'the first comment check to end');
  assert.strictEqual(asked(), 1, 'one comment check read the comments');
  // The Dev's reply, after the last poll: a finding marked non-blocking is a bug. It pushes nothing, and stops.
  const n = asked();
  answer([{ id: 102, html_url: PR + '#issuecomment-102', body: '<!-- office:dev -->\n<!-- office:hold -->\nFinding 2 is a bug.', created_at: new Date().toISOString() }]);
  await say(dev, 'Stop');
  await until(async () => (await task()).state === 'waiting_on_you', 'the task to wait on the person');
  assert.ok(asked() > n, 'the comments were read again before the merge');
  assert.ok((await task()).history.some((h) => /Its Dev says a finding the review marked non-blocking is a bug: https:\/\/github\.com\/acme\/widgets\/pull\/7#issuecomment-102/.test(h.note || '')), 'the card says why');
  await sleep(1000);
  assert.strictEqual(merged(), '', 'no merge on the verdict the Dev disputed');
  const decisions = async () => (await R.call('GET', '/needs-you')).body.items.filter((i) => i.kind === 'handed-over').map((i) => i.line);
  assert.deepStrictEqual(await decisions(), ['Decide on PR #7 (' + ticket.id + '): Its Dev says a finding the review marked non-blocking is a bug: ' + PR + '#issuecomment-102']);
  // The person turns Autopilot off and gives the task back: no tick clears the hand-over now, and it is answered all the same.
  await R.call('POST', '/autopilot', { on: false });
  await R.call('POST', '/tasks/' + x.id + '/move', { to: 'in_review' });
  assert.deepStrictEqual(await decisions(), []);
  // T-234: the hold works once. Given back, the task merges on the same merge verdict, since it still covers the head.
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  await until(() => merged().includes(PR + ' --merge --match-head-commit ' + head), 'the merge on the verdict the Dev disputed');
});

// T-303: on PR 45 the Dev held the PR, the person answered, the Dev pushed the fix, and a review of the new
// commit said merge. The hand-over was never cleared, so Autopilot kept the PR for hours. A merge review of a
// newer commit than the hand-over answers it. One of the same commit does not.
test('a merge review of a newer commit clears a Dev\'s hand-over and merges, and one of the same commit does not', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200', RELAY_REVIEW_POLL_SECONDS: '0' });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const merged = () => { try { return fs.readFileSync(path.join(ghDir, 'merged.log'), 'utf8'); } catch (e) { return ''; } };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  const decisions = async () => (await R.call('GET', '/needs-you')).body.items.filter((i) => i.kind === 'handed-over').map((i) => i.line);
  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(task, 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  let head = null, comments = [], n = 0;
  const answer = () => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }], 'repos/acme/widgets/issues/7/comments': comments } }));
  const commit = () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'hello ' + (++n) + '\n');
    sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello ' + n);
    pushPr(wt, origin);
    head = sh(wt, 'rev-parse', 'HEAD'); answer();
  };
  const review = async (id) => {
    const got = await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) }), r = got.body;
    assert.strictEqual(got.status, 201, JSON.stringify(r));
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);
    await say(r, 'UserPromptSubmit');
    await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-' + id } });
    await say(r, 'Stop');
    await until(async () => !(await terminals()).some((y) => y.id === r.id), 'the reviewer to leave');
    // Its checkout is removed after that, and a fetch for the next review while git removes it can fail.
    await until(async () => !(await R.call('GET', '/checkouts')).body.checkouts.some((c) => c.id === r.checkout.id), 'its checkout to go');
  };
  commit();
  await say(dev, 'UserPromptSubmit');  // the Dev is in a turn, so the first merge verdict waits for it
  await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  await review(101);
  const held = PR + '#issuecomment-102';
  comments = [{ id: 102, html_url: held, body: '<!-- office:dev -->\n<!-- office:hold -->\nFinding 2 is a bug.', created_at: new Date().toISOString() }];
  answer();
  assert.strictEqual((await R.call('POST', '/settings', { values: { reviewPollSeconds: 3600 } })).status, 200);
  await say(dev, 'Stop');
  await until(async () => (await task()).state === 'waiting_on_you', 'the hand-over');
  const why = 'Decide on PR #7 (' + ticket.id + '): Its Dev says a finding the review marked non-blocking is a bug: ' + held;

  // A second review of the same commit says merge: the hand-over is on the current head, so it stays.
  await review(103);
  await sleep(1500);
  assert.strictEqual(merged(), '', 'no merge on the commit the Dev disputed');
  assert.deepStrictEqual(await decisions(), [why], 'Needs you still lists the hand-over');

  // main moves, and the Dev merges it, the one push the push hold allows. A merge review of that merge is of a
  // newer commit, but nothing in it answers the finding, so the hand-over stays.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'main moved\n');
  sh(repo, 'add', 'b.txt');
  sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'main moved');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/main');
  sh(wt, 'fetch', '-q', origin, 'main');
  sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', '-m', 'Merge main', 'FETCH_HEAD');
  pushPr(wt, origin);
  head = sh(wt, 'rev-parse', 'HEAD'); answer();
  await review(105);
  await sleep(1500);
  assert.strictEqual(merged(), '', 'no merge on a merge of main');
  assert.ok(!(await R.call('GET', '/autopilot')).body.notes.some((note) => /is back from Waiting on you/.test(note.text)), 'Autopilot did not take it back');
  assert.deepStrictEqual(await decisions(), [why], 'Needs you still lists the hand-over after a merge of main');

  // The person answers on the PR, the Dev pushes the fix, and a review of the new commit says merge.
  await say(dev, 'UserPromptSubmit');
  commit();
  await say(dev, 'PostToolUse', { pushed: true });
  await say(dev, 'Stop');
  await review(104);
  comments = comments.concat([{ id: 104, html_url: PR + '#issuecomment-104', body: 'No findings. Verdict: merge.', created_at: new Date().toISOString() }]);
  answer();
  assert.strictEqual((await R.call('POST', '/settings', { values: { reviewPollSeconds: 1 } })).status, 200);
  await until(() => merged().includes(PR + ' --merge --match-head-commit ' + head), 'the merge of the new commit');
  assert.ok((await R.call('GET', '/autopilot')).body.notes.some((note) => /is back from Waiting on you: a review of \w{7}, a newer commit than the hand-over, says merge/.test(note.text)), 'a note says why the hand-over ended');
  assert.deepStrictEqual(await decisions(), [], 'Needs you no longer lists it');
});

// T-385: on PR 121 the Dev said a finding the merge review marked non-blocking is a bug, and the person agreed.
// The push hold still refused the fix, since only a review posts a verdict. Fix it, on Needs you, is the person's
// fix verdict on the reviewed commit: it lifts the hold, and a later review's verdict counts as usual. The Lead
// may give it only while its merge rung is on.
test('the person\'s Fix it lifts the push hold, a later review counts, and the Lead needs its merge rung', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200', RELAY_REVIEW_POLL_SECONDS: '0' });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  sh(repo, 'config', 'core.hooksPath', path.resolve(__dirname, '..', '..', '.githooks'));
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  const tokenOf = (s) => until(() => { try { return { 'X-Office-Token': sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'its token');
  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(task, 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  let head = null, comments = [], n = 0;
  const answer = () => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }], 'repos/acme/widgets/issues/7/comments': comments } }));
  const commit = () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'hello ' + (++n) + '\n');
    sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello ' + n);
    return sh(wt, 'rev-parse', 'HEAD');
  };
  // A plain git push, so the pre-push hook runs, as it does in a Dev's checkout.
  const push = () => {
    const r = require('child_process').spawnSync('git', ['push', origin, 'HEAD:refs/pull/7/head'], { cwd: wt, encoding: 'utf8' });
    if (r.status === 0) { sh(wt, 'update-ref', 'refs/remotes/origin/pr', 'HEAD'); head = sh(wt, 'rev-parse', 'HEAD'); answer(); }
    return { ok: r.status === 0, out: r.stdout + r.stderr };
  };
  const review = async (id) => {
    const got = await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) }), r = got.body;
    assert.strictEqual(got.status, 201, JSON.stringify(r));
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, await tokenOf(r))).status, 200);
    await say(r, 'UserPromptSubmit');
    await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-' + id } });
    await say(r, 'Stop');
    await until(async () => !(await terminals()).some((y) => y.id === r.id), 'the reviewer to leave');
    await until(async () => !(await R.call('GET', '/checkouts')).body.checkouts.some((c) => c.id === r.checkout.id), 'its checkout to go');
  };
  const reviewed = commit();
  assert.ok(push().ok, 'no mark yet, so the first push goes through');
  await say(dev, 'UserPromptSubmit');
  await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  await review(101);
  assert.deepStrictEqual(await until(() => markOf(wt), 'the push hold'), { pr: PR, commit: reviewed, base: 'main' });
  const held = PR + '#issuecomment-102';
  comments = [{ id: 102, html_url: held, body: '<!-- office:dev -->\n<!-- office:hold -->\nFinding 2 is a bug.', created_at: new Date().toISOString() }];
  answer();
  assert.strictEqual((await R.call('POST', '/settings', { values: { reviewPollSeconds: 3600 } })).status, 200);
  await say(dev, 'Stop');
  await until(async () => (await task()).state === 'waiting_on_you', 'the hand-over');
  commit();
  const refused = push();
  assert.strictEqual(refused.ok, false, 'the fix is refused while the merge verdict stands: ' + refused.out);
  assert.match(refused.out, /Push refused: The review of \w{7} says merge/);

  await t.test('Needs you offers Fix it on the line that says the Dev thinks the finding is a bug', async () => {
    const item = (await R.call('GET', '/needs-you')).body.items.find((i) => i.kind === 'handed-over');
    assert.ok(item, 'the hand-over line');
    assert.strictEqual(item.link.fix, x.id);
    assert.strictEqual(item.link.url, PR, 'it still opens the PR');
  });

  const lead = await R.start({ cwd: fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-fix-lead-'))) });
  await say(lead, 'UserPromptSubmit');
  await say(lead, 'Stop');
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
  await t.test('the Lead without its merge rung, and any other session, cannot decide it', async () => {
    const off = await R.call('POST', '/autopilot/fix', { task: x.id }, await tokenOf(lead));
    assert.strictEqual(off.status, 403, JSON.stringify(off.body));
    assert.match(off.body.message, /Let the Lead merge/);
    const other = await R.call('POST', '/autopilot/fix', { task: x.id }, await tokenOf(dev));
    assert.strictEqual(other.status, 401, JSON.stringify(other.body));
    assert.ok(markOf(wt), 'the push hold stays');
  });

  await t.test('the person\'s Fix it lifts the push hold, and the fix then pushes', async () => {
    assert.strictEqual((await R.call('POST', '/reviews', { auto: true })).status, 200);
    const r = await R.call('POST', '/autopilot/fix', { task: x.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.commit, reviewed);
    assert.match(r.body.message, /A follow-up review checks the fix\./);
    assert.strictEqual(markOf(wt), null, 'the mark is gone');
    const now = await task();
    assert.strictEqual(now.state, 'changes_requested', 'the task goes back to its Dev');
    assert.ok(now.history.some((h) => h.type === 'moved' && h.by === 'you' && /You decided a finding on PR #7 must be fixed/.test(h.note || '')), 'the card says who decided');
    assert.ok(!(await R.call('GET', '/needs-you')).body.items.some((i) => i.kind === 'handed-over'), 'Needs you no longer lists the hand-over');
    const again = await R.call('POST', '/autopilot/fix', { task: x.id });
    assert.strictEqual(again.status, 409, 'a second press has no merge verdict to answer');
    const pushed = push();
    assert.strictEqual(pushed.ok, true, pushed.out);
    await R.call('POST', '/autopilot', { on: false });  // so it does not merge on the next review before the Lead acts
  });

  await t.test('a later review\'s merge verdict holds pushes again, and the Lead with its merge rung can lift it', async () => {
    await review(103);
    assert.deepStrictEqual(await until(() => { const m = markOf(wt); return m && m.commit === head && m; }, 'the push hold on the new commit'), { pr: PR, commit: head, base: 'main' });
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, merge: true })).status, 200);
    assert.strictEqual((await R.call('POST', '/reviews', { auto: false })).status, 200);
    const r = await R.call('POST', '/autopilot/fix', { task: ticket.id }, await tokenOf(lead));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.message, /No follow-up review will start, since Review PRs automatically is off\. Start one with Get a review\./);
    assert.strictEqual(markOf(wt), null);
    assert.ok((await task()).history.some((h) => /^The Lead decided a finding on PR #7 must be fixed/.test(h.note || '')), 'the card says the Lead decided');
  });
});

test('a PR that changes CLAUDE.md waits on the person, and is done once the person merges it', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300' });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
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
  const run = (await R.call('GET', '/autopilot')).body.runs.recent.find((y) => y.task === x.id);
  assert.deepStrictEqual([run.handed && run.handed.reason, run.mergedBy, run.outcome], ['protected-file', 'person', 'manual'], 'handed to the person by rule');
});

// T-214: PR 141 waited 8 hours for a merge it was ready for, and nothing said so. A PR handed over only because it
// changes a file only a person merges now says where it is: waiting for a review, fix, or ready for your merge.
test('a PR only a person merges follows its review, CI and GitHub, and says once when it is ready', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' }, null, { autoReview: true });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const answer = (head, extra) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: Object.assign({ state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN }, extra) },
    api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }, { filename: 'CLAUDE.md' }] } }));
  const calls = () => { try { return fs.readFileSync(path.join(ghDir, 'calls.log'), 'utf8'); } catch (e) { return ''; } };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  const ap = async () => (await R.call('GET', '/autopilot')).body;
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
  // The reason, as the Autopilot view and the task's history both show it.
  const reason = async (text) => {
    await until(async () => { const p = (await ap()).prs[0]; return p && p.why === text && p; }, 'the reason: ' + text).catch(async (e) => { console.log('VIEW:', JSON.stringify((await ap()).prs)); throw e; });
    assert.ok((await task()).history.some((h) => (h.note || '').endsWith(text)), 'the task history says: ' + text);
    assert.strictEqual((await task()).state, 'waiting_on_you');
    return (await ap()).prs[0];
  };
  const only = 'It changes CLAUDE.md, which only a person merges. ';
  const ticket = (await R.call('POST', '/tickets', { title: 'Change the rules', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(task, 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  let n = 0;
  const push = async (first) => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'change ' + (++n) + '\n');
    sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change ' + n);
    pushPr(wt, origin);
    const head = sh(wt, 'rev-parse', 'HEAD');
    answer(head);
    if (first) await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
    else { await say(dev, 'UserPromptSubmit'); await say(dev, 'PostToolUse', { pushed: true }); await say(dev, 'Stop'); }
    return head;
  };

  const h1 = await push(true);
  await say(dev, 'Stop');
  assert.strictEqual((await reason(only + 'Waiting for its review.')).ready, null);
  await review(await reviewer(), 'fix');
  await reason(only + 'The review of ' + h1.slice(0, 7) + ' says fix, so its Dev fixes it first.');

  const h2 = await push(false);
  await reason(only + 'Waiting for a review of the new commits.');
  answer(h2, { statusCheckRollup: [{ name: 'pipeline', status: 'IN_PROGRESS', conclusion: '' }] });
  await review(await reviewer(), 'merge');
  await reason(only + 'Waiting for CI.');
  answer(h2);
  const ready = 'Ready for your merge: the review of ' + h2.slice(0, 7) + ' says merge, CI is green, and GitHub can merge it.';
  assert.strictEqual((await reason(ready)).ready, h2);
  assert.strictEqual((await R.call('GET', '/needs-you')).body.items.find((i) => i.kind === 'handed-over').line, 'Decide on PR #7 (' + ticket.id + '): ' + ready);

  // GitHub flips back and forth: the reason follows, and the ready note is said once for this head.
  answer(h2, { mergeStateStatus: 'BLOCKED' });
  await reason(only + 'GitHub says the PR is blocked.');
  answer(h2);
  await reason(ready);
  await sleep(1000);
  const told = (await ap()).notes.filter((note) => note.text.includes('Ready for your merge'));
  assert.deepStrictEqual(told.map((note) => note.text), [ticket.id + ', PR #7: ' + ready], 'said once for this head');
  assert.ok(!calls().includes('pr merge'), 'Autopilot never merges it');

  // A new push takes it back to waiting for a review.
  const h3 = await push(false);
  assert.strictEqual((await reason(only + 'Waiting for a review of the new commits.')).ready, null);
  await review(await reviewer(), 'merge');
  await reason('Ready for your merge: the review of ' + h3.slice(0, 7) + ' says merge, CI is green, and GitHub can merge it.');
  assert.strictEqual((await ap()).notes.filter((note) => note.text.includes('Ready for your merge')).length, 2, 'said again for the new head');
  await sleep(1000);
  assert.ok(!calls().includes('pr merge'), 'Autopilot never merges it');
});

test('two rounds that say fix hand the task to the person, and a later merge verdict does not merge it', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' }, null, { autoReview: true });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
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
    t.after(async () => { await R.stop(); removeDir(ghDir); });
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

// The person can limit Autopilot to ticket ids, labels, or both. Ids come out as T-12 and labels in lowercase.
test('Autopilot\'s list takes ticket ids and labels', async (t) => {
  const R = await relay({ RELAY_AUTOPILOT_TICK_MS: '60000' }); t.after(R.stop);
  const on = await R.call('POST', '/autopilot', { on: true, only: 't-3, Flaky ci, T-3' });
  assert.strictEqual(on.status, 200, JSON.stringify(on.body));
  assert.deepStrictEqual(on.body.only, ['T-3', 'flaky', 'ci']);
  assert.strictEqual((await R.call('POST', '/autopilot', { only: 'flaky!' })).status, 400, 'not a label');
  assert.strictEqual((await R.call('POST', '/autopilot', { on: false })).body.only, null, 'off clears it');
});

// T-347: PR #113 had a fix verdict while its Dev was stopped, and Autopilot said the Dev was fixing,
// so nothing moved until a person pressed Bring back.
test('a fix verdict whose Dev is not running brings the Dev back to fix it', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' }, null, { autoReview: true });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const ticket = (await R.call('POST', '/tickets', { title: 'Fix after a stop', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(task, 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  await until(async () => /GOT\[Your task is to build/.test(await R.screen(dev.id)), 'the brief');
  await say(dev, 'UserPromptSubmit');
  await until(async () => (await task()).history.some((h) => h.type === 'briefed'), 'the brief to land');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'change\n');
  sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change');
  pushPr(wt, origin);
  fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: sh(wt, 'rev-parse', 'HEAD'), mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }] } }));
  await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  await say(dev, 'Stop');
  const r = await until(async () => (await terminals()).find((y) => y.role === 'reviewer' && y.pr === PR), 'a reviewer');
  await R.call('POST', '/terminals/' + dev.id + '/stop', {});
  await until(async () => !(await terminals()).some((y) => y.id === dev.id), 'the Dev to stop');
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
  assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'fix' }, token)).status, 200);
  await say(r, 'UserPromptSubmit');
  await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-101' } });
  await say(r, 'Stop');
  const back = await until(async () => { const y = await task(); return y.worker && y.worker.terminal !== dev.id && y; }, 'the Dev brought back');
  assert.ok(back.history.some((h) => h.type === 'resumed' && h.by === 'Autopilot'), 'Autopilot brought it back: ' + JSON.stringify(back.history));
  await until(async () => (await R.screen(back.worker.terminal)).includes('--resume'), 'the same conversation');
  const a = await ap();
  assert.ok(a.notes.some((n) => /its Dev was not running, so Autopilot brought it back for the fixes the last review asks for/.test(n.text)), JSON.stringify(a.notes));
  assert.notStrictEqual((await task()).state, 'waiting_on_you', 'nothing went to the person');
});

// T-353: on 2026-11-19 PR #29 got a merge verdict, but GitHub said it conflicts with main. Autopilot asked
// its Dev once to merge main, the Dev's turn ended without it, and only the stall timer, 30 minutes on,
// would have caught it. Now a turn that ends at the same head brings one more ask at once, and a second
// such turn sends the task to the person.
test('a Dev whose turn ends without merging main is asked once more, then the person decides', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' }, null, { autoReview: true });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const ticket = (await R.call('POST', '/tickets', { title: 'Merge main when asked', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(task, 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  await until(async () => /GOT\[Your task is to build/.test(await R.screen(dev.id)), 'the brief');
  await say(dev, 'UserPromptSubmit');
  await until(async () => (await task()).history.some((h) => h.type === 'briefed'), 'the brief to land');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'change\n');
  sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change');
  pushPr(wt, origin);
  const head = sh(wt, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'DIRTY', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }] } }));
  await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  await say(dev, 'Stop');
  const r = await until(async () => (await terminals()).find((y) => y.role === 'reviewer' && y.pr === PR), 'a reviewer');
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
  assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);
  await say(r, 'UserPromptSubmit');
  await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-101' } });
  await say(r, 'Stop');
  // The Dev takes one turn, without a merge of main, for each note the relay typed into it. Other notes, such
  // as the news that a review started, can come between the asks, and each waits for the turn before it.
  const asks = (screen) => (screen.match(/GOT\[[^\]]*conflicts with main/g) || []).length;
  let answered = 0;
  const turnsUntil = async (n, what) => until(async () => {
    const screen = await R.screen(dev.id), got = (screen.match(/GOT\[/g) || []).length;
    if (asks(screen) === n) return screen;
    if (got > answered) { answered = got; await say(dev, 'UserPromptSubmit'); await say(dev, 'Stop'); }
    return null;
  }, what);

  await turnsUntil(1, 'the first ask to merge main');
  const screen = await turnsUntil(2, 'one more ask, at once, after a turn that ended at the same head');
  assert.match(screen, new RegExp('GOT\\[Your PR ' + PR + ' still conflicts with main at ' + head.slice(0, 7) + ', and your last turn ended without a merge of main\\.'));
  assert.notStrictEqual((await task()).state, 'waiting_on_you', 'not the person yet');
  assert.ok((await ap()).notes.some((n) => /PR #7 still conflicts with main after its Dev's turn ended, so its Dev was asked once more\./.test(n.text)), JSON.stringify((await ap()).notes));

  await say(dev, 'UserPromptSubmit');
  await say(dev, 'Stop');
  const parked = await until(async () => { const y = await task(); return y.state === 'waiting_on_you' && y; }, 'the task to wait on you');
  const move = parked.history.filter((h) => h.type === 'moved').pop();
  assert.strictEqual(move.note, 'Autopilot: Its Dev was asked twice to merge main into PR #7 at ' + head.slice(0, 7) + ', and each turn ended without it. Merge main yourself, or tell the Dev to, then move the card back to Autopilot.');
  assert.strictEqual(asks(await R.screen(dev.id)), 2, 'no third ask');
  assert.strictEqual((await ap()).runs.recent.find((y) => y.ticket === ticket.id).blocked.reason, 'conflict-dropped');
  assert.strictEqual(require('../autopilot-runs.js').REASONS['conflict-dropped'], 'its Dev did not merge main after two asks');
  const jam = (await R.call('GET', '/jams?range=1d')).body.jams.filter((j) => j.ticket === ticket.id);
  assert.deepStrictEqual(jam.map((j) => [j.kind, j.by, /Reason conflict-dropped\./.test(j.fix)]), [['handed-over', 'autopilot', true]]);
});

test('a merge verdict on its head merges although the Dev is running a job', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200', RELAY_JOB_SCAN_MS: '200' });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const merged = () => { try { return fs.readFileSync(path.join(ghDir, 'merged.log'), 'utf8'); } catch (e) { return ''; } };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
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
  await until(async () => (await R.screen(dev.id)).includes('❯'), 'the Dev\'s prompt');
  await say(dev, 'UserPromptSubmit');
  await R.call('POST', '/terminals/' + dev.id + '/input', { data: '/job\r' });
  await say(dev, 'Stop');
  await until(async () => /^job/.test((await R.call('GET', '/floor')).body.sessions.find((s) => s.terminal === dev.id).state), 'the Floor to show the job');
  const r = (await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) })).body;
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
  assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token)).status, 200);
  await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-101' } });
  await say(r, 'Stop');
  await until(() => merged() !== '', 'the merge with the job still running');
  assert.ok((await R.call('GET', '/floor')).body.sessions.find((s) => s.terminal === dev.id), 'the Dev is still there');
});
