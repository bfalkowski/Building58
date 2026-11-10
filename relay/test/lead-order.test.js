// T-128: Let the Lead set priority. While the person's switch is on, the Lead's token sets the priority
// and place of Triage and Ready tickets, and nothing else. Every worker's and reviewer's token gets 403 either way.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const PR = 'https://github.com/o/r/pull/7';
const switchTo = (R, on) => R.call('POST', '/settings', { values: { leadOrder: on } });
const switchNow = async (R) => (await R.call('GET', '/settings')).body.settings.find((s) => s.name === 'leadOrder').value;

test('the Lead sets priority and order only with the switch on, only in Triage or Ready, and never a status', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const start = async (extra) => (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
  const talk = async (s) => { await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12), title: '' }); await H.sleep(200); };
  const tokenOf = (s) => H.until(() => { try { return { 'X-Office-Token': H.sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');
  const file = async (title) => (await R.call('POST', '/tickets', { title, repo, priority: 'normal' })).body.ticket.id;
  const ids = {};
  for (const title of ['A', 'B', 'C', 'Started', 'Done', 'Rejected']) { ids[title] = await file(title); await H.sleep(5); }
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.Done + '/move', { to: 'done', pr: PR })).status, 200);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.Rejected + '/move', { to: 'rejected' })).status, 200);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.Started + '/start', {})).status, 200);
  const lead = await start(), worker = await start(), reviewer = await start({ role: 'reviewer', pr: PR, title: 'Review' });
  await talk(lead);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
  const leadT = await tokenOf(lead), workerT = await tokenOf(worker), reviewerT = await tokenOf(reviewer);
  // A worker files one, which waits in Triage.
  ids.T = (await R.call('POST', '/tickets', { title: 'In triage', priority: 'normal' }, workerT)).body.ticket.id;
  const ticket = async (id) => (await R.call('GET', '/tickets/' + id)).body.ticket;
  const prio = (id, priority, who) => R.call('POST', '/tickets/' + id + '/priority', { priority }, who);
  const order = (id, where, who) => R.call('POST', '/tickets/' + id + '/order', where, who);
  const titles = async () => (await R.call('GET', '/tickets')).body.tickets.map((x) => x.title);

  await t.test('off by default: the Lead gets 403 and nothing changes', async () => {
    assert.strictEqual(await switchNow(R), false);
    const before = await titles();
    const r = await prio(ids.C, 'high', leadT);
    assert.strictEqual(r.status, 403);
    assert.match(r.body.message, /Let the Lead set priority/);
    assert.strictEqual((await order(ids.C, { before: ids.A }, leadT)).status, 403);
    assert.deepStrictEqual(await titles(), before);
  });

  await t.test('a worker and a reviewer get 403 with the switch off', async () => {
    for (const who of [workerT, reviewerT]) {
      assert.strictEqual((await prio(ids.C, 'high', who)).status, 403);
      assert.strictEqual((await order(ids.C, { before: ids.A }, who)).status, 403);
    }
  });

  await t.test('on: the Lead sets priority and order on Triage and Ready tickets, and the ticket says so', async () => {
    assert.strictEqual((await switchTo(R, true)).status, 200);
    let r = await prio(ids.C, 'high', leadT);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ticket.priority, 'high');
    assert.strictEqual(r.body.ticket.orderedBy, 'Lead');
    assert.strictEqual(r.body.ticket.orderedWhat, 'priority');
    r = await order(ids.B, { before: ids.A }, leadT);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ticket.orderedBy, 'Lead');
    assert.strictEqual(r.body.ticket.orderedWhat, 'place');
    assert.deepStrictEqual((await titles()).slice(0, 3), ['C', 'B', 'A']);
    r = await prio(ids.T, 'low', leadT);
    assert.strictEqual(r.status, 200, 'a Triage ticket');
    assert.strictEqual(r.body.ticket.status, 'triage');
  });

  await t.test('on: the Lead gets 403 on a started, done or rejected ticket', async () => {
    for (const id of [ids.Started, ids.Done, ids.Rejected]) {
      const before = await ticket(id);
      assert.strictEqual((await prio(id, 'high', leadT)).status, 403, id);
      assert.strictEqual((await order(id, { before: ids.A }, leadT)).status, 403, id);
      const after = await ticket(id);
      assert.deepStrictEqual([after.priority, after.rank, after.orderedBy], [before.priority, before.rank, before.orderedBy]);
    }
  });

  await t.test('on: the switch does not let the Lead move, start or rebase a ticket', async () => {
    assert.strictEqual((await R.call('POST', '/tickets/' + ids.T + '/move', { to: 'ready' }, leadT)).status, 401);
    assert.strictEqual((await R.call('POST', '/tickets/' + ids.A + '/start', {}, leadT)).status, 401);
    assert.strictEqual((await R.call('POST', '/tickets/' + ids.A + '/base', { base: 'main' }, leadT)).status, 401);
    assert.strictEqual((await ticket(ids.T)).status, 'triage');
    assert.strictEqual((await ticket(ids.A)).status, 'ready');
  });

  await t.test('a worker and a reviewer get 403 with the switch on', async () => {
    const before = await titles();
    for (const who of [workerT, reviewerT]) {
      assert.strictEqual((await prio(ids.A, 'low', who)).status, 403);
      assert.strictEqual((await order(ids.A, { before: ids.B }, who)).status, 403);
    }
    assert.deepStrictEqual(await titles(), before);
  });

  await t.test('the person changes any priority or order, and it is recorded as theirs', async () => {
    const r = await prio(ids.C, 'normal');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ticket.orderedBy, 'you');
  });

  await t.test('ticket.js priority and order work for the Lead', async () => {
    const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: leadT['X-Office-Token'] };
    const cli = (...args) => execFileSync('node', [path.join(H.ROOT, 'relay', 'ticket.js'), ...args], { env, encoding: 'utf8' });
    assert.match(cli('priority', ids.A, 'high'), new RegExp('^Priority: ' + ids.A + ' {2}high {2}A'));
    assert.match(cli('order', ids.C, '--before', ids.B), new RegExp('^Placed: ' + ids.C + ' {2}before ' + ids.B));
    assert.strictEqual((await ticket(ids.C)).orderedBy, 'Lead');
    assert.throws(() => execFileSync('node', [path.join(H.ROOT, 'relay', 'ticket.js'), 'priority', ids.Done, 'low'], { env, encoding: 'utf8', stdio: 'pipe' }), /Triage or Ready/);
  });

  await t.test('a session that is no longer the Lead gets 403', async () => {
    await talk(worker);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: worker.id })).status, 200);
    assert.strictEqual((await prio(ids.B, 'low', leadT)).status, 403, 'the old Lead');
    assert.strictEqual((await prio(ids.B, 'low', workerT)).status, 200, 'the new Lead');
  });

  await t.test('turned off again, the Lead gets 403', async () => {
    assert.strictEqual((await switchTo(R, false)).status, 200);
    assert.strictEqual((await prio(ids.B, 'high', workerT)).status, 403);
  });
});

test('the Lead\'s switch stays off after a restart unless the person turned it on', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
  let R = null;
  t.after(async () => { if (R) await R.kill(); fs.rmSync(home, { recursive: true, force: true }); });
  const restart = async () => { if (R) await R.kill(); R = await H.relay({}, home); };
  await restart();
  assert.strictEqual(await switchNow(R), false, 'off on a new relay');
  await restart();
  assert.strictEqual(await switchNow(R), false, 'still off after a restart');
  assert.strictEqual((await switchTo(R, true)).status, 200);
  await restart();
  assert.strictEqual(await switchNow(R), true, 'on after a restart, since the person turned it on');
  assert.strictEqual((await switchTo(R, false)).status, 200);
  await restart();
  assert.strictEqual(await switchNow(R), false, 'off again after the person turned it off');
});
