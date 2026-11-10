// Settings the person changes on the page while the relay runs (relay/config.js): GET and POST /settings.
'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, until, sessionToken, makeRepo } = require('./helpers.js');

const value = (body, name) => body.settings.find((s) => s.name === name);

test('a value set on the page applies at once, wins over the variable, and stays after a restart', async (t) => {
  let R = await relay({ RELAY_AUTOPILOT_AT_ONCE: '2' });
  const home = R.home;
  t.after(async () => { await R.kill().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); });

  let r = await R.call('GET', '/settings');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([value(r.body, 'maxAutoReviews').value, value(r.body, 'maxAutoReviews').from], [3, 'default']);
  assert.deepStrictEqual([value(r.body, 'autopilotAtOnce').value, value(r.body, 'autopilotAtOnce').from], [2, 'env']);
  assert.strictEqual((await R.call('GET', '/reviews')).body.max, 3);
  assert.strictEqual((await R.call('GET', '/tickets')).body.wipLimit, 3);

  r = await R.call('POST', '/settings', { values: { maxAutoReviews: 5, wipLimit: 4, autopilotAtOnce: 1, autopilotRounds: 3 } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.changed.sort(), ['autopilotAtOnce', 'autopilotRounds', 'maxAutoReviews', 'wipLimit']);
  // The routes read the new values with no restart.
  assert.strictEqual((await R.call('GET', '/reviews')).body.max, 5);
  assert.strictEqual((await R.call('GET', '/tickets')).body.wipLimit, 4);
  const ap = (await R.call('GET', '/autopilot')).body;
  assert.deepStrictEqual([ap.atOnce, ap.maxRounds], [1, 3], 'the page wins over RELAY_AUTOPILOT_AT_ONCE');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, '.office-world', 'settings.json'), 'utf8')).wipLimit, 4);

  await R.kill();
  R = await relay({ RELAY_AUTOPILOT_AT_ONCE: '2' }, home);
  r = await R.call('GET', '/settings');
  assert.deepStrictEqual([value(r.body, 'wipLimit').value, value(r.body, 'wipLimit').from], [4, 'page'], 'kept through a restart');

  // Reset takes it back to the variable, or the default.
  r = await R.call('POST', '/settings', { reset: ['autopilotAtOnce', 'wipLimit'] });
  assert.deepStrictEqual([value(r.body, 'autopilotAtOnce').value, value(r.body, 'autopilotAtOnce').from], [2, 'env']);
  assert.deepStrictEqual([value(r.body, 'wipLimit').value, value(r.body, 'wipLimit').from], [3, 'default']);
});

test('a bad value changes nothing, and no session can read or change the settings', async (t) => {
  const R = await relay({});
  t.after(() => R.stop());
  let r = await R.call('POST', '/settings', { values: { maxAutoReviews: 4, wipLimit: 0 } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'bad_value');
  r = await R.call('POST', '/settings', { values: { maxAutoReviews: 2.5 } });
  assert.strictEqual(r.status, 400);
  r = await R.call('POST', '/settings', { values: { leadStops: 'yes' } });
  assert.strictEqual(r.status, 400);
  r = await R.call('POST', '/settings', { values: { RELAY_KEY: 'x' } });
  assert.strictEqual(r.body.error, 'unknown_setting');
  assert.strictEqual(value((await R.call('GET', '/settings')).body, 'maxAutoReviews').value, 3, 'all or nothing');

  // A session's token, even the Lead's, gets nothing.
  const repo = makeRepo(R.home);
  const s = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ session_id: s.sessionId.slice(0, 12), hook_event_name: 'UserPromptSubmit' });
  await R.call('POST', '/terminals/lead', { terminal: s.id, board: true });
  const token = await until(() => { try { return { 'X-Office-Token': sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');
  assert.strictEqual((await R.call('GET', '/settings', undefined, token)).status, 401);
  assert.strictEqual((await R.call('POST', '/settings', { values: { leadStopLimit: 60 } }, token)).status, 401);
  // From another site, refused.
  assert.strictEqual((await R.call('GET', '/settings', undefined, { Authorization: 'Bearer test-key', Origin: 'https://example.com' })).status, 403);
});
