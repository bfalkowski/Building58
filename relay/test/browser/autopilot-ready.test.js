// T-214 on the room page (relay/test/browser/page.js, WebGL off): when a PR that only a person merges is
// ready for the merge, the page says so once for each head, also after a reload. The relay's side, which
// sets ready, is in relay/test/autopilot.test.js. Here the page reads an Autopilot view with a ready PR in it.
'use strict';
const assert = require('node:assert');
const { sleep } = require('../helpers.js');
const { office, pageTest } = require('./page.js');
const test = require('node:test');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

const PR = 'https://github.com/acme/widgets/pull/7';
const readyWhy = (head) => 'Ready for your merge: the review of ' + head.slice(0, 7) + ' says merge, CI is green, and GitHub can merge it.';

pageTest('a PR ready for your merge is announced once for each head', get, async (p) => {
  const page = p.page;
  let head = 'a'.repeat(40);
  await page.route(/\/channels\/t\/autopilot(\?|$)/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const real = await (await route.fetch()).json();
    real.prs = [{ pr: PR, ticket: 'T-5', task: 'k1', state: 'waiting_on_you', rounds: 1, verdict: 'merge', act: 'person', why: readyWhy(head), ready: head }];
    return route.fulfill({ json: real });
  });
  await page.addInitScript(() => {
    window.said = [];
    let last = null;
    new MutationObserver(() => { const s = document.getElementById('cc-status'); if (s && s.textContent !== last) window.said.push(last = s.textContent); })
      .observe(document, { subtree: true, childList: true, characterData: true });
  });
  const told = (h) => page.evaluate((text) => window.said.filter((x) => x === text).length, 'T-5, PR #7: ' + readyWhy(h));

  await p.open();
  await page.waitForFunction((text) => window.said.includes(text), 'T-5, PR #7: ' + readyWhy(head));
  await sleep(4500);  // two more reads of the view
  assert.strictEqual(await told(head), 1, 'said once');

  await p.open();
  await sleep(4500);
  assert.strictEqual(await told(head), 0, 'not said again after a reload');

  head = 'b'.repeat(40);
  await page.waitForFunction((text) => window.said.includes(text), 'T-5, PR #7: ' + readyWhy(head));
  assert.strictEqual(await told(head), 1, 'said for the new head');
  assert.deepStrictEqual(p.errors, []);
});
