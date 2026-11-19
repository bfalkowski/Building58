// The person's switch for the merge rung (T-50), through a real relay with a fake `claude`. The relay
// checks nothing before a merge, so the switch is what the Lead's brief says.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until, sessionToken } = require('./helpers.js');

const NEVER = 'Never merge a pull request: merging stays with the person.';
// The second condition asks for no merge hold on the floor too (relay/merge-hold.js, T-203).
const RUNG = 'Read the merge rung in docs/constitution.md of ticket.js\'s repo; merge only if: ' +
  'the head has a posted review, blocking findings are fixed and checked in code with no floor merge hold, its pipeline is green, ' +
  'base main merges cleanly, no decision is left to the person.';
// Each brief the fake echoed, in order, from the screen.
const briefs = (screen) => screen.split('GOT[You are the Lead of this room.').slice(1).map((x) => x.split(']')[0]);
const merging = (brief) => (brief.includes(RUNG) ? 'on' : brief.includes(NEVER) ? 'off' : 'neither');

// A page that stays open on a session. until(fn) checks the screen again each time the session draws,
// so a test acts the moment something shows, not after a screen read of 300 ms.
function watchScreen(R, id) {
  const ctl = new AbortController(), checks = new Set();
  let raw = '', bytes = Buffer.alloc(0), ended = null;
  const recheck = () => { for (const check of [...checks]) check(); };
  (async () => {
    const r = await fetch(R.base + '/terminals/' + id + '/stream', { headers: { Authorization: 'Bearer test-key' }, signal: ctl.signal });
    const reader = r.body.getReader(), dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      const events = raw.split('\n\n');
      raw = events.pop();
      for (const e of events) { const m = /^event: out\ndata: "([^"]+)"/.exec(e); if (m) bytes = Buffer.concat([bytes, Buffer.from(m[1], 'base64')]); }
      recheck();
    }
    throw new Error('the stream ended');
  })().catch((e) => { ended = e; recheck(); });
  const until = (fn, what) => new Promise((resolve, reject) => {
    const check = () => {
      const v = fn(bytes.toString());
      if (v || ended) { clearTimeout(late); checks.delete(check); }
      if (v) resolve(v); else if (ended) reject(new Error('Gave up waiting for ' + what + ': ' + ended.message));
    };
    const late = setTimeout(() => { checks.delete(check); reject(new Error('Timed out waiting for ' + what)); }, 60 * 1000);
    checks.add(check);
    check();
  });
  return { until, close: () => ctl.abort() };
}

test('the brief says never merge unless the switch is on, and names the five conditions when it is', () => {
  const { leadBrief } = require('../lead-brief.js');
  const relayDir = path.join('/', 'r'.repeat(119), 'relay');
  const off = leadBrief(relayDir), on = leadBrief(relayDir, { merge: true });
  assert.strictEqual(merging(off), 'off');
  assert.ok(!/merge rung|Merge only/.test(off), 'off, it does not point to the rung at all');
  assert.strictEqual(merging(on), 'on');
  assert.ok(!on.includes(NEVER));
  for (const b of [off, on]) assert.ok(Buffer.byteLength(b) < 1024, Buffer.byteLength(b) + ' bytes, from a checkout root of 120 characters');
});

