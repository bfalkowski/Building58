// Which ticket each session is on, as the page gets it: the Floor, the name tags and the Org chart
// all read `work` on GET /terminals, so nothing here depends on what a browser remembers.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('what each session is working on', async (t) => {
  const R = await relay(), { call, hook } = R, repo = makeRepo(R.home);
  t.after(R.stop);
  // A local bare repo standing in for GitHub, as in checkouts.test.js.
  const origin = path.join(R.home, 'origin.git'), PR = (n) => 'https://github.com/acme/widgets/pull/' + n;
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  for (const n of [7, 8, 9, 10]) sh(repo, 'push', '-q', origin, 'HEAD:refs/pull/' + n + '/head');

  const sessions = async () => (await call('GET', '/terminals')).body.terminals;
  const session = async (id) => (await sessions()).find((x) => x.id === id);
  const review = async (n) => (await call('POST', '/checkouts', { from: repo, pr: PR(n) })).body;
  const opened = (sessionId, n) => hook({ hook_event_name: 'PostToolUse', session_id: sessionId.slice(0, 12), pr_url: PR(n) });

  const ticket = (await call('POST', '/tickets', { title: 'Review comments reach the Dev', repo })).body.ticket;
  const started = (await call('POST', '/tickets/' + ticket.id + '/start', {})).body;
  const dev = started.task.worker.terminal, devSession = (await session(dev)).sessionId;

  await t.test('a Dev shows their task\'s ticket', async () => {
    assert.deepStrictEqual((await session(dev)).work, { role: 'dev', ticket: ticket.id, ticketAt: ticket.createdAt, pr: null, label: ticket.id + ' · Review comments reach the Dev' });
  });
  await t.test('a reviewer started before the task records its PR shows the PR, then the ticket', async () => {
    const r = await review(7);
    assert.deepStrictEqual(r.work, { role: 'reviewer', ticket: null, ticketAt: null, pr: PR(7), label: 'Review PR #7' });
    await opened(devSession, 7);
    const work = await until(async () => { const w = (await session(r.id)).work; return w.ticket && w; }, 'the PR to be recorded');
    assert.deepStrictEqual(work, { role: 'reviewer', ticket: ticket.id, ticketAt: ticket.createdAt, pr: PR(7), label: 'reviewing ' + ticket.id + ' · Review comments reach the Dev' });
    assert.strictEqual((await session(dev)).work.pr, PR(7));
  });
  await t.test('a reviewer started after the task records its PR shows the ticket at once', async () => {
    assert.strictEqual((await review(7)).work.ticket, ticket.id);
  });
  await t.test('a task that moves on to a new PR keeps the reviewer of the old one', async () => {
    const r = await review(7);
    await opened(devSession, 8);
    await until(async () => (await session(dev)).work.pr === PR(8), 'the new PR');
    assert.strictEqual((await session(r.id)).work.ticket, ticket.id);
  });
  await t.test('a reviewer whose PR has no task has no number', async () => {
    assert.deepStrictEqual((await review(9)).work, { role: 'reviewer', ticket: null, ticketAt: null, pr: PR(9), label: 'Review PR #9' });
  });
  await t.test('a session with no ticket has no work, and keeps its own title', async () => {
    const plain = (await call('POST', '/checkouts', { from: repo })).body;
    assert.strictEqual(plain.work, null);
    await hook({ hook_event_name: 'UserPromptSubmit', session_id: plain.sessionId.slice(0, 12), title: 'My own title' });
    const now = await until(async () => { const s = await session(plain.id); return s.title && s; }, 'the title');
    assert.strictEqual(now.title, 'My own title');
    assert.strictEqual(now.work, null);
  });
  await t.test('a task with no ticket has no number', async () => {
    const task = (await call('POST', '/tasks', { title: 'No ticket here', repo })).body.task;
    const s = await session(task.worker.terminal);
    assert.strictEqual(s.title, 'No ticket here');
    assert.strictEqual(s.work, null);
  });
  await t.test('the PM says they are the PM', async () => {
    const pm = (await call('POST', '/tickets/ask', { idea: 'A radio', repo })).body;
    const work = (await session(pm.terminal)).work;
    assert.strictEqual(work.role, 'pm');
    assert.strictEqual(work.ticket, null);
    assert.match(work.label, /^PM: A radio/);
  });
  await t.test('a page that reloads can get every label from the relay, using only its address', async () => {
    // Only what the page's own address holds: the key in the query, no header and no stored state.
    // This covers the relay's half. Whether the page draws `work` needs a browser, which is T-23.
    const page = await (await fetch(R.base + '/terminals?key=test-key')).json();
    const labels = page.terminals.map((s) => s.work && s.work.label);
    assert.ok(labels.includes(ticket.id + ' · Review comments reach the Dev'));
    assert.ok(labels.includes('reviewing ' + ticket.id + ' · Review comments reach the Dev'));
    assert.ok(labels.includes('Review PR #9'));
    assert.ok(labels.includes(null), 'a session with no ticket stays without one');
    assert.deepStrictEqual(page.terminals.map((s) => [s.id, s.work]), (await sessions()).map((s) => [s.id, s.work]));
  });
  await t.test('the stream a page attaches to says the same', async () => {
    const r = await fetch(R.base + '/terminals/' + dev + '/stream', { headers: { Authorization: 'Bearer test-key' }, signal: AbortSignal.timeout(300) });
    let text = '';
    const reader = r.body.getReader(), dec = new TextDecoder();
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); if (text.includes('event: hello') && text.includes('\n\n', text.indexOf('event: hello'))) break; } } catch (e) { /* cut off */ }
    await reader.cancel().catch(() => {});
    assert.strictEqual(JSON.parse(text.match(/event: hello\ndata: (.+)/)[1]).work.ticket, ticket.id);
  });
  await t.test('a reviewer keeps their ticket after the task is cleaned up', async () => {
    for (const s of (await sessions()).filter((x) => x.id !== dev)) await call('POST', '/terminals/' + s.id + '/stop', {});  // free the desks
    await until(async () => (await sessions()).length === 1, 'the desks to free up');
    const other = (await call('POST', '/tickets', { title: 'Soon cleaned up', repo })).body.ticket;
    await call('POST', '/tasks/' + started.task.id + '/move', { to: 'done' });  // a free place under the limit
    const task = (await call('POST', '/tickets/' + other.id + '/start', {})).body.task;
    await opened((await session(task.worker.terminal)).sessionId, 10);
    await until(async () => (await call('GET', '/tasks/' + task.id)).body.task.pr === PR(10), 'the PR');
    const r = await review(10), label = 'reviewing ' + other.id + ' · Soon cleaned up';
    assert.strictEqual(r.work.label, label);
    await call('POST', '/terminals/' + task.worker.terminal + '/stop', {});
    await until(async () => !(await session(task.worker.terminal)), 'the worker to stop');
    await call('POST', '/tasks/' + task.id + '/move', { to: 'done' });
    assert.strictEqual((await call('POST', '/tasks/' + task.id + '/clean', {})).status, 200);
    assert.strictEqual((await session(r.id)).work.label, label);
    assert.strictEqual((await review(10)).work.label, label, 'and so does a reviewer who starts afterwards');
  });
});
