// The on-screen pad (shared/nav.js) in each world, drawn in software: holding an arrow takes the
// camera around, a key does a step, + zooms in, and the house goes back to the first view. With
// no WebGL there is no scene to move, so there is no pad.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest, SOFTWARE } = require('./page.js');

const WORLDS = { office: '/office/' };

test.describe('the pad, with WebGL, in software', () => {
  let o;
  test.before(async () => { o = await office({ webgl: true }); });
  test.after(() => o && o.stop());

  for (const [world, path] of Object.entries(WORLDS)) {
    pageTest('the pad moves the camera in the ' + world, () => o, async (p) => {
      await p.page.goto('http://127.0.0.1:' + o.R.port + path);
      await p.page.locator('.navpad button[data-dir="home"]').waitFor();
      const angles = () => p.page.evaluate(() => window.NavPad.pads[0].angles());
      assert.strictEqual(await p.page.locator('.navpad button').count(), 7);
      // stop any opening glide, so only the pad moves the camera from here
      await p.page.click('.navpad button[data-dir="home"]');
      const home = await angles();

      const left = p.page.locator('.navpad button[data-dir="left"]');
      const box = await left.boundingBox();
      await p.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.page.mouse.down();
      await p.page.waitForTimeout(500);
      await p.page.mouse.up();
      const held = await angles();
      assert.ok(held.theta < home.theta - 0.05, 'holding the left arrow goes around to the left: ' + JSON.stringify([home, held]));
      await p.page.waitForTimeout(300);
      assert.ok(Math.abs((await angles()).theta - held.theta) < 0.02, 'letting go stops it');

      await p.page.focus('.navpad button[data-dir="home"]');
      await p.page.keyboard.press('ArrowUp');
      const up = await angles();
      assert.ok(up.phi < held.phi - 0.01, 'the up key raises the camera: ' + JSON.stringify([held, up]));

      await p.page.click('.navpad button[data-dir="in"]');
      assert.ok((await angles()).radius < up.radius, 'a click on + zooms in');

      await p.page.click('.navpad button[data-dir="home"]');
      const back = await angles();
      for (const k of ['theta', 'phi', 'radius']) assert.ok(Math.abs(back[k] - home[k]) < 0.02, 'home goes back, ' + k + ': ' + JSON.stringify([home, back]));
      assert.deepStrictEqual(p.errors, []);
    }, SOFTWARE);
  }
});

test.describe('the pad, with no WebGL', () => {
  let o;
  test.before(async () => { o = await office({ webgl: false }); });
  test.after(() => o && o.stop());

  pageTest('a world with no scene shows no pad', () => o, async (p) => {
    await p.page.goto('http://127.0.0.1:' + o.R.port + '/office/');
    await p.page.locator('#fallback').waitFor();
    assert.strictEqual(await p.page.locator('.navpad').count(), 0);
  });
});
