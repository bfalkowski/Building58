// setup.sh on a server with no screen: before the GitHub step it prints the ssh -L command for the
// laptop, and it prints a link in place of opening it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');

function run(headless) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['docker', 'curl']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.copyFileSync(path.join(root, 'setup.sh'), path.join(dir, 'setup.sh'));
  fs.writeFileSync(path.join(dir, '.env'), 'RELAY_KEY=k\nCLAUDE_CODE_USE_BEDROCK=1\n', { mode: 0o600 });
  const env = { PATH: bin + ':/usr/bin:/bin', HOME: dir, SETUP_HEADLESS: headless ? '1' : '0', SETUP_APP_PORT: '47123' };
  const r = spawnSync('sh', ['setup.sh'], { cwd: dir, env, input: '', encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return r.stdout + r.stderr;
}

test('with no display, it prints the ssh -L command before the GitHub step', () => {
  assert.match(run(true), /ssh -N -L 47123:localhost:47123 \S+@\S+/);
});

test('with a display, it prints no ssh command', () => {
  assert.doesNotMatch(run(false), /ssh -N -L/);
});
