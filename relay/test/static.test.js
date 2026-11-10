// The relay serves the pages from its root, and refuses what is not a page: dot folders, relay/
// and node_modules/. It answers a malformed escape with 404, and in a channel name, under the
// API's /channels/ route, with 400 bad_channel, so this file also holds that one API case.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relay } = require('./helpers.js');

test('The static server', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-root-')));
  const put = (rel) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), 'x'); };
  ['office/index.html', 'node_modules/eslint/package.json', 'office/node_modules/x/index.js', '.git/config', 'relay/server.js'].forEach(put);
  const R = await relay({ RELAY_ROOT: root });
  t.after(async () => { await R.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const get = (p) => fetch('http://127.0.0.1:' + R.port + p).then((r) => r.status);

  await t.test('serves a page', async () => {
    assert.strictEqual(await get('/office/index.html'), 200);
  });
  await t.test('refuses node_modules, at the top or deeper, in any case', async () => {
    assert.strictEqual(await get('/node_modules/eslint/package.json'), 404);
    assert.strictEqual(await get('/node_modules/'), 404);
    assert.strictEqual(await get('/office/node_modules/x/index.js'), 404);
    assert.strictEqual(await get('/%6Eode_modules/eslint/package.json'), 404);
    assert.strictEqual(await get('/Node_Modules/eslint/package.json'), 404);
    assert.strictEqual(await get('/node_module%C5%BF/eslint/package.json'), 404);  // a long s, which macOS reads as s
  });
  await t.test('still refuses dot folders and relay/', async () => {
    assert.strictEqual(await get('/.git/config'), 404);
    assert.strictEqual(await get('/relay/server.js'), 404);
  });
  await t.test('refuses relay/ in any case', async () => {
    assert.strictEqual(await get('/RELAY/server.js'), 404);
    assert.strictEqual(await get('/Relay/server.js'), 404);
    assert.strictEqual(await get('/%72elay/server.js'), 404);
    assert.strictEqual(await get('/relay'), 404);
  });
  await t.test('answers 404, not 500, to a malformed escape', async () => {
    assert.strictEqual(await get('/%E0%A4%A'), 404);
    assert.strictEqual(await get('/office/%'), 404);
  });
  await t.test('answers 400 bad_channel, not 500, to a malformed escape in a channel name', async () => {
    const r = await fetch('http://127.0.0.1:' + R.port + '/channels/%E0%A4%A/tickets', { headers: { Authorization: 'Bearer test-key' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).error, 'bad_channel');
  });
});
