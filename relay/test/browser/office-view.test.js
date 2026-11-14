// The Manager's office button (office/office.js) on the room page. Drawn in software, it takes the
// view into the manager's office, where it stays (its pivot is behind the back wall, which the room
// allows), and Back to the room brings back the first view. With no WebGL there is no scene, so
// there is no button.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest, SOFTWARE } = require('./page.js');

test.describe('the office view, with WebGL, in software', () => {
  let o;
  test.before(async () => { o = await office({ webgl: true }); });
  test.after(() => o && o.stop());

  pageTest('the button goes into the manager\'s office, stays there, and comes back', () => o, async (p) => {
    await p.page.goto(o.address);
    const btn = p.page.locator('#view-office');
    await btn.waitFor();
    const angles = () => p.page.evaluate(() => window.NavPad.pads[0].angles());
    await p.page.click('.navpad button[data-dir="home"]');  // stop the opening glide
    const home = await angles();
    assert.strictEqual(await btn.innerText(), 'Manager\'s office');

    await btn.click();
    assert.strictEqual(await btn.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(await btn.innerText(), 'Back to the room');
    const inside = await angles();
    assert.ok(Math.abs(inside.radius - home.radius) > 1, 'the view moved: ' + JSON.stringify([home, inside]));
    await p.page.waitForTimeout(800);
    const later = await angles();
    for (const k of ['theta', 'phi', 'radius']) assert.ok(Math.abs(later[k] - inside[k]) < 0.02, 'the view stays in the office, ' + k + ': ' + JSON.stringify([inside, later]));

    await btn.click();
    assert.strictEqual(await btn.innerText(), 'Manager\'s office');
    const back = await angles();
    for (const k of ['theta', 'phi', 'radius']) assert.ok(Math.abs(back[k] - home[k]) < 0.02, 'it goes back to the first view, ' + k + ': ' + JSON.stringify([home, back]));
    assert.deepStrictEqual(p.errors, []);
  }, SOFTWARE);
});

test.describe('the office view, without WebGL', () => {
  let o;
  test.before(async () => { o = await office(); });
  test.after(() => o && o.stop());

  pageTest('there is no button without a scene', () => o, async (p) => {
    await p.open();
    assert.strictEqual(await p.page.locator('#view-office').isHidden(), true);
    assert.deepStrictEqual(p.errors, []);
  });
});
