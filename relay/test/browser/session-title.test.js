// The title you give a session with /rename shows right after its person's name, as "Paul · my title":
// on the name tag in the scene, on their row in the people list, and in the Claude Code panel's header
// (relay/test/browser/page.js). Drawn in software, since the tags follow the scene. A long title is cut
// with an ellipsis, the whole of it is the tooltip, and it is text, never HTML.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeRepo, sleep } = require('../helpers.js');
const { office, pageTest, SOFTWARE } = require('./page.js');

let o;
test.before(async () => { o = await office({ webgl: true }); });
test.after(() => o && o.stop());

const FULL = 'fix the <b>login</b> page before the demo';
const SHOWN = ' · fix the <b>login</b> page bef…';

pageTest('a /rename title shows after the name on the tag, the row and the panel header', () => o, async (p) => {
  const { R } = o;
  const s = (await R.call('POST', '/terminals', { cwd: makeRepo(R.home, 'title-repo') })).body;
  const other = (await R.call('POST', '/terminals', { cwd: makeRepo(R.home, 'plain-repo') })).body;
  for (const ev of ['UserPromptSubmit', 'Stop']) { await R.hook({ session_id: s.sessionId.slice(0, 12), hook_event_name: ev, title: 'Claude wrote this' }); await sleep(100); }
  await R.hook({ session_id: other.sessionId.slice(0, 12), hook_event_name: 'Stop', title: 'only Claude\'s title' });
  const all = (await R.call('GET', '/terminals')).body.terminals;
  const who = all.find((x) => x.id === s.id).who, plain = all.find((x) => x.id === other.id).who;
  await p.open();
  await p.page.evaluate(() => window.run.ready());
  const page = p.page;
  const tag = (name) => page.locator('#tags .tag', { has: page.locator('b', { hasText: new RegExp('^' + name + '$') }) });
  const row = (name) => page.locator('#people li', { has: page.locator('b', { hasText: new RegExp('^' + name + '$') }) });

  // Claude Code's own title is not one you gave it, so the name stands alone.
  await row(who).waitFor();
  assert.strictEqual(await row(who).locator('.who > em').textContent(), '');
  await R.hook({ session_id: s.sessionId.slice(0, 12), hook_event_name: 'Stop', title: FULL, customTitle: FULL });

  await row(who).locator('.who > em', { hasText: SHOWN.trim() }).waitFor();
  const r = await row(who).evaluate((li) => ({ name: li.querySelector('b').textContent, named: li.querySelector('.who > em').textContent, tip: li.querySelector('.who > em').title, tags: li.querySelector('.who > em').children.length, label: li.querySelector('.person').getAttribute('aria-label') }));
  assert.deepStrictEqual([r.name, r.named, r.tip, r.tags], [who, SHOWN, FULL, 0]);
  assert.ok(r.label.startsWith(who + ' · ' + FULL + ': '), r.label);

  await tag(who).locator('em', { hasText: SHOWN.trim() }).waitFor({ state: 'attached' });
  const t = await tag(who).evaluate((el) => ({ name: el.querySelector('b').textContent, named: el.querySelector('em').textContent, tip: el.querySelector('em').title, tags: el.querySelector('em').children.length }));
  assert.deepStrictEqual(t, { name: who, named: SHOWN, tip: FULL, tags: 0 });

  // Someone with no title of their own looks as before.
  assert.strictEqual(await tag(plain).locator('em').textContent(), '');
  assert.strictEqual(await row(plain).locator('.who > em').textContent(), '');

  // The panel's header, once you pick them.
  await row(who).locator('.person').click();
  await page.locator('#cc-title', { hasText: 'Claude Code · ' + who + SHOWN }).waitFor();
  assert.strictEqual(await page.getAttribute('#cc-title', 'title'), who + ' · ' + FULL);

  if (process.env.SESSION_TITLE_SHOT) {
    await page.evaluate((id) => window.run.focus(id), all.find((x) => x.id === s.id).seat);
    await sleep(2500);
    await page.screenshot({ path: process.env.SESSION_TITLE_SHOT });
  }

  // Taking it away takes it off.
  await R.hook({ session_id: s.sessionId.slice(0, 12), hook_event_name: 'Stop', customTitle: '' });
  await page.locator('#cc-title', { hasText: new RegExp('^Claude Code · ' + who + '$') }).waitFor();
  await page.waitForFunction((name) => [...document.querySelectorAll('#tags .tag')].some((el) => el.querySelector('b').textContent === name && el.querySelector('em').textContent === ''), who);
  await page.waitForFunction((name) => [...document.querySelectorAll('#people li')].some((li) => li.querySelector('b').textContent === name && li.querySelector('.who > em').textContent === ''), who);
  assert.deepStrictEqual(p.errors, []);
}, SOFTWARE);
