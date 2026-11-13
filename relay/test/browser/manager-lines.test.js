// The manager's lines (office/manager-lines.js) on the room page: the page loads all of them, and a
// line as long as the longest one wraps in its bubble instead of being cut off with "...".
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest, until } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

pageTest('the manager\'s lines load, and a long line shows in full in a bubble', get, async (p) => {
  await p.open();
  const lines = await p.page.evaluate(() => window.MANAGER_LINES);
  assert.strictEqual(lines.length, 100);
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a));
  await p.page.evaluate((text) => window.run.say({ who: 'lead', text }), longest);
  await until(p, (text) => [...document.querySelectorAll('.bubble')].some((b) => !b.hidden && b.textContent === text), longest);
  const b = await p.page.evaluate((text) => {
    const el = [...document.querySelectorAll('.bubble')].find((x) => !x.hidden && x.textContent === text);
    return { long: el.classList.contains('long'), cut: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 };
  }, longest);
  assert.ok(b.long, 'a long line gets the wrapping style');
  assert.ok(!b.cut, 'the line is not cut off');
  // A short line keeps the one-line bubble.
  await p.page.evaluate(() => window.run.say({ who: 'lead', text: 'Hm.' }));
  await until(p, () => [...document.querySelectorAll('.bubble')].some((x) => !x.hidden && x.textContent === 'Hm.' && !x.classList.contains('long')));
  assert.deepStrictEqual(p.errors, []);
});
