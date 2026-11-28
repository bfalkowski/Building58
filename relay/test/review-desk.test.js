'use strict';
// T-374: on 2026-11-19 all 9 desks were taken by idle sessions: the Lead, Devs whose PRs waited on a review,
// and a reviewer whose review was posted the day before. The reviews waited for a desk, and the Devs waited
// for the reviews. Now a review that waits for a desk frees one by itself: a posted reviewer first, then an
// idle Dev whose PR waits on a review, the longest idle first. It never stops the Lead, a session in a turn, or
// one with text typed in its prompt. When it can stop none, Needs you names the wait.
// Through a real relay with a fake claude, as relay/test/auto-review.test.js.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');
const { forReview } = require('../stop-verdict.js');

const DESKS = 6;
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = (n) => 'https://github.com/acme/widgets/pull/' + n;

async function office(t) {
  const R = await relay({ RELAY_REVIEW_GRACE_MS: '600000', RELAY_WIP_LIMIT: '8' }, null, { autoReview: true });
  t.after(R.stop);
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  sh(repo, 'push', '-q', origin, 'HEAD:refs/pull/1/head');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/pull/2/head');
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const plain = async () => (await R.call('POST', '/terminals', { cwd: repo })).body;
  // A task's Dev, briefed, and idle after its first turn.
  const dev = async () => {
    const task = (await R.call('POST', '/tasks', { title: 'Some work', repo })).body.task;
    const s = { id: task.owner.terminal, sessionId: task.owner.sessionId, task };
    await until(async () => (await R.screen(s.id)).includes('GOT['), 'the task brief');
    await say(s, 'UserPromptSubmit');
    await say(s, 'Stop');
    await sleep(150);
    return s;
  };
  // The Dev opens a PR in a turn: gh pr create, as its hook reports it.
  const opens = async (s, pr, end) => {
    await say(s, 'UserPromptSubmit');
    await say(s, 'PostToolUse', { pr_url: pr, cwd: repo });
    if (end) await say(s, 'Stop');
  };
  const reviewerOf = (pr) => until(async () => (await terminals()).find((x) => x.role === 'reviewer' && x.pr === pr), 'a review of ' + pr);
  const reviews = async () => (await R.call('GET', '/reviews')).body;
  const needsYou = async () => (await R.call('GET', '/needs-you')).body.items;
  return { R, repo, say, terminals, plain, dev, opens, reviewerOf, reviews, needsYou };
}

