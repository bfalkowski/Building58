// T-98: Let the Lead start reviews is a switch in Settings under The Lead, on the room page
// (relay/test/browser/page.js, WebGL off). It starts off, and turning it on and off saves it in the relay.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;
const value = async () => (await o.R.call('GET', '/settings')).body.settings.find((s) => s.name === 'leadReviews').value;

pageTest('Let the Lead start reviews shows under The Lead, starts off, and turns on and off', get, async (p) => {
  await p.open();
  const page = p.page;
  await page.click('#cc-settings');
  await page.locator('#settings[open]').waitFor();
  const box = page.locator('#set-cfg-trust label', { hasText: 'Let the Lead start reviews' }).locator('input[type="checkbox"]');
  await box.waitFor();
  assert.strictEqual(await box.isChecked(), false, 'off by default');
  assert.match(await page.locator('#set-cfg-trust .set-row', { hasText: 'Let the Lead start reviews' }).innerText(), /ticket\.js review/);
  await box.check();
  await page.locator('#settings-said', { hasText: 'Saved.' }).waitFor();
  assert.strictEqual(await value(), true);
  await box.uncheck();
  await page.waitForFunction(() => document.querySelector('#settings-said').textContent.includes('Saved.'));
  assert.strictEqual(await value(), false);
});
