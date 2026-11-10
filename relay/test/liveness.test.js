// Whether a session is alive: one answer from its hooks, its output and its exit together (relay/liveness.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { livenessOf } = require('../liveness.js');

const now = Date.parse('2026-11-07T12:00:00.000Z'), min = 60 * 1000, STALL = 30 * min;
// A session in a turn: a hook said a turn began, and it printed a second ago.
const turn = (over) => Object.assign({ exited: false, stopped: false, state: 'working', lastActAt: now - min, lastOutAt: now - 1000, stuck: null }, over);
const of = (t) => livenessOf(t, now, STALL);

test('in a turn, a hook within the stall time: working', () => {
  assert.deepStrictEqual(of(turn()), { state: 'working', since: now - min, cause: null });
  assert.strictEqual(of(turn({ lastActAt: now - STALL + 1000, lastOutAt: now - STALL + 1000 })).state, 'working', 'just under the stall time, with no output either');
});

test('in a turn, no hook for the stall time but output still moving: quiet, not working and not stuck', () => {
  // Claude's spinner prints while it thinks, so output alone is not progress, and never makes it working.
  const lv = of(turn({ lastActAt: now - 31 * min, lastOutAt: now - 200 }));
  assert.deepStrictEqual(lv, { state: 'quiet', since: now - 31 * min, cause: null });
});

test('in a turn, no hook and no output for the stall time: stuck since both went silent', () => {
  assert.deepStrictEqual(of(turn({ lastActAt: now - 50 * min, lastOutAt: now - 31 * min })), { state: 'stuck', since: now - 31 * min, cause: 'silent' });
  assert.deepStrictEqual(of(turn({ lastActAt: now - 31 * min, lastOutAt: now - 40 * min })), { state: 'stuck', since: now - 31 * min, cause: 'silent' }, 'a hook after the last output');
  assert.deepStrictEqual(of(turn({ lastActAt: now - 31 * min, lastOutAt: 0 })), { state: 'stuck', since: now - 31 * min, cause: 'silent' }, 'it never printed');
});

test('a quiet session whose output stops too becomes stuck', () => {
  const t = turn({ lastActAt: now - 31 * min, lastOutAt: now - 200 });
  assert.strictEqual(of(t).state, 'quiet');
  assert.strictEqual(livenessOf(t, now + STALL, STALL).state, 'stuck');
});

test('its process ended, or it was stopped: gone, whatever its hooks last said', () => {
  assert.deepStrictEqual(of(turn({ exited: true })), { state: 'gone', since: null, cause: null });
  assert.strictEqual(of(turn({ stopped: true })).state, 'gone');
  assert.strictEqual(of(turn({ exited: true, lastActAt: now - 99 * min, lastOutAt: now - 99 * min })).state, 'gone');
  assert.strictEqual(of(null).state, 'gone');
});

test('waiting on the person is not stuck, however long: the question waits for them', () => {
  assert.deepStrictEqual(of(turn({ state: 'waiting', waitingAt: now - 90 * min, lastActAt: now - 90 * min, lastOutAt: now - 90 * min })), { state: 'waiting', since: now - 90 * min, cause: null });
});

test('out of a turn: idle, or stuck when relay/delivery.js says it did not start on what it was told', () => {
  assert.deepStrictEqual(of(turn({ state: 'idle', lastActAt: now - 90 * min, lastOutAt: now - 90 * min })), { state: 'idle', since: now - 90 * min, cause: null });
  assert.deepStrictEqual(of(turn({ state: 'idle', stuck: { at: now - 3 * min, why: 'a menu is open on its screen' } })), { state: 'stuck', since: now - 3 * min, cause: 'told' });
});
