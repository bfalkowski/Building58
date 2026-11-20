// Stop on the Lead's panel asks first and says what is lost (T-225). Other sessions stop with one click.
// Once the Lead's session ends, the Floor and the panel say so and offer Bring back as the Lead.
'use strict';
const assert = require('node:assert');
const { makeRepo, sleep } = require('../helpers.js');
const { office, pageTest, until } = require('./page.js');
const test = require('node:test');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());

pageTest('Stop asks before it stops the Lead, and not before other sessions', () => o, async (p) => {
  const { R } = o;
  const repo = makeRepo(R.home, 'stop-ask-repo');
  const start = async () => (await R.call('POST', '/terminals', { cwd: repo })).body;
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(150); };
  const running = async (s) => (await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === s.id && x.running);
  const lead = await start(), other = await start();
  await hook(lead, { hook_event_name: 'UserPromptSubmit', title: '' }); await hook(lead, { hook_event_name: 'Stop' });
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);

  await p.open();
  const { page } = p;
  const show = async (s) => { await page.evaluate((id) => window.dispatchEvent(new CustomEvent('office:session', { detail: { terminal: id } })), s.id); await page.locator('#cc-stop:not([hidden])').waitFor(); };

  await show(other);
  await page.locator('#cc-stop').click();
  await until(p, () => !document.getElementById('cc-stop') || /Stopped|Stopping/.test(document.getElementById('cc-status').textContent));
  assert.ok(await page.locator('#cc-stop-lead').isHidden(), 'no question for a session that is not the Lead');
  await until(p, () => /Stopped/.test(document.getElementById('cc-status').textContent));
  assert.ok(!(await running(other)), 'the other session stopped with one click');

  await show(lead);
  await page.locator('#cc-stop').click();
  const ask = page.locator('#cc-stop-lead');
  await ask.waitFor();
  const words = await ask.innerText();
  assert.match(words, /turn in progress/);
  assert.match(words, /Bring back as the Lead/);
  assert.match(words, /Refresh the Lead instead/);
  await sleep(300);
  assert.ok(await running(lead), 'the question alone stops nothing');
  await ask.getByRole('button', { name: 'Keep it running' }).click();
  assert.ok(await ask.isHidden());
  assert.ok(await running(lead));

  await page.locator('#cc-stop').click();
  await ask.getByRole('button', { name: 'Stop the Lead' }).click();
  await until(p, () => /The Lead's session was stopped/.test(document.getElementById('cc-status').textContent));
  assert.ok(!(await running(lead)));
  await page.locator('#lead-gone:not([hidden])').waitFor();
  assert.match(await page.locator('#lead-gone').innerText(), /The Lead's session was stopped/);
  await page.locator('#lead-gone').getByRole('button', { name: 'Bring back as the Lead' }).click();
  await until(p, () => document.getElementById('lead-gone').hidden);
  const back = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.running && x.sessionId === lead.sessionId);
  assert.ok(back && back.lead, 'it came back as the Lead');
  assert.deepStrictEqual(p.errors, []);
});
