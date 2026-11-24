'use strict';
// T-424: on 2026-11-24 PR #402 had a merge verdict, main moved, and the merge needed two fixes of its own. The hold
// refused the merge with its fixes, and the PR sat an hour until the person pressed Fix it. Through a real relay and
// real git pushes: a merge of main with a fix on a file the merge changed is pushed and gets a follow-up review, a
// push with a commit on another file is refused, the refusal shows on Needs you with Fix it, and the jam log has it.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, removeDir, until, sessionToken } = require('./helpers.js');
const pushHold = require('../push-hold.js');

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/widgets/pull/7';
const PENDING = [{ name: 'pipeline', status: 'IN_PROGRESS', conclusion: null }];
const markOf = (wt) => { try { return JSON.parse(fs.readFileSync(path.join(pushHold.gitDirOf(wt), pushHold.MARK), 'utf8')); } catch (e) { return null; } };

test('under a push hold, a merge of main with a fix on a file it changed is pushed and reviewed again, and any other push is refused, shown and logged', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: '200' }, null, { autoReview: true });
  t.after(async () => { await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'main\n');
  sh(repo, 'add', 'b.txt');
  sh(repo, 'commit', '-qm', 'b');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  const trunk = sh(repo, 'symbolic-ref', '--short', 'HEAD');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + trunk);
  sh(repo, 'config', 'core.hooksPath', path.resolve(__dirname, '..', '..', '.githooks'));
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const task = async () => (await R.call('GET', '/tasks')).body.tasks[0];
  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(task, 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  let head = null, n = 0;
  const answer = () => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: PENDING } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }], 'repos/acme/widgets/issues/7/comments': [] } }));
  const edit = (cwd, file) => { fs.writeFileSync(path.join(cwd, file), 'change ' + (++n) + '\n'); sh(cwd, 'commit', '-qam', 'change ' + n); return sh(cwd, 'rev-parse', 'HEAD'); };
  const push = () => {
    const r = spawnSync('git', ['push', origin, 'HEAD:refs/pull/7/head'], { cwd: wt, encoding: 'utf8' });
    if (r.status === 0) { sh(wt, 'update-ref', 'refs/remotes/origin/pr', 'HEAD'); head = sh(wt, 'rev-parse', 'HEAD'); answer(); }
    return { ok: r.status === 0, out: r.stdout + r.stderr };
  };
  const seen = new Set();
  const reviewer = () => until(async () => (await terminals()).find((y) => y.role === 'reviewer' && y.pr === PR && !seen.has(y.id) && seen.add(y.id)), 'a reviewer');
  const review = async (r, kind) => {
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind }, token)).status, 200);
    await say(r, 'UserPromptSubmit');
    await say(r, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-' + (100 + seen.size) } });
    await say(r, 'Stop');
    await until(async () => !(await terminals()).some((y) => y.id === r.id), 'the reviewer to leave');
  };

  const reviewed = edit(wt, 'a.txt');
  assert.ok(push().ok, 'no mark yet, so the first push goes through');
  await say(dev, 'UserPromptSubmit');
  await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  await say(dev, 'Stop');
  await review(await reviewer(), 'merge');
  assert.deepStrictEqual(await until(() => markOf(wt), 'the push hold'), { pr: PR, commit: reviewed, base: 'main' });

  sh(repo, 'checkout', '-q', trunk);
  edit(repo, 'b.txt');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + trunk);
  sh(wt, 'fetch', '-q', origin, trunk);
  sh(wt, 'update-ref', 'refs/remotes/origin/' + trunk, 'FETCH_HEAD');
  sh(wt, 'merge', '-q', '--no-ff', '-m', 'Merge main', 'FETCH_HEAD');
  await say(dev, 'UserPromptSubmit');
  const unrelated = edit(wt, 'a.txt');

  await t.test('a commit on a file the merge did not change is refused, and Needs you offers Fix it', async () => {
    const refused = push();
    assert.strictEqual(refused.ok, false, refused.out);
    assert.match(refused.out, new RegExp('Refused: commit ' + unrelated.slice(0, 7) + ' changes a\\.txt, which the merge did not change\\.'));
    const item = await until(async () => (await R.call('GET', '/needs-you')).body.items.find((i) => i.kind === 'push-refused'), 'the Needs you line');
    assert.deepStrictEqual(item.link, { url: PR, fix: x.id });
    assert.match(item.line, /^Look at PR #7 \(\S+\): the push hold refused its Dev's push\. commit \w{7} changes a\.txt/);
  });

  await t.test('the jam log has the refused push, once', async () => {
    const jam = await until(async () => (await R.call('GET', '/jams?range=1d')).body.jams.find((j) => j.kind === 'push-refused'), 'the jam');
    assert.deepStrictEqual([jam.pr, jam.by], [PR, 'the relay']);
    assert.match(jam.fix, /^Push refused: commit \w{7} changes a\.txt/);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.strictEqual((await R.call('GET', '/jams?range=1d')).body.jams.filter((j) => j.kind === 'push-refused').length, 1, 'later looks do not log it again');
  });

  await t.test('the merge with a fix on a file it changed goes through, and a follow-up review of it starts', async () => {
    sh(wt, 'reset', '-q', '--hard', 'HEAD~1');
    const fix = edit(wt, 'b.txt');
    const pushed = push();
    assert.strictEqual(pushed.ok, true, pushed.out);
    assert.strictEqual(head, fix);
    await say(dev, 'PostToolUse', { pushed: true });
    await say(dev, 'Stop');
    const follow = await reviewer();
    await until(async () => (await R.screen(follow.id)).includes('review only what changed since'), 'the follow-up brief');
    assert.ok(!(await R.call('GET', '/needs-you')).body.items.some((i) => i.kind === 'push-refused'), 'the push that went through ends the line');
  });
});
