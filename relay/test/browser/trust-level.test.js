// Trust level 5 on the room page (T-161, relay/test/browser/page.js, WebGL off). At level 5 a Lead keeps
// two switches on, Let the Lead move the board and Let the Lead stop sessions, and the relay narrows them
// while Autopilot is on (relay/test/level-5-lead.test.js). Level 5 needs no Lead, so with none it is still
// level 5, not custom.
'use strict';
const assert = require('node:assert');
const { makeRepo, sleep } = require('../helpers.js');
const { office, pageTest } = require('./page.js');
const test = require('node:test');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

pageTest('level 5 shows with the board and stop switches on, and not as custom', get, async (p) => {
  const R = o.R;
  await R.call('POST', '/reviews', { auto: true, again: true });
  await R.call('POST', '/settings', { values: { leadStops: true } });
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true, only: 'T-999999' })).body.on, true);  // it starts nothing here
  await p.open();
  const page = p.page;
  const note = page.locator('#set-levels > p.set-what').last();
  const five = page.locator('#set-levels label.set-level').nth(5);
  await page.click('#cc-settings');
  await page.locator('#settings[open]').waitFor();

  // With no Lead, there is no one to give the board to, and the switches are level 5.
  await note.filter({ hasText: /^Now: level 5, Autopilot\./ }).waitFor();
  assert.strictEqual(await five.getAttribute('data-now'), 'true');
  assert.match(await five.innerText(), /A Lead keeps two rights: stop a session the Floor calls safe to stop, and move a task to Done once its PR has merged\./);

  // A Lead with no board yet is custom, and Set level 5 gives it the board.
  const lead = (await R.call('POST', '/terminals', { cwd: makeRepo(R.home, 'level-repo') })).body;
  for (const ev of ['UserPromptSubmit', 'Stop']) { await R.hook({ session_id: lead.sessionId.slice(0, 12), hook_event_name: ev, title: '' }); await sleep(150); }
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).body.lead, true);
  await note.filter({ hasText: /^Now: custom\./ }).waitFor();
  await page.check('input[name="trust-level"][value="5"]');
  await note.filter({ hasText: /Set level 5 will turn on Let the Lead move the board\.$/ }).waitFor();
  await page.click('#set-level-apply');
  await note.filter({ hasText: /^Now: level 5, Autopilot\./ }).waitFor();
  assert.strictEqual(await five.getAttribute('data-now'), 'true');
  const t = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === lead.id);
  const stops = (await R.call('GET', '/settings')).body.settings.find((x) => x.name === 'leadStops').value;
  assert.deepStrictEqual([t.board, t.merge, t.starts, stops], [true, false, 0, true], 'the board and stops on, merge and starts off');
});
