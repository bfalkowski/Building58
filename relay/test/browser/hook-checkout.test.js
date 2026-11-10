// The warning under the room bar when the global hooks run office-hook.js from another checkout than the
// relay's own (T-57). It shows the command to run, never the key, and goes away once they match.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const test = require('node:test');
const { ROOT } = require('../helpers.js');
const { office, pageTest, until } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());

const settings = (script) => {
  const file = path.join(o.R.home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const h = { type: 'command', command: 'OFFICE_RELAY_KEY=secret-hook-key node ' + script, async: true };
  fs.writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [h] }] } }));
};

pageTest('the room bar warns about hooks from another checkout, with the command and no key', () => o, async (p) => {
  await p.open();
  assert.strictEqual(await p.page.locator('#cc-hooks-warn').isVisible(), false, 'no global hooks, no warning');

  settings('/old/3d-worker-sessions/relay/office-hook.js');
  const warn = p.page.locator('#cc-hooks-warn');
  await warn.waitFor();  // the panel reads /terminals every 2 seconds
  const text = await warn.innerText();
  assert.match(text, /\/old\/3d-worker-sessions\/relay\/office-hook\.js/);
  assert.ok(text.includes('cd ' + fs.realpathSync(ROOT) + ' && RELAY_KEY=<your relay key> npm run office:hooks'), text);
  assert.ok(!(await p.page.content()).includes('secret-hook-key'), 'the key never reaches the page');
  assert.strictEqual(await p.page.locator('#office-notes #cc-hooks-warn').count(), 1, 'it shows once, under the room bar');

  settings(path.join(ROOT, 'relay', 'office-hook.js'));
  await until(p, () => document.getElementById('cc-hooks-warn').hidden);
  assert.deepStrictEqual(p.errors, []);
});
