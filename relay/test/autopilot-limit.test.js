'use strict';
// At its daily merge limit Autopilot starts nothing, and says why: one idle line beside the switch and one
// note. Raising Merges a day clears the line and it starts the ticket.
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');

test('at the daily merge limit Autopilot says why, once, and clears it when the limit is raised', async (t) => {
  const env = { RELAY_AUTOPILOT_TICK_MS: '200' };
  const first = await relay(env);
  let R = first;
  t.after(async () => { await R.stop(); await first.stop(); });
  const ap = async () => (await R.call('GET', '/autopilot')).body;
  const repo = makeRepo(R.home);
  await R.call('POST', '/tickets', { title: 'Next work', body: 'Do it.', repo });
  assert.strictEqual((await R.call('POST', '/settings', { values: { autopilotMerges: 1 } })).status, 200);
  await R.kill();
  const file = path.join(R.home, '.office-world', 'autopilot.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ t: { on: true, only: null, day: new Date().toISOString().slice(0, 10), merged: 1, prs: {}, notes: [] } }));
  R = await relay(env, first.home);
  const why = 'Autopilot merged 1 PR today, its limit. It starts again tomorrow, or raise Merges a day in Settings.';
  assert.strictEqual(await until(async () => (await ap()).idle, 'the idle line'), why);
  await sleep(800);
  const a = await ap();
  assert.strictEqual(a.notes.filter((n) => n.text === why).length, 1, 'one note, not one each loop');
  assert.strictEqual((await R.call('GET', '/tasks')).body.tasks.length, 0);
  assert.strictEqual((await R.call('POST', '/settings', { values: { autopilotMerges: 2 } })).status, 200);
  await until(async () => (await R.call('GET', '/tasks')).body.tasks.length === 1, 'Autopilot to start the ticket');
  assert.doesNotMatch((await ap()).idle || '', /its limit/);
});
