// T-386: PM trust. Before Autopilot starts a ticket, the PM checks it and answers with ticket.js advise. What the
// answer does depends on the rung: 1 Advise writes it on the ticket, 2 Hold and propose files a proposal and the
// ticket does not start, 3 Order lets the PM set the order, 4 Close and merge carries the close or merge out. The
// check never blocks the room: no PM, or no answer in time, and Autopilot starts the ticket and says why.
'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const CHECK = 'GOT[PM check from the relay, before Autopilot starts ';
const SORT = 'GOT[PM sort from the relay';
const sid = (s) => s.sessionId.slice(0, 12);
const rung = (R, n) => R.call('POST', '/settings', { values: { pmTrust: n } });
const setting = async (R, name) => (await R.call('GET', '/settings')).body.settings.find((s) => s.name === name);

async function room(env) {
  const R = await H.relay({ RELAY_AUTOPILOT_TICK_MS: '200', ...env });
  const repo = H.makeRepo(R.home);
  assert.strictEqual((await R.call('POST', '/settings', { values: { autopilotAtOnce: 5, wipLimit: 10 } })).status, 200);
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const ticket = async (id) => (await R.call('GET', '/tickets/' + id)).body.ticket;
  const ready = async (title, extra) => (await R.call('POST', '/tickets', { title, body: 'Do ' + title + '.', repo, ...extra })).body.ticket.id;
  let worker = null;
  const triage = async (title) => {
    if (!worker) {
      const w = await R.start({ cwd: repo });
      worker = await H.until(() => { try { return { 'X-Office-Token': H.sessionToken(w.sessionId) }; } catch (e) { return null; } }, 'the worker token');
    }
    return (await R.call('POST', '/tickets', { title, body: 'Do ' + title + '.' }, worker)).body.ticket.id;
  };
  const pmSeat = async () => {
    const pm = await R.start({ cwd: repo, role: 'pm', title: 'PM: an idea' });
    await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid(pm) });
    await R.hook({ hook_event_name: 'Stop', session_id: sid(pm) });
    const token = await H.until(() => { try { return { 'X-Office-Token': H.sessionToken(pm.sessionId) }; } catch (e) { return null; } }, 'the PM token');
    const asked = async (id) => (await R.screen(pm.id)).includes(CHECK + id + '.');
    const idle = async () => { await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid(pm) }); await R.hook({ hook_event_name: 'Stop', session_id: sid(pm) }); };
    const advise = (id, body) => R.call('POST', '/tickets/' + id + '/advice', body, token);
    return { pm, token, asked, idle, advise };
  };
  const taskOf = async (id) => (await R.call('GET', '/tasks')).body.tasks.find((x) => x.ticket === id);
  return { R, repo, ap, ticket, ready, triage, pmSeat, taskOf };
}

test('rung 1, Advise: the PM checks the ticket, the advice is on it, and Autopilot starts it anyway', async (t) => {
  const { R, ap, ticket, ready, triage, pmSeat, taskOf } = await room({ RELAY_PM_CHECK_MS: '60000' });
  t.after(R.stop);
  assert.strictEqual((await setting(R, 'pmTrust')).value, 1, 'the default is Advise');
  const other = await triage('Other work');
  const id = await ready('Work that repeats another');
  const seat = await pmSeat();
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true })).status, 200);
  await H.until(() => seat.asked(id), 'the check brief');
  const screen = await R.screen(seat.pm.id);
  assert.match(screen, /main: search the code and docs\/manual/);
  assert.match(screen, /what keeps the room working \(stalls, lost work, broken setup\), security, what the person marked high, then the rest/);
  assert.match(screen, /A low priority ticket at the top of Ready is the first thing to question/);
  assert.strictEqual((await taskOf(id)), undefined, 'nothing starts before the PM answers');
  assert.match((await ap()).idle, new RegExp('Waiting for the PM to check ' + id));
  const r = await seat.advise(id, { answer: 'duplicate', of: other, why: 'Same work as ' + other + '.' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.did, 'advised');
  await H.until(() => taskOf(id), 'Autopilot to start it anyway');
  const t1 = await ticket(id);
  assert.strictEqual(t1.status, 'started');
  assert.strictEqual(t1.proposal, undefined);
  assert.ok(t1.notes.some((n) => n.by === 'PM' && /^PM check, a duplicate \(.+\): Same work as/.test(n.text)), JSON.stringify(t1.notes));
  assert.ok(t1.history.some((h) => h.stage === 'pm-advice' && h.answer === 'duplicate' && h.of === other && h.rung === 1), JSON.stringify(t1.history));
});

