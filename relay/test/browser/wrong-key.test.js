// A page opened with a key that is not the relay's says so plainly, under the room bar, and hides
// Update, which could only fail. The relay's own answer tells a wrong key from a missing one.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());

pageTest('a wrong key in the address is named under the room bar, and Update is hidden', () => o, async (p) => {
  const { page } = p;
  await page.goto(o.address.replace('key=test-key', 'key=not-the-key'));
  const warn = page.locator('#key-warn');
  await warn.waitFor();
  assert.match(await warn.innerText(), /^This page's key is not the relay's key, so nothing on this page reaches the relay\. Open the room with the key the relay was started with \(RELAY_KEY\)/);
  assert.match(await page.innerText('#cc-note'), /^This page's key is not the relay's key/);
  await page.locator('#relay-status', { hasText: 'Relay: wrong key' }).waitFor();
  await page.waitForFunction(() => document.getElementById('cc-update').hidden);
  // Each refused request prints a 401 in the console. Nothing else may fail.
  assert.deepStrictEqual(p.errors.filter((e) => !/status of 401/.test(e)), []);
});

pageTest('with the right key there is no such note', () => o, async (p) => {
  await p.open();
  assert.ok(await p.page.locator('#key-warn').isHidden());
  assert.ok(await p.page.locator('#cc-update').isVisible());
  assert.deepStrictEqual(p.errors, []);
});

test('the relay tells a wrong key from a missing one', async () => {
  const at = (q) => fetch('http://127.0.0.1:' + o.R.port + '/channels/t/tasks' + q).then(async (r) => [r.status, (await r.json()).message]);
  assert.deepStrictEqual(await at('?key=not-the-key'), [401, 'That key is not this relay\'s key. Use the key the relay was started with (RELAY_KEY): the link npm run office prints has it, after key=.']);
  assert.deepStrictEqual(await at(''), [401, 'Send the relay key as "Authorization: Bearer <key>" or ?key=<key>.']);
});
