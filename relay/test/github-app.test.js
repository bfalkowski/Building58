// The room as a GitHub App (relay/github-app.js): the token it signs to ask GitHub for an installation token,
// the settings it sends GitHub to create the App, and what it writes for gh and into .env. No test talks to
// GitHub. And a session never gets the App's private key (relay/session-env.js).
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { jwt, keyOf, hostsYml, manifest, setEnv, ownerOf } = require('../github-app.js');
const sessionEnv = require('../session-env.js');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
const part = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

test('the App token is an RS256 JWT for the App id, valid for under 10 minutes, signed with its key', () => {
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
  const [h, b, sig] = jwt(12345, pem, now).split('.');
  assert.deepStrictEqual(part(h), { alg: 'RS256', typ: 'JWT' });
  assert.deepStrictEqual(part(b), { iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '12345' });
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(h + '.' + b), publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')));
});

test('the private key comes from .env as base64 on one line, or as the PEM itself', () => {
  assert.strictEqual(keyOf({ GITHUB_APP_PRIVATE_KEY: Buffer.from(pem).toString('base64') }), pem);
  assert.strictEqual(keyOf({ GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, '\\n') }), pem);
  assert.throws(() => keyOf({}), /GITHUB_APP_PRIVATE_KEY is empty/);
});

test('the App asks for what the room uses, checks included, and no webhook', () => {
  const m = manifest('building58-room-abc', 'http://localhost:5000/done', false);
  assert.deepStrictEqual(m.default_permissions, { contents: 'write', pull_requests: 'write', issues: 'write', checks: 'read', statuses: 'read', actions: 'read', metadata: 'read' });
  assert.strictEqual(m.public, false);
  assert.strictEqual(m.hook_attributes.active, false);
  assert.deepStrictEqual(m.default_events, []);
  assert.strictEqual(manifest('n', 'r', true).default_permissions.workflows, 'write');
});

test('gh gets the token in hosts.yml, as the App bot', () => {
  const y = hostsYml('building58-room-abc[bot]', 'ghs_TOKEN');
  assert.match(y, /^github\.com:\n {4}users:\n {8}building58-room-abc\[bot\]:\n {12}oauth_token: ghs_TOKEN\n {4}oauth_token: ghs_TOKEN\n {4}git_protocol: https\n {4}user: building58-room-abc\[bot\]\n$/);  // secret-check: allow (a made-up token)
});

test('create writes the App id and key into .env, keeping the other lines, readable only by you', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'github-app-')), '.env');
  fs.writeFileSync(file, 'RELAY_KEY=k\nGITHUB_APP_ID=\nROOM_REPOS=a/b\n');
  setEnv(file, { GITHUB_APP_ID: '42', GITHUB_APP_PRIVATE_KEY: 'QUJD' });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'RELAY_KEY=k\nGITHUB_APP_ID=42\nROOM_REPOS=a/b\nGITHUB_APP_PRIVATE_KEY=QUJD\n');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(path.dirname(file), { recursive: true });
});

test('the installation is picked by the owner of the first repo in ROOM_REPOS', () => {
  assert.strictEqual(ownerOf({ ROOM_REPOS: 'Acme/app other/x' }), 'acme');
  assert.strictEqual(ownerOf({}), '');
});

test('a session never gets the App private key', () => {
  const env = sessionEnv.build({ GITHUB_APP_PRIVATE_KEY: 'secret', GITHUB_APP_ID: '42', PATH: '/bin' }, {});
  assert.strictEqual(env.GITHUB_APP_PRIVATE_KEY, undefined);
  assert.strictEqual(env.GITHUB_APP_ID, '42');
});
