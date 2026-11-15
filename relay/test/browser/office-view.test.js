// The Manager's office button (office/office.js) on the room page. Drawn in software, it puts the
// view at the manager's desk, where it turns like a head but never moves off it, and Back to the room
// brings back the first view. With no WebGL there is no scene, so
// there is no button.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest, SOFTWARE, until } = require('./page.js');

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
    assert.ok(inside.radius < 2.1, 'the view is behind him at his desk, close up: ' + JSON.stringify(inside));
    // Tags move on the next frame, which in software can take a while. Only people in his office keep theirs.
    await until(p, () => {
      const inOffice = new Set(window.run.roster().filter((w) => { const d = window.run.debug(w.id); return d && d.pos[1] < -5; }).map((w) => w.name));
      return [...document.querySelectorAll('#tags .tag')].filter((t) => !t.hidden).every((t) => inOffice.has(t.querySelector('b').textContent));
    });
    // Turning, it stays at his desk and stops before the walls: about 70 degrees each way.
    const left = p.page.locator('.navpad button[data-dir="left"]'), box = await left.boundingBox();
    await p.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.page.mouse.down(); await p.page.waitForTimeout(2500); await p.page.mouse.up();
    const turned = await angles();
    assert.ok(Math.abs(turned.radius - inside.radius) < 0.05, 'turning keeps the view at his desk: ' + JSON.stringify([inside, turned]));
    const off = Math.abs(Math.atan2(Math.sin(turned.theta - inside.theta), Math.cos(turned.theta - inside.theta)));
    assert.ok(off > 0.5 && off < 1.3, 'it turns, and stops before the wall: ' + JSON.stringify([inside, turned]));

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
