// The room's name shows on the page title, the heading, the top-left label and the sign on the back
// wall. It is Building58 unless the page address gives another with ?name=, so two rooms side by
// side can be told apart (office/roster.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());

async function names(p, extra) {
  await p.page.goto(o.address + (extra || ''));
  await p.page.locator('#relay-status[data-state="on"]').waitFor();
  return p.page.evaluate(() => ({
    roster: window.OFFICE_ROSTER.company,
    heading: document.getElementById('title').textContent,
    label: document.getElementById('hud-company').textContent,
    title: document.title
  }));
}

pageTest('the room is called Building58 by default', () => o, async (p) => {
  const n = await names(p);
  assert.deepStrictEqual([n.roster, n.heading, n.label], ['Building58', 'Building58', 'Building58']);
  assert.match(n.title, /^(\(\d+\) )?Building58$/);
  assert.deepStrictEqual(p.errors, []);
});

pageTest('?name= gives the room another name', () => o, async (p) => {
  const n = await names(p, '&name=' + encodeURIComponent('  Room B  '));
  assert.deepStrictEqual([n.roster, n.heading, n.label], ['Room B', 'Room B', 'Room B']);
  assert.match(n.title, /^(\(\d+\) )?Room B · Building58$/);
  assert.deepStrictEqual(p.errors, []);
});

pageTest('a long ?name= is cut to 40 characters, and an empty one is ignored', () => o, async (p) => {
  const long = await names(p, '&name=' + 'x'.repeat(60));
  assert.strictEqual(long.roster, 'x'.repeat(40));
  const empty = await names(p, '&name=%20');
  assert.strictEqual(empty.roster, 'Building58');
  assert.deepStrictEqual(p.errors, []);
});