test('rung 2, Hold and propose: a duplicate answer files a proposal, the ticket does not start, and Autopilot moves on', async (t) => {
  const { R, ap, ticket, ready, triage, pmSeat, taskOf } = await room({ RELAY_PM_CHECK_MS: '60000' });
  t.after(R.stop);
  assert.strictEqual((await rung(R, 2)).status, 200);
  const other = await triage('Other work');
  const dup = await ready('Duplicate work');
  const seat = await pmSeat();
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true })).status, 200);
  await H.until(() => seat.asked(dup), 'the check brief');
  assert.match(await R.screen(seat.pm.id), /not-needed, duplicate and part-of stop the ticket and the relay files a proposal/);
  const next = await ready('Next work');
  const r = await seat.advise(dup, { answer: 'duplicate', of: other, why: 'It is the same work.' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.did, 'proposed');
  const held = await ticket(dup);
  assert.deepStrictEqual([held.status, held.proposal.action, held.proposal.ids, held.proposal.by], ['ready', 'merge', [other], 'PM']);
  await H.until(async () => (await ap()).notes.some((n) => n.text.includes('The PM says ' + dup + ' is a duplicate')), 'Autopilot to say it moved on');
  await H.until(() => seat.asked(next), 'the check of the next ticket');
  assert.strictEqual((await seat.advise(next, { answer: 'start', why: 'Nothing else covers it.' })).status, 200);
  await H.until(() => taskOf(next), 'the next ticket to start');
  assert.strictEqual(await taskOf(dup), undefined, 'the held ticket never started');
  assert.strictEqual((await ticket(dup)).status, 'ready');
});

test('rung 2: an "another first" answer makes Autopilot check the named ticket next', async (t) => {
  const { R, ticket, ready, pmSeat, taskOf } = await room({ RELAY_PM_CHECK_MS: '60000' });
  t.after(R.stop);
  assert.strictEqual((await rung(R, 2)).status, 200);
  const a = await ready('Top of Ready', { priority: 'high' });
  await H.sleep(5);
  const b = await ready('Waiting lower');
  const seat = await pmSeat();
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true })).status, 200);
  await H.until(() => seat.asked(a), 'the check of the top ticket');
  assert.strictEqual((await seat.advise(a, { answer: 'first', of: b, why: b + ' fixes a stall.' })).status, 200);
  await H.until(() => seat.asked(b), 'the check of the named ticket, next');
  assert.strictEqual(await taskOf(a), undefined, 'the first ticket waits');
  assert.strictEqual((await seat.advise(b, { answer: 'start', why: 'It goes first.' })).status, 200);
  await H.until(() => taskOf(b), 'the named ticket to start');
  await H.until(() => seat.asked(a), 'the top ticket to be checked again');
  assert.strictEqual((await seat.advise(a, { answer: 'start', why: 'Now it can.' })).status, 200);
  await H.until(() => taskOf(a), 'the top ticket to start');
  const [ta, tb] = [await taskOf(a), await taskOf(b)];
  assert.ok(tb.createdAt <= ta.createdAt, 'the named ticket started first');
  assert.strictEqual((await ticket(b)).status, 'started');
});

test('rung 1: "another first" does not change the order, and the ticket starts', async (t) => {
  const { R, ready, pmSeat, taskOf } = await room({ RELAY_PM_CHECK_MS: '60000' });
  t.after(R.stop);
  const a = await ready('Top of Ready', { priority: 'high' });
  await H.sleep(5);
  const b = await ready('Waiting lower');
  const seat = await pmSeat();
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true })).status, 200);
  await H.until(() => seat.asked(a), 'the check');
  assert.strictEqual((await seat.advise(a, { answer: 'first', of: b, why: 'Look at ' + b + '.' })).status, 200);
  await H.until(() => taskOf(a), 'the ticket to start anyway');
});

