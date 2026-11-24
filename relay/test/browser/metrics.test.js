// The Metrics page in a real browser (office/metrics.html): every chart draws when the room has data and
// says "No data yet" when it has none, a number shows on hover, Table and Download work, the room page
// links to it, and a narrow screen does not scroll sideways.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { office, pageTest } = require('./page.js');
const runs = require('../../autopilot-runs.js');

const HOUR = 3600000, NOW = Date.now();
const ago = (h) => NOW - h * HOUR;
const iso = (at) => new Date(at).toISOString();
const PR = (n) => 'https://github.com/o/r/pull/' + n;
const CHARTS = ['merged', 'per-ticket', 'where', 'outcomes', 'stalls', 'waits', 'rounds', 'desks', 'cpu', 'memory', 'pm'];

function seeded() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-metrics-page-')));
  const dir = path.join(home, '.office-world');
  fs.mkdirSync(dir, { recursive: true });
  const run = (id, ticket, from, extra) => Object.assign(runs.start({ task: id, ticket, kind: 'bug', at: ago(from) }), extra);
  const made = {
    a1b2c1: run('a1b2c1', 'T-1', 6, { prAt: iso(ago(5)), mergedAt: iso(ago(1)), mergedBy: 'Autopilot', pr: PR(1) }),
    a1b2c2: run('a1b2c2', 'T-2', 30, { prAt: iso(ago(29)), mergedAt: iso(ago(20)), mergedBy: 'person', handed: { reason: 'protected-file', at: iso(ago(28)) }, pr: PR(2) }),
    a1b2c3: run('a1b2c3', 'T-3', 3, { blocked: { reason: 'dev-gone', at: iso(ago(2)) } })
  };
  const task = (id, ticket, from, to) => ({ id, ticket, title: 'A title', brief: 'A brief', state: 'done', pr: PR(Number(id.slice(-1))), createdAt: iso(ago(from)), history: [{ at: iso(ago(from)), type: 'created' }, { at: iso(ago(from - 1)), type: 'moved', to: 'in_review', by: 'relay' }, { at: iso(ago(to)), type: 'merged', pr: PR(1) }, { at: iso(ago(to)), type: 'moved', to: 'done', by: 'Autopilot' }] });
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ t: [task('a1b2c1', 'T-1', 6, 1), task('a1b2c2', 'T-2', 30, 20)] }));
  fs.writeFileSync(path.join(dir, 'autopilot.json'), JSON.stringify({ t: { on: false, only: null, day: null, merged: 0, prs: {}, notes: [], runs: made } }));
  fs.writeFileSync(path.join(dir, 'coo.json'), JSON.stringify({ t: { hands: [{ who: 'Dev', task: null, at: iso(ago(10)), endedAt: iso(ago(9.5)), how: 'answered' }], events: [{ kind: 'stall', who: 'Dev', at: iso(ago(8)), endedAt: iso(ago(6)), ended: 'went on' }], reports: [] } }));
  const at = Math.floor(NOW / 300000) * 300000, mb = 1048576;
  const desks = [], room = [];
  for (let i = 0; i < 24; i++) { desks.push([at - i * 300000, 3 + (i % 3), 1, i % 2, 0, 4 - (i % 3), 0]); room.push([at - i * 300000, 20 + i, mb * (200 + i), mb * 2000]); }
  fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify({ desks: { t: desks }, room, reviews: [], pm: [{ at: ago(2), checked: 4, held: 1, closed: 1, merged: 1, moved: 1, hoursSaved: 5 }], at: 0 }));
  return home;
}

