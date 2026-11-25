// The front office's layout (office/index.html; page.js, WebGL off): Activity has its own folding panel, the
// front office sits under the 3D office with Claude Code beside them, the workers row runs the full width
// under both, and everything stacks in one column on a narrow screen.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());

pageTest('Activity is its own panel, and the seats are in the front office', () => o, async (p) => {
  await p.open();
  const { page } = p;
  await page.locator('#needs-you:not([hidden])').waitFor();
  assert.strictEqual(await page.locator('#front-office #feed').count(), 0, 'Activity is not in the front office');
  assert.strictEqual(await page.locator('#activity #feed').count(), 1, 'Activity has its own panel');
  assert.strictEqual(await page.getAttribute('#activity h2 button', 'aria-expanded'), 'false', 'it starts folded');
  assert.strictEqual(await page.innerText('#floor-title'), 'Front office');
  assert.strictEqual(await page.locator('#front-office #seats').count(), 1);
  await page.click('#activity h2 button');
  assert.strictEqual(await page.locator('#feed-scroll').isVisible(), true, 'pressing its title opens it');
  assert.deepStrictEqual(p.errors, []);
});

const box = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top + scrollY, bottom: r.bottom + scrollY, height: r.height }; }, sel);
const needs = (n) => ({ ok: true, at: new Date().toISOString(), count: n, items: Array.from({ length: n }, (_, i) => ({ kind: 'permission', who: 'w' + i, terminal: null, task: null, ticket: null, pr: null, line: 'Approve or deny the request number ' + i + ' from a session that has waited a long while for an answer from you.', link: {} })) });

pageTest('the front office is under the 3D office, Claude Code is beside them, and the workers row runs under both', () => o, async (p) => {
  await p.open();
  const { page } = p;
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.evaluate(() => scrollTo(0, 0));
  const [stage, front, cc, workers] = [await box(page, '#stage'), await box(page, '#front-office'), await box(page, '.cc'), await box(page, '#workers')];
  assert.ok(front.top >= stage.bottom - 1, 'the front office is under the 3D office');
  assert.ok(Math.abs(front.left - stage.left) <= 1, 'in the same column');
  assert.ok(cc.left >= front.right - 1, 'Claude Code is on the right');
  assert.ok(workers.top >= Math.max(front.bottom, cc.bottom) - 1 || workers.top >= front.bottom - 1, 'the workers row is under the front office');
  assert.ok(workers.left <= stage.left + 1 && workers.right >= cc.right - 1, 'and runs the full width');
  await page.setViewportSize({ width: 900, height: 1000 });
  const [s2, f2, c2, w2] = [await box(page, '#stage'), await box(page, '#front-office'), await box(page, '.cc'), await box(page, '#workers')];
  assert.ok(f2.top >= s2.bottom - 1 && c2.top >= f2.bottom - 1 && w2.top >= c2.bottom - 1, 'on a narrow screen everything stacks in one column');
  assert.deepStrictEqual(p.errors, []);
});

pageTest('scrolled down to the workers row, the Claude Code panel does not cover it', () => o, async (p) => {
  await p.open();
  const { page } = p;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.getElementById('workers').scrollIntoView({ block: 'start' }));
  const seen = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }, sel);
  const [cc, workers] = [await seen('.cc'), await seen('#workers')];
  const overlap = cc.bottom > workers.top + 1 && cc.top < workers.bottom - 1 && cc.right > workers.left + 1 && cc.left < workers.right - 1;
  assert.ok(!overlap, 'the panel ends above the workers row: panel ' + JSON.stringify(cc) + ', row ' + JSON.stringify(workers));
  assert.deepStrictEqual(p.errors, []);
});

pageTest('a long Needs you list scrolls inside itself, and the huddle report keeps room to show', () => o, async (p) => {
  await p.open();
  const { page } = p;
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route(/\/needs-you(\?|$)/, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(needs(15)) }));
  await page.locator('#needs-you-list li:nth-child(15)').waitFor();
  assert.ok(await page.evaluate(() => { const l = document.getElementById('needs-you-list'); return l.scrollHeight > l.clientHeight; }), 'Needs you scrolls inside itself');
  await page.locator('#huddle-bar:not([hidden])').waitFor();
  await page.click('#huddle-free');
  await page.locator('#huddle-report:not([hidden])').waitFor();
  assert.ok((await box(page, '#huddle-report')).height >= 90, 'the huddle report keeps room to show');
  assert.strictEqual(await page.locator('#seats').isVisible(), true);
  assert.deepStrictEqual(p.errors, []);
});
