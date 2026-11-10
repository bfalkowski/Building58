// Each role's model and skills in Settings on the room page (relay/test/browser/page.js, WebGL off):
// a model box saves what you type, and a skills list says which skills are not found here.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

pageTest('a role\'s model saves from Settings, and its skills say which are not found', get, async (p) => {
  await p.open();
  const page = p.page;
  await page.click('#cc-settings');
  await page.locator('#settings[open]').waitFor();
  const model = page.locator('#set-limits input[aria-label="The PM: model"]');
  assert.strictEqual(await model.inputValue(), '', 'every model starts empty');
  assert.strictEqual(await model.getAttribute('list'), 'set-models', 'it suggests opus, sonnet and haiku');
  await model.fill('sonnet');
  await model.press('Enter');
  await page.locator('#settings-said', { hasText: 'Saved.' }).waitFor();
  const pm = (await o.R.call('GET', '/settings')).body.settings.find((s) => s.name === 'pmModel');
  assert.deepStrictEqual([pm.value, pm.from], ['sonnet', 'page']);
  // The test's home has no plugins, so every skill on the Dev's list is not found.
  const skills = page.locator('#set-limits input[aria-label="Devs: skills"]');
  assert.match(await skills.inputValue(), /^mattpocock-skills:tdd, /);
  const row = page.locator('#set-limits .set-row', { has: page.locator('input[aria-label="Devs: skills"]') });
  assert.match(await row.locator('.set-from').innerText(), /not found: mattpocock-skills:tdd, .*pstack:blast-radius/);
  assert.deepStrictEqual(p.errors, []);
});
