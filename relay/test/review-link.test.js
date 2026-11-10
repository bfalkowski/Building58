'use strict';
// T-230: on 2026-11-08 two reviews of PR 162 were on GitHub with a merge verdict on the PR's head, but their
// verdicts stayed posted: null, so Autopilot never merged. The hook had reported both posts. What lost them
// was a prompt in the 30 second grace after the reviewer's turn: a <task-notification> from its own
// background test run (Ada), and the person typing into it (Greta). The relay took either for the person
// taking over, and forgot the post. These tests drive that through a real relay, with a fake gh.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep, sessionToken, ROOT } = require('./helpers.js');
const { prBrief } = require('../../office/reviews.js');
const { reviewPostFor } = require('../autopilot-plan.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/widgets/pull/7';
const GREEN = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const GRACE = 1500;

test('a posted review stays linked to its verdict, whatever comes after it', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_REVIEW_GRACE_MS: String(GRACE) });
  t.after(async () => { await R.stop(); fs.rmSync(ghDir, { recursive: true, force: true }); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  const merged = () => { try { return fs.readFileSync(path.join(ghDir, 'merged.log'), 'utf8'); } catch (e) { return ''; } };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const running = async (s) => (await terminals()).some((x) => x.id === s.id);
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  // The real hook, fed what Claude Code would give it.
  const hook = (s, event, extra) => {
    const payload = Object.assign({ hook_event_name: event, session_id: s.sessionId, cwd: s.cwd }, extra);
    const r = spawnSync('node', [path.join(ROOT, 'relay', 'office-hook.js')], { input: JSON.stringify(payload), env: { ...process.env, HOME: R.home, OFFICE_RELAY_KEY: 'test-key', OFFICE_RELAY_URL: 'http://127.0.0.1:' + R.port, OFFICE_CHANNEL: 't' } });
    assert.strictEqual(r.status, 0);
  };
  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: ticket.id });
  const x = await until(async () => (await R.call('GET', '/tasks')).body.tasks[0], 'the task'), wt = x.worktree;
  const dev = (await terminals()).find((y) => y.id === x.worker.terminal);
  let n = 0, head;
  const answers = (api) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: Object.assign({ 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }] }, api) }));
  // The Dev pushes a new head, so a merge verdict on the old one no longer merges.
  const push = async () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'hello ' + (++n) + '\n');
    sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello ' + n);
    sh(wt, 'push', '-qf', origin, 'HEAD:refs/pull/7/head'); sh(wt, 'update-ref', 'refs/remotes/origin/pr', 'HEAD');
    head = sh(wt, 'rev-parse', 'HEAD');
    answers();
  };
  await push();
  await say(dev, 'PostToolUse', { pr_url: PR, cwd: wt });
  const reviewer = async () => {
    const r = await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const verdict = async (r) => {
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.sessionId); } catch (e) { return null; } }, 'its token') };
    const v = await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token);
    assert.strictEqual(v.status, 200, JSON.stringify(v.body));
  };
  const mergedHead = () => until(() => merged().includes(PR + ' --merge --match-head-commit ' + head), 'the merge of ' + head.slice(0, 7));
  const stop = async (s) => { await R.call('POST', '/terminals/' + s.id + '/stop', {}); await until(async () => !(await running(s)), 'it to stop'); };
  // Greta's command, as she ran it: the review written with a heredoc, then posted with --body-file, in one Bash call.
  const greta = (s, id) => hook(s, 'PostToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'S=' + s.cwd + '/scratch\ncat > $S/review.md <<\'EOF\'\n## Review of 99296df..' + head.slice(0, 7) + '\n\n**Verdict: merge. Nothing blocks.** Run `gh pr review 7 --approve`? No.\nEOF\ngh pr comment ' + PR + ' --body-file $S/review.md' },
    tool_response: { stdout: PR + '#issuecomment-' + id, stderr: '', interrupted: false, isImage: false, noOutputExpected: false, gitOperation: { pr: { number: 7, url: PR, action: 'commented' } } }
  });

  await t.test('a task notice in the grace period is not the person: the verdict counts and the reviewer leaves', async () => {
    const r = await reviewer();
    await verdict(r);
    greta(r, 501);
    await say(r, 'Stop');
    // Ada's background test run finished 28 seconds after her turn ended, inside the 30 second grace.
    hook(r, 'UserPromptSubmit', { prompt: '<task-notification>\n<task-id>bjiocvwkz</task-id>\n<status>completed</status>\n<summary>Background command "Wait for full test suite to finish" completed (exit code 0)</summary>\n</task-notification>' });
    await say(r, 'Stop');
    await until(async () => !(await running(r)), 'the reviewer to leave');
    await mergedHead();
  });

  await t.test('the person typing into it keeps the reviewer, and its posted verdict still counts', async () => {
    await push();
    fs.rmSync(path.join(ghDir, 'merged.log'), { force: true });
    const r = await reviewer();
    await verdict(r);
    greta(r, 502);
    await say(r, 'Stop');
    hook(r, 'UserPromptSubmit', { prompt: 'office-b reported this error - do we have a ticket for it already' });
    await say(r, 'Stop');
    await mergedHead();
    await sleep(GRACE + 500);
    assert.ok(await running(r), 'the person is talking to it, so it stays');
    await stop(r);
  });

  await t.test('a verdict whose post the hook never reported is linked from the PR, when its turn ends', async () => {
    await push();
    fs.rmSync(path.join(ghDir, 'merged.log'), { force: true });
    const r = await reviewer();
    await verdict(r);
    const at = new Date(Date.now() + 1000).toISOString();
    const comments = [
      { id: 1, html_url: PR + '#issuecomment-601', user: { login: 'someone-else' }, created_at: at, body: '## Review of 1234567..' + head.slice(0, 7) + '\n\nmerge' },
      { id: 2, html_url: PR + '#issuecomment-602', user: { login: 'office-bot' }, created_at: '2020-01-01T00:00:00Z', body: '## Review of ' + head.slice(0, 7) + '\n\nmerge' },
      { id: 3, html_url: PR + '#issuecomment-603', user: { login: 'office-bot' }, created_at: at, body: '## Review of 1234567..abcdef0\n\nmerge' }
    ];
    answers({ 'repos/acme/widgets/issues/7/comments': comments, user: { login: 'office-bot' } });
    await say(r, 'Stop');
    await sleep(1500);
    assert.strictEqual(merged(), '', 'another account, a comment from before the review, or another commit is not its review');
    answers({ 'repos/acme/widgets/issues/7/comments': comments.concat({ id: 4, html_url: PR + '#issuecomment-604', user: { login: 'office-bot' }, created_at: at, body: '## Review of 99296df..' + head.slice(0, 7) + '\n\n**Verdict: merge.**' }), user: { login: 'office-bot' } });
    await say(r, 'Stop');
    await mergedHead();
    await stop(r);
  });
});

