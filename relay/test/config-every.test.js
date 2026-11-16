// config.every (relay/config.js): a setting turned on from 0 runs its first call after the short
// first wait, not the full interval. The hold-mark test in autopilot.test.js turns comment checks
// on with POST /settings and waits on that first call, so a change here fails this small test first (T-301).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'config-every-'));
process.env.RELAY_SETTINGS_FILE = path.join(home, 'settings.json');
delete process.env.RELAY_REVIEW_POLL_SECONDS;
const config = require('../config.js');

test('a setting turned on from 0 runs its first call after firstMs, not the full interval', (t) => {
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.strictEqual(config.set({ values: { reviewPollSeconds: 0 } })[0], 200);
  let calls = 0;
  config.every('reviewPollSeconds', () => { calls++; }, 5000);
  t.mock.timers.tick(60 * 1000);
  assert.strictEqual(calls, 0, 'no call while the setting is 0');

  assert.strictEqual(config.set({ values: { reviewPollSeconds: 3600 } })[0], 200);
  t.mock.timers.tick(4999);
  assert.strictEqual(calls, 0, 'not before firstMs');
  t.mock.timers.tick(1);
  assert.strictEqual(calls, 1, 'the first call comes after firstMs (5 seconds), not after an hour');

  t.mock.timers.tick(3600 * 1000 - 1);
  assert.strictEqual(calls, 1, 'the next call waits the full interval');
  t.mock.timers.tick(1);
  assert.strictEqual(calls, 2);
});
