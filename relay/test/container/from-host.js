// The container smoke test from outside the container (docker/smoke.sh), through the port the
// container publishes on the host's 127.0.0.1. The room page and a local-only route answer, as they
// would on the computer itself, and the local-only check still refuses another site, Origin or Host.
'use strict';
const http = require('http');

const PORT = Number(process.env.SMOKE_PORT);
const KEY = process.env.SMOKE_KEY;
const PAGE = 'http://localhost:' + PORT;

function get(p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, headers: Object.assign({ Host: 'localhost:' + PORT }, headers) }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('No answer from ' + p + '.')));
    req.end();
  });
}
function ok(what, cond, detail) {
  if (!cond) throw new Error(what + ' failed' + (detail ? ': ' + detail : '.'));
  console.log('ok   ' + what);
}

(async () => {
  const fromPage = { Authorization: 'Bearer ' + KEY, Origin: PAGE, 'Sec-Fetch-Site': 'same-origin' };
  const page = await get('/office/');
  ok('the room page loads from the host', page.status === 200 && /<html/i.test(page.body), String(page.status));
  const panel = await get('/channels/office/terminals', fromPage);
  ok('a local-only route answers the room page through the published port', panel.status === 200 && JSON.parse(panel.body).enabled === true, panel.status + ' ' + panel.body.slice(0, 200));
  ok('no key gets 401', (await get('/channels/office/terminals', { Origin: PAGE })).status === 401);
  ok('another site gets 403', (await get('/channels/office/terminals', Object.assign({}, fromPage, { 'Sec-Fetch-Site': 'cross-site' }))).status === 403);
  ok('another Origin gets 403', (await get('/channels/office/terminals', Object.assign({}, fromPage, { Origin: 'https://example.com' }))).status === 403);
  ok('another Host gets 403', (await get('/channels/office/terminals', Object.assign({}, fromPage, { Host: 'example.com' }))).status === 403);
  console.log('The checks from the host passed.');
})().catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
