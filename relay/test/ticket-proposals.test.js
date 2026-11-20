// T-200: The PM and the Lead propose to replace, merge or close a ticket, or to change its blockers.
// A proposal changes nothing until the person approves it on the Board, the way they approve a
// ticket. Approving a replace, merge or close rejects the ticket and says what it went into. A
// proposal holds the ticket back, so nothing starts it while it waits. No other session proposes,
// and no session decides.
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const PR = 'https://github.com/o/r/pull/7';
const CLI = path.join(__dirname, '..', 'ticket.js');

test('proposals to replace, merge, close or re-block a ticket wait for the person', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const start = async (extra) => (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
  const talk = async (s) => { await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12), title: '' }); await H.sleep(200); };
  const tokenOf = (s) => H.until(() => { try { return { 'X-Office-Token': H.sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');
  const file = async (title) => (await R.call('POST', '/tickets', { title, repo, body: 'Words of ' + title + '.', priority: 'normal' })).body.ticket.id;
  const ids = {};
  for (const title of ['Old', 'New1', 'New2', 'Dup', 'Keeper', 'Stale', 'Late', 'Early', 'Started', 'Done', 'Rejected']) { ids[title] = await file(title); await H.sleep(5); }
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.Done + '/move', { to: 'done', pr: PR })).status, 200);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.Rejected + '/move', { to: 'rejected' })).status, 200);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.Started + '/start', {})).status, 200);
  const lead = await start(), worker = await start(), reviewer = await start({ role: 'reviewer', pr: PR, title: 'Review' });
  await talk(lead);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
  const pm = await start({ role: 'pm', title: 'PM: an idea' });
  const leadT = await tokenOf(lead), workerT = await tokenOf(worker), reviewerT = await tokenOf(reviewer), pmT = await tokenOf(pm);
  const ticket = async (id) => (await R.call('GET', '/tickets/' + id)).body.ticket;
  const propose = (id, body, who) => R.call('POST', '/tickets/' + id + '/propose', body, who);
  const decide = (id, decision, who) => R.call('POST', '/tickets/' + id + '/proposal', { decision }, who);
  const archived = async (id) => (await R.call('GET', '/chat/' + id)).body.room.archived;
  const steps = async (id) => (await ticket(id)).history.filter((h) => /^proposal/.test(h.stage));

  await t.test('the PM proposes to replace a ticket, and nothing changes until the person approves', async () => {
    const r = await propose(ids.Old, { action: 'replace', ids: [ids.New1, ids.New2], why: 'Split into two smaller tickets.' }, pmT);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const now = await ticket(ids.Old);
    assert.strictEqual(now.status, 'ready');
    assert.deepStrictEqual([now.proposal.action, now.proposal.ids, now.proposal.why, now.proposal.by], ['replace', [ids.New1, ids.New2], 'Split into two smaller tickets.', 'PM']);
    assert.match(now.heldBack, /proposal/i, 'nothing starts it while the proposal waits');
    const h = await steps(ids.Old);
    assert.deepStrictEqual([h.at(-1).stage, h.at(-1).by, h.at(-1).action], ['proposal', 'PM', 'replace']);
  });

  await t.test('the person approves: the ticket is rejected as replaced, naming what replaced it', async () => {
    const r = await decide(ids.Old, 'approve');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const now = await ticket(ids.Old);
    assert.strictEqual(now.status, 'rejected');
    assert.deepStrictEqual([now.closedAs, now.closedFor], ['replaced', [ids.New1, ids.New2]]);
    assert.strictEqual(now.proposal, undefined);
    const h = await steps(ids.Old);
    assert.deepStrictEqual([h.at(-1).stage, h.at(-1).by, h.at(-1).action], ['proposal-approved', 'you', 'replace']);
    assert.strictEqual((await decide(ids.Old, 'approve')).status, 409, 'no proposal waits now');
    const gone = await H.until(() => archived(ids.Old), 'the chat channel to be archived');
    assert.strictEqual(gone.why, 'the ticket was replaced');
  });

  await t.test('merge: approving rejects the ticket as merged into the other one', async () => {
    assert.strictEqual((await propose(ids.Dup, { action: 'merge', ids: [ids.Keeper], why: 'Same work.' }, leadT)).status, 200);
    assert.strictEqual((await decide(ids.Dup, 'approve')).status, 200);
    const now = await ticket(ids.Dup);
    assert.deepStrictEqual([now.status, now.closedAs, now.closedFor], ['rejected', 'merged', [ids.Keeper]]);
    assert.strictEqual((await ticket(ids.Keeper)).status, 'ready', 'the ticket it went into stays');
    assert.strictEqual((await H.until(() => archived(ids.Dup), 'the chat channel to be archived')).why, 'the ticket was merged');
    assert.strictEqual(await archived(ids.Keeper), null, 'its chat channel stays open');
  });

  await t.test('close: declining leaves the ticket as it was', async () => {
    assert.strictEqual((await propose(ids.Stale, { action: 'close', why: 'No longer needed.' }, pmT)).status, 200);
    const r = await decide(ids.Stale, 'decline');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const now = await ticket(ids.Stale);
    assert.deepStrictEqual([now.status, now.proposal, now.heldBack], ['ready', undefined, null]);
    assert.strictEqual((await steps(ids.Stale)).at(-1).stage, 'proposal-declined');
    assert.strictEqual(await archived(ids.Stale), null, 'its chat channel stays open');
  });

  await t.test('blockers: approving sets the new list of blockers', async () => {
    const r = await propose(ids.Late, { action: 'blockers', ids: [ids.Early], why: 'It needs Early first.' }, pmT);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual((await ticket(ids.Late)).blockedBy, [], 'nothing changes yet');
    assert.strictEqual((await decide(ids.Late, 'approve')).status, 200);
    const now = await ticket(ids.Late);
    assert.deepStrictEqual([now.status, now.blockedBy, now.waitingFor], ['ready', [ids.Early], [ids.Early]]);
    assert.strictEqual(await archived(ids.Late), null, 'its chat channel stays open');
    assert.strictEqual((await propose(ids.Late, { action: 'blockers', ids: [] }, pmT)).status, 200, 'an empty list proposes no blockers');
  });

  await t.test('bad proposals are refused', async () => {
    for (const [id, body, error] of [
      [ids.Early, { action: 'blockers', ids: [ids.Late] }, 'bad_proposal'],
      [ids.Early, { action: 'blockers', ids: [ids.Early] }, 'bad_proposal'],
      [ids.Early, { action: 'replace', ids: [] }, 'bad_proposal'],
      [ids.Early, { action: 'replace', ids: ['T-999'] }, 'bad_proposal'],
      [ids.Early, { action: 'replace', ids: [ids.Rejected] }, 'bad_proposal'],
      [ids.Early, { action: 'blockers', ids: [ids.Rejected] }, 'bad_proposal'],
      [ids.Early, { action: 'merge', ids: [ids.New1, ids.New2] }, 'bad_proposal'],
      [ids.Early, { action: 'close', ids: [ids.New1] }, 'bad_proposal'],
      [ids.Early, { action: 'archive' }, 'bad_proposal'],
      [ids.Early, { action: 'close', why: 'x'.repeat(501) }, 'bad_proposal']
    ]) {
      const r = await propose(id, body, pmT);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
      assert.strictEqual(r.body.error, error);
    }
    assert.strictEqual((await ticket(ids.Early)).proposal, undefined);
  });

  await t.test('no proposals on a started, done or rejected ticket', async () => {
    for (const id of [ids.Started, ids.Done, ids.Rejected]) assert.strictEqual((await propose(id, { action: 'close' }, pmT)).status, 403, id);
  });

  await t.test('a worker and a reviewer cannot propose, and no session decides', async () => {
    for (const who of [workerT, reviewerT]) assert.strictEqual((await propose(ids.Early, { action: 'close' }, who)).status, 403);
    assert.strictEqual((await propose(ids.Early, { action: 'close' }, pmT)).status, 200);
    for (const who of [pmT, leadT, workerT]) assert.notStrictEqual((await decide(ids.Early, 'approve', who)).status, 200);
    assert.strictEqual((await ticket(ids.Early)).status, 'ready');
  });

  await t.test('a blockers proposal whose blocker is rejected before approval is refused', async () => {
    const a = await file('Waits'), b = await file('Blocker gone');
    assert.strictEqual((await propose(a, { action: 'blockers', ids: [b] }, pmT)).status, 200);
    assert.strictEqual((await R.call('POST', '/tickets/' + b + '/move', { to: 'rejected' })).status, 200);
    const r = await decide(a, 'approve');
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.message, /rejected, so .* cannot wait for it/);
    assert.deepStrictEqual((await ticket(a)).blockedBy, []);
  });

  await t.test('a proposal no longer true when approved is refused, and waits', async () => {
    assert.strictEqual((await propose(ids.New1, { action: 'merge', ids: [ids.New2] }, pmT)).status, 200);
    assert.strictEqual((await R.call('POST', '/tickets/' + ids.New2 + '/move', { to: 'rejected' })).status, 200);
    const r = await decide(ids.New1, 'approve');
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual((await ticket(ids.New1)).status, 'ready');
    assert.strictEqual((await decide(ids.New1, 'decline')).status, 200, 'the person can still decline it');
  });

  await t.test('the Board words a proposal and what a closed ticket went into', async () => {
    const M = require('../../office/board-model.js');
    assert.strictEqual((await propose(ids.Keeper, { action: 'replace', ids: [ids.New1, ids.Late], why: 'Split up.' }, pmT)).status, 200);
    const keeper = await ticket(ids.Keeper);
    assert.strictEqual(M.proposalText(keeper), 'The PM proposes to replace ' + ids.Keeper + ' with ' + ids.New1 + ', ' + ids.Late + '. Why: Split up.');
    assert.strictEqual(M.waitsOnYou(keeper), true, 'it is in the waiting on you line');
    assert.strictEqual(M.closedText(await ticket(ids.Old)), 'replaced by ' + ids.New1 + ', ' + ids.New2);
    assert.strictEqual(M.closedText(await ticket(ids.Dup)), 'merged into ' + ids.Keeper);
    assert.strictEqual(M.closedText(await ticket(ids.Rejected)), '');
  });

  await t.test('rejecting the ticket yourself drops its proposal', async () => {
    const id = await file('Dropped');
    assert.strictEqual((await propose(id, { action: 'close' }, pmT)).status, 200);
    assert.strictEqual((await R.call('POST', '/tickets/' + id + '/move', { to: 'rejected' })).status, 200);
    const now = await ticket(id);
    assert.deepStrictEqual([now.status, now.proposal, now.closedAs], ['rejected', undefined, undefined]);
    assert.strictEqual((await R.call('POST', '/tickets/' + id + '/move', { to: 'triage' })).status, 200);
    assert.strictEqual((await ticket(id)).proposal, undefined, 'back in Triage it has no old proposal');
  });

  await t.test('back in Triage, a ticket no longer says what replaced it', async () => {
    const id = await file('Brought back');
    assert.strictEqual((await propose(id, { action: 'replace', ids: [ids.Late] }, pmT)).status, 200);
    assert.strictEqual((await decide(id, 'approve')).status, 200);
    assert.strictEqual((await ticket(id)).closedAs, 'replaced');
    assert.strictEqual((await R.call('POST', '/tickets/' + id + '/move', { to: 'triage' })).status, 200);
    const now = await ticket(id);
    assert.deepStrictEqual([now.status, now.closedAs, now.closedFor], ['triage', null, null]);
  });

  await t.test('starting the ticket yourself drops its proposal', async () => {
    const id = await file('Started anyway');
    assert.strictEqual((await propose(id, { action: 'close' }, pmT)).status, 200);
    assert.strictEqual((await R.call('POST', '/tickets/' + id + '/start', {})).status, 200);
    assert.strictEqual((await ticket(id)).proposal, undefined);
    const h = await steps(id);
    assert.deepStrictEqual([h.at(-1).stage, h.at(-1).by, h.at(-1).action], ['proposal-dropped', 'you', 'close'], 'the history says where it went');
  });

  await t.test('ticket.js replace, merge, close and blockers', async () => {
    const env = (tok) => ({ ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: tok['X-Office-Token'] });
    const run = (args, tok) => spawnSync('node', [CLI, ...args], { env: env(tok || pmT), encoding: 'utf8' });
    let out = execFileSync('node', [CLI, 'replace', ids.Keeper, '--by', ids.New1 + ',' + ids.Late, '--why', 'Split up.'], { env: env(pmT), encoding: 'utf8' });
    assert.match(out, /^Proposed: replace /);
    assert.match(out, /the person approves or declines it/);
    assert.deepStrictEqual((await ticket(ids.Keeper)).proposal.ids, [ids.New1, ids.Late]);
    out = execFileSync('node', [CLI, 'merge', ids.Keeper, '--into', ids.Late], { env: env(pmT), encoding: 'utf8' });
    assert.match(out, /^Proposed: merge /);
    assert.strictEqual((await ticket(ids.Keeper)).proposal.action, 'merge', 'a new proposal takes the place of the old one');
    out = execFileSync('node', [CLI, 'blockers', ids.Keeper, '--blocked-by', 'none'], { env: env(leadT), encoding: 'utf8' });
    assert.match(out, /^Proposed: blockers /);
    assert.deepStrictEqual((await ticket(ids.Keeper)).proposal.ids, []);
    out = execFileSync('node', [CLI, 'close', ids.Keeper, '--why', 'Done another way.'], { env: env(pmT), encoding: 'utf8' });
    assert.match(out, /^Proposed: close /);
    const no = run(['close', ids.Keeper], workerT);
    assert.strictEqual(no.status, 1);
    assert.match(no.stderr, /Only the PM and the Lead propose/);
    const bad = run(['replace', ids.Keeper]);
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stderr, /--by/);
  });
});
