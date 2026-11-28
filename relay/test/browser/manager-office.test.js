// The manager's office (office/office.js), on the room page with WebGL off: the people still walk
// without a scene. The manager starts at his desk in the office behind the back wall, a round takes
// him out through the glass door and back to his desk, the Lead can go in and sit, and nobody else
// walks in.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest, until, watch } = require('./page.js');

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
  assert.strictEqual(start.door, 0, 'the door is shut while he sits');

  await p.page.evaluate(() => { window.run.do({ action: 'speed', value: 8 }); window.run.do({ action: 'manager' }); });
  // The door opens for him on his way out, before he reaches it.
  await until(p, () => { const d = window.run.debug('manager'); return d.door > 1 && d.pos[1] < -5; });
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
  const spots = { board: 'board-', chat: 'bar', window: 'win', couch: 'couch' };
  const sent = [];
  for (const id of others) {
    for (const what of Object.keys(spots)) {
      const r = await p.page.evaluate(([who, to]) => window.run.do({ action: 'idle', who, do: to }), [id, what]);
      if (r.ok) { sent.push([id, spots[what]]); break; }
    }
  }
  assert.ok(sent.length > 0, 'someone is sent to a spot on the floor');
  const seen = await watch(p, ([ids, wall, sentTo]) => {
    const ds = ids.map((id) => window.run.debug(id)).filter(Boolean);
    const bad = ds.filter((d) => d.pos[1] <= wall).map((d) => d.pos[1]);
    if (bad.length) return { bad: 'nobody but the manager and the Lead is in the office: ' + bad };
    return { done: sentTo.every(([id, prefix]) => { const d = window.run.debug(id); return d && d.step && d.step.t === 'act' && d.spot.startsWith(prefix); }) };
  }, [others, BACK_WALL, sent], 90000);
  assert.strictEqual(seen.bad, undefined, seen.bad);
  assert.deepStrictEqual(p.errors, []);
});
