// Refresh the Lead, run by the relay: POST /terminals/lead { refresh: true }. Each step is typed with the
// relay's safe typing, and only once the Lead's turn has ended, as its hooks say.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');

const BRIEF = 'GOT[You are the Lead of this room.', NOTES = 'GOT[Your conversation is about to be cleared', CLEAR = 'GOT[/clear]', READ = 'GOT[You were just cleared';
const count = (text, what) => text.split(what).length - 1;

test('Refresh the Lead', async (t) => {
  const R = await relay();
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const a = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const hook = (event, sid) => R.hook({ hook_event_name: event, session_id: sid.slice(0, 12) });
  const lead = async () => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === a.id);
  const refresh = () => R.call('POST', '/terminals/lead', { refresh: true });
  let sid = a.sessionId;

  await t.test('there is nothing to refresh until a Lead runs', async () => {
    const r = await refresh();
    assert.strictEqual(r.status, 409);
    assert.match(r.body.message, /no Lead/);
  });
  await R.call('POST', '/terminals/lead', { terminal: a.id });
  await until(async () => (await R.screen(a.id)).includes(BRIEF), 'the brief');
  await hook('UserPromptSubmit', sid); await hook('Stop', sid); await sleep(200);
  await R.call('POST', '/terminals/lead', { terminal: a.id, board: true });

  await t.test('it will not start while the Lead is busy, or while the person has text in its prompt', async () => {
    await hook('UserPromptSubmit', sid); await sleep(100);
    let r = await refresh();
    assert.strictEqual(r.status, 409); assert.match(r.body.message, /busy/);
    await hook('Stop', sid); await sleep(1600);  // the screen settles
    await R.call('POST', '/terminals/' + a.id + '/input', { data: 'half a thought' });
    r = await refresh();
    assert.strictEqual(r.status, 409); assert.match(r.body.message, /typed/);
    await R.call('POST', '/terminals/' + a.id + '/input', { data: '\x15' });  // Ctrl+U takes it back
    await sleep(1600);
  });
  await t.test('notes first, and /clear only once that turn has ended', async () => {
    const r = await refresh();
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await refresh()).status, 409, 'one refresh at a time, whichever tab asks');
    await until(async () => (await R.screen(a.id)).includes(NOTES), 'the notes prompt');
    assert.strictEqual((await lead()).refresh, 'notes');
    await sleep(2000);
    assert.ok(!(await R.screen(a.id)).includes(CLEAR), 'not before the notes turn has even started');
    await hook('UserPromptSubmit', sid); await sleep(500);
    assert.ok(!(await R.screen(a.id)).includes(CLEAR), 'not while the notes turn runs');
    await hook('Stop', sid);
    await until(async () => (await R.screen(a.id)).includes(CLEAR), '/clear');
  });
  await t.test('after /clear, the relay briefs it, and the read prompt waits for that turn to end', async () => {
    sid = '11111111-2222-4333-8444-555555555555';
    await R.hook({ hook_event_name: 'SessionStart', source: 'clear', session_id: sid.slice(0, 12), full_session_id: sid, terminal: a.id });
    await until(async () => count(await R.screen(a.id), BRIEF) === 2, 'the brief again');
    await sleep(1000);
    assert.ok(!(await R.screen(a.id)).includes(READ), 'not before the brief\'s turn');
    await hook('UserPromptSubmit', sid); await sleep(300); await hook('Stop', sid);
    await until(async () => (await R.screen(a.id)).includes(READ), 'the read prompt');
    const l = await lead();
    assert.strictEqual(l.refresh, null);
    assert.ok(l.lead, 'still the Lead'); assert.ok(l.board, 'still allowed to move the board');
    assert.match(l.refreshNote.text, /fresh/);
  });
  await t.test('a refresh stops when the Lead goes away', async () => {
    await hook('UserPromptSubmit', sid); await hook('Stop', sid); await sleep(3200);  // the read prompt's turn, and Enter settles
    assert.strictEqual((await refresh()).status, 200);
    await R.call('POST', '/terminals/' + a.id + '/stop', {});
    await until(() => /Refresh the Lead: The Lead's session ended before the refresh finished/.test(R.output()), 'the refresh to end with the session');
    const l = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === a.id);
    assert.ok(!l || l.refresh === null);
  });
});