test('every desk is idle and a review waits: the relay stops the Dev whose PR waits on it, and the review starts', async (t) => {
  const o = await office(t);
  const other = await o.dev();  // idle the longest, but its PR waits on no review
  const waits = await o.dev();
  while ((await o.terminals()).length < DESKS) await o.plain();
  await o.opens(waits, PR(1), true);
  const reviewer = await o.reviewerOf(PR(1));
  const now = await o.terminals();
  assert.ok(!now.some((x) => x.id === waits.id), 'the idle Dev whose PR waits on a review was stopped');
  assert.ok(now.some((x) => x.id === other.id), 'a Dev whose PR waits on no review stays');
  assert.strictEqual(now.length, DESKS, 'one desk was freed, and the review took it');
  assert.ok(now.some((x) => x.id === reviewer.id));
  const news = (await o.reviews()).news.map((x) => x.text);
  assert.ok(news.some((x) => /^The relay stopped .* \(Dev, task \w+\) to free a desk for the review of PR #1: its PR waits on a review, idle \d+ min, and Bring back returns it to the same checkout\.$/.test(x)), JSON.stringify(news));
  const history = (await o.R.call('GET', '/tasks/' + waits.task.id)).body.task.history;
  assert.ok(history.some((h) => /^The relay stopped its worker to free a desk for the review of PR #1: /.test(h.note || '')), JSON.stringify(history.slice(-3)));
  assert.match(o.R.output(), /to free a desk for the review of PR #1/, 'the relay\'s log says it');
});

test('reviews wait and no session may be stopped: nobody is stopped, Needs you names the wait, and each review starts once a session may be stopped', async (t) => {
  const o = await office(t);
  const typed = await o.dev(), busy = await o.dev();
  while ((await o.terminals()).length < DESKS) await o.plain();
  await o.R.call('POST', '/terminals/' + typed.id + '/input', { data: 'a draft' });
  await o.opens(typed, PR(2), true);  // idle, with text typed in its prompt
  await o.opens(busy, PR(1), false);  // still in its turn
  await until(async () => (await o.needsYou()).some((x) => x.kind === 'desks' && /reviews of PR #2 and #1 wait/.test(x.line)), 'Needs you to name both waiting reviews');
  await sleep(2500);  // the relay looks every second
  let now = await o.terminals();
  assert.strictEqual(now.length, DESKS);
  assert.ok(now.some((x) => x.id === busy.id), 'a session in a turn is never stopped');
  assert.ok(now.some((x) => x.id === typed.id), 'a session with text typed in its prompt is never stopped');
  const item = (await o.needsYou()).find((x) => x.kind === 'desks');
  assert.strictEqual(item.pr, PR(2), 'the review that waited longest');
  assert.match(item.line, /^Stop a session to free a desk: the reviews of PR #2 and #1 wait for one\. All 6 desks are taken, and the relay may stop none of them\./);
  assert.ok((await o.reviews()).news.some((x) => /^No desk is free for the review of PR #2, and the relay may stop no session for it\./.test(x.text)));

  await o.say(busy, 'Stop');
  await o.reviewerOf(PR(2));
  now = await o.terminals();
  assert.ok(!now.some((x) => x.id === busy.id), 'once idle, it was the one to stop');
  assert.ok(now.some((x) => x.id === typed.id));
  await until(async () => ((await o.needsYou()).find((x) => x.kind === 'desks') || {}).pr === PR(1), 'Needs you to name the review still waiting');

  await o.R.call('POST', '/terminals/' + typed.id + '/input', { data: '\u0015' });
  await o.reviewerOf(PR(1));
  assert.ok(!(await o.terminals()).some((x) => x.id === typed.id), 'its prompt is empty now, so it was stopped');
  assert.ok(!(await o.needsYou()).some((x) => x.kind === 'desks'), 'the wait is over');
});

test('a reviewer whose review is posted goes before a Dev', async (t) => {
  const o = await office(t);
  const first = await o.dev(), second = await o.dev();
  while ((await o.terminals()).length < DESKS - 1) await o.plain();
  await o.opens(first, PR(1), true);
  const reviewer = await o.reviewerOf(PR(1));
  await until(async () => (await o.R.screen(reviewer.id)).includes('GOT['), 'the review brief');
  await o.say(reviewer, 'UserPromptSubmit', { notice: true });
  await o.say(reviewer, 'PostToolUse', { tool_name: 'Bash', posted: { pr: 1, repo: 'acme/widgets', kind: 'comment', url: PR(1) + '#issuecomment-1' } });
  await o.say(reviewer, 'Stop');
  await sleep(3100);  // a session the relay typed into in the last 3 seconds is not safe to stop yet
  await o.opens(second, PR(2), true);
  await o.reviewerOf(PR(2));
  const now = await o.terminals();
  assert.ok(!now.some((x) => x.id === reviewer.id), 'the posted reviewer was stopped');
  assert.ok(now.some((x) => x.id === first.id) && now.some((x) => x.id === second.id), 'no Dev was stopped');
  assert.ok((await o.reviews()).news.some((x) => /^The relay stopped .* \(reviewer\) to free a desk for the review of PR #2: its review is posted, idle \d+ min\.$/.test(x.text)));
});

test('which session a review may stop, and in what order', () => {
  const ok = { safe: true, reason: 'idle 9 min' }, no = { safe: false, reason: 'it is working' };
  const row = (id, t, extra) => Object.assign({ t: Object.assign({ id, lastActAt: 0 }, t), task: null, verdict: ok, merged: false, unsaved: null, waits: false }, extra);
  const reviewer = row('r', { reviewOf: PR(1), posted: { kind: 'comment' }, lastActAt: 50 }, { verdict: { safe: true, reason: 'its review is posted, idle 9 min' } });
  const notPosted = row('n', { reviewOf: PR(1), lastActAt: 1 });
  const doneDev = row('d', { task: 'a', lastActAt: 40 }, { task: { id: 'a', state: 'done' } });
  const dirty = row('x', { task: 'x', lastActAt: 2 }, { task: { id: 'x', state: 'done' }, unsaved: 'its checkout has 1 uncommitted file' });
  const older = row('o', { task: 'b', lastActAt: 10 }, { task: { id: 'b', state: 'in_review', pr: PR(2) }, waits: true });
  const newer = row('w', { task: 'c', lastActAt: 30 }, { task: { id: 'c', state: 'in_review', pr: PR(3) }, waits: true });
  const reviewed = row('v', { task: 'e', lastActAt: 3 }, { task: { id: 'e', state: 'in_review', pr: PR(4) } });
  const busy = row('b', { task: 'f', lastActAt: 4 }, { task: { id: 'f', state: 'in_review', pr: PR(5) }, waits: true, verdict: no });
  const lead = row('l', { lead: true, lastActAt: 5 });
  const waitingDirty = row('y', { task: 'y', lastActAt: 6 }, { task: { id: 'y', state: 'waiting_on_you', pr: PR(6) }, unsaved: 'its checkout has 1 uncommitted file' });
  const all = [newer, older, doneDev, dirty, notPosted, reviewed, busy, lead, reviewer];
  assert.strictEqual(forReview(all).t.id, 'r', 'a posted reviewer first');
  assert.strictEqual(forReview(all).why, 'its review is posted, idle 9 min');
  assert.strictEqual(forReview(all.filter((x) => x !== reviewer)).t.id, 'd', 'then a Dev whose task is Done, with its work pushed');
  assert.strictEqual(forReview(all.filter((x) => x !== reviewer)).why, 'its task is Done, idle 9 min');
  assert.strictEqual(forReview([newer, older]).t.id, 'o', 'then the longest idle Dev whose PR waits on a review');
  assert.strictEqual(forReview([newer]).why, 'its PR waits on a review, idle 9 min');
  assert.strictEqual(forReview([notPosted, dirty, reviewed, busy, lead]), null, 'nothing else');
  assert.strictEqual(forReview([newer, waitingDirty, dirty]).t.id, 'y', 'a Dev whose task waits on the person goes before one whose PR waits on a review, though its checkout is dirty: the checkout stays');
  assert.strictEqual(forReview([waitingDirty]).why, 'its task waits on the person, idle 9 min');
});

test('every desk is held by an idle Dev whose task waits on the person: the oldest is stopped and the review starts', async (t) => {
  const o = await office(t);
  const older = await o.dev(), newer = await o.dev();
  while ((await o.terminals()).length < DESKS) await o.plain();
  for (const s of [older, newer]) assert.strictEqual((await o.R.call('POST', '/tasks/' + s.task.id + '/move', { to: 'waiting_on_you' })).status, 200);
  const floor = async () => (await o.R.call('GET', '/floor')).body.sessions.find((r) => r.terminal === older.id);
  await until(async () => (await floor()).canStop === true, 'the Floor to call the idle Dev safe to stop');
  await o.opens(older, PR(1), true);
  await o.R.call('POST', '/tasks/' + older.task.id + '/move', { to: 'waiting_on_you' });
  const reviewer = await o.reviewerOf(PR(1));
  const now = await o.terminals();
  assert.ok(!now.some((x) => x.id === older.id), 'the idle Dev whose task waits on the person was stopped');
  assert.ok(now.some((x) => x.id === newer.id), 'only one desk was freed');
  assert.ok(now.some((x) => x.id === reviewer.id));
  const news = (await o.reviews()).news.map((x) => x.text);
  assert.ok(news.some((x) => /to free a desk for the review of PR #1: its task waits on the person, idle/.test(x)), JSON.stringify(news));
});
