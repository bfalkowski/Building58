// The officers' buttons on the org chart's officer cards (office/officers.js, relay/test/browser/page.js,
// WebGL off): Ask security starts its session, its report shows on the Floor in place of Activity, and the
// COO's report and its own take turns.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest } = require('./page.js');
const { until, sessionToken } = require('../helpers.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

pageTest('Ask security starts its session, and its report shows on the Floor', get, async (p) => {
  await p.open();
  const page = p.page;
  const ask = page.locator('#security-ask');
  await page.click('#org-btn');
  await ask.waitFor();
  assert.strictEqual(await ask.innerText(), 'Ask security');
  await ask.click();
  assert.strictEqual(await page.locator('#org').isVisible(), false, 'asking closes the org chart');
  await page.locator('#security-ask', { hasText: 'Security is writing' }).waitFor({ state: 'attached' });
  const officer = await until(async () => (await o.R.call('GET', '/terminals')).body.terminals.find((t) => t.role === 'security'), 'the security session');

  // Its report, saved with its own token, opens by itself in place of Activity.
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(officer.sessionId); } catch (e) { return null; } }, 'its token') };
  assert.strictEqual((await o.R.call('POST', '/security/report', { text: '# Access\n\nEvery session inherits the gh login.' }, token)).status, 201);
  await page.locator('#security-report:not([hidden])').waitFor();
  assert.match(await page.locator('#security-text').innerText(), /inherits the gh login/);
  assert.match(await page.locator('#security-title').innerText(), /^Security report · /);
  assert.strictEqual(await page.locator('#feed-title').isVisible(), false, 'the report takes the place of Activity');

  // The COO's report and this one take turns: one shows at a time.
  assert.strictEqual((await o.R.call('POST', '/coo/report', { text: 'The room ran alone.' })).status, 201);
  await page.locator('#coo-last', { hasText: /^Last COO report, from / }).waitFor({ state: 'attached' });
  await page.click('#org-btn');
  await page.click('#coo-last');
  assert.strictEqual(await page.locator('#org').isVisible(), false, 'the report shows on the Floor, so the chart closes');
  assert.strictEqual(await page.locator('#security-report').isHidden(), true);
  assert.strictEqual(await page.locator('#coo-report').isVisible(), true);
  await page.click('#coo-close');
  assert.strictEqual(await page.locator('#feed-title').isVisible(), true, 'Activity is back once no report shows');
  await page.click('#org-btn');
  await page.click('#security-last');
  assert.strictEqual(await page.locator('#security-report').isVisible(), true);
  assert.deepStrictEqual(p.errors, []);
});
