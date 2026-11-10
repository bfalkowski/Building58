// The room bar (relay/test/browser/page.js, WebGL off): what applies to the whole room sits in one
// bar between the title and the scene, not in the Claude Code panel. Settings, its chips, Update and
// the office-wide notes are there, the session panel's header keeps only the session's own controls,
// and each chip opens Settings at its own section.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeRepo } = require('../helpers.js');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

pageTest('the room bar holds Settings, its chips, Update and the office-wide notes', get, async (p) => {
  const repo = makeRepo(o.R.home, 'bar-repo');
  await p.open();
  const page = p.page;
  await page.fill('#cc-cwd', repo);
  await page.click('#cc-start');
  await page.locator('#cc-status[data-state="on"]', { hasText: /^Running in / }).waitFor();

  // Shared controls are in the bar, and only there.
  const bar = page.locator('#officebar');
  for (const id of ['#cc-settings', '#cc-update']) {
    assert.strictEqual(await bar.locator(id).count(), 1, id + ' is in the room bar');
    assert.strictEqual(await page.locator('.cc header ' + id).count(), 0, id + ' is not in the session panel');
  }
  assert.strictEqual(await page.locator('.cc #cc-hooks-warn').count(), 0, 'the hooks warning is not in the session panel');
  assert.strictEqual(await bar.locator('#office-notes #cc-hooks-warn').count(), 1, 'it is under the room bar');
  assert.strictEqual(await page.locator('#cc-settings-sum').count(), 0, 'the summary line is now the chips');
  assert.strictEqual(await bar.getByRole('link', { name: 'How work moves' }).getAttribute('href'), '../docs/manual/roles.html');
  // The session panel keeps the session's own buttons.
  for (const id of ['#cc-review', '#cc-stop', '#cc-start']) assert.ok(await page.locator('.cc header ' + id).isVisible(), id + ' stays in the panel');

  // One chip per area, saying what is on.
  const chip = (k) => bar.locator('.ob-chip[data-chip="' + k + '"]');
  await chip('reviews').filter({ hasText: /^Reviews: / }).waitFor();
  assert.strictEqual(await chip('autopilot').innerText(), 'Autopilot off');
  assert.strictEqual(await chip('autopilot').getAttribute('data-on'), '');
  assert.strictEqual(await chip('lead').innerText(), 'no Lead');
  assert.strictEqual(await chip('reviews').innerText(), 'Reviews: by hand', 'the test relay turns automatic reviews off');
  assert.strictEqual(await chip('reviews').getAttribute('data-on'), '');

  // A chip opens Settings at its section.
  await chip('lead').click();
  await page.locator('#settings[open]').waitFor();
  const scroll = await page.locator('#settings .set-scroll').boundingBox(), head = await page.locator('#set-lead-title').boundingBox();
  assert.ok(head.y >= scroll.y - 1 && head.y < scroll.y + 60, 'The Lead is at the top of Settings: ' + head.y + ' vs ' + scroll.y);
  await page.click('#settings-close');
  await page.locator('#settings[open]').waitFor({ state: 'detached' });
  await o.R.call('POST', '/reviews', { auto: true });  // a chip follows the switch
  await bar.locator('.ob-chip[data-chip="reviews"][data-on="1"]', { hasText: 'Reviews: auto' }).waitFor();
  await chip('reviews').click();
  const top = await page.locator('#settings .set-scroll').evaluate((el) => el.scrollTop);
  assert.ok(top > 0, 'Reviews is below the trust levels, so Settings scrolled to it');
  await page.click('#settings-close');

  // A checkout nobody is in is about the room, so its note is under the bar too. An empty one
  // leaves nothing behind, so this one gets a file.
  const t = (await o.R.call('GET', '/terminals')).body.terminals.find((x) => x.running);
  fs.writeFileSync(path.join(t.cwd, 'notes.txt'), 'kept\n');
  await page.click('#cc-stop');
  await page.locator('#cc-status', { hasText: /^Stopped\./ }).waitFor();
  await bar.locator('#office-notes .cc-ask', { hasText: 'Checkout with nobody in it: ' }).waitFor();
  assert.strictEqual(await page.locator('.cc .cc-ask').count(), 0, 'no notes in the session panel');
  if (process.env.OFFICE_BAR_SHOT) await page.screenshot({ path: process.env.OFFICE_BAR_SHOT, clip: { x: 0, y: 0, width: 1400, height: 1000 } });
  assert.deepStrictEqual(p.errors, []);
});
