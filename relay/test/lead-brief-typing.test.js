// A press of Let the Lead merge while the Lead's brief is being typed: relay/delivery.js as it is, with
// a stand-in for relay/terminal.js that holds each typing until the test lets it finish, as in
// relay/test/review-typing.test.js. A typing finishes the way terminal.typeIfSafe does: Enter only if
// the delivery is still wanted, otherwise the text is taken back out. The brief is saved as
// terminal.briefLead saves it: one key, for the Lead, first. Holding the typing makes the press land
// before Enter every time, which a real relay can only race for (T-233, relay/test/lead-merge.test.js).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { sleep, until } = require('./helpers.js');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-lead-brief-typing-')));
Object.assign(process.env, { RELAY_DELIVERIES_FILE: path.join(home, 'deliveries.json'), RELAY_SETTINGS_FILE: path.join(home, 'settings.json'), RELAY_TOLD_CHECK_MS: '3600000' });
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const lead = { id: 'L1', sessionId: 'sess-lead', state: 'idle', lead: true };
const typing = [];   // { text, finish } held until the test calls finish
const entered = [];  // the texts Enter was pressed on
const fake = {
  all: () => [lead], leadOf: () => lead, find: () => lead, onWork: () => {}, onEnd: () => {},
  notSafeToType: (t) => (t ? null : 'ended'), questionOnScreen: () => null, noteShown: () => false,
  typeIfSafe: (t, text, wanted, done) => typing.push({ text, finish: () => { if (!wanted()) { done('dropped'); return; } entered.push(text); done(null); } }),
  nudge: (t, text, wanted, done) => done('working'),
};
require.cache[require.resolve('../terminal.js')] = { id: 'terminal', filename: require.resolve('../terminal.js'), loaded: true, exports: fake };
const delivery = require('../delivery.js');

const OFF = 'You are the Lead of this room. Never merge a pull request.';
const ON = 'You are the Lead of this room. Merge only if the five conditions hold.';
const told = [];  // { text, what }
const brief = (text) => delivery.save('test', { key: 'lead-brief', to: 'lead', terminal: lead.id, sessionId: lead.sessionId, first: true, text, on: (what) => told.push({ text, what }) });
const held = () => until(() => typing[0], 'a typing');
const take = (x) => { typing.splice(typing.indexOf(x), 1); x.finish(); };
const quiet = async () => { await sleep(1500); assert.deepStrictEqual(typing.map((x) => x.text), [], 'nothing more is typed'); };
const reset = () => { entered.length = 0; told.length = 0; };

test('a press while the brief is being typed takes the half-typed one out, and the new one goes in once', async () => {
  reset();
  brief(OFF);
  const first = await held();
  assert.strictEqual(first.text, OFF);
  brief(ON);  // the press: it lands before Enter, since the typing is held
  take(first);
  const second = await held();
  assert.strictEqual(second.text, ON);
  take(second);
  await quiet();
  assert.deepStrictEqual(entered, [ON], 'the half-typed brief got no Enter');
  assert.deepStrictEqual(told, [{ text: ON, what: 'delivered' }], 'the replaced brief is not reported delivered');
  assert.deepStrictEqual(delivery.pending('test'), []);
});

test('a press that comes after Enter gets its own brief', async () => {
  reset();
  brief(OFF);
  take(await held());
  brief(ON);
  const second = await held();
  assert.strictEqual(second.text, ON);
  take(second);
  await quiet();
  assert.deepStrictEqual(entered, [OFF, ON]);
});

test('a press that says what the brief being typed says changes nothing', async () => {
  reset();
  brief(ON);
  const first = await held();
  brief(ON);
  take(first);
  await quiet();
  assert.deepStrictEqual(entered, [ON], 'typed once');
  assert.deepStrictEqual(told, [{ text: ON, what: 'delivered' }]);
});
