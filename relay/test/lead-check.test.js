'use strict';
// The Lead's heartbeat setting (relay/lead-check.js). The event prompts are in stuck.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { relay } = require('./helpers.js');

test('Settings shows the Lead check, in the Work group, 60 minutes unless set, and 0 turns it off', async (t) => {
  const R = await relay();
  t.after(() => R.stop());
  const find = async () => (await R.call('GET', '/settings')).body.settings.find((s) => s.name === 'leadCheckMinutes');
  const s = await find();
  assert.strictEqual(s.group, 'Work');
  assert.strictEqual(s.label, 'Lead heartbeat every');
  assert.strictEqual(s.unit, 'minutes');
  assert.strictEqual(s.def, 60);
  assert.strictEqual(s.min, 0);
  assert.strictEqual(s.env, 'RELAY_LEAD_CHECK_MS');
  assert.strictEqual((await R.call('POST', '/settings', { values: { leadCheckMinutes: 1 } })).status, 200);
  assert.strictEqual((await find()).value, 1);
  assert.strictEqual((await R.call('POST', '/settings', { values: { leadCheckMinutes: 0 } })).status, 200);
  assert.strictEqual((await find()).value, 0);
  assert.strictEqual((await R.call('POST', '/settings', { values: { leadCheckMinutes: -1 } })).status, 400);
});