test('a refresh ends when another session is made the Lead, and the person can stop one', async (t) => {
  const R = await relay();
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const a = (await R.call('POST', '/terminals', { cwd: repo })).body, b = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const hook = (event, sid) => R.hook({ hook_event_name: event, session_id: sid.slice(0, 12) });
  const term = async (id) => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === id);
  const ready = async (s) => {
    await R.call('POST', '/terminals/lead', { terminal: s.id });
    await until(async () => (await R.screen(s.id)).includes(BRIEF), 'the brief');
    await hook('UserPromptSubmit', s.sessionId); await hook('Stop', s.sessionId); await sleep(3200);  // past ENTER_SETTLES after the brief's Enter
  };
  await ready(a);

  await t.test('a new Lead takes over: the old one gets no /clear', async () => {
    assert.strictEqual((await R.call('POST', '/terminals/lead', { refresh: true })).status, 200);
    await until(async () => (await R.screen(a.id)).includes(NOTES), 'the notes prompt');
    await hook('UserPromptSubmit', a.sessionId); await sleep(200);
    await R.call('POST', '/terminals/' + a.id + '/input', { data: 'a draft' });  // /clear has to wait for this
    await hook('Stop', a.sessionId); await sleep(800);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: b.id })).status, 200);
    await R.call('POST', '/terminals/' + a.id + '/input', { data: '\x15' });
    await sleep(3500);
    assert.ok(!(await R.screen(a.id)).includes(CLEAR), 'nothing more is typed into a session that is no longer the Lead');
    const A = await term(a.id);
    assert.strictEqual(A.refresh, null);
    assert.match(A.refreshNote.text, /another session/i);
  });
  await t.test('Stop the refresh ends it before /clear', async () => {
    await until(async () => (await R.screen(b.id)).includes(BRIEF), 'the brief for b');
    await hook('UserPromptSubmit', b.sessionId); await hook('Stop', b.sessionId); await sleep(3200);  // past ENTER_SETTLES after the brief's Enter
    assert.strictEqual((await R.call('POST', '/terminals/lead', { refresh: true })).status, 200);
    await until(async () => (await R.screen(b.id)).includes(NOTES), 'the notes prompt');
    const stop = await R.call('POST', '/terminals/lead', { refresh: false });
    assert.strictEqual(stop.status, 200);
    await hook('UserPromptSubmit', b.sessionId); await hook('Stop', b.sessionId); await sleep(2500);
    assert.ok(!(await R.screen(b.id)).includes(CLEAR), 'no /clear after it was stopped');
    const B = await term(b.id);
    assert.strictEqual(B.refresh, null);
    assert.match(B.refreshNote.text, /stopped/);
    assert.match(B.refreshNote.text, /before \/clear/, 'it says /clear never went in');
    assert.strictEqual((await R.call('POST', '/terminals/lead', { refresh: false })).status, 409, 'nothing to stop');
  });
  await t.test('stop and start again at once: the old run types nothing into the new one', async () => {
    await sleep(3200);  // the last turn's Enter settles
    const before = count(await R.screen(b.id), NOTES);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { refresh: true })).status, 200);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { refresh: false })).status, 200);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { refresh: true })).status, 200);
    await until(async () => count(await R.screen(b.id), NOTES) > before, 'the notes prompt');
    await sleep(4500);  // long enough for a second copy, if one were coming
    assert.strictEqual(count(await R.screen(b.id), NOTES), before + 1, 'one notes prompt, from the new run only');
    await R.call('POST', '/terminals/lead', { refresh: false });
  });
});

test('a refresh stopped after /clear says so, and types no read prompt', async (t) => {
  const R = await relay();
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const a = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const hook = (event, sid) => R.hook({ hook_event_name: event, session_id: sid.slice(0, 12) });
  await R.call('POST', '/terminals/lead', { terminal: a.id });
  await until(async () => (await R.screen(a.id)).includes(BRIEF), 'the brief');
  await hook('UserPromptSubmit', a.sessionId); await hook('Stop', a.sessionId); await sleep(3200);  // past ENTER_SETTLES after the brief's Enter
  assert.strictEqual((await R.call('POST', '/terminals/lead', { refresh: true })).status, 200);
  await until(async () => (await R.screen(a.id)).includes(NOTES), 'the notes prompt');
  await hook('UserPromptSubmit', a.sessionId); await hook('Stop', a.sessionId);
  await until(async () => (await R.screen(a.id)).includes(CLEAR), '/clear');
  const sid = '11111111-2222-4333-8444-555555555555';
  await R.hook({ hook_event_name: 'SessionStart', source: 'clear', session_id: sid.slice(0, 12), full_session_id: sid, terminal: a.id });
  await until(async () => count(await R.screen(a.id), BRIEF) === 2, 'the brief again');
  await hook('UserPromptSubmit', sid); await sleep(200);
  await R.call('POST', '/terminals/' + a.id + '/input', { data: 'a draft' });  // the read prompt has to wait for this
  await hook('Stop', sid); await sleep(800);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { refresh: false })).status, 200);
  const A = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === a.id);
  assert.match(A.refreshNote.text, /after \/clear/, 'the conversation was cleared');
  assert.doesNotMatch(A.refreshNote.text, /old conversation/);
  await R.call('POST', '/terminals/' + a.id + '/input', { data: '\x15' }); await sleep(3000);
  assert.ok(!(await R.screen(a.id)).includes(READ), 'no read prompt after the stop');
});
