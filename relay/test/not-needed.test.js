// T-490: the Dev of a ticket's own task closes it as not needed, with the commit on main that did the work.
// The relay checks the commit, notes the reason, moves the task and the ticket to Done, frees the slot, ends
// the Dev's session and logs a not-needed jam by the relay. Anyone else, and a commit not on main, get a refusal.
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();

test('the task\'s own Dev closes its ticket as not needed', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  fs.writeFileSync(path.join(repo, 'fix.txt'), 'fixed\n');
  git(repo, 'add', 'fix.txt');
  git(repo, 'commit', '-qm', 'the fix');
  const onMain = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(repo, 'side.txt'), 'side\n');
  git(repo, 'add', 'side.txt');
  git(repo, 'commit', '-qm', 'not on main');
  const offMain = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');

  const file = async (title) => (await R.call('POST', '/tickets', { title, repo })).body.ticket;
  const begin = async (ticket) => {
    const task = (await R.call('POST', '/tickets/' + ticket.id + '/start', {})).body.task;
    const token = await H.until(() => { try { return { 'X-Office-Token': H.sessionToken(task.owner.sessionId) }; } catch (e) { return null; } }, 'the Dev token');
    return { task, token };
  };
  const close = (ticket, body, who) => R.call('POST', '/tickets/' + ticket.id + '/not-needed', body, who);
  const mine = await file('Already done'), other = await file('Someone else');
  const dev = await begin(mine), stranger = await begin(other);
  const reviewer = (await R.call('POST', '/terminals', { cwd: repo, role: 'reviewer', pr: 'https://github.com/o/r/pull/7', title: 'Review' })).body;
  const reviewerToken = await H.until(() => { try { return { 'X-Office-Token': H.sessionToken(reviewer.sessionId) }; } catch (e) { return null; } }, 'the reviewer token');
  const unchanged = async () => {
    const now = (await R.call('GET', '/tickets/' + mine.id)).body.ticket;
    assert.strictEqual(now.status, 'started');
    assert.strictEqual((await R.call('GET', '/tasks/' + dev.task.id)).body.task.state, 'building');
  };

  await t.test('a session that is not the task\'s Dev is refused', async () => {
    for (const who of [stranger.token, reviewerToken, undefined]) {
      const r = await close(mine, { commit: onMain, why: 'on main' }, who);
      assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    }
    await unchanged();
  });
  await t.test('a commit that is not on main, or is not a commit, is refused', async () => {
    assert.strictEqual((await close(mine, { commit: offMain, why: 'x' }, dev.token)).body.error, 'not_on_main');
    assert.strictEqual((await close(mine, { commit: 'deadbeef', why: 'x' }, dev.token)).body.error, 'not_on_main');
    assert.strictEqual((await close(mine, { commit: 'nope', why: 'x' }, dev.token)).body.error, 'bad_commit');
    assert.strictEqual((await close(mine, { commit: onMain, why: '' }, dev.token)).body.error, 'bad_why');
    await unchanged();
  });
  await t.test('a commit on main closes the task and the ticket, frees the slot, ends the session and logs a jam', async () => {
    const before = (await R.call('GET', '/tasks')).body.tasks.filter((x) => x.state === 'building' && x.worker).length;
    const r = await close(mine, { commit: onMain.slice(0, 10), why: 'T-154 fixed it' }, dev.token);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const ticket = (await R.call('GET', '/tickets/' + mine.id)).body.ticket;
    assert.deepStrictEqual([ticket.status, ticket.closedAs], ['done', 'not-needed']);
    assert.strictEqual(ticket.notNeeded.commit, onMain);
    assert.match(ticket.notes.at(-1).text, /T-154 fixed it/);
    assert.strictEqual((await R.call('GET', '/tasks/' + dev.task.id)).body.task.state, 'done');
    await H.until(async () => (await R.call('GET', '/tasks')).body.tasks.filter((x) => x.state === 'building' && x.worker).length === before - 1, 'the slot free');
    await H.until(async () => !(await R.call('GET', '/terminals')).body.terminals.some((x) => x.sessionId === dev.task.owner.sessionId && x.running), 'the session ended');
    const jams = (await R.call('GET', '/jams')).body.jams.filter((j) => j.kind === 'not-needed');
    assert.deepStrictEqual(jams.map((j) => [j.ticket, j.by]), [[mine.id, 'the relay']]);
    assert.match(jams[0].fix, /T-154 fixed it/);
  });
  await t.test('the Dev brief names the command, and the command asks for a commit and a reason', async () => {
    const fresh = await file('Brief check'), got = await begin(fresh);
    const seen = await H.until(async () => { const text = (await R.screen(got.task.owner.terminal)).replace(/\s+/g, ' '); return /GOT\[Your task is to build/.test(text) && text; }, 'the brief typed');
    assert.match(seen, /ticket\.js not-needed \S+ --commit <sha> --why/);
    const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: got.token['X-Office-Token'] };
    const run = (args) => spawnSync('node', [path.join(__dirname, '..', 'ticket.js'), ...args], { env, encoding: 'utf8' });
    for (const args of [['not-needed', fresh.id, '--why', 'x'], ['not-needed', fresh.id, '--commit', onMain]]) {
      const out = run(args);
      assert.strictEqual(out.status, 1);
      assert.match(out.stderr, /Use: ticket\.js not-needed/);
    }
  });
  await t.test('a reason over 500 characters is refused', async () => {
    const r = await close(other, { commit: onMain, why: 'x'.repeat(501) }, stranger.token);
    assert.deepStrictEqual([r.status, r.body.error], [400, 'bad_why']);
  });
  await t.test('a task the person already moved to done is refused with bad_move', async () => {
    assert.strictEqual((await R.call('POST', '/tasks/' + stranger.task.id + '/move', { to: 'done' })).status, 200);
    const r = await close(other, { commit: onMain, why: 'on main' }, stranger.token);
    assert.deepStrictEqual([r.status, r.body.error], [409, 'bad_move']);
  });
  await t.test('a second close is refused and changes nothing', async () => {
    const again = await close(mine, { commit: onMain, why: 'again' }, dev.token);
    assert.strictEqual(again.status, 401, JSON.stringify(again.body));
    assert.strictEqual((await R.call('GET', '/jams')).body.jams.filter((j) => j.kind === 'not-needed').length, 1);
  });
  await t.test('a task with a PR is refused: it is done when the PR merges', async () => {
    const third = await file('Has a PR'), has = await begin(third);
    await R.hook({ hook_event_name: 'PostToolUse', session_id: has.task.owner.sessionId.slice(0, 12), pr_url: 'https://github.com/o/r/pull/9' });
    await H.until(async () => (await R.call('GET', '/tasks/' + has.task.id)).body.task.pr, 'the PR on the task');
    const r = await close(third, { commit: onMain, why: 'on main' }, has.token);
    assert.deepStrictEqual([r.status, r.body.error], [409, 'has_pr']);
    assert.strictEqual((await R.call('GET', '/tickets/' + third.id)).body.ticket.status, 'started');
  });
});
