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
