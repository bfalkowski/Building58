// The robot edition (office/figures.js), WebGL off: ?edition=robots builds each person at a desk as a robot,
// and the room and the trailer run as they do with people. Without it the room has people. The
// pictures are checked by eye; relay/test/figures.test.js checks that each robot keeps the skeleton.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest, until } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

pageTest('?edition=robots shows the robot edition, and the page has no errors', get, async (p) => {
  await p.page.goto(o.address + '&edition=robots');
  await until(p, () => window.run && window.run.state().edition === 'robots');
  await until(p, () => window.run.state().workers.filter((w) => w.present).length >= 3);
  assert.deepStrictEqual(p.errors, []);
});

pageTest('without ?edition, and with ?edition=people, the room has people', get, async (p) => {
  await p.page.goto(o.address);
  await until(p, () => window.run && window.run.state().edition === 'people');
  await p.page.goto(o.address + '&edition=people');
  await until(p, () => window.run && window.run.state().edition === 'people');
  assert.deepStrictEqual(p.errors, []);
});

pageTest('the trailer plays in the robot edition, with the whole roster in the room', get, async (p) => {
  await p.page.goto(o.address + '&edition=robots&trailer');
  await until(p, () => document.documentElement.dataset.trailer === 'playing');
  await until(p, () => window.run.state().workers.every((w) => w.present));
  assert.strictEqual(await p.page.evaluate(() => window.run.state().edition), 'robots');
  assert.deepStrictEqual(p.errors, []);
});
