// The Claude Code version check (relay/claude-version.js) and its line in Needs you (relay/needs-you-plan.js).
// The container image pins one Claude Code, and that pin must be the newest version the room was tested
// with, so moving the pin also moves the tested range, in the same pull request.
'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { compare, verdict, TESTED } = require('../claude-version.js');
const { listOf } = require('../needs-you-plan.js');
const ROOT = path.join(__dirname, '..', '..');

test('versions compare by number, not as text', () => {
  assert.strictEqual(compare('2.1.330', '2.1.330'), 0);
  assert.strictEqual(compare('2.1.99', '2.1.330'), -1);
  assert.strictEqual(compare('2.2.0', '2.1.330'), 1);
  assert.strictEqual(compare('10.0.0', '9.9.9'), 1);
});

test('the version comes from the first words of claude --version', () => {
  assert.deepStrictEqual(verdict(TESTED.newest + ' (Claude Code)'), { version: TESTED.newest, oldest: TESTED.oldest, newest: TESTED.newest, ok: true });
  assert.strictEqual(verdict('9.0.0 (Claude Code)').ok, false);
  assert.strictEqual(verdict('0.0.1').ok, false);
  assert.strictEqual(verdict('fake claude --version'), null, 'the fake claude in the tests says no version');
  assert.strictEqual(verdict(''), null);
});

test('the image pins the newest tested Claude Code, and compose.yaml does not pin another', () => {
  const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const pin = (docker.match(/^ARG CLAUDE_CODE_VERSION=(\S+)$/m) || [])[1];
  assert.strictEqual(pin, TESTED.newest, 'move the pin and TESTED.newest in relay/claude-version.js together');
  assert.ok(compare(TESTED.oldest, TESTED.newest) <= 0);
  assert.ok(!/CLAUDE_CODE_VERSION/.test(fs.readFileSync(path.join(ROOT, 'compose.yaml'), 'utf8')));
});

test('Needs you has a line only for a version the room was not tested with', () => {
  assert.deepStrictEqual(listOf({ claude: verdict(TESTED.newest) }), []);
  assert.deepStrictEqual(listOf({ claude: null }), []);
  const items = listOf({ claude: { version: '9.0.0', oldest: '2.1.300', newest: '2.1.330', ok: false } });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'claude');
  assert.match(items[0].line, /^Check the sessions: they run Claude Code 9\.0\.0, and the room was tested with versions 2\.1\.300 to 2\.1\.330\./);
  assert.match(listOf({ claude: { version: '9.0.0', oldest: '2.1.330', newest: '2.1.330', ok: false } })[0].line, /tested with version 2\.1\.330\./);
});
