// Ping pong through the room's idle action (office/office.js), and the trailer's ping pong shot
// (office/trailer.js), WebGL off. Someone sent to do something else ends their game, so nobody rallies
// alone. And when a game is already going at the trailer's ping pong cue, the trailer clears the table
// and Kai still plays: once, Sam started a game with June before the cue, the cue could not seat Kai,
// then sent Sam to the window, and June played on alone in the shot at 0:40.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest, until } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

const PLAYING = 'Playing ping pong';
const doing = (p, id) => p.page.evaluate((who) => window.run.state().workers.find((w) => w.id === who).doing, id);
const atTable = (p, id, spot) => until(p, ([who, key, label]) => {
  const d = window.run.debug(who), w = window.run.state().workers.find((x) => x.id === who);
  return d && d.spot === key && d.step && d.step.t === 'act' && w.doing === label;
}, [id, spot, PLAYING]);

pageTest('someone sent to do something else ends their game, so the other player leaves the table', get, async (p) => {
  await p.open();
  await p.page.evaluate(() => window.run.ready());
  await p.page.evaluate(() => { window.run.cast(); window.run.speed({ value: 8 }); });
  const r = await p.page.evaluate(() => window.run.idle({ who: 'sam', do: 'pingpong' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const partner = await p.page.evaluate(() => window.run.state().workers.find((w) => w.id !== 'sam' && w.doing === 'Playing ping pong').id);
  await atTable(p, 'sam', 'pp-w');
  await atTable(p, partner, 'pp-e');
  // At normal speed a game lasts 37 to 57 seconds, so for the next few seconds the game can end only
  // because Sam left. The partner may start a new game with someone else, but nobody plays alone.
  await p.page.evaluate(() => { window.run.speed({ value: 1 }); return window.run.idle({ who: 'sam', do: 'window' }); });
  await p.page.waitForFunction((who) => window.run.debug(who).step === null || window.run.debug(who).step.t !== 'act', partner, { timeout: 5000 }).catch(() => {});
  for (let i = 0; i < 10; i++) {
    const players = await p.page.evaluate(() => window.run.state().workers.filter((w) => w.doing === 'Playing ping pong').map((w) => w.id));
    assert.notStrictEqual(players.length, 1, 'one person plays alone: ' + players.join(', '));
    await p.page.waitForTimeout(400);
  }
  assert.notStrictEqual(await doing(p, 'sam'), PLAYING);
  assert.deepStrictEqual(p.errors, []);
});

pageTest('the trailer\'s ping pong cue clears a game already going, and Kai plays with a partner', get, async (p) => {
  await p.page.goto(o.address + '&trailer');
  await until(p, () => document.documentElement.dataset.trailer === 'playing');
  // The trailer moves the room by its own clock, so the film is played forward here a step at a time.
  await p.page.evaluate(() => { window.trailer.clock = 0; window.__to = 0; setInterval(() => { if (window.trailer.clock < window.__to) window.trailer.clock = Math.min(window.__to, window.trailer.clock + 0.05); }, 16); });
  const playTo = (t) => p.page.evaluate((to) => { window.__to = to; }, t).then(() => until(p, (to) => window.trailer.clock >= to, t));
  await playTo(3);
  await until(p, () => { const d = window.run.debug('june'); return d && d.spot.startsWith('couch') && d.seated; });
  const r = await p.page.evaluate(() => window.run.idle({ who: 'sam', do: 'pingpong' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  await playTo(29.7);
  await atTable(p, 'sam', 'pp-w');
  await atTable(p, 'june', 'pp-e');
  await playTo(31);
  await atTable(p, 'kai', 'pp-w');
  const partner = await p.page.evaluate(() => window.run.state().workers.find((w) => w.id !== 'kai' && w.doing === 'Playing ping pong').id);
  await atTable(p, partner, 'pp-e');
  const players = await p.page.evaluate(() => window.run.state().workers.filter((w) => w.doing === 'Playing ping pong').map((w) => w.id).sort());
  assert.deepStrictEqual(players, ['kai', partner].sort(), 'two players, and nobody else at the table');
  assert.notStrictEqual(await doing(p, 'sam'), PLAYING);
  assert.deepStrictEqual(p.errors, []);
});
