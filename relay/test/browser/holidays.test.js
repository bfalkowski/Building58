// Holiday decorations on the room page (office/holidays.js picks the holiday, office/office.js
// builds it). The scene is drawn in software here, so each holiday's decorations are built and drawn
// once with no console errors. The Decorations switch is kept in this browser, and the Holiday preview
// shows any holiday whatever the date.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest, SOFTWARE } = require('./page.js');

let o;
test.before(async () => { o = await office({ webgl: true }); });
test.after(() => o && o.stop());
const get = () => o;
const holiday = (p) => p.page.evaluate(() => window.run.state().holiday);
const frames = (p) => p.page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));

pageTest('each holiday can be previewed, and the switch is kept in this browser', get, async (p) => {
  const page = p.page;
  await page.goto(o.address + '&holiday=halloween');
  await page.locator('#relay-status[data-state="on"]').waitFor();
  await page.evaluate(() => window.run.ready());
  assert.strictEqual((await holiday(p)).showing, 'halloween', '?holiday= previews a holiday');
  assert.strictEqual(await page.locator('#holiday').inputValue(), 'halloween', 'and the preview shows in the Holiday list');

  for (const key of ['newyear', 'easter', 'july4', 'halloween', 'thanksgiving', 'christmas']) {
    await page.selectOption('#holiday', key);
    await frames(p);
    const h = await holiday(p);
    assert.deepStrictEqual([h.showing, h.preview], [key, key], key);
    if (key === 'newyear') { assert.ok(h.year > 2000, 'the banner names a year'); }
  }

  // The switch turns the date's decorations off and this browser keeps it. A preview still shows.
  await page.selectOption('#holiday', '');
  assert.strictEqual(await page.locator('#decor-btn').getAttribute('aria-pressed'), 'true');
  await page.click('#decor-btn');
  assert.strictEqual(await page.locator('#decor-btn').getAttribute('aria-pressed'), 'false');
  assert.strictEqual((await holiday(p)).showing, null);
  await page.goto(o.address);
  await page.locator('#relay-status[data-state="on"]').waitFor();
  const after = await holiday(p);
  assert.deepStrictEqual([after.on, after.showing, after.preview], [false, null, null], 'still off after a reload');
  assert.strictEqual(await page.locator('#decor-btn').getAttribute('aria-pressed'), 'false');
  await page.selectOption('#holiday', 'easter');
  assert.strictEqual((await holiday(p)).showing, 'easter', 'a preview shows with the switch off');
  await page.click('#decor-btn');
  assert.strictEqual(await page.evaluate(() => localStorage.getItem('office.decorations')), 'on');
  assert.strictEqual(typeof after.next.key, 'string', 'the state names the next holiday');
  assert.deepStrictEqual(p.errors, []);
}, SOFTWARE);

// From Dec 26 to Jan 1 New Year's is up already, so picking it rebuilds nothing. The preview still
// drops the confetti.
pageTest('a New Year\'s preview drops confetti while New Year\'s is up already', get, async (p) => {
  const page = p.page;
  await page.clock.setFixedTime(new Date(2026, 11, 28, 12, 0));
  await page.goto(o.address);
  await page.locator('#relay-status[data-state="on"]').waitFor();
  await page.evaluate(() => window.run.ready());
  await frames(p); await frames(p);
  const before = await holiday(p);
  assert.deepStrictEqual([before.showing, before.year, before.preview, before.confetti], ['newyear', 2027, null, false], 'Dec 28 shows New Year\'s 2027, with no confetti before midnight');
  await page.selectOption('#holiday', 'newyear');
  await page.waitForFunction(() => window.run.state().holiday.confetti, null, { timeout: 25000 });  // under the half minute the preview's confetti falls
  assert.deepStrictEqual(p.errors, []);
}, SOFTWARE);
