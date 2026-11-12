// The Lead's row is the first on the Floor, above sessions that wait on you or are working, and it
// stays at the top of the list while the rest scrolls under it (office/panel.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeRepo, until, sleep } = require('../helpers.js');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());

pageTest('the Lead is pinned to the top of the Floor', () => o, async (p) => {
  const { R } = o;
  const repo = makeRepo(R.home, 'pin-repo');
  const start = async () => (await R.call('POST', '/terminals', { cwd: repo })).body;
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(150); };
  const finish = async (s) => { await hook(s, { hook_event_name: 'UserPromptSubmit', title: '' }); await hook(s, { hook_event_name: 'Stop' }); };

  const lead = await start(), others = [];
  for (let i = 0; i < 5; i++) others.push(await start());
  await finish(lead);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
  // Sessions that would sort above an idle Lead: one waits on you, the rest are working.
  await finish(others[0]); await hook(others[0], { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
  for (const s of others.slice(1)) await hook(s, { hook_event_name: 'UserPromptSubmit', title: '' });

  await p.open();
  const { page } = p;
  await page.locator('#people li[data-lead="1"]').waitFor();
  await until(async () => (await page.locator('#people li').count()) >= 6 || null, 'six rows on the Floor');
  assert.strictEqual(await page.locator('#people li').first().getAttribute('data-lead'), '1', 'the Lead is the first row');
  assert.strictEqual(await page.locator('#people li[data-lead="1"]').count(), 1, 'one row is pinned');

  // Make the list short enough to scroll, scroll to the end, and the Lead's row is still at its top.
  await page.evaluate(() => { const l = document.getElementById('people'); l.style.maxHeight = '120px'; l.style.minHeight = '120px'; l.scrollTop = l.scrollHeight; });
  await sleep(100);
  const box = await page.evaluate(() => {
    const l = document.getElementById('people'), r = l.querySelector('li[data-lead="1"]');
    return { scrolled: l.scrollTop, list: l.getBoundingClientRect().top, row: r.getBoundingClientRect().top, under: document.elementFromPoint(r.getBoundingClientRect().left + 40, r.getBoundingClientRect().top + 8).closest('li') === r };
  });
  assert.ok(box.scrolled > 0, 'the list scrolled');
  assert.ok(Math.abs(box.row - box.list) <= 6, 'the Lead row sits at the top of the list: ' + JSON.stringify(box));
  assert.ok(box.under, 'the Lead row is drawn over the rows that scroll under it');
  assert.deepStrictEqual(p.errors, []);
});
