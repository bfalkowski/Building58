// A ticket's history (relay/ticket-history.js): who has it now, and who did what on it, through a real
// relay with a fake `claude`. It stays through a relay restart and through Clean up.
'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep, sessionToken } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/widgets/pull/9', PR2 = 'https://github.com/acme/widgets/pull/10';
const tokenFor = (s) => until(() => { try { return { 'X-Office-Token': sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the session');

test('a ticket\'s history', async (t) => {
  let R = await relay({ RELAY_WIP_LIMIT: '5' });
  const home = R.home, repo = makeRepo(home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  // A PR the reviewer can fetch, as auto-review.test.js does it.
  const origin = path.join(home, 'origin.git');
  sh(home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-qf', origin, 'HEAD:refs/pull/9/head');
  sh(repo, 'push', '-qf', origin, 'HEAD:refs/pull/10/head');

  const ticketOf = async (id) => (await R.call('GET', '/tickets/' + id)).body.ticket;
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const stop = async (id) => { await R.call('POST', '/terminals/' + id + '/stop', {}); await until(async () => !(await terminals()).some((x) => x.id === id), 'it to stop'); };
  const steps = (ticket, stage) => ticket.history.filter((x) => x.stage === stage);
  const talk = async (s) => { await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12), title: '' }); await sleep(200); };

  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await talk(lead);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true })).status, 200);
  const leadToken = await tokenFor(lead);

  let ticket, task, dev, devName, revName;
  await t.test('before it starts, nobody has it', async () => {
    ticket = (await R.call('POST', '/tickets', { title: 'Show the history', body: 'Do it.', repo })).body.ticket;
    assert.strictEqual(ticket.assignee, null);
    assert.deepStrictEqual(ticket.history.map((x) => [x.stage, x.by]), [['filed', 'you']]);
    assert.strictEqual(ticket.history[0].old, false);
  });

  await t.test('once started, its Dev has it, by the name the relay gave and with the full session id', async () => {
    const r = await R.call('POST', '/tickets/' + ticket.id + '/start', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    task = r.body.task;
    dev = (await terminals()).find((x) => x.id === task.worker.terminal);
    const now = await ticketOf(ticket.id);
    assert.deepStrictEqual(now.history.map((x) => x.stage), ['filed', 'started', 'dev']);
    assert.strictEqual(steps(now, 'started')[0].by, 'you');
    const d = steps(now, 'dev')[0];
    devName = dev.who;
    assert.ok(devName, 'the relay named the Dev');
    assert.strictEqual(d.name, devName);
    assert.strictEqual(d.session.sessionId, dev.sessionId);
    assert.match(d.session.sessionId, /^[0-9a-f-]{36}$/);
    assert.strictEqual(d.session.cwd, task.worktree);
    assert.strictEqual(d.session.running, true);
    assert.strictEqual(d.session.terminal, dev.id);
    assert.deepStrictEqual([now.assignee.role, now.assignee.name, now.assignee.session.running], ['dev', devName, true]);
  });

  await t.test('a reviewer is linked to its task, and has it while it is in review', async () => {
    await R.hook({ hook_event_name: 'PostToolUse', session_id: dev.sessionId.slice(0, 12), pr_url: PR, cwd: task.worktree });
    await until(async () => (await R.call('GET', '/tasks/' + task.id)).body.task.pr === PR, 'the task to record its PR');
    const r = await R.call('POST', '/checkouts', { from: repo, pr: PR, cols: 80, rows: 24 });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    await R.call('POST', '/tasks/' + task.id + '/move', { to: 'in_review' });
    let now = await ticketOf(ticket.id);
    const rev = steps(now, 'reviewer')[0];
    revName = (await terminals()).find((x) => x.id === r.body.id).who;
    assert.ok(revName && revName !== devName, 'the relay named the reviewer apart');
    assert.deepStrictEqual([rev.task, rev.pr, rev.name, rev.by, rev.session.sessionId, rev.session.running], [task.id, PR, revName, 'you', r.body.sessionId, true]);
    assert.strictEqual(rev.session.cwd, r.body.cwd);
    assert.deepStrictEqual([now.assignee.role, now.assignee.name], ['reviewer', revName]);
    // /clear gives the reviewer a new conversation in the same terminal. The history follows it, as it
    // does a Dev: a new step with the new id, and the old one has ended.
    const fresh = crypto.randomUUID();
    await R.hook({ hook_event_name: 'SessionStart', source: 'clear', session_id: fresh.slice(0, 12), full_session_id: fresh, terminal: r.body.id });
    now = await ticketOf(ticket.id);
    assert.deepStrictEqual(steps(now, 'reviewer').map((x) => [x.session.sessionId, x.session.running, x.name, x.by, x.task, x.pr]),
      [[r.body.sessionId, false, revName, 'you', task.id, PR], [fresh, true, revName, 'you', task.id, PR]]);
    assert.strictEqual(steps(now, 'reviewer')[1].session.cwd, r.body.cwd);
    assert.deepStrictEqual([now.assignee.name, now.assignee.session.sessionId, now.assignee.session.running], [revName, fresh, true], 'the reviewer has it in its new conversation');
    await stop(r.body.id);
    now = await ticketOf(ticket.id);
    assert.deepStrictEqual([now.assignee.name, now.assignee.session.running], [revName, false], 'it says the reviewer\'s session has ended');
    await until(async () => steps(await ticketOf(ticket.id), 'reviewer')[0].session.folderGone, 'a reviewer\'s checkout to go once it ends, so it cannot come back');
  });

  await t.test('a move by the Lead is signed with the Lead\'s session and name', async () => {
    const r = await R.call('POST', '/tasks/' + task.id + '/move', { to: 'waiting_on_you', by: 'you' }, leadToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const now = await ticketOf(ticket.id);
    const m = steps(now, 'moved').at(-1);
    assert.deepStrictEqual([m.from, m.to, m.by, m.role, m.name, m.session.sessionId], ['in_review', 'waiting_on_you', 'Lead', 'lead', require('../../office/roster.js').lead.name, lead.sessionId]);  // signed by the role, named by the Lead's desk, Paul
    assert.deepStrictEqual(now.assignee, { role: 'you', name: 'You', session: null });
  });

  await t.test('it stays through Clean up and a relay restart', async () => {
    await R.call('POST', '/tasks/' + task.id + '/move', { to: 'done' });
    await stop(dev.id);
    const c = await R.call('POST', '/tasks/' + task.id + '/clean', {});
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    await R.kill();
    R = await relay({ RELAY_WIP_LIMIT: '5' }, home);
    const now = await ticketOf(ticket.id);
    assert.strictEqual(now.status, 'done');
    assert.strictEqual(now.task, null, 'the task is gone');
    assert.strictEqual(now.assignee, null);
    assert.deepStrictEqual(now.history.map((x) => x.stage), ['filed', 'started', 'dev', 'reviewer', 'moved', 'reviewer', 'moved', 'moved']);
    const d = steps(now, 'dev')[0];
    assert.deepStrictEqual([d.name, d.session.sessionId, d.session.running, d.session.folderGone], [devName, dev.sessionId, false, true], 'its checkout went with Clean up');
    assert.strictEqual(steps(now, 'reviewer')[0].name, revName);
    assert.ok(now.history.every((x) => !x.old));
  });

  await t.test('a review started after Clean up is still linked to its ticket', async () => {
    // Its task is gone, so the ticket comes from the saved history: a step with that PR.
    const again = await R.call('POST', '/checkouts', { from: repo, pr: PR, cols: 80, rows: 24 });
    assert.strictEqual(again.status, 201, JSON.stringify(again.body));
    const revs = steps(await ticketOf(ticket.id), 'reviewer');
    assert.strictEqual(revs.length, 3);
    assert.deepStrictEqual([revs[2].task, revs[2].pr, revs[2].by, revs[2].session.sessionId, revs[2].session.running], [task.id, PR, 'you', again.body.sessionId, true]);
    await stop(again.body.id);
    // A PR that was never reviewed before its Clean up: the task's moves after it opened carry the PR.
    const other = (await R.call('POST', '/tickets', { title: 'Reviewed late', body: 'Do it.', repo })).body.ticket;
    const late = (await R.call('POST', '/tickets/' + other.id + '/start', {})).body.task;
    const worker = (await terminals()).find((x) => x.id === late.worker.terminal);
    await R.hook({ hook_event_name: 'PostToolUse', session_id: worker.sessionId.slice(0, 12), pr_url: PR2, cwd: late.worktree });
    await until(async () => (await R.call('GET', '/tasks/' + late.id)).body.task.pr === PR2, 'the task to record its PR');
    await R.call('POST', '/tasks/' + late.id + '/move', { to: 'done' });
    await stop(worker.id);
    assert.strictEqual((await R.call('POST', '/tasks/' + late.id + '/clean', {})).status, 200);
    const r = await R.call('POST', '/checkouts', { from: repo, pr: PR2, cols: 80, rows: 24 });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const rev = steps(await ticketOf(other.id), 'reviewer');
    assert.deepStrictEqual(rev.map((x) => [x.task, x.pr, x.session.sessionId]), [[late.id, PR2, r.body.sessionId]]);
    await stop(r.body.id);
  });

  await t.test('an old ticket shows only what its ticket and task recorded', async () => {
    const old = (await R.call('POST', '/tickets', { title: 'From before', repo })).body.ticket;
    const started = (await R.call('POST', '/tickets/' + old.id + '/start', {})).body.task;
    await R.call('POST', '/tasks/' + started.id + '/move', { to: 'in_review' });
    const none = (await R.call('POST', '/tickets', { title: 'Never started', repo })).body.ticket;
    // As if this relay had kept no histories: they were not kept before.
    await R.kill();
    fs.rmSync(path.join(home, '.office-world', 'ticket-history.json'));
    R = await relay({ RELAY_WIP_LIMIT: '5' }, home);
    const now = await ticketOf(old.id);
    assert.deepStrictEqual(now.history.map((x) => [x.stage, x.by, x.old]), [['filed', 'you', true], ['approved', 'you', true], ['started', 'you', true], ['dev', null, true], ['moved', 'you', true]]);
    assert.strictEqual(steps(now, 'approved')[0].at, null, 'no time was recorded for the approval, so none is shown');
    const d = steps(now, 'dev')[0];
    assert.strictEqual(d.name, null, 'no name is guessed');
    assert.strictEqual(d.session.sessionId, started.owner.sessionId);
    assert.strictEqual(d.session.running, false, 'it did not come back with the restart');
    assert.strictEqual(d.session.folderGone, false, 'its checkout is still there, so Resume can bring it back');
    assert.strictEqual(now.assignee.role, 'dev', 'in review with no reviewer, its Dev still has it');
    const bare = await ticketOf(none.id);
    assert.deepStrictEqual(bare.history.map((x) => x.stage), ['filed', 'approved']);
    assert.strictEqual(bare.assignee, null);
  });
});
