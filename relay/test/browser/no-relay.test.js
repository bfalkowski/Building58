// A room page opened with no relay, as from a plain web server or a copy on a website, says so once,
// points to Run a demo, and turns off each control that needs the relay, with "Needs a relay" beside
// it (office/no-relay.js). A page opened through the relay shows none of it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());

pageTest('with no relay the page says so, turns off what needs one, and its Run a demo starts the demo', () => o, async (p) => {
  const { page } = p;
  await page.goto(new URL('/office/', o.address).href);
  const note = page.locator('#no-relay');
  await note.waitFor();
  assert.match(await note.innerText(), /^No relay\. This page is not connected to a relay, so the room plays on its own\./);
  for (const id of ['cc-update', 'cc-start', 'cc-cwd', 'cc-resume']) assert.ok(await page.locator('#' + id).isDisabled(), id + ' is off');
  assert.strictEqual(await page.locator('#cc-update + .needs-relay').innerText(), 'Needs a relay');
  assert.strictEqual(await page.locator('#cc-start + .needs-relay').innerText(), 'Needs a relay');
  const own = page.locator('details[data-needs-relay]');
  assert.match(await own.locator('summary').innerText(), /Needs a relay/);
  await own.locator('summary').click();
  assert.strictEqual(await own.evaluate((d) => d.open), false, 'Use your own terminal instead does not open');
  assert.match(await page.innerText('#cc-note'), /^Needs a relay\./);
  await page.click('#no-relay-demo');
  await page.waitForFunction(() => document.getElementById('demo').getAttribute('aria-pressed') === 'true');
  await page.click('#no-relay-demo');
  assert.strictEqual(await page.locator('#demo').getAttribute('aria-pressed'), 'true', 'a second press does not stop the demo');
  assert.ok(await page.locator('#party-btn').isEnabled(), 'what works with no relay stays on');
  assert.deepStrictEqual(p.errors, []);
});

pageTest('opened through the relay, the page has no such note and Update is on', () => o, async (p) => {
  await p.open();
  assert.ok(await p.page.locator('#no-relay').isHidden());
  assert.ok(await p.page.locator('#cc-update').isEnabled());
  assert.strictEqual(await p.page.locator('.needs-relay').count(), 0);
  assert.deepStrictEqual(p.errors, []);
});
