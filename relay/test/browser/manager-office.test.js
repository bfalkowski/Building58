// The manager's office (office/office.js), on the room page with WebGL off: the people still walk
// without a scene. The manager starts at his desk in the office behind the back wall, a round takes
// him out through the glass door and back to his desk, the Lead can go in and sit, and nobody else
// walks in.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest, until } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;
const BACK_WALL = -5;  // the office is behind it, at z below this

pageTest('the manager works in his office, goes out through its door on a round, and comes back to his desk', get, async (p) => {
  await p.open();
  await p.page.evaluate(() => window.run.ready());
  const boss = () => p.page.evaluate(() => window.run.debug('manager'));
  const start = await boss();
  assert.strictEqual(start.spot, 'boss-desk');
  assert.ok(start.seated, 'he sits at his desk');
  assert.ok(start.pos[1] < BACK_WALL, 'his desk is in the office, behind the back wall');
  assert.strictEqual((await p.page.evaluate(() => window.run.state())).managerHere, false, 'at his desk, he is not out on the floor');

  await p.page.evaluate(() => { window.run.do({ action: 'speed', value: 8 }); window.run.do({ action: 'manager' }); });
  // He comes out through the door, in the middle of the opening, onto the floor.
  await until(p, () => { const d = window.run.debug('manager'); return d.pos[1] > -4.5; });
  const out = await boss();
  assert.ok(Math.abs(out.pos[0] - 2.04) < 1, 'he came out by the door, not through a wall: ' + out.pos);
  assert.strictEqual((await p.page.evaluate(() => window.run.state())).managerHere, true);
  // And goes back to his desk and sits.
  await until(p, () => !window.run.state().managerHere);
  await until(p, () => { const d = window.run.debug('manager'); return d.seated && d.spot === 'boss-desk'; });
  assert.deepStrictEqual(p.errors, []);
});

pageTest('the Lead can go into the manager\'s office and sit, and nobody else walks in', get, async (p) => {
  await p.open();
  await p.page.evaluate(() => window.run.ready());
  await p.page.evaluate(() => window.run.do({ action: 'speed', value: 8 }));
  const r = await p.page.evaluate(() => window.run.do({ action: 'leadVisit' }));
  assert.deepStrictEqual(r, { ok: true });
  await until(p, () => { const d = window.run.debug('lead'); return d.seated && /^boss-guest-/.test(d.spot); });
  assert.ok((await p.page.evaluate(() => window.run.debug('lead'))).pos[1] < BACK_WALL, 'the guest chair is in the office');

  // Everyone else wanders for a while, and none of them goes past the back wall.
  const others = await p.page.evaluate(() => window.run.roster().filter((w) => w.id !== 'lead').map((w) => w.id));
  for (const id of others) await p.page.evaluate((who) => window.run.do({ action: 'idle', who, do: 'board' }), id);
  for (let i = 0; i < 20; i++) {
    const zs = await p.page.evaluate((ids) => ids.map((id) => window.run.debug(id)).filter(Boolean).map((d) => d.pos[1]), others);
    assert.ok(zs.every((z) => z > BACK_WALL), 'nobody but the manager and the Lead is in the office: ' + zs);
    await p.page.waitForTimeout(250);
  }
  assert.deepStrictEqual(p.errors, []);
});
