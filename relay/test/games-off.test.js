'use strict';
// Games are off by default (ticket 623): the relay says so on GET /games, starts no round while it is off,
// and takes a round once the person turns Games on.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relay } = require('./helpers.js');

test('with Games off, no round starts; with it on, the relay takes the ask', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-games-off-')));
  const R = await relay({}, home);
  t.after(async () => { await R.kill(); await R.remove(); });

  const games = await R.call('GET', '/games');
  assert.strictEqual(games.status, 200);
  assert.strictEqual(games.body.on, false, 'Games are off by default');
  const off = await R.call('POST', '/rounds', { game: 'any' });
  assert.strictEqual(off.status, 409);
  assert.strictEqual(off.body.error, 'games_off');

  assert.strictEqual((await R.call('POST', '/settings', { values: { games: true } })).status, 200);
  assert.strictEqual((await R.call('GET', '/games')).body.on, true);
  const on = await R.call('POST', '/rounds', { game: 'any' });
  assert.notStrictEqual(on.body.error, 'games_off', 'with Games on, the ask reaches the round code');
});
