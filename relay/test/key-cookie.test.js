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
  });
  await t.test('no cookie, a wrong cookie or a cookie from another port gets 401 or 403', async () => {
    for (const h of [{}, { Cookie: name + '=wrong' }, { Cookie: 'relay_key_1=test-key' }]) {
      const r = await at('/channels/t', h);
      assert.ok([401, 403].includes(r.status), String(r.status));
    }
  });
  await t.test('?key= and the Bearer header still work', async () => {
    assert.strictEqual((await at('/channels/t?key=test-key')).status, 200);
    assert.strictEqual((await at('/channels/t', { Authorization: 'Bearer test-key' })).status, 200);
  });
});
