// The Claude Code settings the container writes before the relay starts (relay/container-setup.js):
// the first run is marked done, so no text style question blocks a session, and the API key from .env
// is approved, so no question about it blocks one either. What the person set is kept.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { claudeConfig } = require('../container-setup.js');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'container-setup-'));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('a new Claude Code folder gets its first run marked done and a text style', () => {
  const d = dir();
  const config = read(claudeConfig({ CLAUDE_CONFIG_DIR: d }));
  assert.strictEqual(config.hasCompletedOnboarding, true);
  assert.strictEqual(config.theme, 'dark');
  assert.strictEqual(config.customApiKeyResponses, undefined, 'no key, so nothing to approve');
  fs.rmSync(d, { recursive: true });
});

test('what the person set is kept, and the key from .env is approved once', () => {
  const d = dir();
  const key = 'sk-ant-api03-' + 'x'.repeat(30) + 'ENDOFTHEKEY1234567890';
  const tail = key.slice(-20);
  fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ theme: 'light', projects: { '/a': {} }, customApiKeyResponses: { approved: ['other'], rejected: [tail] } }));
  claudeConfig({ CLAUDE_CONFIG_DIR: d, ANTHROPIC_API_KEY: key });
  const config = read(claudeConfig({ CLAUDE_CONFIG_DIR: d, ANTHROPIC_API_KEY: key }));
  assert.strictEqual(config.theme, 'light');
  assert.deepStrictEqual(config.projects, { '/a': {} });
  assert.deepStrictEqual(config.customApiKeyResponses, { approved: ['other', tail], rejected: [] });
  assert.ok(!JSON.stringify(config).includes(key), 'only the last 20 characters, as Claude Code keeps them');
  fs.rmSync(d, { recursive: true });
});

test('a file that is not JSON is set aside and kept, not a reason to stop', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, '.claude.json'), '{ not json');
  assert.strictEqual(read(claudeConfig({ CLAUDE_CONFIG_DIR: d })).hasCompletedOnboarding, true);
  const kept = fs.readdirSync(d).filter((f) => f.startsWith('.claude.json.unreadable-'));
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(d, kept[0]), 'utf8'), '{ not json');
  fs.rmSync(d, { recursive: true });
});
