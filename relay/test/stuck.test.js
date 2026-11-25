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
fake('../config.js', { get: () => 60, every() {}, onChange() {} });
const stuck = require('../stuck.js');
const lead = require('../lead-check.js');

test.beforeEach(() => { stuck.reset(); saved.length = 0; pending.length = 0; });

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
