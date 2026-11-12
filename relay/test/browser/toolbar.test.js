// The controls under the scene (office/index.html): one panel in three labelled groups, so each
// control sits with the ones like it. The page needs no WebGL for this.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office({ webgl: false }); });
test.after(() => o && o.stop());

const GROUPS = {
  People: ['demo', 'finish', 'party-btn', 'org-btn'],
  Scene: ['time', 'holiday', 'decor-btn', 'tags-btn'],
  Sound: ['radio-btn', 'radio-next', 'radio-now']
};

pageTest('the controls sit in three labelled groups, and each switch says whether it is on', () => o, async (p) => {
  await p.open();
  const groups = await p.page.evaluate(() => [...document.querySelectorAll('.toolbar > section')].map((s) => ({
    name: document.getElementById(s.getAttribute('aria-labelledby')).textContent,
    ids: [...s.querySelectorAll('[id]')].map((e) => e.id).filter((id) => !id.startsWith('tb-'))
  })));
  assert.deepStrictEqual(groups.map((g) => g.name), Object.keys(GROUPS));
  for (const g of groups) assert.deepStrictEqual(g.ids.sort(), GROUPS[g.name].slice().sort(), g.name);
  for (const id of ['party-btn', 'decor-btn', 'tags-btn', 'radio-btn']) {
    assert.match(await p.page.locator('#' + id).getAttribute('aria-pressed'), /^(true|false)$/, id + ' is a switch');
  }
  assert.deepStrictEqual(p.errors, []);
});
