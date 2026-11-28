// Ping pong through the room's idle action (office/office.js), and the trailer's ping pong shot
// (office/trailer.js), WebGL off. Someone sent to do something else ends their game, so nobody rallies
// alone.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest, until, watch } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

const PLAYING = 'Playing ping pong';
// Who is in a game: at a table spot with their paddle up, or with the table in their plan. A label can still say
// Playing ping pong for a moment after the game ends, until the person picks what to do next.
const playing = (p) => p.page.evaluate((label) => window.run.state().workers.filter((w) => {
  const d = window.run.debug(w.id), s = d && d.step;
  const headed = String((s && s.key) || '').startsWith('pp-') || d.steps.some((x) => /:pp-/.test(x));
  return w.doing === label && !!d && ((!!s && s.t === 'act' && d.spot.startsWith('pp-')) || headed);
}).map((w) => w.id).sort(), PLAYING);
const atTable = (p, id, spot) => until(p, ([who, key, label]) => {
  const d = window.run.debug(who), w = window.run.state().workers.find((x) => x.id === who);
  return d && d.spot === key && d.step && d.step.t === 'act' && w.doing === label;
}, [id, spot, PLAYING]);

pageTest('someone sent to their desk ends their game, so the other player leaves the table', get, async (p) => {
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
  // Sam goes to his own desk, which is always free: the window or the couch can be full and refuse.
  await p.page.evaluate((id) => { window.__partner = id; }, partner);
  const away = await p.page.evaluate(() => { window.run.speed({ value: 1 }); return window.run.idle({ who: 'sam', do: 'desk' }); });
  assert.strictEqual(away.ok, true, JSON.stringify(away));
  await p.page.waitForFunction((who) => window.run.debug(who).step === null || window.run.debug(who).step.t !== 'act', partner, { timeout: 5000 }).catch(() => {});
  const seen = await watch(p, ([label]) => {
    const players = window.run.state().workers.filter((w) => {
      const d = window.run.debug(w.id), s = d && d.step;
      const headed = String((s && s.key) || '').startsWith('pp-') || d.steps.some((x) => /:pp-/.test(x));
      return w.doing === label && !!d && ((!!s && s.t === 'act' && d.spot.startsWith('pp-')) || headed);
    }).map((w) => w.id).sort();
    if (players.length === 1) return { bad: 'one person plays alone: ' + players.join(', ') };
    return { done: !players.includes('sam') && window.run.debug(window.__partner).spot !== 'pp-e' };
  }, [PLAYING], 90000);
  assert.strictEqual(seen.bad, undefined, seen.bad);
  assert.ok(!(await playing(p)).includes('sam'), 'Sam left the game');
  assert.deepStrictEqual(p.errors, []);
});
