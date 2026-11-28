// The elevator (office/office.js) on the room page. Doors in the back wall of the loft have two floor
// buttons, and pressing one takes the view to that floor: the executive floor sits above the loft, and
// the Main floor button brings back the first view. Nobody walks through the elevator's wall, and without
// WebGL there are no buttons. The wall test counts each person once they have been at their spot: a stay at the
// fridge lasts 4 seconds of room time, half a second at the speed 8 the test sets, so waiting for everyone at once to be at a spot could never come.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest, SOFTWARE, until, watch } = require('./page.js');

const LOFT_HEIGHT = 4.6;

test.describe('the elevator, with WebGL, in software', () => {
  let o;
  test.before(async () => { o = await office({ webgl: true }); });
  test.after(() => o && o.stop());

  pageTest('the buttons take the view up to the executive floor and back', () => o, async (p) => {
    await p.page.goto(o.address);
    const exec = p.page.locator('#floor-exec'), main = p.page.locator('#floor-main');
    await exec.waitFor();
    await p.page.click('.navpad button[data-dir="home"]');
    const angles = () => p.page.evaluate(() => window.NavPad.pads[0].angles());
    const level = () => p.page.evaluate(() => window.run.level());
    const home = await angles();
    assert.strictEqual(await main.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(await exec.getAttribute('aria-pressed'), 'false');
    assert.strictEqual((await level()).floor, 'main');

    await exec.click();
    assert.strictEqual(await exec.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(await main.getAttribute('aria-pressed'), 'false');
    const up = await level();
    assert.strictEqual(up.floor, 'exec');
    assert.ok(up.camera[1] > LOFT_HEIGHT && up.target[1] > LOFT_HEIGHT, 'the view is above the loft, never inside it: ' + JSON.stringify(up));
    assert.ok(up.camera[1] > up.target[1], 'it looks down at the floor, so it is never under it: ' + JSON.stringify(up));

    // Dragging does not take the view off the floor or through its walls.
    const box = await p.page.locator('#world').boundingBox();
    await p.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.page.mouse.down();
    await p.page.mouse.move(box.x + box.width / 2 - 300, box.y + box.height / 2 + 200, { steps: 10 }); await p.page.mouse.up();
    await until(p, (ceil) => { const l = window.run.level(); return l.target[1] > ceil && l.camera[1] > l.target[1]; }, LOFT_HEIGHT);
    const dragged = await level();
    assert.ok(dragged.target[1] > LOFT_HEIGHT && dragged.camera[1] > dragged.target[1], 'dragging stays on the floor: ' + JSON.stringify(dragged));
    assert.ok(Math.abs(dragged.target[0]) <= 6.5 && dragged.target[2] >= -4.5 && dragged.target[2] <= 4.5, 'the view stays inside the walls: ' + JSON.stringify(dragged));

    // The buttons on the wall do the same: one click on each, as it shows on the screen.
    await main.click();
    await p.page.click('.navpad button[data-dir="home"]');
    const wall = (floor) => p.page.evaluate((f) => window.run.level().buttons.find((b) => b.floor === f), floor);
    const upButton = await wall('exec');
    assert.ok(upButton, 'the wall has a button for the executive floor');
    await p.page.mouse.click(upButton.x, upButton.y);
    await until(p, () => window.run.level().floor === 'exec');
    const downButton = await wall('main');
    await p.page.mouse.click(downButton.x, downButton.y);
    await until(p, () => window.run.level().floor === 'main');
    assert.strictEqual(await main.getAttribute('aria-pressed'), 'true');
    assert.strictEqual((await level()).floor, 'main');
    const back = await angles();
    for (const k of ['theta', 'phi', 'radius']) assert.ok(Math.abs(back[k] - home[k]) < 0.02, 'it goes back to the first view, ' + k + ': ' + JSON.stringify([home, back]));
    assert.deepStrictEqual(p.errors, []);
  }, SOFTWARE);

  pageTest('the Manager\'s office button and the floor buttons agree on one view', () => o, async (p) => {
    await p.page.goto(o.address);
    await p.page.locator('#floor-exec').waitFor();
    await p.page.click('#floor-exec');
    await p.page.click('#view-office');
    assert.strictEqual((await p.page.evaluate(() => window.run.level())).floor, 'main', 'the office is on the main floor');
    assert.strictEqual(await p.page.locator('#floor-main').getAttribute('aria-pressed'), 'true');
    await p.page.click('#floor-exec');
    assert.strictEqual(await p.page.locator('#view-office').getAttribute('aria-pressed'), 'false');
    assert.deepStrictEqual(p.errors, []);
  }, SOFTWARE);
});

test.describe('the elevator, without WebGL', () => {
  let o;
  test.before(async () => { o = await office(); });
  test.after(() => o && o.stop());

  pageTest('there are no floor buttons without a scene, and nobody walks through the elevator wall', () => o, async (p) => {
    await p.open();
    assert.strictEqual(await p.page.locator('#floor-exec').isHidden(), true);
    assert.strictEqual(await p.page.locator('#floor-main').isHidden(), true);
    await p.page.evaluate(() => window.run.ready());
    await p.page.evaluate(() => { window.run.cast(); window.run.do({ action: 'speed', value: 8 }); });
    const doors = await p.page.evaluate(() => window.run.level().doors);
    assert.ok(doors && doors.x1 > doors.x0, 'the doors are in the back wall: ' + JSON.stringify(doors));
    const ids = await p.page.evaluate(() => window.run.roster().filter((w) => w.id !== 'manager' && w.id !== 'lead').map((w) => w.id));
    const spots = { board: 'board-', chat: 'bar-', window: 'win-', coffee: 'espresso', fridge: 'fridge' };
    const sent = [], answers = [];
    for (const id of ids) {
      for (const what of Object.keys(spots)) {
        const r = await p.page.evaluate(([who, to]) => window.run.do({ action: 'idle', who, do: to }), [id, what]);
        if (r.ok) { sent.push([id, spots[what]]); break; }
        answers.push(id + ' ' + what + ': ' + JSON.stringify(r));
      }
    }
    assert.ok(sent.length > 0, 'someone walks along the back wall: ' + answers.join('; '));
    await p.page.evaluate(() => { window.reached = {}; });
    const seen = await watch(p, ([who, d]) => {
      const bad = who.map(([id]) => window.run.debug(id)).filter((x) => x && x.pos[0] > d.x0 - 0.05 && x.pos[0] < d.x1 + 0.05 && x.pos[1] < d.wall + 0.05);
      if (bad.length) return { bad: 'someone is in the elevator wall: ' + JSON.stringify(bad.map((x) => x.pos)) };
      for (const [id, prefix] of who) { const x = window.run.debug(id); if (x && x.step && x.step.t === 'act' && x.spot && x.spot.startsWith(prefix)) window.reached[id] = true; }
      return { done: who.every(([id]) => window.reached[id]) };
    }, [sent, doors], 90000);
    assert.ok(!seen.bad, seen.bad);
    assert.deepStrictEqual(p.errors, []);
  });
});
