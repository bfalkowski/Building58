// Requests from another site to a route that runs commands (POST /terminals): the key alone is not enough.
'use strict';
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo } = require('./helpers.js');

test('a route that runs commands answers only the room page on this computer', async (t) => {
  const R = await relay();
  t.after(() => R.stop());
  const repo = makeRepo(R.home);
  // fetch cannot set Host, so the request goes out as raw HTTP.
  const post = (headers) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ cwd: repo });
    const req = http.request({ host: '127.0.0.1', port: R.port, method: 'POST', path: '/channels/t/terminals',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const page = 'http://127.0.0.1:' + R.port;
  const here = { Host: '127.0.0.1:' + R.port };
  const key = { Authorization: 'Bearer test-key' };
  const sessions = async () => (await R.call('GET', '/terminals')).body.terminals.length;

  const refused = {
    'an Origin of another site': { Origin: 'https://example.com' },
    'an Origin on this computer but another port': { Origin: 'http://localhost:' + (R.port + 1) },
    'Sec-Fetch-Site: cross-site': { 'Sec-Fetch-Site': 'cross-site' },
    'Sec-Fetch-Site: same-site': { 'Sec-Fetch-Site': 'same-site' },
    'a Host that is not localhost': { Host: 'evil.example:' + R.port },
  };
  for (const [what, extra] of Object.entries(refused)) {
    await t.test(what + ' gets 403 even with the key', async () => {
      const r = await post({ ...here, ...key, ...extra });
      assert.strictEqual(r.status, 403, JSON.stringify(r.body));
      assert.strictEqual(r.body.error, 'local_only');
      assert.strictEqual(await sessions(), 0, 'nothing was started');
    });
  }
  await t.test('the room page itself still starts a session', async () => {
    const r = await post({ ...here, ...key, Origin: page, 'Sec-Fetch-Site': 'same-origin' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(await sessions(), 1);
  });
});
