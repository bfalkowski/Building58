// T-45: Let the PM set the order. While the person's switch is on, the PM's token sets the priority and
// place of Triage and Ready tickets, and nothing else. Every other session's token gets 403 either way.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const PR = 'https://github.com/o/r/pull/7';
const switchTo = (R, on) => R.call('POST', '/settings', { values: { pmOrder: on } });
const switchNow = async (R) => (await R.call('GET', '/settings')).body.settings.find((s) => s.name === 'pmOrder').value;

test('the PM sets priority and order only with the switch on, only in Triage or Ready, and never a status', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const start = async (extra) => (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
  const tokenOf = (s) => H.until(() => { try { return { 'X-Office-Token': H.sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');
  const file = async (title, priority) => (await R.call('POST', '/tickets', { title, repo, priority })).body.ticket.id;
  const ids = {};
  for (const title of ['A', 'B', 'C', 'Started', 'Done', 'Rejected']) { ids[title] = await file(title, 'normal'); await H.sleep(5); }
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.Done + '/move', { to: 'done', pr: PR })).status, 200);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.Rejected + '/move', { to: 'rejected' })).status, 200);
  assert.strictEqual((await R.call('POST', '/tickets/' + ids.Started + '/start', {})).status, 200);
  // A worker files one, which waits in Triage.
  const worker = await start(), reviewer = await start({ role: 'reviewer', pr: PR, title: 'Review' });
  const workerT = await tokenOf(worker), reviewerT = await tokenOf(reviewer);
  ids.T = (await R.call('POST', '/tickets', { title: 'In triage', priority: 'normal' }, workerT)).body.ticket.id;
  const pm = await start({ role: 'pm', title: 'PM: an idea' });
  const pmT = await tokenOf(pm);
  const ticket = async (id) => (await R.call('GET', '/tickets/' + id)).body.ticket;
  const prio = (id, priority, who) => R.call('POST', '/tickets/' + id + '/priority', { priority }, who);
  const order = (id, where, who) => R.call('POST', '/tickets/' + id + '/order', where, who);
  const titles = async () => (await R.call('GET', '/tickets')).body.tickets.map((x) => x.title);

  await t.test('off by default: the PM gets 403 and nothing changes', async () => {
    assert.strictEqual(await switchNow(R), false);
    const before = await titles();
    const r = await prio(ids.C, 'high', pmT);
    assert.strictEqual(r.status, 403);
    assert.match(r.body.message, /Let the PM set the order/);
    assert.strictEqual((await order(ids.C, { before: ids.A }, pmT)).status, 403);
    assert.deepStrictEqual(await titles(), before);
  });

  await t.test('a worker and a reviewer get 403 with the switch off', async () => {
    for (const who of [workerT, reviewerT]) {
      assert.strictEqual((await prio(ids.C, 'high', who)).status, 403);
      assert.strictEqual((await order(ids.C, { before: ids.A }, who)).status, 403);
    }
  });

  await t.test('on: the PM sets priority and order on Triage and Ready tickets, and the ticket says so', async () => {
    assert.strictEqual((await switchTo(R, true)).status, 200);
    let r = await prio(ids.C, 'high', pmT);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ticket.priority, 'high');
    assert.strictEqual(r.body.ticket.orderedBy, 'PM');
    assert.strictEqual(r.body.ticket.orderedWhat, 'priority');
    r = await order(ids.B, { before: ids.A }, pmT);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ticket.orderedBy, 'PM');
    assert.strictEqual(r.body.ticket.orderedWhat, 'place');
    assert.deepStrictEqual((await titles()).slice(0, 3), ['C', 'B', 'A']);
    r = await prio(ids.T, 'low', pmT);
    assert.strictEqual(r.status, 200, 'a Triage ticket');
    assert.strictEqual(r.body.ticket.status, 'triage');
  });

  await t.test('on: the PM gets 403 on a started, done or rejected ticket', async () => {
    for (const id of [ids.Started, ids.Done, ids.Rejected]) {
      const before = await ticket(id);
      assert.strictEqual((await prio(id, 'high', pmT)).status, 403, id);
      assert.strictEqual((await order(id, { before: ids.A }, pmT)).status, 403, id);
      const after = await ticket(id);
      assert.deepStrictEqual([after.priority, after.rank, after.orderedBy], [before.priority, before.rank, before.orderedBy]);
    }
  });

  await t.test('on or off: the PM gets 403 on any status change, start or base', async () => {
    for (const on of [true, false]) {
      await switchTo(R, on);
      assert.strictEqual((await R.call('POST', '/tickets/' + ids.T + '/move', { to: 'ready' }, pmT)).status, 403);
      assert.strictEqual((await R.call('POST', '/tickets/' + ids.A + '/move', { to: 'rejected' }, pmT)).status, 403);
      assert.strictEqual((await R.call('POST', '/tickets/' + ids.A + '/start', {}, pmT)).status, 403);
      assert.strictEqual((await R.call('POST', '/tickets/' + ids.A + '/base', { base: 'main' }, pmT)).status, 403);
      assert.strictEqual((await ticket(ids.T)).status, 'triage');
      assert.strictEqual((await ticket(ids.A)).status, 'ready');
    }
    await switchTo(R, true);
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
    let r = await prio(ids.C, 'normal');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ticket.orderedBy, 'you');
    assert.strictEqual(r.body.ticket.orderedWhat, 'priority');
    r = await order(ids.B, { after: ids.A });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ticket.orderedBy, 'you');
    assert.strictEqual(r.body.ticket.orderedWhat, 'place');
    assert.strictEqual((await prio(ids.Started, 'high')).status, 409, 'the person still gets 409 on a started ticket');
  });

  await t.test('ticket.js priority and order work for the PM', async () => {
    const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: pmT['X-Office-Token'] };
    const cli = (...args) => execFileSync('node', [path.join(H.ROOT, 'relay', 'ticket.js'), ...args], { env, encoding: 'utf8' });
    assert.match(cli('priority', ids.A, 'high'), new RegExp('^Priority: ' + ids.A + ' {2}high {2}A'));
    assert.match(cli('priority', ids.A, 'high'), new RegExp('^Already high, nothing changed: ' + ids.A), 'a priority it already has');
    assert.match(cli('order', ids.C, '--before', ids.B), new RegExp('^Placed: ' + ids.C + ' {2}before ' + ids.B));
    assert.strictEqual((await ticket(ids.C)).orderedBy, 'PM');
    // The PM leaves a ticket the person set as it is (T-46), so the list says which ones those are.
    const line = (id) => cli('list').split('\n').find((l) => l.startsWith(id + '  '));
    assert.match(line(ids.B), /\(set by the person\)$/, 'the person placed B');
    assert.doesNotMatch(line(ids.C), /set by the person/, 'the PM placed C');
    assert.throws(() => execFileSync('node', [path.join(H.ROOT, 'relay', 'ticket.js'), 'priority', ids.Done, 'low'], { env, encoding: 'utf8', stdio: 'pipe' }), /Triage or Ready/);
  });

  await t.test('only the PM that started last may set the order', async () => {
    const newer = await start({ role: 'pm', title: 'PM: another idea' });
    const newerT = await tokenOf(newer);
    assert.strictEqual((await prio(ids.B, 'low', pmT)).status, 403);
    assert.strictEqual((await prio(ids.B, 'low', newerT)).status, 200);
  });
});

