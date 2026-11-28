'use strict';
// The Games panel is hidden while Games is off (the default, ticket 623), and shows once it is on.
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

pageTest('the Games panel is hidden while Games is off, and shows once it is on', get, async (p) => {
  await p.open();
  await p.page.locator('#games').waitFor({ state: 'hidden' });
  assert.strictEqual(await p.page.locator('#games').isVisible(), false);
  assert.strictEqual((await o.R.call('POST', '/settings', { values: { games: true } })).status, 200);
  await p.open();
  await p.page.locator('#games').waitFor({ state: 'visible' });
  assert.deepStrictEqual(p.errors, []);
});