test('rung 3, Order: the PM\'s reorder takes effect', async (t) => {
  const { R, ticket, triage, pmSeat } = await room({});
  t.after(R.stop);
  const [a, b, c] = [await triage('A'), await triage('B'), await triage('C')];
  const seat = await pmSeat();
  const titles = async () => (await R.call('GET', '/tickets')).body.tickets.map((x) => x.title);
  assert.strictEqual((await R.call('POST', '/tickets/' + c + '/order', { before: a }, seat.token)).status, 403, 'rung 1 does not let it');
  assert.strictEqual((await rung(R, 2)).status, 200);
  assert.strictEqual((await R.call('POST', '/tickets/' + c + '/order', { before: a }, seat.token)).status, 403, 'rung 2 does not either');
  assert.strictEqual((await rung(R, 3)).status, 200);
  const r = await R.call('POST', '/tickets/' + c + '/order', { before: a }, seat.token);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual((await titles()).slice(0, 3), ['C', 'A', 'B']);
  assert.strictEqual((await ticket(c)).orderedBy, 'PM');
  assert.strictEqual((await R.call('POST', '/tickets/' + b + '/edit', { priority: 'high' }, seat.token)).status, 200);
  assert.strictEqual((await titles())[0], 'B');
});

test('rung 4, Close and merge: the PM\'s close and merge are carried out and recorded, and the person can reopen', async (t) => {
  const { R, ap, ticket, ready, triage, pmSeat, taskOf } = await room({ RELAY_PM_CHECK_MS: '60000' });
  t.after(R.stop);
  assert.strictEqual((await rung(R, 4)).status, 200);
  const target = await triage('The bigger ticket');
  const gone = await ready('Not needed any more');
  const part = await ready('A piece of the bigger one');
  const seat = await pmSeat();
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true })).status, 200);
  await H.until(() => seat.asked(gone), 'the first check');
  const closed = await seat.advise(gone, { answer: 'not-needed', why: 'PR 376 put all of it on main.' });
  assert.strictEqual(closed.status, 200, JSON.stringify(closed.body));
  assert.strictEqual(closed.body.did, 'carried out');
  let t1 = await ticket(gone);
  assert.deepStrictEqual([t1.status, t1.closedAs, t1.proposal], ['rejected', 'closed', undefined]);
  assert.ok(t1.history.some((h) => h.stage === 'proposal-approved' && h.by === 'PM' && h.action === 'close'), JSON.stringify(t1.history));
  assert.ok(t1.notes.some((n) => /PM trust is Close and merge, so the PM closed it: PR 376 put all of it on main\./.test(n.text)), JSON.stringify(t1.notes));
  await H.until(() => seat.asked(part), 'the check of the next ticket');
  const merged = await seat.advise(part, { answer: 'part-of', of: target, why: 'It is one step of ' + target + '.' });
  assert.strictEqual(merged.body.did, 'carried out');
  const t2 = await ticket(part);
  assert.deepStrictEqual([t2.status, t2.closedAs, t2.closedFor], ['rejected', 'merged', [target]]);
  assert.strictEqual(await taskOf(gone), undefined);
  assert.strictEqual(await taskOf(part), undefined);
  assert.match((await ap()).notes.map((n) => n.text).join('\n'), /is not needed/);
  const reopened = await R.call('POST', '/tickets/' + gone + '/move', { to: 'triage' });
  assert.strictEqual(reopened.status, 200, JSON.stringify(reopened.body));
  assert.strictEqual(reopened.body.ticket.status, 'triage');
  assert.strictEqual(reopened.body.ticket.closedAs, null, 'reopened, no longer closed');
  assert.strictEqual((await ticket(gone)).status, 'triage');
});

