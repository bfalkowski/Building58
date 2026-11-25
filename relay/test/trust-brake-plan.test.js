'use strict';
// The manager's brake (relay/trust-brake-plan.js): one step down from each level, never up, and the same
// switches for each level as the Set level button on the room page.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { KEYS, LEVELS, levelOf, step } = require('../trust-brake-plan.js');

test('each level goes one step down, never up, and level 0 and a custom mix have nowhere to go', () => {
  assert.strictEqual(step(LEVELS[0], true), null);
  for (let n = 1; n <= 6; n++) {
    const s = step(LEVELS[n], true);
    assert.strictEqual(s.from, n);
    assert.strictEqual(s.to, n - 1);
    assert.ok(s.offs.every((k) => LEVELS[n][k] && !LEVELS[n - 1][k]), 'it turns off only what the lower level has off: ' + n);
    assert.ok(s.ons.every((k) => !LEVELS[n][k] && LEVELS[n - 1][k]));
  }
  assert.deepStrictEqual(step(LEVELS[5], true).ons, ['merge', 'starts'], 'from Autopilot to the Lead merges the Lead takes merge and starts');
  assert.deepStrictEqual(step(LEVELS[5], true).offs, ['autopilot']);
  assert.deepStrictEqual(step(LEVELS[1], true), { from: 1, to: 0, offs: ['again'], ons: [] });
  assert.strictEqual(step(Object.assign({}, LEVELS[4], { stops: false }), true), null, 'custom');
});

test('levels 5 and 6 need no Lead, so with none the board switch is off', () => {
  assert.strictEqual(levelOf(Object.assign({}, LEVELS[5], { board: false }), false), 5);
  assert.strictEqual(levelOf(LEVELS[5], false), null);
  assert.strictEqual(step(Object.assign({}, LEVELS[6], { board: false }), false).to, 5);
});

test('the levels are the page\'s levels', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'office', 'terminal.js'), 'utf8');
  const wants = [...page.matchAll(/want: \{([^}]*)\}/g)].map((m) => Object.fromEntries(m[1].split(',').map((x) => { const [k, v] = x.split(':').map((y) => y.trim()); return [k, v === 'true']; })));
  assert.strictEqual(wants.length, LEVELS.length);
  wants.forEach((w, n) => { assert.deepStrictEqual(Object.keys(w), KEYS, 'level ' + n); assert.deepStrictEqual(w, LEVELS[n], 'level ' + n); });
});

test('the brake acts on kinds the watch really finds, handoffs included', () => {
  const { STALLS } = require('../trust-brake.js');
  const { findings } = require('../manager-watch-plan.js');
  const limits = { buildingMs: 1, checkFails: 2, briefMs: 1, slotMs: 1, handoffs: 2, skipMs: 1 };
  const found = findings({ now: 1e12, limits, tasks: [{ id: 't1', ticket: 'T-1', state: 'building', slot: false, dev: 'live', movedAt: 1e12, since: 1e12, checks: [{ name: 'pipeline', heads: 2 }] }], seats: [], runs: [{ task: 't1', ticket: 'T-1', outcome: 'handed' }, { task: 't2', ticket: 'T-2', outcome: 'handed' }], ready: [] });
  for (const kind of STALLS) assert.ok(found.some((f) => f.kind === kind), kind);
  assert.deepStrictEqual([...STALLS].sort(), ['check', 'handoffs']);
});
