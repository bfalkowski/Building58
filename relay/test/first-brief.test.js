// A session's first brief through relay/delivery.js, with a stand-in for relay/terminal.js, as in
// relay/test/told-stuck.test.js. The test plays the hooks by setting what terminal.noteHook would.
// A first brief is in only once a turn begins after it, and stays saved until then.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { sleep, until } = require('./helpers.js');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-first-brief-')));
const FILE = path.join(home, 'deliveries.json');
Object.assign(process.env, { RELAY_DELIVERIES_FILE: FILE, RELAY_TOLD_CHECK_MS: '3600000' });
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const sessions = [];
const typed = [];  // { id, text }
const session = (id, sessionId) => { const t = { id, sessionId, state: 'idle' }; sessions.push(t); return t; };
const fake = {
  all: () => sessions.filter((t) => !t.exited), leadOf: () => null, find: () => null, onWork: () => {}, onEnd: () => {},
  notSafeToType: (t) => (!t || t.exited ? 'ended' : t.state !== 'idle' ? t.state : null),
  questionOnScreen: () => null, noteShown: () => false,
  typeIfSafe: (t, text, wanted, done) => { const p = fake.notSafeToType(t); if (p) { done(p); return; } typed.push({ id: t.id, text }); done(null); },
  nudge: (t, text, wanted, done) => done('working'),
};
require.cache[require.resolve('../terminal.js')] = { id: 'terminal', filename: require.resolve('../terminal.js'), loaded: true, exports: fake };
const delivery = require('../delivery.js');

const startsTurn = (t) => { t.turnAt = Date.now(); t.state = 'working'; t.stuck = null; };  // UserPromptSubmit
const endsTurn = (t) => { t.state = 'idle'; };                                             // Stop
const typedTo = (id) => typed.filter((x) => x.id === id).map((x) => x.text);
const saved = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')).test || []; } catch (e) { return []; } };
const brief = (t, key, text) => { const told = []; delivery.save('test', { key, terminal: t.id, sessionId: t.sessionId, text, first: true, untilTurn: true, on: (what) => told.push(what) }); return told; };

test('a first brief is delivered only once a turn begins after it', async () => {
  const t = session('a1', 'sess-a');
  const told = brief(t, 'brief a', 'Build the radio.');
  await until(() => typedTo('a1').length === 1, 'the brief');
  await sleep(1200);
  assert.deepStrictEqual(told, [], 'typed is not delivered');
  assert.ok(saved().some((d) => d.key === 'brief a' && d.typedAt), 'it stays saved, marked typed');
  startsTurn(t);
  await until(() => told.length, 'delivered');
  assert.deepStrictEqual(told, ['delivered']);
  assert.ok(!saved().some((d) => d.key === 'brief a'), 'it leaves the file');
  endsTurn(t);
  await sleep(1200);
  assert.strictEqual(typedTo('a1').length, 1, 'typed once');
});

test('a worker that ends before its brief lands gets it when brought back with the same session id', async () => {
  const t = session('b1', 'sess-b');
  const told = brief(t, 'brief b', 'Build the lamp.');
  await until(() => typedTo('b1').length === 1, 'the brief');
  t.exited = true;  // it ends before a turn begins
  await sleep(1200);
  assert.ok(saved().some((d) => d.key === 'brief b'), 'still saved for that session id');
  const back = session('b2', 'sess-b');  // Bring back: a new desk, the same session id
  await until(() => typedTo('b2').length === 1, 'the brief in the session brought back');
  assert.deepStrictEqual(typedTo('b2'), ['Build the lamp.']);
  assert.deepStrictEqual(told, []);
  startsTurn(back);
  await until(() => told.length, 'delivered');
  assert.deepStrictEqual(told, ['delivered']);
});

test('nothing else goes into a session before its first brief lands', async () => {
  const t = session('c1', 'sess-c');
  brief(t, 'brief c', 'Build the clock.');
  delivery.save('test', { key: 'chat c', terminal: t.id, sessionId: t.sessionId, text: 'A post mentions you.' });
  await until(() => typedTo('c1').length === 1, 'the brief');
  await sleep(1200);
  assert.deepStrictEqual(typedTo('c1'), ['Build the clock.'], 'the note waits');
  assert.strictEqual(delivery.pending('test').find((d) => d.key === 'chat c').blocked, 'briefing');
  startsTurn(t); await sleep(100); endsTurn(t);
  await until(() => typedTo('c1').length === 2, 'the note, after the brief landed');
  assert.strictEqual(typedTo('c1')[1], 'A post mentions you.');
});

