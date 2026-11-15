// The Floor's layout (office/index.html; page.js, WebGL off): Activity has its own folding panel, so the
// people list takes the Floor's free height and the workers stay in view.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());

pageTest('Activity is its own panel, and the people fill the Floor', () => o, async (p) => {
  await p.open();
  const { page } = p;
  await page.locator('#needs-you:not([hidden])').waitFor();
  assert.strictEqual(await page.locator('.floor #feed').count(), 0, 'Activity is not on the Floor');
  assert.strictEqual(await page.locator('#activity #feed').count(), 1, 'Activity has its own panel');
  assert.strictEqual(await page.getAttribute('#activity h2 button', 'aria-expanded'), 'false', 'it starts folded');
  const floor = await page.locator('.floor-in').boundingBox();
  const people = await page.locator('#people').boundingBox();
  assert.ok(people.height >= floor.height * 0.5, 'the people take at least half the Floor: ' + Math.round(people.height) + ' of ' + Math.round(floor.height));
  if (process.env.FLOOR_SHOT) await page.screenshot({ path: process.env.FLOOR_SHOT, fullPage: true });
  await page.click('#activity h2 button');
  assert.strictEqual(await page.locator('#feed-scroll').isVisible(), true, 'pressing its title opens it');
  assert.deepStrictEqual(p.errors, []);
});
