// A relay's claim on a state file (relay/lockfile.js) counts only while its pid is still a relay. A relay
// that was killed leaves its .lock, and its pid can belong to another process by the next start: after a
// reboot, or in a new container (issue #181). Then the next relay must take the file, not refuse to save.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');
const { claim, isRelay } = require('../lockfile.js');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lockfile-'));
const running = (args) => new Promise((resolve) => { const c = spawn(process.execPath, args, { stdio: 'ignore' }); setTimeout(() => resolve(c), 300); });

test('a claim whose pid is now some other process is stale, so the file is taken', async () => {
  const d = dir(), file = path.join(d, 'tasks.json');
  const other = await running(['-e', 'setTimeout(() => {}, 30000)']);
  try {
    fs.writeFileSync(file + '.lock', String(other.pid));
    assert.strictEqual(isRelay(other.pid), false);
    assert.strictEqual(claim(file), true);
    assert.strictEqual(fs.readFileSync(file + '.lock', 'utf8'), String(process.pid));
  } finally { other.kill(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('a claim whose pid is still a relay counts, so the file is left alone', async () => {
  const d = dir(), file = path.join(d, 'tasks.json');
  const relay = await running(['-e', 'setTimeout(() => {}, 30000)', path.join('relay', 'server.js')]);
  try {
    fs.writeFileSync(file + '.lock', String(relay.pid));
    assert.strictEqual(isRelay(relay.pid), true);
    assert.strictEqual(claim(file), false);
    assert.strictEqual(fs.readFileSync(file + '.lock', 'utf8'), String(relay.pid));
  } finally { relay.kill(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('a claim whose pid is gone is stale, as before', () => {
  const d = dir(), file = path.join(d, 'tasks.json');
  fs.writeFileSync(file + '.lock', '999999');
  assert.strictEqual(claim(file), true);
  fs.rmSync(d, { recursive: true, force: true });
});
