// The arc lamp in the lounge (office/office.js) hangs its shade clear of the couch's seats, so it never
// hides the head of someone sitting there. Drawn in software, because the room is built only with a scene.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest, SOFTWARE } = require('./page.js');

let o;
test.before(async () => { o = await office({ webgl: true }); });
test.after(() => o && o.stop());

// The couch's three seats, from the spots couch-0 to couch-2, and the top of a seated head: a tall
// person (1.1) on the 0.47 cushion has the top of their head at about 1.4.
const SEATS = [[4.6, 0.98], [5.25, 0.98], [5.9, 0.98]], HEAD_TOP = 1.4;

pageTest('the arc lamp\'s shade hangs clear of every seat on the couch', () => o, async (p) => {
  await p.open();
  await p.page.evaluate(() => window.run.ready());
  const shade = await p.page.evaluate(() => {
    const m = window.OfficeLook.liveParts().find((x) => x.geometry.parameters && x.geometry.parameters.radiusBottom === 0.22 && x.geometry.parameters.radiusTop === 0.06);
    const at = m.getWorldPosition(new window.THREE.Vector3());
    return { x: at.x, y: at.y, z: at.z, bottom: at.y - m.geometry.parameters.height / 2 };
  });
  for (const [x, z] of SEATS) {
    const away = Math.hypot(shade.x - x, shade.z - z);
    assert.ok(away >= 0.45, 'the shade is ' + away.toFixed(2) + ' m from the seat at x ' + x + ', so it hangs over a head');
  }
  assert.ok(shade.bottom >= HEAD_TOP + 0.1, 'the shade\'s bottom is at ' + shade.bottom.toFixed(2) + ' m');
  assert.deepStrictEqual(p.errors, []);
}, SOFTWARE);
