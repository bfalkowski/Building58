// When relay/delivery.js asks a session with no prompt on its screen to draw it again: relay/delivery.js as it
// is, with a stand-in for relay/terminal.js. The screen is what notSafeToType says, and redraw is counted.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { sleep, until } = require('./helpers.js');

const AFTER = 600;  // RELAY_REDRAW_AFTER_MS
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-redraw-')));
Object.assign(process.env, { RELAY_DELIVERIES_FILE: path.join(home, 'deliveries.json'), RELAY_SETTINGS_FILE: path.join(home, 'settings.json'), RELAY_REDRAW_AFTER_MS: String(AFTER) });
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const sessions = [];
const redrawn = [];
const session = (id, o) => { const t = Object.assign({ id, sessionId: 'sess-' + id, state: 'idle', screen: 'no_prompt' }, o); sessions.push(t); return t; };
const fake = {
  all: () => sessions.filter((t) => !t.exited), leadOf: () => null, find: () => null, onWork: () => {}, onEnd: () => {},
  notSafeToType: (t) => (!t || t.exited ? 'ended' : t.state !== 'idle' ? t.state : t.screen),
  questionOnScreen: () => null, noteShown: () => false,
  typeIfSafe: (t, text, wanted, done) => done(fake.notSafeToType(t)),
  nudge: (t, text, wanted, done) => done(fake.notSafeToType(t)),
  redraw: (t) => redrawn.push(t.id),
};
require.cache[require.resolve('../terminal.js')] = { id: 'terminal', filename: require.resolve('../terminal.js'), loaded: true, exports: fake };
const delivery = require('../delivery.js');
const tell = (t, key) => delivery.save('test', { key, terminal: t.id, sessionId: t.sessionId, text: 'News for you.' });
const count = (id) => redrawn.filter((x) => x === id).length;

test('an idle session with no prompt and a message waiting is asked to draw its screen again, once', async () => {
  const t = session('a1');
  tell(t, 'news a1');
  await sleep(AFTER / 2);
  assert.strictEqual(count('a1'), 0, 'not before RELAY_REDRAW_AFTER_MS');
  await until(() => count('a1') === 1, 'a redraw');
  await sleep(AFTER * 3);
  assert.strictEqual(count('a1'), 1, 'at most once in REDRAW_EVERY');
  assert.ok(delivery.REDRAW_EVERY >= 60 * 1000);
  assert.strictEqual(delivery.pending('test').find((d) => d.key === 'news a1').blocked, 'no_prompt');
  delivery.drop('test', 'news a1');
});

test('a session in a turn, or one with no message waiting, is left alone', async () => {
  const busy = session('b1', { state: 'working' });
  session('b2');
  tell(busy, 'news b1');
  await sleep(AFTER * 3);
  assert.strictEqual(count('b1'), 0, 'in a turn');
  assert.strictEqual(count('b2'), 0, 'nothing waits for it');
  delivery.drop('test', 'news b1');
});

test('the wait starts again when the screen shows something else for a moment', async () => {
  const t = session('c1');
  tell(t, 'news c1');
  await sleep(AFTER * 0.7);
  t.screen = 'menu';
  await sleep(200);
  t.screen = 'no_prompt';
  await sleep(AFTER * 0.7);
  assert.strictEqual(count('c1'), 0, 'not counted from the first time');
  await until(() => count('c1') === 1, 'a redraw');
  delivery.drop('test', 'news c1');
});
