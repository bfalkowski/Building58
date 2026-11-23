// The room page trades the relay key in its address for an HttpOnly, SameSite=Strict cookie, and routes
// and streams accept that cookie in place of ?key=. See docs/manual/running.html#relay-key.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relay } = require('./helpers.js');

test('The relay key cookie', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-root-')));
  fs.mkdirSync(path.join(root, 'office'), { recursive: true });
  fs.writeFileSync(path.join(root, 'office', 'index.html'), 'x');
  const R = await relay({ RELAY_ROOT: root });
  t.after(async () => { await R.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const at = (p, headers) => fetch('http://127.0.0.1:' + R.port + p, { redirect: 'manual', headers });
  const name = 'relay_key_' + R.port;
  const first = await at('/office/index.html?channel=t&key=test-key');
  const set = first.headers.get('set-cookie') || '';
  const cookie = set.split(';')[0];

  await t.test('a valid key in the address sets the cookie and redirects with no key in the address', () => {
    assert.strictEqual(first.status, 302);
    assert.strictEqual(first.headers.get('location'), '/office/index.html?channel=t');
    assert.ok(set.startsWith(name + '=test-key'));
    assert.ok(/;\s*HttpOnly/.test(set) && /;\s*SameSite=Strict/.test(set));
  });
  await t.test('a wrong key sets no cookie and does not redirect', async () => {
    const r = await at('/office/index.html?channel=t&key=nope');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('set-cookie'), null);
  });
  await t.test('the cookie opens a route and the event stream', async () => {
    assert.strictEqual((await at('/channels/t', { Cookie: cookie })).status, 200);
    const ctl = new AbortController();
    const s = await fetch('http://127.0.0.1:' + R.port + '/channels/t/stream', { headers: { Cookie: cookie }, signal: ctl.signal });
    assert.strictEqual(s.status, 200);
    ctl.abort();
    await s.body.cancel().catch(() => {});
  });
  await t.test('no cookie, a wrong cookie or a cookie from another port gets 401 or 403', async () => {
    for (const h of [{}, { Cookie: name + '=wrong' }, { Cookie: 'relay_key_1=test-key' }, { Cookie: name + '=%E0%A4%A' }]) {
      assert.strictEqual((await at('/channels/t', h)).status, 401);
    }
  });
  await t.test('the redirect keeps the other parameters, and only a page gets one', async () => {
    const r = await at('/office/index.html?a=1&key=test-key&b=2');
    assert.strictEqual(r.headers.get('location'), '/office/index.html?a=1&b=2');
    const other = await at('/office/x.js?key=test-key');
    assert.strictEqual(other.headers.get('set-cookie'), null);
    assert.strictEqual((await at('//office/index.html?key=test-key')).status, 404);
  });
  await t.test('an empty ?key= with the cookie works', async () => {
    assert.strictEqual((await at('/channels/t?key=', { Cookie: cookie })).status, 200);
  });
  await t.test('the cookie from a request with another origin gets 403, a key in the header or address does not', async () => {
    const foreign = { Cookie: cookie, Origin: 'http://localhost:9999' };
    const r = await fetch('http://127.0.0.1:' + R.port + '/channels/t', { method: 'POST', headers: { ...foreign, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await at('/channels/t', foreign)).status, 403);
    assert.strictEqual((await at('/channels/t', { ...foreign, Authorization: 'Bearer test-key' })).status, 200);
    assert.strictEqual((await at('/channels/t?key=test-key', foreign)).status, 200);
    assert.strictEqual((await at('/channels/t', { Cookie: cookie, Origin: 'http://127.0.0.1:' + R.port })).status, 200);
  });
  await t.test('?key= and the Bearer header still work', async () => {
    assert.strictEqual((await at('/channels/t?key=test-key')).status, 200);
    assert.strictEqual((await at('/channels/t', { Authorization: 'Bearer test-key' })).status, 200);
  });
});
