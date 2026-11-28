'use strict';
// One owner for each kind of stuck (467), and a Lead woken by events: nothing stuck, no prompt; a new item
// prompts it at once; the same item raised by a second detector is one item.
const test = require('node:test');
const assert = require('node:assert');
const { JAM_KINDS } = require('../metrics-plan.js');

const saved = [], pending = [];
const fake = (name, exports) => { require.cache[require.resolve(name)] = { id: name, filename: require.resolve(name), loaded: true, exports }; };
fake('../terminal.js', { leadOf: () => ({ id: 'lead' }), onEnd() {} });
fake('../tasks.js', { channels: () => ['t'], list: () => [], events: new (require('events'))() });
fake('../delivery.js', { pending: () => pending, save: (c, d) => { saved.push(d); pending.splice(0, pending.length, d); }, drop: (c, k) => { const i = pending.findIndex((d) => d.key === k); if (i >= 0) pending.splice(i, 1); }, onStuck() {} });
let channelOpen = false;
fake('../failures.js', { rooms: () => (channelOpen ? [{}] : []), leadLines: () => (channelOpen ? ['#failure-browser (browser): blocks PR #1.'] : []) });
fake('../config.js', { get: (n) => (n === 'leadCheckMinutes' ? 60 : n === 'leadUnstick' ? channelOpen : false), every() {}, onChange() {} });
const stuck = require('../stuck.js');
const lead = require('../lead-check.js');

test.beforeEach(() => { channelOpen = false; stuck.reset(); saved.length = 0; pending.length = 0; });

test('every jam kind has one owner', () => {
  for (const kind of Object.keys(JAM_KINDS)) assert.ok(['autopilot', 'lead', 'person'].includes(stuck.OWNERS[kind]), kind);
});

test('one stuck task is reported once, with one owner, whoever finds it', () => {
  const a = stuck.raise('t', { kind: 'handed-over', id: 'pr https://github.com/o/r/pull/7', text: 'Autopilot hands PR 7 over' });
  const b = stuck.raise('t', { kind: 'waits-on-state', id: 'pr https://github.com/o/r/pull/7', text: 'The PR watch says PR 7 waits' });
  assert.strictEqual(a.fresh, true);
  assert.strictEqual(b.fresh, false);
  assert.strictEqual(stuck.list('t').length, 1);
  assert.strictEqual(b.item.owner, 'person');
  assert.strictEqual(b.item.kind, 'handed-over');
});

test('with nothing stuck, the heartbeat and a sweep prompt no one', () => {
  lead.heartbeat();
  assert.strictEqual(saved.length, 0);
});

test('a new item the Lead or the person owns prompts the Lead at once, and Autopilot\'s does not', () => {
  lead.begin();
  stuck.raise('t', { kind: 'no-first-review', id: 'pr a', text: 'No review yet' });
  assert.strictEqual(saved.length, 0, 'Autopilot owns it');
  stuck.raise('t', { kind: 'main-red', id: 'main x', text: 'Main is red' });
  assert.strictEqual(saved.length, 1);
  assert.match(saved[0].text, /main-red \(lead owns it/);
  assert.doesNotMatch(saved[0].text, /nothing has changed/i);
});

test('the heartbeat prompts again only while an item is open, and a cleared one is not listed', () => {
  stuck.raise('t', { kind: 'handed-over', id: 'pr b', text: 'Waits on you' });
  saved.length = 0; pending.length = 0;
  lead.heartbeat();
  assert.strictEqual(saved.length, 1);
  stuck.clear('t', 'pr b');
  saved.length = 0; pending.length = 0;
  lead.heartbeat();
  assert.strictEqual(saved.length, 0);
});

test('a prompt that still waits is replaced by one with every open item', () => {
  stuck.raise('t', { kind: 'main-red', id: 'main 1', text: 'first' });
  stuck.raise('t', { kind: 'handed-over', id: 'pr 2', text: 'second' });
  assert.strictEqual(pending.length, 1);
  assert.match(pending[0].text, /first/);
  assert.match(pending[0].text, /second/);
});

test('a second new item prompts about itself, not the first one again', () => {
  stuck.raise('t', { kind: 'main-red', id: 'main 1', text: 'first-item' });
  pending.length = 0;
  stuck.raise('t', { kind: 'handed-over', id: 'pr 2', text: 'second-item' });
  assert.match(pending[0].text, /second-item/);
  assert.doesNotMatch(pending[0].text, /first-item/);
});

test('an open failure channel with no stuck item prompts on the heartbeat and is kept by the sweep', () => {
  channelOpen = true;
  lead.heartbeat();
  assert.strictEqual(saved.length, 1);
  assert.match(saved[0].text, /A failure channel is open\./);
  assert.match(saved[0].text, /Failure channels open now: #failure-browser/);
  lead.sweep();
  assert.strictEqual(pending.length, 1, 'the sweep keeps it');
  channelOpen = false;
  lead.sweep();
  assert.strictEqual(pending.length, 0, 'taken back when the channel closes');
});

test('open items are kept in the state folder, and a restart brings them back with their told mark', () => {
  const file = require('../state.js').file('stuck.json', 'RELAY_STUCK_FILE');
  stuck.raise('t', { kind: 'main-red', id: 'main 1', text: 'Main is red' });
  const [item] = stuck.list('t');
  stuck.told('t', [item]);
  assert.strictEqual(JSON.parse(require('fs').readFileSync(file, 'utf8')).t.length, 1);
  delete require.cache[require.resolve('../stuck.js')];
  const again = require('../stuck.js');
  assert.deepStrictEqual(again.list('t').map((i) => [i.id, i.kind, i.owner, i.told]), [['main 1', 'main-red', 'lead', true]]);
  assert.strictEqual(again.raise('t', { kind: 'main-red', id: 'main 1', text: 'again' }).fresh, false);
  again.clear('t', 'main 1');
  assert.deepStrictEqual(JSON.parse(require('fs').readFileSync(file, 'utf8')), {});
});

test('a session item is not saved, since the session may end while the relay is down', () => {
  const file = require('../state.js').file('stuck.json', 'RELAY_STUCK_FILE');
  stuck.raise('t', { kind: 'dev-idle', id: 'session abc', text: 'stuck' });
  stuck.raise('t', { kind: 'handed-over', id: 'pr x', text: 'waits' });
  assert.deepStrictEqual(JSON.parse(require('fs').readFileSync(file, 'utf8')).t.map((i) => i.id), ['pr x']);
});

test('a file with junk loads what is good and drops the rest', () => {
  const fs = require('fs');
  const file = require('../state.js').file('stuck.json', 'RELAY_STUCK_FILE');
  const good = { id: 'pr ok', kind: 'handed-over', text: 'ok', since: '2026-11-27T00:00:00.000Z', told: false };
  const load = (text) => { fs.writeFileSync(file, text); delete require.cache[require.resolve('../stuck.js')]; return require('../stuck.js'); };
  const mixed = load(JSON.stringify({ t: [good, { id: 5, kind: 'handed-over', since: good.since }, { id: 'pr a', kind: 'nope', since: good.since }, { id: 'pr b', kind: 'handed-over', since: 'not a date' }, null, 'x'], u: 'no' }));
  assert.deepStrictEqual(mixed.list('t').map((i) => i.id), ['pr ok']);
  assert.deepStrictEqual(mixed.list('u'), []);
  for (const text of ['not json', '[1,2]', 'null', '"x"']) assert.deepStrictEqual(load(text).list('t'), [], text);
});