test('the switch stays off after a restart unless the person turned it on', async (t) => {
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

// T-46: the PM's brief gives each ticket a priority and names the goal the order follows. With the switch
// on it places and reorders Triage and Ready tickets. With it off it only recommends an order.
test('the PM\'s brief asks for a priority on each ticket, and orders the work only with the switch on', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const briefOf = async (idea) => {
    const r = await R.call('POST', '/tickets/ask', { idea, repo });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const screen = await H.until(async () => { const s = await R.screen(r.body.terminal); return s.includes('GOT[') && s; }, 'the brief');
    assert.ok(screen.includes('PASTED GOT[You are the product manager'), 'it went in as one paste');
    return screen.match(/GOT\[(You are the product manager[^\]\r\n]*)\]/)[1];
  };
  const off = await briefOf('An idea while off');
  assert.strictEqual((await switchTo(R, true)).status, 200);
  // Longer than Claude Code reads at once (T-34), so the end has to arrive too.
  const long = 'A long idea ' + 'with many words '.repeat(100) + 'that ends here';
  const on = await briefOf(long);

  for (const [name, brief] of [['off', off], ['on', on]]) {
    assert.ok(brief.includes('--priority high, normal or low on each'), name + ': a priority on each ticket');
    assert.ok(brief.includes('stronger checks first, then fewer decisions for the person, then a truer room, then looks'), name + ': the goal');
    assert.match(brief, /Do not change any code, commit, or open a pull request/, name);
    assert.match(brief, /stop once they are filed/, name);
    assert.match(brief, /end with one short list/, name);
    // T-239: wording changes to CLAUDE.md and the constitution gather in one ticket, apart from code tickets.
    assert.match(brief, /File code tickets without changes to CLAUDE\.md or docs\/constitution\.md/, name);
    assert.ok(brief.includes('into one open ticket, the one in Triage or Ready'), name + ': one grouped ticket');
    assert.match(brief, /ticket\.js edit ID --body -/, name + ': it adds to the open one');
    assert.ok(brief.includes('the one in Triage or Ready whose title starts with "CLAUDE.md and constitution updates"'), name + ': a dated one counts too');
    assert.match(brief, /If create says Already filed because that title has started or was rejected, file it as "CLAUDE\.md and constitution updates, " and today's date/, name + ': a rejected title does not stop the next one');
    assert.match(brief, /Each change you add takes back the person's approval/, name);
  }
  assert.ok(on.endsWith('The idea: ' + long), 'the whole brief arrived, idea last');
  assert.ok(off.endsWith('The idea: An idea while off'));

  assert.ok(on.includes('ticket.js order ID --before ID'), 'on: it places new tickets');
  assert.ok(on.includes('reorder Triage and Ready tickets'), 'on: it reorders Triage and Ready');
  assert.ok(on.includes('Leave a ticket marked set by the person as it is'), 'on: it does not undo the person');
  assert.ok(on.includes('what you changed and why'), 'on: it says what it changed');
  assert.ok(off.includes('Do not run ticket.js priority or order'), 'off: it does not try the commands');
  assert.ok(off.includes('the order you recommend'), 'off: it recommends an order');
  assert.doesNotMatch(off, /order ID --before/);
  assert.notStrictEqual(on.slice(0, on.indexOf('The idea:')), off.slice(0, off.indexOf('The idea:')));
});
