// The room page loads with no console errors, both with the scene drawn in software and with no
// WebGL at all (relay/test/browser/page.js). Without WebGL the scene shows its fallback, and the
// panels still work.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest, SOFTWARE } = require('./page.js');

for (const webgl of [true, false]) {
  test.describe(webgl ? 'with WebGL, in software' : 'with no WebGL', () => {
    let o;
    test.before(async () => { o = await office({ webgl }); });
    test.after(() => o && o.stop());

    pageTest('the page loads with no console errors' + (webgl ? '' : ', and shows the scene\'s fallback'), () => o, async (p) => {
      await p.open();
      await p.page.locator('#board-cols h3').first().waitFor({ state: 'attached' });  // the Board and Tasks start folded (office/fold.js)
      await p.page.locator('#task-rows li').first().waitFor({ state: 'attached' });
      assert.strictEqual(await p.page.locator('#fallback').isVisible(), !webgl, webgl ? 'the scene drew, so its fallback is hidden' : 'the fallback says the scene needs WebGL');
      assert.strictEqual(await p.page.locator('#world').isVisible(), webgl);
      assert.match(await p.page.innerText('#cc-status'), /^Ready\. Pick a folder and add a worker\.$/);
      assert.deepStrictEqual(p.errors, []);
    }, webgl ? SOFTWARE : undefined);
  });
}
