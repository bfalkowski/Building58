'use strict';
// On 2026-11-23 every desk held an idle Dev whose PR waited on its first review, and Autopilot spent the
// desks that came free on new tickets. Now a review goes before a new ticket, and frees the desk it needs.
// Through a real relay with a fake claude, as relay/test/review-desk.test.js, with Autopilot on.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');

const DESKS = 9;
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = (n) => 'https://github.com/acme/widgets/pull/' + n;

async function office(t) {
  const R = await relay({ RELAY_REVIEW_GRACE_MS: '600000', RELAY_WIP_LIMIT: '8', RELAY_AUTOPILOT_TICK_MS: '300' }, null, { autoReview: true });
  t.after(R.stop);
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/heads/' + sh(repo, 'symbolic-ref', '--short', 'HEAD'));
  sh(repo, 'push', '-q', origin, 'HEAD:refs/pull/1/head');
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const dev = async () => {
    const task = (await R.call('POST', '/tasks', { title: 'Some work', repo })).body.task;
    const s = { id: task.owner.terminal, sessionId: task.owner.sessionId, task };
    await until(async () => (await R.screen(s.id)).includes('GOT['), 'the task brief');
    await say(s, 'UserPromptSubmit');
    await say(s, 'Stop');
    await sleep(150);
    return s;
  };
  const ticket = async () => (await R.call('POST', '/tickets', { title: 'Next one', repo })).body.ticket;
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  return { R, repo, say, terminals, dev, ticket, ap };
}

test('every desk holds an idle Dev and a review waits, with a Ready ticket: the Dev stops, the review starts, the ticket waits', async (t) => {
  const o = await office(t);
  const waits = await o.dev();
  while ((await o.terminals()).length < DESKS) await o.R.call('POST', '/terminals', { cwd: o.repo });
  const next = await o.ticket();
  await o.R.call('POST', '/autopilot', { on: true, only: next.id });
  await o.say(waits, 'UserPromptSubmit');
  await o.say(waits, 'PostToolUse', { pr_url: PR(1), cwd: o.repo });
  await o.say(waits, 'Stop');
  const reviewer = await until(async () => (await o.terminals()).find((x) => x.role === 'reviewer' && x.pr === PR(1)), 'the review');
  const now = await o.terminals();
  assert.ok(!now.some((x) => x.id === waits.id), 'the idle Dev whose PR waited on the review was stopped');
  assert.ok(now.some((x) => x.id === reviewer.id));
  await sleep(1200);
  assert.ok(!(await o.R.call('GET', '/tasks')).body.tasks.some((x) => x.ticket === next.id), 'the ticket did not take the desk');
});

test('a free desk, a review that waits and a Ready ticket: the review starts, not the ticket', async (t) => {
  const o = await office(t);
  const waits = await o.dev();
  while ((await o.terminals()).length < DESKS - 1) await o.R.call('POST', '/terminals', { cwd: o.repo });
  const next = await o.ticket();
  await o.R.call('POST', '/autopilot', { on: true, only: next.id });
  await o.say(waits, 'UserPromptSubmit');
  await o.say(waits, 'PostToolUse', { pr_url: PR(1), cwd: o.repo });
  await o.say(waits, 'Stop');
  const started = async () => (await o.terminals()).some((x) => x.role === 'reviewer' && x.pr === PR(1));
  const ticketTask = async () => (await o.R.call('GET', '/tasks')).body.tasks.some((x) => x.ticket === next.id);
  await until(async () => {
    const review = await started();
    assert.ok(review || !(await ticketTask()), 'the ticket started before the review');
    return review;
  }, 'the review');
});

test('a first review in retry back-off with a free desk: the ticket waits and the idle line says the review goes first', async (t) => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-backoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'reviews.json');
  fs.writeFileSync(file, JSON.stringify({ t: { prs: { [PR(7)]: { count: 0, head: null, pending: null, waits: false, first: { at: 1, desk: false, tries: 1, notBefore: Date.now() + 3600000 } } } } }));
  const R = await relay({ RELAY_REVIEWS_FILE: file, RELAY_AUTOPILOT_TICK_MS: '300' }, null, { autoReview: true });
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const next = (await R.call('POST', '/tickets', { title: 'Next one', repo })).body.ticket;
  await R.call('POST', '/autopilot', { on: true, only: next.id });
  const idle = await until(async () => (await R.call('GET', '/autopilot')).body.idle, 'the idle line');
  assert.strictEqual(idle, 'Waiting for the review of PR #7 to start: it goes first.');
  assert.ok(!(await R.call('GET', '/tasks')).body.tasks.some((x) => x.ticket === next.id));
});
