// Remote mode (relay/cf-access.js): a request for the room's public address must carry a Cloudflare
// Access token for the one owner, signed by the team's keys, with MFA. Anything else gets 403 and no detail.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { relay } = require('./helpers.js');
const cf = require('../cf-access.js');

const HOST = 'room.example.com', TEAM = 'myteam.cloudflareaccess.com', AUD = 'aud-123', EMAIL = 'owner@example.com';
const pair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const good = pair(), other = pair();
const jwk = (k, kid) => Object.assign(k.publicKey.export({ format: 'jwk' }), { kid, alg: 'RS256', use: 'sig' });
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const claims = (over) => Object.assign({ aud: [AUD], iss: 'https://' + TEAM, email: EMAIL, amr: ['mfa', 'pwd'], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }, over);
function token(over, key, kid) {
  const data = enc({ alg: 'RS256', kid: kid || 'k1', typ: 'JWT' }) + '.' + enc(claims(over));
  return data + '.' + crypto.sign('RSA-SHA256', Buffer.from(data), (key || good).privateKey).toString('base64url');
}

async function keyServer(t) {
  const s = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ keys: [jwk(good, 'k1')] })); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => s.close());
  return 'http://127.0.0.1:' + s.address().port + '/certs';
}
async function remote(t) {
  const R = await relay({ RELAY_REMOTE: '1', RELAY_REMOTE_URL: 'https://' + HOST, RELAY_ACCESS_TEAM: TEAM, RELAY_ACCESS_AUD: AUD, RELAY_ACCESS_EMAIL: EMAIL, RELAY_ACCESS_CERTS_URL: await keyServer(t) });
  t.after(R.stop);
  return R;
}
// fetch cannot set Host, so these go out with http.
const raw = (R, p, headers) => new Promise((ok, no) => {
  http.get({ host: '127.0.0.1', port: R.port, path: p, headers: Object.assign({ Host: HOST }, headers) }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => ok({ status: res.statusCode, body }));
  }).on('error', no);
});

test('a valid token for the owner reaches the room page', async (t) => {
  const R = await remote(t);
  const r = await raw(R, '/office/', { 'Cf-Access-Jwt-Assertion': token() });
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /<html|<!doctype/i);
  const o = await raw(R, '/health', { 'Cf-Access-Jwt-Assertion': token(), Origin: 'https://' + HOST });
  assert.strictEqual(o.status, 200, 'the public address as Origin is fine');
});

const bad = {
  'no token': () => ({}),
  'a bad signature': () => ({ 'Cf-Access-Jwt-Assertion': token({}, other) }),
  'an unknown key id': () => ({ 'Cf-Access-Jwt-Assertion': token({}, good, 'nope') }),
  'the wrong audience': () => ({ 'Cf-Access-Jwt-Assertion': token({ aud: ['someone-else'] }) }),
  'the wrong issuer': () => ({ 'Cf-Access-Jwt-Assertion': token({ iss: 'https://evil.cloudflareaccess.com' }) }),
  'an expired token': () => ({ 'Cf-Access-Jwt-Assertion': token({ exp: Math.floor(Date.now() / 1000) - 10 }) }),
  'another email': () => ({ 'Cf-Access-Jwt-Assertion': token({ email: 'other@example.com' }) }),
  'no MFA': () => ({ 'Cf-Access-Jwt-Assertion': token({ amr: ['pwd'] }) }),
  'no authentication methods': () => ({ 'Cf-Access-Jwt-Assertion': token({ amr: undefined }) }),
  'another Origin': () => ({ 'Cf-Access-Jwt-Assertion': token(), Origin: 'https://evil.example.com' }),
  'a token that is not a token': () => ({ 'Cf-Access-Jwt-Assertion': 'abc' })
};
for (const [name, headers] of Object.entries(bad)) {
  test('403 with no detail for ' + name, async (t) => {
    const R = await remote(t);
    const r = await raw(R, '/office/', headers());
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body, 'Forbidden');
  });
}

test('a request through the tunnel under another Host is checked too', async (t) => {
  const R = await remote(t);
  const r = await raw(R, '/office/', { Host: 'localhost:' + R.port, 'Cf-Ray': 'abc' });
  assert.strictEqual(r.status, 403);
});

test('local use does not change', async (t) => {
  const R = await remote(t);
  const r = await raw(R, '/office/', { Host: 'localhost:' + R.port });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await R.call('GET', '/tickets')).status, 200);
});

test('remote mode is off by default, and a half-set one stops the relay', async () => {
  assert.strictEqual(cf.fromEnv({}), null);
  assert.throws(() => cf.fromEnv({ RELAY_REMOTE: '1', RELAY_REMOTE_URL: 'https://a.example.com' }), /RELAY_ACCESS_TEAM/);
  assert.throws(() => cf.fromEnv({ RELAY_REMOTE: '1', RELAY_REMOTE_URL: 'http://a.example.com', RELAY_ACCESS_TEAM: 't.cloudflareaccess.com', RELAY_ACCESS_AUD: 'a', RELAY_ACCESS_EMAIL: 'e@x.com' }), /https/);
  const R = await relay({ RELAY_REMOTE: '1' }).catch((e) => e);
  if (!(R instanceof Error)) { await R.stop(); assert.fail('the relay started with half the settings'); }
  assert.match(R.message, /RELAY_REMOTE=1 needs/);
});