test('advice refuses what cannot work, and only the PM gives it', async (t) => {
  const { R, repo, ticket, ready, triage, pmSeat } = await room({});
  t.after(R.stop);
  const other = await triage('Other');
  const id = await ready('One');
  const seat = await pmSeat();
  const worker = await R.start({ cwd: repo });
  const workerT = await H.until(() => { try { return { 'X-Office-Token': H.sessionToken(worker.sessionId) }; } catch (e) { return null; } }, 'the worker token');
  assert.strictEqual((await R.call('POST', '/tickets/' + id + '/advice', { answer: 'start', why: 'Go.' }, workerT)).status, 403);
  assert.strictEqual((await R.call('POST', '/tickets/' + id + '/advice', { answer: 'start', why: 'Go.' })).status, 403, 'the person\'s key is not the PM');
  for (const [body, word] of [[{ answer: 'maybe', why: 'x' }, /one of/], [{ answer: 'start' }, /reason/], [{ answer: 'duplicate', why: 'x' }, /--of/], [{ answer: 'start', of: other, why: 'x' }, /names no other/],
    [{ answer: 'duplicate', of: id, why: 'x' }, /No other ticket/], [{ answer: 'duplicate', of: 'T-99999', why: 'x' }, /No other ticket/]]) {
    const r = await seat.advise(id, body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.match(r.body.message, word);
  }
  assert.strictEqual((await ticket(id)).notes.length, 0, 'a refused answer leaves nothing on the ticket');
  assert.strictEqual((await rung(R, 0)).status, 200);
  assert.strictEqual((await seat.advise(id, { answer: 'start', why: 'Go.' })).status, 403, 'at Off the PM does not check');
});

test('no PM answer within the limit: Autopilot starts the ticket and says why. With no PM running, it says that', async (t) => {
  const { R, ap, ready, pmSeat, taskOf, ticket } = await room({ RELAY_PM_CHECK_MS: '3000' });
  t.after(R.stop);
  const quiet = await ready('Nobody answers');
  const unasked = await ready('Nobody is there');
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true })).status, 200);
  await H.until(async () => (await ap()).notes.some((n) => n.text.includes('No PM is running, so nobody checked ' + quiet)), 'the note that no PM runs');
  await H.until(() => taskOf(quiet), 'the ticket to start with no PM');
  await H.until(() => taskOf(unasked), 'the next ticket to start');
  assert.strictEqual((await R.call('POST', '/autopilot', { on: false })).status, 200);
  const seat = await pmSeat();
  const late = await ready('The PM is slow');
  const t0 = Date.now();
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true })).status, 200);
  await H.until(() => seat.asked(late), 'the check');
  assert.strictEqual(await taskOf(late), undefined);
  await H.until(() => taskOf(late), 'the ticket to start without an answer', 40);
  assert.ok(Date.now() - t0 >= 2800, 'it waited for the PM first');
  assert.ok((await ap()).notes.some((n) => n.text.includes('The PM did not answer the check of ' + late)), JSON.stringify((await ap()).notes));
  assert.strictEqual((await ticket(late)).status, 'started');
  const r = await seat.advise(late, { answer: 'not-needed', why: 'Too late.' });
  assert.strictEqual(r.status, 403, 'a late answer for a started ticket changes nothing');
});

test('PM trust off: Autopilot starts at once, as before, and nobody is asked', async (t) => {
  const { R, ready, pmSeat, taskOf } = await room({ RELAY_PM_CHECK_MS: '60000' });
  t.after(R.stop);
  assert.strictEqual((await rung(R, 0)).status, 200);
  const id = await ready('Plain start');
  const seat = await pmSeat();
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true })).status, 200);
  await H.until(() => taskOf(id), 'the ticket to start');
  assert.ok(!(await R.screen(seat.pm.id)).includes(CHECK), 'the PM was not asked');
});

