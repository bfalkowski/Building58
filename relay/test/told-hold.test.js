// How long a second note waits for a turn after the first one (T-353): relay/delivery.js as it is, with a
// stand-in for relay/terminal.js. The check that a told session started is far off here, so only the hold
// decides when the second note goes in.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { sleep, until } = require('./helpers.js');

const HOLD = 1500;
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-told-hold-')));
Object.assign(process.env, { RELAY_DELIVERIES_FILE: path.join(home, 'deliveries.json'), RELAY_SETTINGS_FILE: path.join(home, 'settings.json'), RELAY_TOLD_CHECK_MS: '3600000', RELAY_TOLD_HOLD_MS: String(HOLD) });
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const sessions = [];
const typed = [];
const fake = {
  all: () => sessions.filter((t) => !t.exited), leadOf: () => null, find: () => null, onWork: () => {}, onEnd: () => {},
  notSafeToType: (t) => (!t || t.exited ? 'ended' : t.state !== 'idle' ? t.state : null),
  questionOnScreen: () => null, noteShown: () => false,
  typeIfSafe: (t, text, wanted, done) => { const p = fake.notSafeToType(t); if (p) { done(p); return; } typed.push({ id: t.id, text, at: Date.now() }); done(null); },
  nudge: (t, text, wanted, done) => done('working'),
};
require.cache[require.resolve('../terminal.js')] = { id: 'terminal', filename: require.resolve('../terminal.js'), loaded: true, exports: fake };
const delivery = require('../delivery.js');
const typedTo = (id) => typed.filter((x) => x.id === id);

test('with no turn after the first note, the second goes in once the hold has passed', async () => {
  const t = { id: 'h1', sessionId: 'sess-h1', state: 'idle' };
  sessions.push(t);
  delivery.save('test', { key: 'one h1', terminal: t.id, sessionId: t.sessionId, text: 'First.' });
  await until(() => typedTo('h1').length === 1, 'the first note');
  delivery.save('test', { key: 'two h1', terminal: t.id, sessionId: t.sessionId, text: 'Second.' });
  await sleep(HOLD / 2);
  assert.strictEqual(typedTo('h1').length, 1, 'held at first');
  await until(() => typedTo('h1').length === 2, 'the second note after the hold');
  const [a, b] = typedTo('h1');
  assert.ok(b.at - a.at >= HOLD, 'not before the hold: ' + (b.at - a.at) + ' ms');
  assert.ok(b.at - a.at < HOLD + 2000, 'soon after it: ' + (b.at - a.at) + ' ms');
});
