// A session told something that does not start on it: relay/delivery.js as it is, with a stand-in for
// relay/terminal.js. The test plays the hooks by setting what terminal.noteHook would (turnAt, state,
// and stuck cleared when a turn begins), and what is on screen through notSafeToType and noteShown.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { sleep, until } = require('./helpers.js');

const CHECK = 400;
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-told-stuck-')));
const READY = 1500;  // RELAY_READY_LIMIT: how long a first prompt waits for its session to be ready
Object.assign(process.env, { RELAY_DELIVERIES_FILE: path.join(home, 'deliveries.json'), RELAY_SETTINGS_FILE: path.join(home, 'settings.json'), RELAY_TOLD_CHECK_MS: String(CHECK), RELAY_READY_LIMIT: String(READY) });
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const sessions = [];
const typed = [];    // { id, text }: a note typed and sent
const nudged = [];   // { id, how }: the second try
const session = (id, sessionId) => { const t = { id, sessionId: sessionId || 'sess-' + id, state: 'idle', screen: null, shown: false }; sessions.push(t); return t; };
const enders = [];  // what delivery.js runs when a session ends (terminal.onEnd)
const fake = {
  all: () => sessions.filter((t) => !t.exited), leadOf: () => null, find: () => null, onWork: () => {}, onEnd: (fn) => { enders.push(fn); },
  notSafeToType: (t) => (!t || t.exited ? 'ended' : t.state !== 'idle' ? t.state : t.screen),
  questionOnScreen: (t) => (t.screen === 'menu' || t.screen === 'trust' ? t.screen : null),
  noteShown: (t) => t.shown,
  typeIfSafe: (t, text, wanted, done) => { const p = fake.notSafeToType(t); if (p) { done(p); return; } typed.push({ id: t.id, text }); done(null); },
  nudge: (t, text, wanted, done) => {
    const p = fake.notSafeToType(t);
    if (p) { done(p); return; }
    if (t.shown) { nudged.push({ id: t.id, how: 'enter' }); done(null, 'enter'); return; }
    nudged.push({ id: t.id, how: 'typed' }); typed.push({ id: t.id, text }); done(null, 'typed');
  },
};
require.cache[require.resolve('../terminal.js')] = { id: 'terminal', filename: require.resolve('../terminal.js'), loaded: true, exports: fake };
const delivery = require('../delivery.js');
const stuckSeen = [];
delivery.onStuck((channel, t) => stuckSeen.push(t.id));

const startsTurn = (t) => { t.turnAt = Date.now(); t.state = 'working'; t.stuck = null; };  // UserPromptSubmit
const endsTurn = (t) => { t.state = 'idle'; };                                             // Stop
const typedTo = (id) => typed.filter((x) => x.id === id);
const tell = (t, key, text) => { let told = 0; delivery.save('test', { key, terminal: t.id, sessionId: t.sessionId, text, on: (what) => { if (what === 'delivered') told++; } }); return () => told; };

test('a session that starts on its note is left alone, and is never told it twice', async () => {
  const t = session('a1');
  const told = tell(t, 'review a1', 'Review news for you.');
  await until(() => typedTo('a1').length === 1, 'the note');
  startsTurn(t);
  await sleep(100); endsTurn(t);  // a short turn: done before the check looks
  await sleep(CHECK * 3);
  assert.strictEqual(typedTo('a1').length, 1, 'typed once');
  assert.deepStrictEqual(nudged.filter((x) => x.id === 'a1'), [], 'no second try');
  assert.ok(!t.stuck, 'not stuck');
  assert.strictEqual(told(), 1);
});