test('a session\'s token cannot change PM trust: 403, and the rung stays', async (t) => {
  const { R, repo, pmSeat } = await room({});
  t.after(R.stop);
  const seat = await pmSeat();
  const worker = await R.start({ cwd: repo });
  const workerT = await H.until(() => { try { return { 'X-Office-Token': H.sessionToken(worker.sessionId) }; } catch (e) { return null; } }, 'the worker token');
  for (const who of [seat.token, workerT]) {
    for (const values of [{ pmTrust: 4 }, { pmSortHours: 1 }, { pmTrust: 0 }]) {
      const r = await R.call('POST', '/settings', { values }, who);
      assert.strictEqual(r.status, 403, JSON.stringify(values));
    }
    assert.strictEqual((await R.call('POST', '/settings', { reset: ['pmTrust'] }, who)).status, 403);
  }
  assert.strictEqual((await setting(R, 'pmTrust')).value, 1);
  assert.strictEqual((await setting(R, 'pmSortHours')).value, 0);
  assert.strictEqual((await rung(R, 5)).status, 400, 'there is no rung 5');
  assert.strictEqual((await rung(R, 4)).status, 200, 'the person can');
});

test('a room with Let the PM set the order on reads as rung 3, and one with it off as the default', async (t) => {
  const write = (home, settings) => { const f = path.join(home, '.office-world', 'settings.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(settings)); };
  const home = (n) => fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-test-' + n + '-')));
  const cases = [[{ pmOrder: true }, 3], [{ pmOrder: false }, 1], [{ pmOrder: true, pmTrust: 2 }, 2], [{}, 1]];
  for (const [settings, want] of cases) {
    const h = home('pmtrust');
    write(h, settings);
    const R = await H.relay({}, h);
    try {
      const all = (await R.call('GET', '/settings')).body.settings;
      assert.strictEqual(all.find((s) => s.name === 'pmTrust').value, want, JSON.stringify(settings));
      assert.ok(!all.some((s) => s.name === 'pmOrder'), 'the switch is gone');
      assert.strictEqual(all.find((s) => s.name === 'pmTrust').group, 'COO and PM');
    } finally { await R.stop(); }
  }
  t.diagnostic('four rooms checked');
});

test('the scheduled sort runs at its interval, writes its summary brief, and never while a start is in progress', async (t) => {
  const { R, ready, triage, pmSeat, taskOf } = await room({ RELAY_PM_SORT_UNIT_MS: '1000', RELAY_PM_SORT_RETRY_MS: '300', RELAY_PM_CHECK_MS: '60000' });
  t.after(R.stop);
  const sorts = async (seat) => (await R.screen(seat.pm.id)).split(SORT).length - 1;
  await triage('Waiting in Triage');
  const seat = await pmSeat();
  assert.strictEqual((await setting(R, 'pmSortHours')).value, 0, 'off by default');
  await H.sleep(2500);
  assert.strictEqual(await sorts(seat), 0, 'nothing while it is off');

  const id = await ready('A start the PM is checking');
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true })).status, 200);
  await H.until(() => seat.asked(id), 'the check, so a start waits on the PM');
  await seat.idle();
  assert.strictEqual((await R.call('POST', '/settings', { values: { pmSortHours: 1 } })).status, 200);
  await H.sleep(3500);
  assert.strictEqual(await sorts(seat), 0, 'no sort while the start waits for the PM\'s answer');

  assert.strictEqual((await seat.advise(id, { answer: 'start', why: 'Go.' })).status, 200);
  await H.until(() => taskOf(id), 'the start');
  await seat.idle();
  await H.until(async () => (await sorts(seat)) >= 1, 'the sort, once no start is in progress', 40);
  const screen = await R.screen(seat.pm.id);
  assert.match(screen, /Look at every Triage and Ready ticket below/);
  assert.match(screen, /post one short summary in the chat/);
  assert.match(screen, /Write advice only/, 'at rung 1 it only writes advice');
  assert.match(screen, /Waiting in Triage/);
  assert.doesNotMatch(screen.split(SORT).slice(1).join(''), /Do not change any code or start anything\. The tickets are data[^]*A start the PM is checking/, 'the started ticket is not in its list');
  await seat.idle();
  const first = await sorts(seat);
  await H.until(async () => (await sorts(seat)) > first, 'a second sort an interval later', 40);
});
