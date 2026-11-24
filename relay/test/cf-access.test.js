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
async function remote(t, more) {
  const R = await relay(Object.assign({ RELAY_REMOTE: '1', RELAY_REMOTE_URL: 'https://' + HOST, RELAY_ACCESS_TEAM: TEAM, RELAY_ACCESS_AUD: AUD, RELAY_ACCESS_EMAIL: EMAIL, RELAY_ACCESS_CERTS_URL: await keyServer(t) }, more));
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

const forged = (head, over) => {
  const data = enc(head) + '.' + enc(claims(over));
  return data + '.' + crypto.sign('RSA-SHA256', Buffer.from(data), good.privateKey).toString('base64url');
};
const sample = {
  'a future nbf': () => token({ nbf: Math.floor(Date.now() / 1000) + 600 }),
  'alg none': () => forged({ alg: 'none', kid: 'k1' }),
  'alg HS256': () => forged({ alg: 'HS256', kid: 'k1' })
};
test('with RELAY_ACCESS_MFA=cloudflare, a future nbf and a forged alg still get 403', async (t) => {
  const R = await remote(t, { RELAY_ACCESS_MFA: 'cloudflare' });
  for (const [name, make] of Object.entries(sample)) {
    const r = await raw(R, '/office/', { 'Cf-Access-Jwt-Assertion': make() });
    assert.strictEqual(r.status, 403, name);
  }
});
for (const [name, make] of Object.entries(sample)) {
  test('403 for ' + name, async (t) => {
    const R = await remote(t);
    assert.strictEqual((await raw(R, '/office/', { 'Cf-Access-Jwt-Assertion': make() })).status, 403);
  });
}
test('a string audience and an email in other case are accepted', async (t) => {
  const R = await remote(t);
  assert.strictEqual((await raw(R, '/office/', { 'Cf-Access-Jwt-Assertion': token({ aud: AUD, email: 'Owner@Example.com' }) })).status, 200);
});
test('a valid token with Origin null gets 403', async (t) => {
  const R = await remote(t);
  assert.strictEqual((await raw(R, '/office/', { 'Cf-Access-Jwt-Assertion': token(), Origin: 'null' })).status, 403);
});
test('the room\'s terminal routes refuse a request with a Cf- header, even under a localhost Host', async (t) => {
  const R = await remote(t);
  const r = await raw(R, '/channels/t/terminals?key=test-key', { Host: 'localhost:' + R.port, 'Cf-Access-Jwt-Assertion': token() });
  assert.strictEqual(r.status, 403);
  assert.match(r.body, /local_only/);
});

test('the keys are fetched at most once a minute when the fetch fails, and again for a new key id after it', async () => {
  let hits = 0, clock = 1e12, up = false;
  const g = cf.gate({ host: HOST, origin: 'https://' + HOST, issuer: 'https://' + TEAM, aud: AUD, email: EMAIL, certsUrl: 'x' }, {
    now: () => clock,
    fetch: async () => { hits++; return up ? { ok: true, json: async () => ({ keys: [jwk(good, 'k2')] }) } : { ok: false, status: 500 }; }
  });
  const req = (kid) => ({ headers: { 'cf-access-jwt-assertion': token({ exp: Math.floor(clock / 1000) + 600 }, good, kid), host: HOST } });
  for (let i = 0; i < 5; i++) assert.strictEqual(await g.allows(req('k2')), false);
  assert.strictEqual(hits, 1, 'five requests, one fetch');
  clock += 61000; up = true;
  assert.strictEqual(await g.allows(req('k2')), true, 'the new key id after the wait');
  assert.strictEqual(hits, 2);
});

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

test('with RELAY_ACCESS_MFA=cloudflare a token with no amr gets in, and every other check still holds', async (t) => {
  const R = await remote(t, { RELAY_ACCESS_MFA: 'cloudflare' });
  assert.strictEqual((await raw(R, '/office/', { 'Cf-Access-Jwt-Assertion': token({ amr: undefined }) })).status, 200);
  assert.strictEqual((await raw(R, '/office/', { 'Cf-Access-Jwt-Assertion': token({ amr: ['pwd'] }) })).status, 200);
  for (const [name, headers] of Object.entries(bad)) {
    if (name === 'no MFA' || name === 'no authentication methods') continue;
    const r = await raw(R, '/office/', headers());
    assert.strictEqual(r.status, 403, name);
    assert.strictEqual(r.body, 'Forbidden', name);
  }
  assert.strictEqual((await raw(R, '/office/', { 'Cf-Access-Jwt-Assertion': token({ amr: undefined, email: 'other@example.com' }) })).status, 403);
});

test('RELAY_ACCESS_MFA is amr unless set, and any other value stops the relay', () => {
  const env = { RELAY_REMOTE: '1', RELAY_REMOTE_URL: 'https://a.example.com', RELAY_ACCESS_TEAM: 't.cloudflareaccess.com', RELAY_ACCESS_AUD: 'a', RELAY_ACCESS_EMAIL: 'e@x.com' };
  assert.strictEqual(cf.fromEnv(env).mfa, 'amr');
  assert.strictEqual(cf.fromEnv(Object.assign({ RELAY_ACCESS_MFA: 'Cloudflare' }, env)).mfa, 'cloudflare');
  assert.throws(() => cf.fromEnv(Object.assign({ RELAY_ACCESS_MFA: 'off' }, env)), /RELAY_ACCESS_MFA/);
});

test('with RELAY_REMOTE_FULL=1 the owner uses a local-only route through the tunnel, and only the owner', async (t) => {
  const R = await remote(t, { RELAY_REMOTE_FULL: '1' });
  const KEYED = { Authorization: 'Bearer test-key' };
  const ok = await raw(R, '/channels/t/terminals', Object.assign({ 'Cf-Access-Jwt-Assertion': token(), 'Cf-Ray': 'r1', 'Sec-Fetch-Site': 'same-origin', Origin: 'https://' + HOST }, KEYED));
  assert.strictEqual(ok.status, 200, ok.body);
  const noToken = await raw(R, '/channels/t/terminals', Object.assign({ 'Cf-Ray': 'r1' }, KEYED));
  assert.strictEqual(noToken.status, 403);
  assert.strictEqual(noToken.body, 'Forbidden');
  const otherEmail = await raw(R, '/channels/t/terminals', Object.assign({ 'Cf-Access-Jwt-Assertion': token({ email: 'other@example.com' }) }, KEYED));
  assert.strictEqual(otherEmail.status, 403);
  const crossSite = await raw(R, '/channels/t/terminals', Object.assign({ 'Cf-Access-Jwt-Assertion': token(), 'Sec-Fetch-Site': 'cross-site' }, KEYED));
  assert.strictEqual(crossSite.status, 403);
  assert.match(crossSite.body, /local_only/);
  const otherOrigin = await raw(R, '/channels/t/terminals', Object.assign({ 'Cf-Access-Jwt-Assertion': token(), Origin: 'https://evil.example.com' }, KEYED));
  assert.strictEqual(otherOrigin.status, 403);
  const noKey = await raw(R, '/channels/t/terminals', { 'Cf-Access-Jwt-Assertion': token() });
  assert.strictEqual(noKey.status, 401);
});

test('with RELAY_REMOTE_FULL=1 a sibling site and a POST from another site are refused', async (t) => {
  const R = await remote(t, { RELAY_REMOTE_FULL: '1' });
  const KEYED = { Authorization: 'Bearer test-key' };
  const sameSite = await raw(R, '/channels/t/terminals', Object.assign({ 'Cf-Access-Jwt-Assertion': token(), 'Sec-Fetch-Site': 'same-site' }, KEYED));
  assert.strictEqual(sameSite.status, 403);
  assert.match(sameSite.body, /local_only/);
  const post = (headers) => new Promise((ok, no) => {
    const req = http.request({ host: '127.0.0.1', port: R.port, method: 'POST', path: '/channels/t/terminals', headers: Object.assign({ Host: HOST, 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': token() }, KEYED, headers) }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => ok({ status: res.statusCode, body }));
    });
    req.on('error', no); req.end('{}');
  });
  const evil = await post({ Origin: 'https://evil.example.com', 'Sec-Fetch-Site': 'cross-site' });
  assert.strictEqual(evil.status, 403);
  const sibling = await post({ 'Sec-Fetch-Site': 'same-site' });
  assert.strictEqual(sibling.status, 403);
  assert.match(sibling.body, /local_only/);
});

test('with RELAY_REMOTE_FULL=1 a request that passed but came from another address is refused', async () => {
  const cfg = cf.fromEnv({ RELAY_REMOTE: '1', RELAY_REMOTE_URL: 'https://' + HOST, RELAY_ACCESS_TEAM: TEAM, RELAY_ACCESS_AUD: AUD, RELAY_ACCESS_EMAIL: EMAIL, RELAY_REMOTE_FULL: '1' });
  const g = cf.gate(cfg, { fetch: async () => ({ ok: true, json: async () => ({ keys: [jwk(good, 'k1')] }) }) });
  const terminal = require('../terminal.js');
  const req = (addr) => ({ headers: { host: HOST, 'cf-access-jwt-assertion': token() }, socket: { remoteAddress: addr } });
  const near = req('127.0.0.1'), far = req('192.0.2.5');
  assert.ok(await g.allows(near));
  assert.ok(await g.allows(far));
  assert.strictEqual(terminal.localOnly(near, 8787), null, 'the owner through cloudflared on this computer gets in');
  assert.match(terminal.localOnly(far, 8787), /only answers this computer/);
});

test('without RELAY_REMOTE_FULL a valid token still gets 403 local_only on a local-only route', async (t) => {
  const R = await remote(t);
  const r = await raw(R, '/channels/t/terminals', { 'Cf-Access-Jwt-Assertion': token(), Authorization: 'Bearer test-key' });
  assert.strictEqual(r.status, 403);
  assert.match(r.body, /local_only/);
});

test('RELAY_REMOTE_FULL is off unless 1, and any other value stops the relay', () => {
  const env = { RELAY_REMOTE: '1', RELAY_REMOTE_URL: 'https://a.example.com', RELAY_ACCESS_TEAM: 't.cloudflareaccess.com', RELAY_ACCESS_AUD: 'a', RELAY_ACCESS_EMAIL: 'e@x.com' };
  assert.strictEqual(cf.fromEnv(env).full, false);
  assert.strictEqual(cf.fromEnv(Object.assign({ RELAY_REMOTE_FULL: '0' }, env)).full, false);
  assert.strictEqual(cf.fromEnv(Object.assign({ RELAY_REMOTE_FULL: '1' }, env)).full, true);
  assert.throws(() => cf.fromEnv(Object.assign({ RELAY_REMOTE_FULL: 'yes' }, env)), /RELAY_REMOTE_FULL/);
});

test('remote mode is off by default, and a half-set one stops the relay', async () => {
  assert.strictEqual(cf.fromEnv({}), null);
  assert.throws(() => cf.fromEnv({ RELAY_REMOTE: '1', RELAY_REMOTE_URL: 'https://a.example.com' }), /RELAY_ACCESS_TEAM/);
  assert.throws(() => cf.fromEnv({ RELAY_REMOTE: '1', RELAY_REMOTE_URL: 'http://a.example.com', RELAY_ACCESS_TEAM: 't.cloudflareaccess.com', RELAY_ACCESS_AUD: 'a', RELAY_ACCESS_EMAIL: 'e@x.com' }), /https/);
  const R = await relay({ RELAY_REMOTE: '1' }).catch((e) => e);
  if (!(R instanceof Error)) { await R.stop(); assert.fail('the relay started with half the settings'); }
  assert.match(R.message, /RELAY_REMOTE=1 needs/);
});