test('a session that does not start gets one more try, then shows as stuck and nothing more is typed', async () => {
  const t = session('b1');
  tell(t, 'review b1', 'Merge main into your PR.');
  await until(() => typedTo('b1').length === 1, 'the note');
  await until(() => nudged.some((x) => x.id === 'b1'), 'the second try', 30);
  assert.deepStrictEqual(nudged.filter((x) => x.id === 'b1'), [{ id: 'b1', how: 'typed' }], 'the note was not on screen, so it was typed again');
  await until(() => t.stuck, 'stuck', 30);
  assert.strictEqual(t.stuck.why, 'the relay cannot tell why from its screen');
  assert.ok(Date.now() - t.stuck.at >= 2 * CHECK, 'stuck since it was first told');
  assert.deepStrictEqual(stuckSeen.filter((id) => id === 'b1'), ['b1'], 'said once');
  tell(t, 'chat b1', 'A post mentions you.');  // another note waits while it is stuck
  await sleep(CHECK * 3);
  assert.strictEqual(typedTo('b1').length, 2, 'the note and its one retry, and nothing after');
  assert.strictEqual(nudged.filter((x) => x.id === 'b1').length, 1);
  assert.strictEqual(delivery.pending('test').find((d) => d.key === 'chat b1').blocked, 'stuck');
  // The person presses Enter in it: a turn begins, so it is not stuck, its kept note is dropped, and the waiting one goes in after.
  startsTurn(t); await sleep(600); endsTurn(t);
  await until(() => typedTo('b1').length === 3, 'the waiting note');
  assert.strictEqual(typedTo('b1')[2].text, 'A post mentions you.');
  assert.ok(!delivery.pending('test').some((d) => d.key === 'review b1'), 'the stuck note is not typed again into the session that took it up');
  startsTurn(t); endsTurn(t);
});

test('a note still in the prompt gets Enter, and a session that then starts is not stuck', async () => {
  const t = session('c1');
  tell(t, 'review c1', 'Review news.');
  await until(() => typedTo('c1').length === 1, 'the note');
  t.shown = true;
  await until(() => nudged.some((x) => x.id === 'c1'), 'the second try', 30);
  assert.deepStrictEqual(nudged.filter((x) => x.id === 'c1'), [{ id: 'c1', how: 'enter' }]);
  assert.strictEqual(typedTo('c1').length, 1, 'Enter only, the note is not typed twice');
  t.shown = false; startsTurn(t);
  await sleep(CHECK * 3);
  assert.ok(!t.stuck);
  assert.ok(!stuckSeen.includes('c1'));
});

test('a menu on its screen: no second try, stuck at once, and the Floor can say why', async () => {
  const t = session('d1');
  tell(t, 'review d1', 'Review news.');
  await until(() => typedTo('d1').length === 1, 'the note');
  t.screen = 'menu';
  await until(() => t.stuck, 'stuck', 30);
  assert.strictEqual(t.stuck.why, 'a menu is open on its screen');
  assert.deepStrictEqual(nudged.filter((x) => x.id === 'd1'), [], 'Enter at a menu would pick from it');
});

test('a stuck session brought back gets the note in its new session, once', async () => {
  const t = session('e1', 'sess-e');
  tell(t, 'review e1', 'Merge main.');
  await until(() => t.stuck, 'stuck', 40);
  assert.strictEqual(typedTo('e1').length, 2);
  t.exited = true;                     // the person stops it
  const back = session('e2', 'sess-e');  // and presses Bring back: a new desk, the same session id
  await until(() => typedTo('e2').length === 1, 'the note in the session brought back');
  assert.strictEqual(typedTo('e2')[0].text, 'Merge main.');
  startsTurn(back); endsTurn(back);
  await sleep(CHECK * 3);
  assert.strictEqual(typedTo('e2').length, 1);
  assert.ok(!back.stuck);
});

// T-209: a reviewer's, the PM's or the COO's first prompt is a saved delivery. A session nobody spoke to
// comes back after a stop with a new desk and a new session id, and relay/sessions.js calls promptOnce
// again with the old desk: the prompt follows it there. One that ran on through a restart keeps it as it was.
test('a first prompt follows its session to a new desk and session id, and goes in once', async () => {
  const owed = {};
  fake.find = (channel, id) => sessions.find((x) => x.id === id && !x.exited) || null;
  fake.owePrompt = (t, text) => { owed[t.id] = text || null; };
  const done = [];
  const p1 = session('p1', 'sess-p1');
  delivery.promptOnce('test', 'p1', 'Review PR 9.', (problem) => done.push(['p1', problem]));
  await until(() => typedTo('p1').length === 1, 'the prompt');
  assert.strictEqual(owed.p1, 'Review PR 9.', 'owed until a turn begins');
  // The relay restarts and takes p1 back as it was: the same desk, so nothing is typed again.
  delivery.promptOnce('test', 'p1', 'Review PR 9.', (problem) => done.push(['p1 again', problem]), 'p1');
  await sleep(CHECK / 2);
  assert.strictEqual(typedTo('p1').length, 1);
  // The relay is stopped before a turn begins, and the session comes back with a new desk and id.
  p1.exited = true;
  const p2 = session('p2', 'sess-p2');
  delivery.promptOnce('test', 'p2', 'Review PR 9.', (problem) => done.push(['p2', problem]), 'p1');
  await until(() => typedTo('p2').length === 1, 'the prompt in the session that came back');
  assert.deepStrictEqual(delivery.pending('test').filter((d) => /^first-prompt /.test(d.key)).map((d) => d.key), ['first-prompt p2'], 'only the new desk is owed it');
  startsTurn(p2);
  await until(() => done.length, 'done');
  assert.deepStrictEqual(done, [['p2', null]]);
  assert.strictEqual(owed.p2, null, 'no longer owed');
  endsTurn(p2);
  await sleep(CHECK * 2);
  assert.strictEqual(typedTo('p2').length, 1, 'typed once');
  assert.strictEqual(typedTo('p1').length, 1);
});

