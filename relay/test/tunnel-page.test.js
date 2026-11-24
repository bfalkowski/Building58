// A room page that came through a tunnel never takes the commands from a page on the room's own
// computer. It gets them only when no local page is open (T-373).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { relay, until } = require('./helpers.js');

function openPage(R, headers) {
  return new Promise((ok, no) => {
    const req = http.get({ host: '127.0.0.1', port: R.port, path: '/channels/t/stream', headers: Object.assign({ Authorization: 'Bearer test-key' }, headers) }, (res) => {
      const page = { text: '', close: () => req.destroy() };
      res.setEncoding('utf8');
      res.on('data', (c) => {
        page.text += c;
        const m = page.text.match(/event: hello\ndata: (\{.*\})/);
        if (m && !page.id) { page.id = JSON.parse(m[1]).page; ok(page); }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') no(e); });
  });
}
const sent = async (R) => (await R.call('POST', '/commands', { action: 'state', wait: false })).body.id;
const got = (page, id) => page.text.includes('"id":"' + id + '"');

test('a page through a tunnel gets commands only when no local page is open', async (t) => {
  const R = await relay();
  t.after(R.stop);
  const local = await openPage(R, {});
  const tunnel = await openPage(R, { 'Cf-Ray': 'abc123', 'Cf-Connecting-Ip': '203.0.113.9' });
  t.after(() => { local.close(); tunnel.close(); });

  const first = await sent(R);
  await until(() => got(local, first), 'the local page gets the command');
  assert.ok(!got(tunnel, first), 'the newer page through the tunnel does not');

  const hide = await R.call('POST', '/pages/' + local.id, { visible: false }, { Authorization: 'Bearer test-key', 'Cf-Ray': 'abc123' });
  assert.strictEqual(hide.status, 200);
  const second = await sent(R);
  await until(() => got(local, second), 'the local page still gets it after the tunnel page marks it hidden');
  assert.ok(!got(tunnel, second));

  local.close();
  await until(async () => (await R.call('GET', '')).body.pagesConnected === 1, 'the local page has left');
  const third = await sent(R);
  await until(() => got(tunnel, third), 'with no local page open, the page through the tunnel gets it');
});
