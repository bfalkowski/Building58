// The room bar while Update goes through merges one at a time (office/update.js). The relay's answers
// to /update are played by the test, since the loop itself is tested at the relay
// (relay/test/update-steps.test.js): here, what the page shows, its stop button, and its reload.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

pageTest('the bar shows the loop\'s progress, stops it between merges, and reloads for a page-only merge', get, async (p) => {
  const page = p.page;
  const step = (over) => Object.assign({ at: 2, of: 5, name: 'PR 41', pr: 41, sha: 'a'.repeat(40), later: 0, reloads: 0, stopping: false }, over);
  let update = null, loads = 0, run = 'r1';
  const posts = [];
  const answer = () => ({ ok: true, dir: '/x', branch: 'main', run, update, note: null, noteAt: null, reloads: 0, steps: true, rollback: null });
  page.on('load', () => { loads++; });
  await page.route(/\/channels\/[^/]+\/update(\?|$)/, async (route) => {
    const r = route.request();
    if (r.method() === 'POST') {
      posts.push(JSON.parse(r.postData() || '{}'));
      if (posts[posts.length - 1].cancel) update = Object.assign({}, update, { step: Object.assign({}, update.step, { stopping: true }) });
      else update = { state: 'waiting', from: 'f', to: 't', files: [], startedAt: '', waitingOn: [{ title: 'Ada', why: 'in a turn' }], step: step({ at: 1 }) };
      return route.fulfill({ status: posts[posts.length - 1].cancel ? 200 : 202, contentType: 'application/json', body: JSON.stringify(Object.assign({ ok: true, changed: true, restart: true, run: 'r1', message: 'Fetched.' }, { update })) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer()) });
  });
  await p.open();
  const note = page.locator('#cc-update-note'), off = page.locator('#cc-update-off');

  await page.click('#cc-update');
  await note.filter({ hasText: 'Update: 1 of 5, PR 41. It changes the relay, so the relay restarts on it when nobody is in a turn. A session at a question stays at it. Waiting for: Ada (in a turn).' }).waitFor();
  assert.strictEqual(await off.innerText(), 'Stop after this merge');
  assert.ok(await off.isVisible());

  update = Object.assign({}, update, { state: 'checking', step: step({ later: 3 }) });
  await note.filter({ hasText: 'Update: 2 of 5, PR 41. The new relay is in. Waiting for its check before the next merge. 3 more wait for the next Update.' }).waitFor();

  await off.click();
  await note.filter({ hasText: "Update: 2 of 5, PR 41. The new relay is in. Waiting for its check before the next merge. It stops after this merge. 3 more wait for the next Update." }).waitFor();
  assert.deepStrictEqual(posts[posts.length - 1], { cancel: true });
  await off.waitFor({ state: 'hidden' });

  // A page-only merge went in: the page reloads, and follows the loop again.
  const before = loads;
  update = Object.assign({}, update, { state: 'stepping', step: step({ at: 3, name: 'PR 42', reloads: 1 }) });
  await page.waitForEvent('load');
  assert.ok(loads > before, 'the page reloaded');
  await note.filter({ hasText: 'Update: 3 of 5, PR 42. Putting it in.' }).waitFor();

  // A relay merge restarted the relay, and the new relay counts its page steps from 0 again. The page
  // reloads for the new relay, and again for its next page-only merge.
  let reloaded = page.waitForEvent('load');
  run = 'r2';
  update = Object.assign({}, update, { state: 'checking', step: step({ at: 4, name: 'PR 43', reloads: 0 }) });
  await reloaded;
  await note.filter({ hasText: 'Update: 4 of 5, PR 43. The new relay is in.' }).waitFor();
  reloaded = page.waitForEvent('load');
  update = Object.assign({}, update, { state: 'stepping', step: step({ at: 5, name: 'PR 44', reloads: 1 }) });
  await reloaded;
  await note.filter({ hasText: 'Update: 5 of 5, PR 44. Putting it in.' }).waitFor();
});