test('Let the Lead merge', async (t) => {
  // The relay presses Enter RELAY_TYPE_SETTLE_MS after it types a brief, and the press-while-typing test
  // must press inside that time. It watches the screen live (T-218), and 1500 ms (T-183) leaves a busy
  // runner room to press.
  let R = await relay({ RELAY_WIP_LIMIT: '5', RELAY_TYPE_SETTLE_MS: '1500' });
  const home = R.home, repo = makeRepo(home), file = path.join(home, '.office-world', 'lead.json');
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')).t;
  const start = async (extra) => (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
  const hook = async (s, event) => { await R.hook({ session_id: s.slice(0, 12), ...event }); await sleep(200); };
  const talk = async (s) => { await hook(s, { hook_event_name: 'UserPromptSubmit', title: '' }); await hook(s, { hook_event_name: 'Stop' }); };
  const terminal = async (id) => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === id);
  const told = (id, list) => until(async () => JSON.stringify(briefs(await R.screen(id)).map(merging)) === JSON.stringify(list), 'briefs ' + list.join(', '));
  const lead = (id, body) => R.call('POST', '/terminals/lead', { terminal: id, ...body });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });

  const a = await start(), b = await start();
  await talk(a.sessionId); await talk(b.sessionId);
  await t.test('it is off by default: a new Lead is told never to merge', async () => {
    const r = await lead(a.id);
    assert.strictEqual(r.body.merge, false);
    await told(a.id, ['off']);
    assert.strictEqual(saved().merge, false);
    assert.strictEqual((await terminal(a.id)).merge, false);
  });
  await t.test('a session cannot turn it on for itself', async () => {
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(a.sessionId); } catch (e) { return null; } }, 'the token') };
    const r = await R.call('POST', '/terminals/lead', { terminal: a.id, merge: true }, token);
    assert.strictEqual(r.status, 401);
    assert.strictEqual((await terminal(a.id)).merge, false);
  });
  await t.test('only the Lead can have it', async () => {
    assert.strictEqual((await terminal(b.id)).merge, false);
    const reviewer = await start({ role: 'reviewer' });
    assert.strictEqual((await lead(reviewer.id, { merge: true })).body.error, 'task');
    await R.call('POST', '/terminals/' + reviewer.id + '/stop', {});
  });
  await t.test('turning it on types the brief again, with the five conditions, and saves it', async () => {
    const r = await lead(a.id, { merge: true });
    assert.strictEqual(r.body.merge, true);
    assert.strictEqual(r.body.board, false, 'it is separate from moving the board');
    await told(a.id, ['off', 'on']);
    assert.strictEqual(saved().merge, true);
    assert.strictEqual((await terminal(a.id)).merge, true);
    await lead(a.id, { merge: true });
    await sleep(2000);
    assert.strictEqual(briefs(await R.screen(a.id)).length, 2, 'turning it on again tells it nothing new');
  });
  await t.test('moving the board leaves it on', async () => {
    await lead(a.id, { board: true });
    await lead(a.id, { board: false });
    assert.strictEqual((await terminal(a.id)).merge, true);
    assert.strictEqual(saved().merge, true);
  });
  await t.test('turning it off, whichever session is named, types the brief again with never merge', async () => {
    const r = await lead(b.id, { merge: false });
    assert.strictEqual(r.body.merge, false);
    await told(a.id, ['off', 'on', 'off']);
    assert.strictEqual(saved().merge, false);
    assert.strictEqual((await terminal(a.id)).merge, false);
  });
  await t.test('a brief waiting on a busy Lead says what the switch says when it goes in', async () => {
    await hook(a.sessionId, { hook_event_name: 'UserPromptSubmit', title: '' });
    await lead(a.id, { merge: true });
    await lead(a.id, { merge: false });
    await lead(a.id, { merge: true });
    await sleep(1500);
    assert.strictEqual(briefs(await R.screen(a.id)).length, 3, 'nothing typed during a turn');
    await hook(a.sessionId, { hook_event_name: 'Stop' });
    await told(a.id, ['off', 'on', 'off', 'on']);
  });
  // The brief is a saved delivery (relay/delivery.js): a press while it is being typed saves the new
  // words in its place, so the half-typed one is taken back out and only the new one goes in.
  let sofar = ['off', 'on', 'off', 'on'];
  await t.test('a press while the brief is being typed is not lost', async () => {
    // The press has to reach the relay before it presses Enter. A screen read of 300 ms to see the brief on
    // the line, on a busy runner, came too late (T-218), so the test watches the screen as it is drawn and
    // presses the moment the brief shows. Typed but not yet entered: the terminal has echoed the text once
    // more than the fake has answered it. A runner that still stalls past Enter gets "off" answered first;
    // nothing is lost then, but the case went untested, so the test tries again.
    const typing = (sc) => sc.split('You are the Lead of this room.').length - 1 > 2 * briefs(sc).length;
    let inTime = false;
    for (let round = 0; round < 3 && !inTime; round++) {
      const page = watchScreen(R, a.id);
      try {
        await lead(a.id, { merge: false });
        await page.until(typing, 'the brief to be on the line');
        await lead(a.id, { merge: true });
        const next = merging((await page.until((sc) => briefs(sc).length > sofar.length && briefs(sc), 'the next brief'))[sofar.length]);
        inTime = next === 'on';
        sofar = sofar.concat(inTime ? ['on'] : [next, 'on']);
        await told(a.id, sofar);
      } finally { page.close(); }
    }
    assert.ok(inTime, 'the press reached the relay before Enter in one of three tries');
    await sleep(1500);
    assert.strictEqual(briefs(await R.screen(a.id)).length, sofar.length, 'and only once');
  });
  const fresh = crypto.randomUUID();
  await t.test('/clear keeps it, and the brief after it still has the conditions', async () => {
    await R.hook({ hook_event_name: 'SessionStart', source: 'clear', session_id: fresh.slice(0, 12), full_session_id: fresh, terminal: a.id });
    await told(a.id, sofar.concat(['on']));
    assert.strictEqual((await terminal(a.id)).merge, true);
    await until(() => saved().sessionId === fresh && saved().merge === true, 'it to be saved under the new id');
    await talk(fresh);
  });

  await R.kill();
  R = await relay({ RELAY_WIP_LIMIT: '5' }, home);
  let back;
  await t.test('Bring back keeps it, like moving the board', async () => {
    const offered = (await R.call('GET', '/terminals')).body.restore;
    assert.strictEqual(offered.sessionId, fresh);
    back = await start({ resume: fresh, lead: true });
    assert.strictEqual((await terminal(back.id)).merge, true);
    await hook(fresh, { hook_event_name: 'SessionStart', source: 'resume', full_session_id: fresh, terminal: back.id });
    await told(back.id, ['on']);
  });
  await t.test('a new Lead does not get it, and the old one loses it', async () => {
    const c = await start();
    await talk(c.sessionId);
    const r = await lead(c.id);
    assert.strictEqual(r.body.merge, false);
    await told(c.id, ['off']);
    await until(async () => (await R.screen(back.id)).includes('GOT[You are no longer the Lead of this room. Never merge a pull request: merging stays with the person.]'), 'the old Lead to be told it may not merge');
    const terms = (await R.call('GET', '/terminals')).body.terminals;
    assert.deepStrictEqual(terms.filter((x) => x.merge), []);
    assert.strictEqual(saved().merge, false);
  });

  await R.kill();
  const old = crypto.randomUUID();
  fs.writeFileSync(file, JSON.stringify({ t: { sessionId: old, cwd: repo, title: null, board: true, savedAt: '2026-11-03T00:00:00.000Z' } }));
  R = await relay({ RELAY_WIP_LIMIT: '5' }, home);
  await t.test('a Lead saved before the switch existed comes back with it off', async () => {
    const back = await start({ resume: old, lead: true });
    const now = await terminal(back.id);
    assert.strictEqual(now.lead, true);
    assert.strictEqual(now.board, true);
    assert.strictEqual(now.merge, false);
    await hook(old, { hook_event_name: 'SessionStart', source: 'resume', full_session_id: old, terminal: back.id });
    await told(back.id, ['off']);
  });
});

test('the relay restarting brings the Lead back with the switch as it was', async (t) => {
  let R = await relay({ RELAY_RESUME: '1', RELAY_WIP_LIMIT: '5' });
  const home = R.home, repo = makeRepo(home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const s = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12), title: '' }); await sleep(200);
  await R.hook({ hook_event_name: 'Stop', session_id: s.sessionId.slice(0, 12) }); await sleep(200);
  await R.call('POST', '/terminals/lead', { terminal: s.id, merge: true });
  await until(async () => briefs(await R.screen(s.id)).map(merging).join() === 'on', 'the brief');
  await R.kill();
  R = await relay({ RELAY_RESUME: '1', RELAY_WIP_LIMIT: '5' }, home);
  const back = await until(async () => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.sessionId === s.sessionId), 'it to come back');
  assert.strictEqual(back.lead, true);
  assert.strictEqual(back.merge, true);
});
