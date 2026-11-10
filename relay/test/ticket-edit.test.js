// T-90: Edit a ticket's title, body and priority. The person, the PM and the Lead edit a ticket in Triage
// or Ready, with the limits of filing one. A worker's or reviewer's token gets 403, and nobody edits a
// ticket once it has started. Priority still needs the PM's or the Lead's switch. Each edit is in the
// ticket's history.
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const PR = 'https://github.com/o/r/pull/7';
const CLI = path.join(__dirname, '..', 'ticket.js');

test('who can edit a ticket, and in which state', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const start = async (extra) => (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
  const talk = async (s) => { await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12), title: '' }); await H.sleep(200); };
  const tokenOf = (s) => H.until(() => { try { return { 'X-Office-Token': H.sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');
  const file = async (title) => (await R.call('POST', '/tickets', { title, repo, body: 'The first words.', priority: 'normal' })).body.ticket.id;
  const ids = {};
  for (const title of ['A', 'B', 'Started', 'Done', 'Rejected']) { ids[title] = await file(title); await H.sleep(5); }
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.Done + '/move', { to: 'done', pr: PR })).status, 200);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.Rejected + '/move', { to: 'rejected' })).status, 200);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.Started + '/start', {})).status, 200);
  const lead = await start(), worker = await start(), reviewer = await start({ role: 'reviewer', pr: PR, title: 'Review' });
  await talk(lead);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
  const pm = await start({ role: 'pm', title: 'PM: an idea' });
  const leadT = await tokenOf(lead), workerT = await tokenOf(worker), reviewerT = await tokenOf(reviewer), pmT = await tokenOf(pm);
  ids.T = (await R.call('POST', '/tickets', { title: 'In triage', body: 'From a worker.' }, workerT)).body.ticket.id;
  const ticket = async (id) => (await R.call('GET', '/tickets/' + id)).body.ticket;
  const edit = (id, changes, who) => R.call('POST', '/tickets/' + id + '/edit', changes, who);
  const edits = async (id) => (await ticket(id)).history.filter((h) => h.stage === 'edited');
  const words = (x) => [x.title, x.body, x.priority];

  await t.test('the person edits title, body and priority of a Ready ticket, and the history says so', async () => {
    const r = await edit(ids.A, { title: 'A, with a link', body: 'The first words. See https://example.com/x', priority: 'high' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(words(r.body.ticket), ['A, with a link', 'The first words. See https://example.com/x', 'high']);
    assert.strictEqual(r.body.ticket.status, 'ready');
    assert.strictEqual(r.body.ticket.approved, true, 'your own edit keeps your approval');
    const h = await edits(ids.A);
    assert.strictEqual(h.length, 1);
    assert.strictEqual(h[0].by, 'you');
    assert.deepStrictEqual(h[0].what, ['title', 'body', 'priority']);
    assert.ok(h[0].at);
  });

  await t.test('only what is given changes, and nothing new is not an edit', async () => {
    let r = await edit(ids.A, { body: 'Only the body.' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(words(r.body.ticket), ['A, with a link', 'Only the body.', 'high']);
    r = await edit(ids.A, { title: 'A, with a link', body: 'Only the body.' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.unchanged, true);
    const h = await edits(ids.A);
    assert.strictEqual(h.length, 2);
    assert.deepStrictEqual(h[1].what, ['body']);
  });

  await t.test('the limits of filing: a title of 1 to 80 characters, a body of up to 8000, a known priority', async () => {
    const before = words(await ticket(ids.B));
    for (const [changes, error] of [[{ title: 'x'.repeat(81) }, 'bad_title'], [{ title: '  ' }, 'bad_title'], [{ body: 'x'.repeat(8001) }, 'bad_body'], [{ priority: 'urgent' }, 'bad_priority'], [{}, 'bad_param'], [{ status: 'done' }, 'bad_param']]) {
      const r = await edit(ids.B, changes);
      assert.strictEqual(r.status, 400, JSON.stringify(changes));
      assert.strictEqual(r.body.error, error);
    }
    assert.deepStrictEqual(words(await ticket(ids.B)), before);
    assert.strictEqual((await edit(ids.B, { title: 'x'.repeat(80), body: 'x'.repeat(8000) })).status, 200);
    assert.strictEqual((await edit(ids.B, { title: 'B' })).status, 200);
  });

  await t.test('a title another open ticket in the repo has is refused', async () => {
    const r = await edit(ids.B, { title: 'a, WITH a link' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'duplicate');
    assert.strictEqual((await ticket(ids.B)).title, 'B');
  });

  await t.test('the PM and the Lead cannot rename a ticket to a title the person rejected, and the person can', async () => {
    for (const who of [pmT, leadT]) {
      const r = await edit(ids.B, { title: 'rejected' }, who);
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.body.error, 'duplicate');
      assert.match(r.body.message, /the person rejected it/);
    }
    assert.strictEqual((await ticket(ids.B)).title, 'B');
    const mine = await edit(ids.B, { title: 'Rejected' });
    assert.strictEqual(mine.status, 200, 'you may bring it back');
    assert.deepStrictEqual(mine.body.edited, ['title']);
    assert.strictEqual((await edit(ids.B, { title: 'B' })).status, 200);
  });

  await t.test('nobody edits a started, done or rejected ticket', async () => {
    for (const id of [ids.Started, ids.Done, ids.Rejected]) {
      const before = words(await ticket(id));
      const mine = await edit(id, { title: 'Changed' });
      assert.strictEqual(mine.status, 409, id);
      assert.strictEqual(mine.body.error, 'not_ready');
      for (const who of [pmT, leadT]) assert.strictEqual((await edit(id, { title: 'Changed' }, who)).status, 403, id);
      assert.deepStrictEqual(words(await ticket(id)), before);
    }
  });

  await t.test('a worker and a reviewer get 403, and nothing changes', async () => {
    for (const who of [workerT, reviewerT]) {
      for (const id of [ids.B, ids.T]) {
        const before = words(await ticket(id));
        const r = await edit(id, { title: 'Changed', body: 'Changed' }, who);
        assert.strictEqual(r.status, 403);
        assert.deepStrictEqual(words(await ticket(id)), before);
      }
    }
  });

  await t.test('the PM edits title and body in Triage and Ready, and the history names it', async () => {
    let r = await edit(ids.T, { title: 'In triage, clearer', body: 'From a worker, with a link.' }, pmT);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(words(r.body.ticket), ['In triage, clearer', 'From a worker, with a link.', 'normal']);
    assert.strictEqual(r.body.ticket.status, 'triage');
    const h = await edits(ids.T);
    assert.strictEqual(h.at(-1).by, 'PM');
    assert.strictEqual(h.at(-1).role, 'pm');
    r = await edit(ids.B, { body: 'The PM made it clearer.' }, pmT);
    assert.strictEqual(r.status, 200);
  });

  await t.test('the PM and the Lead set priority through an edit only with their switch on', async () => {
    for (const [who, name, sw] of [[pmT, 'PM', 'pmOrder'], [leadT, 'Lead', 'leadOrder']]) {
      const before = words(await ticket(ids.T));
      const off = await edit(ids.T, { title: 'Not this', priority: 'low' }, who);
      assert.strictEqual(off.status, 403, name);
      assert.deepStrictEqual(words(await ticket(ids.T)), before, 'nothing changes, not even the title');
      assert.strictEqual((await R.call('POST', '/settings', { values: { [sw]: true } })).status, 200);
      const on = await edit(ids.T, { priority: 'low' }, who);
      assert.strictEqual(on.status, 200, name);
      assert.strictEqual(on.body.ticket.priority, 'low');
      assert.strictEqual(on.body.ticket.orderedBy, name);
      assert.strictEqual((await edit(ids.T, { priority: 'normal' }, who)).status, 200);
      assert.strictEqual((await R.call('POST', '/settings', { values: { [sw]: false } })).status, 200);
    }
  });

  await t.test('the Lead edits a Ready ticket, and a session\'s edit takes back your approval', async () => {
    assert.strictEqual((await ticket(ids.B)).approved, false, 'the PM\'s edit above took it back');
    assert.strictEqual((await R.call('POST', '/tickets/approve-ready', { ids: [ids.B] })).status, 200);
    assert.strictEqual((await ticket(ids.B)).approved, true);
    const r = await edit(ids.B, { title: 'B, by the Lead' }, leadT);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ticket.title, 'B, by the Lead');
    assert.strictEqual(r.body.ticket.status, 'ready');
    assert.strictEqual(r.body.ticket.approved, false, 'you approved other words');
    assert.strictEqual(r.body.approvalTaken, true);
    const h = await edits(ids.B);
    assert.strictEqual(h.at(-1).by, 'Lead');
    assert.deepStrictEqual(h.at(-1).what, ['title']);
    // Approve all Ready offers it again, for you to read first.
    assert.strictEqual((await R.call('POST', '/tickets/approve-ready', { ids: [ids.B] })).body.approved[0], ids.B);
  });
  await t.test('ticket.js edit: a title, a body from stdin, and a worker is refused', async () => {
    const env = (tok) => ({ ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: tok['X-Office-Token'] });
    const body = 'Line one with `backticks` and $(not run)\nLine two';
    const out = execFileSync('node', [CLI, 'edit', ids.T, '--title', 'In triage, from the CLI', '--body', '-'], { env: env(pmT), input: body, encoding: 'utf8' });
    assert.match(out, /^Edited: /);
    const now = await ticket(ids.T);
    assert.deepStrictEqual([now.title, now.body], ['In triage, from the CLI', body]);
    const again = execFileSync('node', [CLI, 'edit', ids.T, '--title', 'In triage, from the CLI'], { env: env(pmT), encoding: 'utf8' });
    assert.match(again, /^Nothing new/);
    const no = spawnSync('node', [CLI, 'edit', ids.T, '--title', 'No'], { env: env(workerT), encoding: 'utf8' });
    assert.strictEqual(no.status, 1);
    assert.match(no.stderr, /Only the person, the PM and the Lead edit a ticket/);
    const stray = spawnSync('node', [CLI, 'edit', ids.T, 'A', 'title', 'without', 'the', 'flag'], { env: env(pmT), encoding: 'utf8' });
    assert.strictEqual(stray.status, 1);
    assert.match(stray.stderr, /--title/);
  });
});
