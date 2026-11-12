// The baked look (office/look.js) in a real browser, drawn in software. ?look=baked starts at evening,
// swaps every still part the bake knows for the baked copy, keeps people live, and gives the live look
// back for another Light. No test reads what the scene draws.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest, SOFTWARE } = require('./page.js');

let o;
test.before(async () => { o = await office({ webgl: true }); });
test.after(() => o && o.stop());
const look = (p) => p.page.evaluate(() => Object.assign({}, window.OfficeLook.state));

pageTest('?look=baked bakes the evening, and another Light gives the live look back', () => o, async (p) => {
  const page = p.page;
  await page.goto(o.address + '&look=baked');
  await page.locator('#relay-status[data-state="on"]').waitFor();
  await page.evaluate(() => window.run.ready());
  await page.waitForFunction(() => window.OfficeLook.state.status !== 'loading' && window.OfficeLook.state.status !== 'off');
  let s = await look(p);
  assert.strictEqual(s.error, null);
  assert.strictEqual(s.status, 'baked');
  assert.strictEqual(await page.evaluate(() => window.run.state().time), 'evening', 'the bake is of the evening, so the page starts there');
  assert.strictEqual(s.missing, 0, 'every part in the bake was found in the room');
  assert.ok(s.hidden > 300, 'the still parts are swapped for the baked copy');
  await page.waitForFunction(() => window.OfficeLook.state.fx !== 'loading');
  assert.strictEqual((await look(p)).fx, 'on', 'the effects draw the baked look');
  assert.strictEqual(await page.evaluate(() => window.THREE.EffectComposer !== undefined), true);

  await page.evaluate(() => window.run.time('day'));
  s = await look(p);
  assert.deepStrictEqual([s.status, s.hidden, s.fx], ['live', 0, 'off'], 'day is lit live, with no effects');
  await page.evaluate(() => window.run.time('evening'));
  assert.deepStrictEqual([(await look(p)).status, (await look(p)).fx], ['baked', 'on'], 'evening brings the baked look back, with its effects');
  assert.deepStrictEqual(p.errors, []);
}, SOFTWARE);

pageTest('fx=off keeps the baked look and leaves out its effects', () => o, async (p) => {
  const page = p.page;
  await page.goto(o.address + '&look=baked&fx=off');
  await page.locator('#relay-status[data-state="on"]').waitFor();
  await page.evaluate(() => window.run.ready());
  await page.waitForFunction(() => window.OfficeLook.state.status === 'baked');
  assert.strictEqual((await look(p)).fx, 'off');
  assert.strictEqual(await page.evaluate(() => window.THREE.EffectComposer === undefined), true, 'the effects are not fetched');
  assert.deepStrictEqual(p.errors, []);
}, SOFTWARE);

pageTest('without ?look=baked the room loads nothing for it', () => o, async (p) => {
  await p.open();
  await p.page.evaluate(() => window.run.ready());
  const s = await look(p);
  assert.deepStrictEqual([s.look, s.status, s.hidden], ['live', 'off', 0]);
  assert.strictEqual(await p.page.evaluate(() => !!window.THREE.GLTFLoader), false, 'the loader is fetched only for the baked look');
  assert.deepStrictEqual(p.errors, []);
}, SOFTWARE);