test('saving the same brief again keeps its place, and only listens again', async () => {
  const t = session('d1', 'sess-d');
  brief(t, 'brief d', 'Build the fan.');
  await until(() => typedTo('d1').length === 1, 'the brief');
  const told = brief(t, 'brief d', 'Build the fan.');  // what a relay that comes back to the same worker does
  await sleep(1200);
  assert.strictEqual(typedTo('d1').length, 1, 'not typed again');
  startsTurn(t);
  await until(() => told.length, 'the new listener hears it');
  assert.deepStrictEqual(told, ['delivered']);
});

// A relay restart: each relay is its own process, on one deliveries file, with the same stand-in.
// sessions: what that relay finds running; act: 'save' saves the brief, 'listen' saves it again as a
// relay that comes back does, and a turn begins halfway through. It prints what it typed and what it
// was told, as JSON, after ms.
const { execFileSync } = require('child_process');
function relayRun(file, { sessions: list, act, ms }) {
  const script = `
    const sessions = ${JSON.stringify(list)}, typed = [], told = [];
    const fake = {
      all: () => sessions, leadOf: () => null, find: () => null, onWork: () => {}, onEnd: () => {},
      notSafeToType: (t) => (!t ? 'ended' : t.state !== 'idle' ? t.state : null),
      questionOnScreen: () => null, noteShown: () => false,
      typeIfSafe: (t, text, wanted, done) => { typed.push({ id: t.id, text }); done(null); },
      nudge: (t, text, wanted, done) => done('working'),
    };
    require.cache[require.resolve('./relay/terminal.js')] = { id: 'terminal', filename: require.resolve('./relay/terminal.js'), loaded: true, exports: fake };
    const delivery = require('./relay/delivery.js');
    const on = (what) => told.push(what);
    const t = sessions[0];
    delivery.save('test', { key: 'brief r', terminal: t.id, sessionId: t.sessionId, text: 'Build the bell.', first: true, untilTurn: true, on });
    if (${JSON.stringify(act)} === 'listen') setTimeout(() => { t.turnAt = Date.now(); t.state = 'working'; }, ${Number(ms) / 2});
    setTimeout(() => { process.stdout.write(JSON.stringify({ typed, told })); process.exit(0); }, ${Number(ms)});
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, RELAY_DELIVERIES_FILE: file, RELAY_TOLD_CHECK_MS: '3600000' }, encoding: 'utf8' }));
}

test('a relay restart between saving and typing still delivers the brief', () => {
  const file = path.join(home, 'restart-1.json');
  // The first relay saves it while the session is busy, so it is not typed, and stops.
  const first = relayRun(file, { sessions: [{ id: 'r1', sessionId: 'sess-r', state: 'waiting' }], act: 'save', ms: 1200 });
  assert.deepStrictEqual(first.typed, []);
  // The next relay finds the same session idle, and types it.
  const next = relayRun(file, { sessions: [{ id: 'r1', sessionId: 'sess-r', state: 'idle' }], act: 'listen', ms: 3000 });
  assert.deepStrictEqual(next.typed.map((x) => x.text), ['Build the bell.']);
  assert.deepStrictEqual(next.told, ['delivered'], 'in once a turn began after it');
});

test('a relay restart between typing and the turn: the same session is not told twice, and one brought back is', () => {
  const typedOnce = (file, id) => {
    const first = relayRun(file, { sessions: [{ id, sessionId: 'sess-' + id, state: 'idle' }], act: 'save', ms: 900 });
    assert.deepStrictEqual(first.typed.map((x) => x.text), ['Build the bell.']);
    assert.deepStrictEqual(first.told, [], 'typed is not delivered');
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).test.some((d) => d.key === 'brief r' && d.typedAt), 'still saved, marked typed');
  };
  // An update restart: the session ran on in the host, and the next relay takes back the same one.
  const kept = path.join(home, 'restart-2.json');
  typedOnce(kept, 'r2');
  const same = relayRun(kept, { sessions: [{ id: 'r2', sessionId: 'sess-r2', state: 'idle' }], act: 'listen', ms: 3000 });
  assert.deepStrictEqual(same.typed, [], 'it has the brief already');
  assert.deepStrictEqual(same.told, ['delivered']);
  // A stop ended the session, and it comes back at a new desk with the same id: it gets the brief.
  const stopped = path.join(home, 'restart-3.json');
  typedOnce(stopped, 'r3');
  const back = relayRun(stopped, { sessions: [{ id: 'r4', sessionId: 'sess-r3', state: 'idle' }], act: 'listen', ms: 3000 });
  assert.deepStrictEqual(back.typed.map((x) => x.text), ['Build the bell.']);
  assert.deepStrictEqual(back.told, ['delivered']);
});