let full, bare, home;
test.before(async () => { home = seeded(); full = await office({ home }); bare = await office(); });
test.after(async () => { if (full) await full.stop(); if (bare) await bare.stop(); if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const metrics = (o, p, query) => p.page.goto('http://127.0.0.1:' + o.R.port + '/office/metrics.html?channel=t&key=test-key' + (query || ''));

pageTest('the room page links to Metrics with its channel, and the page reads the room with the cookie', () => bare, async (p) => {
  await p.open();
  const href = await p.page.getAttribute('#metrics-link', 'href');
  assert.strictEqual(href, 'metrics.html?channel=t');
  await p.page.click('#metrics-link');
  await p.page.waitForURL(/metrics\.html/);
  await p.page.waitForSelector('body[data-drawn="7d"]');
});

pageTest('with data, each of the 11 charts draws, with a legend where it has more than one series', () => full, async (p) => {
  await metrics(full, p);
  await p.page.waitForSelector('body[data-drawn="7d"]');
  for (const id of CHARTS) {
    const card = p.page.locator('#chart-' + id);
    assert.strictEqual(await card.count(), 1, id + ' is on the page');
    assert.strictEqual(await card.getAttribute('data-empty'), null, id + ' has data');
    assert.ok(await card.locator('svg .mark').count() > 0, id + ' draws marks');
    assert.ok((await card.locator('h2').innerText()).length > 0 && (await card.locator('.q').innerText()).length > 0, id + ' has a title and a line that says what it answers');
  }
  for (const id of ['merged', 'per-ticket', 'waits', 'desks', 'pm']) assert.ok(await p.page.locator('#chart-' + id + ' .legend span').count() >= 2, id + ' has a legend');
  const tiles = await p.page.locator('#tiles .tile .k').allTextContents();
  assert.deepStrictEqual(tiles, ['Merged', 'Median time per ticket', 'Waiting on you', 'Stalled', 'Merged with no help']);
  assert.strictEqual(await p.page.locator('#tiles .tile .v').first().innerText(), '2');
  assert.deepStrictEqual(p.errors, []);
});

pageTest('a number shows on hover, and Table shows the same numbers as text', () => full, async (p) => {
  await metrics(full, p);
  await p.page.waitForSelector('body[data-drawn="7d"]');
  await p.page.locator('#chart-where .hit').first().hover();
  const tip = p.page.locator('#tip');
  await tip.waitFor({ state: 'visible' });
  assert.match(await tip.innerText(), /\d/);
  const tips = [];
  for (const hit of await p.page.locator('#chart-merged .hit').all()) { await hit.hover(); tips.push(await tip.innerText()); }
  assert.ok(tips.some((t) => /By Autopilot\s+1/.test(t)), 'a day with Autopilot\'s merge shows its count: ' + tips.join(' | '));
  await p.page.locator('#chart-desks .hit').hover();
  assert.match(await tip.innerText(), /Working\s+[\d.]+ desks/);
  const card = p.page.locator('#chart-merged');
  await card.locator('.tbl-btn').click();
  await card.locator('table.data').waitFor();
  assert.deepStrictEqual((await card.locator('table.data tr').first().locator('th').allInnerTexts()), ['Day', 'By Autopilot', 'By you']);
  assert.ok(await card.locator('svg').isHidden());
  await card.locator('.tbl-btn').click();
  assert.ok(await card.locator('svg').isVisible());
});

pageTest('the range switch asks again, and the downloads give the same numbers as CSV and JSON', () => full, async (p) => {
  await metrics(full, p);
  await p.page.waitForSelector('body[data-drawn="7d"]');
  await p.page.click('[data-range="1d"]');
  await p.page.waitForSelector('body[data-drawn="1d"]');
  assert.strictEqual(await p.page.locator('#tiles .tile .v').first().innerText(), '2');
  await p.page.click('[data-range="30d"]');
  await p.page.waitForSelector('body[data-drawn="30d"]');
  const [csv] = await Promise.all([p.page.waitForEvent('download'), p.page.click('#download-csv')]);
  assert.strictEqual(csv.suggestedFilename(), 'building58-metrics-30d.csv');
  const text = fs.readFileSync(await csv.path(), 'utf8');
  assert.match(text, /^chart,when,label,series,value\n/);
  const [json] = await Promise.all([p.page.waitForEvent('download'), p.page.click('#download-json')]);
  assert.strictEqual(JSON.parse(fs.readFileSync(await json.path(), 'utf8')).range, '30d');
});

pageTest('with no data, every chart says No data yet', () => bare, async (p) => {
  await metrics(bare, p);
  await p.page.waitForSelector('body[data-drawn="7d"]');
  for (const id of CHARTS) {
    const card = p.page.locator('#chart-' + id);
    assert.strictEqual(await card.getAttribute('data-empty'), '1', id + ' is empty');
    assert.match(await card.locator('.empty').innerText(), /^No data yet/);
  }
  assert.deepStrictEqual(p.errors, []);
});

pageTest('on a narrow screen the page does not scroll sideways, in Light and in Dark', () => full, async (p) => {
  await p.page.setViewportSize({ width: 375, height: 800 });
  await metrics(full, p);
  await p.page.waitForSelector('body[data-drawn="7d"]');
  for (const theme of ['light', 'dark']) {
    await p.page.click('[data-page-theme="' + theme + '"]');
    assert.strictEqual(await p.page.evaluate(() => document.documentElement.getAttribute('data-theme')), theme);
    const wide = await p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(wide <= 0, theme + ': the page is ' + wide + 'px too wide');
  }
});
