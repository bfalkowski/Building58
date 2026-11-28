// The PM's seat (relay/pm-seat.js): a session that ends soon after it starts counts as a failed try, so the
// wait grows, and the count clears only after a session ran for a while.
'use strict';
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const load = () => {
  const ends = [];
  const starts = [];
  const sitting = [];
  const stub = (file, exports) => { const f = require.resolve(path.join('..', file)); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
  stub('terminal.js', { ENABLED: true, isClosing: () => false, isUpdating: () => false, all: () => sitting, onEnd: (fn) => ends.push(fn) });
  stub('tickets.js', { seatPm: async () => { starts.push(Date.now()); return [201, {}]; } });
  delete require.cache[require.resolve('../pm-seat.js')];
  return { seat: require('../pm-seat.js'), ends, starts };
};

test('a seat that ends at once waits longer each time, and a seat that ran a while starts the count again', async (t) => {
  const env = { RELAY_PM_SEAT: '1', RELAY_PM_SEAT_RETRY_MS: '1000', RELAY_PM_SEAT_STABLE_MS: '30000' };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const realNow = Date.now;
  const realTimeout = global.setTimeout;
  const waits = [];
  let clock = realNow();
  t.after(() => { Date.now = realNow; global.setTimeout = realTimeout; for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  Date.now = () => clock;
  global.setTimeout = (fn, ms) => { waits.push(ms); realTimeout(fn, 0); return { unref() {} }; };
  const { seat, ends, starts } = load();
  const settle = () => new Promise((r) => realTimeout(r, 20));
  const end = async (ranMs) => { clock += ranMs; ends[0]('room', { standing: true }, 1, false); await settle(); };
  seat.begin('room', { log() {} });
  await settle();
  assert.strictEqual(starts.length, 1);
  await end(100);
  await end(100);
  await end(100);
  assert.deepStrictEqual(waits, [2000, 4000, 8000]);
  await end(31000);
  assert.strictEqual(waits[3], 1000, 'a seat that ran a while starts the count again');
  await end(100);
  assert.strictEqual(waits[4], 2000, 'a quick end after that counts from one');
  assert.strictEqual(starts.length, 6);
});
