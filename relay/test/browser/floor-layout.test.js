// The Floor's layout (office/index.html; page.js, WebGL off): Activity has its own folding panel, so the
// people list takes the Floor's free height and the workers stay in view.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());

pageTest('Activity is its own panel, and the people fill the Floor', () => o, async (p) => {
  await p.open();
  const { page } = p;
  await page.locator('#needs-you:not([hidden])').waitFor();
  assert.strictEqual(await page.locator('.floor #feed').count(), 0, 'Activity is not on the Floor');
  assert.strictEqual(await page.locator('#activity #feed').count(), 1, 'Activity has its own panel');
  assert.strictEqual(await page.getAttribute('#activity h2 button', 'aria-expanded'), 'false', 'it starts folded');
  const floor = await page.locator('.floor-in').boundingBox();
  const people = await page.locator('#people').boundingBox();
  assert.ok(people.height >= floor.height * 0.5, 'the people take at least half the Floor: ' + Math.round(people.height) + ' of ' + Math.round(floor.height));
  if (process.env.FLOOR_SHOT) await page.screenshot({ path: process.env.FLOOR_SHOT, fullPage: true });
  await page.click('#activity h2 button');
  assert.strictEqual(await page.locator('#feed-scroll').isVisible(), true, 'pressing its title opens it');
  assert.deepStrictEqual(p.errors, []);
});

const box = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY, height: r.height }; }, sel);
const lined = async (page) => { const f = await box(page, '.floor'), c = await box(page, '.cc'); assert.ok(Math.abs(f.bottom - c.bottom) <= 2, 'Floor bottom ' + f.bottom + ' and Claude Code bottom ' + c.bottom); };
const needs = (n) => ({ ok: true, at: new Date().toISOString(), count: n, items: Array.from({ length: n }, (_, i) => ({ kind: 'permission', who: 'w' + i, terminal: null, task: null, ticket: null, pr: null, line: 'Approve or deny the request number ' + i + ' from a worker', link: null })) });
const longList = async (page) => { await page.route(/\/needs-you\?/, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(needs(15)) })); await page.locator('#needs-you-list li:nth-child(15)').waitFor(); };
const peopleOk = async (page) => {
  const rows = await page.evaluate(() => { const list = document.getElementById('people'), r = list.getBoundingClientRect(); return [...list.children].filter((li) => { const b = li.getBoundingClientRect(); return b.top >= r.top - 1 && b.bottom <= r.bottom + 1; }).length; });
  const total = await page.locator('#people li').count();
  assert.ok(rows >= Math.min(3, total), 'full rows in view: ' + rows + ' of ' + total);
  assert.ok((await box(page, '#people')).height >= 3 * 40, 'the people list is tall enough for three rows');
};

pageTest('the Floor lines up with the Claude Code panel, also after a resize', () => o, async (p) => {
  await p.open();
  const { page } = p;
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.evaluate(() => scrollTo(0, 0));
  await lined(page);
  await page.setViewportSize({ width: 1400, height: 1200 });
  await lined(page);
  await page.setViewportSize({ width: 1600, height: 700 });
  assert.ok((await box(page, '.floor')).height >= 420, 'the Floor keeps its height in a short window');
  assert.strictEqual(await page.locator('#people').isVisible(), true);
  await page.setViewportSize({ width: 900, height: 1000 });
  assert.strictEqual(Math.round((await box(page, '.floor')).height), 460);
  assert.strictEqual(Math.round((await box(page, '.cc')).height), 520);
  assert.deepStrictEqual(p.errors, []);
});

pageTest('a long Needs you list scrolls and the people stay in view', () => o, async (p) => {
  const { R } = o;
  await p.open();
  const { page } = p;
  for (let i = 0; i < 4; i++) await R.call('POST', '/terminals', { cwd: R.home });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await longList(page);
  await page.waitForFunction(() => document.querySelectorAll('#people li').length >= 3);
  if (process.env.FLOOR_SHOT) await page.screenshot({ path: process.env.FLOOR_SHOT, fullPage: true });
  const list = await page.evaluate(() => { const l = document.getElementById('needs-you-list'); return l.scrollHeight > l.clientHeight; });
  assert.ok(list, 'Needs you scrolls inside itself');
  await peopleOk(page);
  await lined(page);
  await page.evaluate(() => { const s = document.getElementById('huddle-report'); s.hidden = false; document.querySelector('.floor').dataset.huddle = '1'; });
  await peopleOk(page);
  assert.ok(await page.evaluate(() => { const l = document.getElementById('needs-you-list'); return l.scrollHeight > l.clientHeight; }));
  assert.deepStrictEqual(p.errors, []);
});