// A relay that comes back to a session it never typed the prompt into gives it the full wait again, so
// the time the relay was down does not count against RELAY_READY_LIMIT (review of PR 164).
test('a first prompt not typed yet gets its full wait again when a relay comes back', async () => {
  const done = [];
  const q = session('q1', 'sess-q1');
  q.screen = 'trust';  // not ready: it asks whether to trust its folder
  delivery.promptOnce('test', 'q1', 'Review PR 10.', (problem) => done.push(problem));
  await sleep(READY * 2 / 3);
  // The relay restarts and takes q1 back, still at its question.
  delivery.promptOnce('test', 'q1', 'Review PR 10.', (problem) => done.push(problem), 'q1');
  await sleep(READY * 2 / 3);  // past the limit from the first save, inside it from the relay coming back
  assert.deepStrictEqual(done, [], 'it did not give up');
  q.screen = null;  // the person answers the question
  await until(() => typedTo('q1').length === 1, 'the prompt');
  startsTurn(q);
  await until(() => done.length, 'done');
  assert.deepStrictEqual(done, [null]);
  endsTurn(q);
});

test('a first prompt whose session is never ready gives up, and says why', async () => {
  const done = [];
  const q = session('q2', 'sess-q2');
  q.screen = 'trust';
  delivery.promptOnce('test', 'q2', 'Review PR 11.', (problem) => done.push(problem));
  await until(() => done.length, 'it to give up', 100);
  assert.deepStrictEqual(done, ['the session was not ready after 0 minutes']);
  assert.strictEqual(typedTo('q2').length, 0);
});

// The log says whether the prompt was typed before the session ended (review of PR 164).
test('a session that ends while the relay runs: its first prompt is dropped, and the log says whether it was typed', async () => {
  const done = [];
  const typedOne = session('r1', 'sess-r1'), notYet = session('r2', 'sess-r2');
  notYet.screen = 'trust';
  delivery.promptOnce('test', 'r1', 'Review PR 12.', (problem) => done.push(['r1', problem]));
  delivery.promptOnce('test', 'r2', 'Review PR 13.', (problem) => done.push(['r2', problem]));
  await until(() => typedTo('r1').length === 1, 'the prompt typed into r1');
  for (const t of [typedOne, notYet]) { t.exited = true; for (const fn of enders) fn('test', t, 0, false); }
  assert.deepStrictEqual(done, [['r1', 'the session ended after its prompt was typed, before a hook said a turn began'], ['r2', 'the session ended first']]);
  assert.ok(!delivery.pending('test').some((d) => d.key === 'first-prompt r1' || d.key === 'first-prompt r2'), 'both dropped');
});

test('a relay that is stopping keeps the first prompt, for the session brought back', async () => {
  const done = [];
  const s1 = session('s1', 'sess-s1');
  s1.screen = 'trust';
  delivery.promptOnce('test', 's1', 'Review PR 14.', (problem) => done.push(problem));
  s1.exited = true;
  for (const fn of enders) fn('test', s1, 0, true);
  assert.deepStrictEqual(done, []);
  assert.ok(delivery.pending('test').some((d) => d.key === 'first-prompt s1'), 'kept');
  delivery.drop('test', 'first-prompt s1');
});
