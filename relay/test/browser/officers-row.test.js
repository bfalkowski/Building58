// The officers on the org chart (office/orgchart.js, office/officers.js, office/huddle.js; page.js, WebGL
// off): the Floor bar keeps only what is about the people on the Floor, and the org chart has a fixed
// row of four officer cards, the Lead, the PM, the COO and security, each in or out, with its buttons.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest } = require('./page.js');
const { until } = require('../helpers.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

const cards = (page) => page.$$eval('#org .org-officer', (els) => els.map((el) => ({
  role: el.id.replace('org-officer-', ''),
  in: el.dataset.in,
  name: el.querySelector('.org-name').textContent,
  status: el.querySelector('.org-status').textContent
})));

pageTest('the Floor bar holds only the huddle buttons, and the org chart holds the officers', get, async (p) => {
  await p.open();
  const page = p.page;
  await page.locator('#huddle-bar:not([hidden])').waitFor();

  // The Floor bar: the status report, asking idle workers and Stop all safe. No officer is asked from there.
  const bar = await page.$$eval('#huddle-bar button', (els) => els.map((b) => b.id));
  assert.deepStrictEqual(bar, ['huddle-free', 'huddle-ask', 'stop-safe']);
  assert.strictEqual(await page.locator('#huddle-free').innerText(), 'Status report');
  assert.strictEqual(await page.locator('#huddle-ask').innerText(), 'Ask idle workers too (nobody is idle)');
  assert.strictEqual(await page.locator('#huddle-ask').isDisabled(), true);
  assert.strictEqual(await page.locator('#huddle-bar a[href$="roles.html#huddles"]').count(), 1, 'a ? link to the manual');
  // The bar reads as two things: the huddle under its label, and Stop all safe apart from it.
  assert.deepStrictEqual(await page.$$eval('#huddle-bar .huddle-group button', (els) => els.map((b) => b.id)), ['huddle-free', 'huddle-ask']);
  assert.strictEqual(await page.locator('#huddle-label').innerText(), 'Huddle');
  assert.strictEqual(await page.locator('#huddle-bar .stop-group #stop-safe').count(), 1);
  // Telling the Lead is a switch in Settings, in a Huddle section of its own, with a chip in the room bar.
  assert.strictEqual(await page.locator('#huddle-bar input').count(), 0);
  assert.strictEqual(await page.locator('#settings section[aria-labelledby="set-huddle-title"] #huddle-lead').count(), 1);
  const chip = page.locator('.ob-chip[data-chip="huddle"]');
  assert.strictEqual(await chip.innerText(), 'Huddle: tells the Lead');
  await chip.click();
  await page.locator('#settings[open]').waitFor();
  await page.uncheck('#huddle-lead');
  assert.strictEqual(await chip.innerText(), 'Huddle: Floor only');
  await page.check('#huddle-lead');
  await page.click('#settings-close');

  // The org chart: four officer cards above the groups, all out at first. Paul waits at the Lead's desk.
  await page.click('#org-btn');
  await page.locator('#org-officer-coo #coo-ask:not([hidden])').waitFor();
  assert.deepStrictEqual(await cards(page), [
    { role: 'lead', in: 'false', name: 'Paul', status: 'Out · no Lead session' },
    { role: 'pm', in: 'false', name: 'Nobody', status: 'Out · not running' },
    { role: 'coo', in: 'false', name: 'Nobody', status: 'Out · not running' },
    { role: 'security', in: 'false', name: 'Nobody', status: 'Out · not running' }
  ]);
  assert.match(await page.locator('#org-officer-coo .org-what').innerText(), /Proposes only\. Costs one session\./);
  assert.strictEqual(await page.locator('#coo-last').innerText(), 'No COO report yet');
  assert.strictEqual(await page.locator('#coo-last').isDisabled(), true);
  assert.strictEqual(await page.locator('#org-groups .org-card', { hasText: 'Paul' }).count(), 0, 'Paul shows once, in the officers row');

  // Ask the COO from the chart starts the COO as before. The chart closes, and opened again, the COO is in.
  await page.click('#coo-ask');
  assert.strictEqual(await page.locator('#org').isVisible(), false);
  const coo = await until(async () => (await o.R.call('GET', '/terminals')).body.terminals.find((t) => t.role === 'coo'), 'the COO session');
  assert.ok(coo.running);
  await page.click('#org-btn');
  await page.locator('#org-officer-coo[data-in="true"]').waitFor();
  const now = (await cards(page)).find((c) => c.role === 'coo');
  assert.notStrictEqual(now.name, 'Nobody');
  assert.match(now.status, /^In now · /);
  assert.strictEqual(await page.locator('#coo-ask').innerText(), 'The COO is writing');
  assert.strictEqual(await page.locator('#org-officer-coo .org-go').innerText(), 'Go to ' + now.name);
  assert.strictEqual(await page.locator('#org-groups .org-card', { hasText: now.name }).count(), 0, 'a running COO shows once, in the officers row');

  // Ask the PM with no idea typed takes you to the ticket title, with a hint.
  await page.click('#org-pm-ask');
  assert.strictEqual(await page.locator('#org').isVisible(), false);
  assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'ticket-title');
  assert.match(await page.locator('#ticket-note').innerText(), /idea for the PM/);
  assert.deepStrictEqual(p.errors, []);
});
