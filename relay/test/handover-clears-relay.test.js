'use strict';
// A PR handed over for red CI comes back by itself once CI is green on a newer head (569). On 2026-11-27
// PR 515 sat in Needs you after its Dev fixed CI, until a person moved the card.
// Through a real relay, with a fake claude and a fake gh.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, removeDir, until, sessionToken } = require('./helpers.js');
const { prBrief } = require('../../office/reviews.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PR = 'https://github.com/acme/widgets/pull/7';
const RED = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'FAILURE' }];
const GREEN = [{ name: 'pipeline', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const STALL = 2000;

async function rig(t) {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh, RELAY_AUTOPILOT_TICK_MS: '300', RELAY_AUTOPILOT_STALL_MS: String(STALL), RELAY_REVIEW_GRACE_MS: '200' });
  t.after(async () => { await R.stop(); removeDir(gh); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/main');
  sh(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const ticket = (await R.call('POST', '/tickets', { title: 'Make a.txt say hello', repo })).body.ticket;
  const taskOf = async () => (await R.call('GET', '/tasks')).body.tasks.find((x) => x.ticket === ticket.id);
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const say = (sessionId, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: sessionId.slice(0, 12) }, extra));
  const merged = () => { try { return fs.readFileSync(path.join(gh, 'merged.log'), 'utf8'); } catch (e) { return ''; } };
  await R.call('POST', '/autopilot', { on: true, only: [ticket.id] });
  const task = await until(taskOf, 'the ticket to start');
  const dev = task.owner.sessionId, wt = task.worktree;
  await until(async () => (await R.screen(task.owner.terminal)).includes('GOT['), 'the brief');
  await say(dev, 'UserPromptSubmit');
  // The Dev's commit, pushed as the PR's head, so nothing in its checkout is unpushed (relay/merge-hold.js).
  const openPr = async () => {
    fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
    sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'hello');
    sh(wt, 'push', '-qf', origin, 'HEAD:refs/pull/7/head');
    sh(wt, 'update-ref', 'refs/remotes/origin/pr', 'HEAD');
    const head = sh(wt, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }] } }));
    await say(dev, 'PostToolUse', { tool_name: 'Bash', pr_url: PR, cwd: wt });
    return head;
  };
  // What the page's Get a review sends. Its reviewer gives a verdict and posts.
  const reviewSays = async (kind) => {
    const r = await R.call('POST', '/checkouts', { from: wt, pr: PR, prompt: prBrief(PR) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(r.body.sessionId); } catch (e) { return null; } }, 'its token') };
    assert.strictEqual((await R.call('POST', '/autopilot/verdict', { kind }, token)).status, 200);
    await say(r.body.sessionId, 'UserPromptSubmit');
    await say(r.body.sessionId, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 7, repo: 'acme/widgets', kind: 'comment', url: PR + '#issuecomment-1' } });
    await say(r.body.sessionId, 'Stop');
  };
  const parked = () => until(async () => { const x = await taskOf(); return x.state === 'waiting_on_you' && x; }, 'the task to wait on you');
  const lastMove = (x) => x.history.filter((h) => h.type === 'moved').pop();
  const reviewSaysMerge = () => reviewSays('merge');
  return { gh, R, dev, taskOf, ap, say, merged, openPr, reviewSays, reviewSaysMerge, parked, lastMove };
}

test('a PR handed over for red CI comes back when CI is green on a newer head', async (t) => {
  const { gh: dir, R, dev, taskOf, ap, say, openPr, reviewSaysMerge, parked, lastMove } = await rig(t);
  const wt = (await taskOf()).worktree;
  const head = await openPr();
  const answers = (p, h, roll) => JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: h, mergeStateStatus: 'CLEAN', statusCheckRollup: roll } }, api: { 'repos/acme/widgets/pulls/7/files': [{ filename: 'a.txt' }] } });
  fs.writeFileSync(path.join(dir, 'answers.json'), answers(PR, head, RED));
  await reviewSaysMerge();
  const p = await parked();
  assert.match(lastMove(p).note, /CI failed on the reviewed commit/);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'more\n');
  sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'b.txt');
  sh(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fix ci');
  const next = sh(wt, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'answers.json'), answers(PR, next, GREEN));
  const back = await until(async () => { const x = await taskOf(); return x.state !== 'waiting_on_you' && x; }, 'the task to leave Waiting on you');
  assert.strictEqual(lastMove(back).by, 'Autopilot');
  assert.match(lastMove(back).note, /CI is green on [0-9a-f]{7}, a newer commit than the one that failed, so the task is back\./);
  assert.ok((await ap()).notes.some((n) => /is back from Waiting on you: CI is green on/.test(n.text)));
  const needs = (await R.call('GET', '/needs-you')).body;
  assert.ok(!JSON.stringify(needs).includes('Decide on PR'), 'Needs you dropped the item');
  await say(dev, 'Stop');
});
