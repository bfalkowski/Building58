// Settings in tabs on the room page (relay/test/browser/page.js, WebGL off): it opens on Trust, each tab
// shows only its settings, search finds a setting on another tab and opens it, a setting changed from its
// default shows the mark and its tab the count, and the tabs work from the keyboard and on a narrow window.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;
const openSettings = async (p) => { await p.page.click('#cc-settings'); await p.page.locator('#settings[open]').waitFor(); };
const shown = (p) => p.page.locator('#settings .set-panel:not([hidden]) .set-row:not([data-miss])');

pageTest('Settings opens on Trust, and each tab shows only its settings', get, async (p) => {
  await p.open();
  await openSettings(p);
  const page = p.page;
  assert.strictEqual(await page.locator('#set-tab-trust').getAttribute('aria-selected'), 'true');
  assert.strictEqual(await page.locator('#settings .set-panel:not([hidden])').count(), 1);
  assert.strictEqual(await page.locator('#set-panel-trust').isVisible(), true);
  const all = (await o.R.call('GET', '/settings')).body.settings;
  await page.locator('#set-cfg-autopilot .set-row').first().waitFor({ state: 'attached' });
  for (const tab of await page.locator('#set-tabs [role="tab"]').evaluateAll((ts) => ts.map((t) => t.dataset.tab))) {
    await page.click('#set-tab-' + tab);
    assert.strictEqual(await page.locator('#settings .set-panel:not([hidden])').count(), 1, tab);
    const names = await page.locator('#set-panel-' + tab + ' [id^="set-cfg-"] .set-row').evaluateAll((rows) => rows.map((r) => r.querySelector('label').textContent.trim()));
    const want = all.filter((s) => s.tab === tab).map((s) => s.label);
    for (const label of want) assert.ok(names.some((n) => n.startsWith(label)), tab + ' lacks ' + label);
    for (const other of all.filter((s) => s.tab !== tab)) assert.ok(!names.some((n) => n.startsWith(other.label + ' ') && n === other.label), tab + ' shows ' + other.label);
  }
  const loose = await page.locator('#settings input:not(#set-search), #settings select:not(#set-tab-menu), #settings button:not([role="tab"]):not(#settings-close)').evaluateAll((els) => els.filter((e) => !e.closest('.set-panel')).map((e) => e.id || e.outerHTML.slice(0, 60)));
  assert.deepStrictEqual(loose, [], 'every switch is on a tab');
  assert.deepStrictEqual(p.errors, []);
});

pageTest('the search box finds a setting on another tab and opens that tab', get, async (p) => {
  await p.open();
  await openSettings(p);
  const page = p.page;
  assert.strictEqual(await page.locator('#set-panel-autopilot').isVisible(), false);
  await page.fill('#set-search', 'wip limit');
  await page.locator('#set-panel-autopilot').waitFor();
  assert.strictEqual(await page.locator('#set-tab-autopilot').getAttribute('aria-selected'), 'true');
  assert.match(await shown(p).first().innerText(), /^WIP limit/);
  assert.strictEqual(await p.page.locator('#settings .set-panel:not([hidden]) .set-row[data-miss]').count() > 0, true, 'the rest of the tab is hidden');
  assert.strictEqual(await page.locator('#set-search-said').innerText(), '2 settings match on 1 tab.');
  assert.strictEqual(await page.locator('#set-tab-chat').isVisible(), false, 'a tab with no match goes');
  await page.fill('#set-search', 'huddle answers');
  await page.locator('#set-panel-chat').waitFor();
  assert.match(await shown(p).first().innerText(), /Wait for huddle answers/);
  await page.fill('#set-search', 'zzzz nothing');
  await page.locator('#set-empty').waitFor();
  await page.fill('#set-search', '');
  await page.locator('#set-tab-room').waitFor();
  assert.strictEqual(await page.locator('#set-empty').isVisible(), false);
  assert.deepStrictEqual(p.errors, []);
});

pageTest('a setting changed from its default shows the mark, and its tab shows the count', get, async (p) => {
  await o.R.call('POST', '/settings', { values: { wipLimit: 4, autopilotRounds: 3, chatKeep: 300 } });
  await p.open();
  await openSettings(p);
  const page = p.page;
  const count = (tab) => page.locator('#set-tab-' + tab + ' .set-count');
  await count('autopilot').waitFor();
  assert.strictEqual(await count('autopilot').innerText(), '2');
  assert.strictEqual(await count('chat').innerText(), '1');
  assert.strictEqual(await count('room').isVisible(), false, 'no count when nothing changed');
  assert.strictEqual(await page.locator('#set-tab-autopilot').getAttribute('aria-label'), 'Autopilot, 2 changed');
  await page.click('#set-tab-autopilot');
  const row = page.locator('#set-cfg-autopilot .set-row', { has: page.locator('input[aria-label^="WIP limit"]') });
  assert.strictEqual(await row.locator('.set-mark').isVisible(), true);
  assert.strictEqual(await page.locator('#set-cfg-autopilot .set-row', { hasText: 'Merges a day' }).locator('.set-mark').isVisible(), false);
  await row.locator('.set-reset').click();
  await page.waitForFunction(() => document.querySelector('#set-tab-autopilot .set-count').textContent === '1');
  assert.strictEqual(await row.locator('.set-mark').isVisible(), false);
  await page.click('#set-tab-trust');
  await page.locator('#set-panel-trust .set-row', { hasText: 'Let the Lead stop sessions' }).locator('input[type="checkbox"]').check();
  await page.waitForFunction(() => document.querySelector('#set-tab-trust .set-count').textContent === '1');
  await o.R.call('POST', '/settings', { reset: ['autopilotRounds', 'chatKeep', 'leadStops'] });
  assert.deepStrictEqual(p.errors, []);
});

pageTest('the arrow keys move between tabs, the last tab is kept, and a narrow window gets one menu', get, async (p) => {
  await p.open();
  await openSettings(p);
  const page = p.page;
  await page.focus('#set-tab-trust');
  await page.keyboard.press('ArrowDown');
  assert.strictEqual(await page.locator('#set-tab-autopilot').getAttribute('aria-selected'), 'true');
  assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'set-tab-autopilot');
  await page.keyboard.press('End');
  assert.strictEqual(await page.locator('#set-tab-advanced').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowDown');
  assert.strictEqual(await page.locator('#set-tab-trust').getAttribute('aria-selected'), 'true', 'it wraps');
  await page.click('#set-tab-roles');
  await page.click('#settings-close');
  await p.open();
  await openSettings(p);
  assert.strictEqual(await page.locator('#set-tab-roles').getAttribute('aria-selected'), 'true', 'the tab last used is kept');
  assert.strictEqual(await page.locator('#set-tab-menu').isVisible(), false);
  await page.setViewportSize({ width: 480, height: 800 });
  assert.strictEqual(await page.locator('#set-tab-menu').isVisible(), true);
  assert.strictEqual(await page.locator('#set-tabs').isVisible(), false);
  await page.selectOption('#set-tab-menu', 'chat');
  assert.strictEqual(await page.locator('#set-panel-chat').isVisible(), true);
  assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
  assert.deepStrictEqual(p.errors, []);
});