test('a review heading names the commit it reviewed, or a range ending in it', () => {
  const head = '04fe778091e19b67dc60a782f083d704434a7c31';
  const since = Date.parse('2026-11-08T22:09:05Z');
  const c = (body, extra) => Object.assign({ html_url: 'https://github.com/bfalkowski/3d/pull/162#issuecomment-1', user: { login: 'bfalkowski' }, created_at: '2026-11-08T22:51:50Z', body }, extra);
  const found = (comments) => reviewPostFor(comments, { login: 'bfalkowski', since, commit: head });
  assert.strictEqual(found([c('## Review of 99296df..04fe778\n\n**Verdict: merge.**')]), 'https://github.com/bfalkowski/3d/pull/162#issuecomment-1');
  assert.ok(found([c('## Review of 04fe778\n')]), 'the head alone');
  assert.ok(found([c('# Review of `99296df...04fe778091e1`\n')]), 'three dots, a longer hash, in code');
  assert.ok(found([c('\n\n### review of 99296DF..04FE778\n')]), 'case and blank lines first');
  for (const [why, x] of [
    ['a range that starts at the head', c('## Review of 04fe778..99296df\n')],
    ['another commit', c('## Review of 99296df\n')],
    ['too short a hash to tell', c('## Review of 04fe\n')],
    ['not the heading', c('Some words first.\n## Review of 04fe778\n')],
    ['another account', c('## Review of 04fe778\n', { user: { login: 'someone' } })],
    ['before the review started', c('## Review of 04fe778\n', { created_at: '2026-11-08T21:00:00Z' })],
    ['a link that is not a PR comment', c('## Review of 04fe778\n', { html_url: 'https://example.com/x' })]
  ]) assert.strictEqual(found([x]), null, why);
  // The newest that matches, as a reviewer that posts twice means the second.
  assert.strictEqual(found([c('## Review of 04fe778\n'), c('## Review of 04fe778\n', { html_url: 'https://github.com/bfalkowski/3d/pull/162#issuecomment-2', created_at: '2026-11-08T22:55:00Z' })]), 'https://github.com/bfalkowski/3d/pull/162#issuecomment-2');
});

test('the hook says a prompt is a task notice, and sends none of its words', () => {
  const { summarize } = require('../office-hook.js');
  const ev = (prompt) => summarize({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt });
  assert.strictEqual(ev('<task-notification>\n<task-id>x</task-id>\n<summary>secret words</summary>\n</task-notification>').notice, true);
  assert.strictEqual(ev('please look at <task-notification>').notice, undefined);
  assert.strictEqual(ev('office-b reported this error').notice, undefined);
  assert.doesNotMatch(JSON.stringify(ev('<task-notification>secret words</task-notification>')), /secret/);
});
