// docs/openapi.json is the relay's API as an OpenAPI 3.1 document, built from the route tables in
// docs/manual/relay.html by relay/openapi.js. These tests keep it true: the file is what the build
// makes, it is well formed, each route in it answers on a real relay, and a change to it since main
// came with a new version (docs/constitution.md, article 15).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { build, render, rows, OUT, PAGE } = require('../openapi.js');
const { relay } = require('./helpers.js');

const ROOT = path.join(__dirname, '..', '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const spec = () => JSON.parse(fs.readFileSync(OUT, 'utf8'));
const ops = (s) => Object.entries(s.paths).flatMap(([p, o]) => Object.entries(o).map(([m, op]) => ({ method: m.toUpperCase(), path: p, op })));
const newer = (a, b) => { const [x, y] = [a, b].map((v) => v.split('.').map(Number)); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const shape = (s) => JSON.stringify({ ...s, info: { ...s.info, version: null } });
const versionProblem = (before, now) => {
  if (shape(now) !== shape(before)) return newer(now.info.version, before.info.version) ? null : 'docs/openapi.json changed since main, so its version must go up from ' + before.info.version + ' (docs/constitution.md, article 15). Change <code id="api-version"> in docs/manual/relay.html, then run npm run openapi.';
  return now.info.version === before.info.version ? null : 'the version changed with no change to the API';
};

test('docs/openapi.json is what npm run openapi builds from the manual', () => {
  assert.strictEqual(fs.readFileSync(OUT, 'utf8'), render(), 'docs/openapi.json is out of date. Run npm run openapi.');
});

test('the document is well formed: a version, every path parameter declared, unique operation ids, and every $ref found', () => {
  const s = spec();
  assert.strictEqual(s.openapi, '3.1.0');
  assert.match(s.info.version, /^\d+\.\d+\.\d+$/);
  const ids = new Set();
  for (const { method, path: p, op } of ops(s)) {
    const named = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual((op.parameters || []).filter((x) => x.in === 'path').map((x) => x.name).sort(), named, method + ' ' + p + ' declares each path parameter once');
    assert.ok(!ids.has(op.operationId), 'operationId ' + op.operationId + ' is used twice');
    ids.add(op.operationId);
    assert.ok(op.summary && op.description && op.responses && op.responses.default, method + ' ' + p + ' has a summary, a description and its errors');
  }
  const refs = JSON.stringify(s).match(/"\$ref":"#\/[^"]+"/g) || [];
  for (const r of refs) {
    const at = r.slice(10, -1).split('/').reduce((o, k) => o && o[k], s);
    assert.ok(at, r + ' points at nothing');
  }
});

test('the build refuses a page with no version, or a route with a parameter it has no pattern for', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  assert.throws(() => build(html.replace(/<code id="api-version">[^<]+<\/code>/, '')), /api-version/);
  assert.throws(() => build(html.replace('<code>GET /tickets/{id}</code>', '<code>GET /tickets/{nope}</code>')), /No pattern for \{nope\}/);
  assert.ok(rows(html).length >= 85, 'the manual\'s tables still list the routes');
});

test('the relay serves docs/openapi.json, each route in it answers, and a made-up one does not', async (t) => {
  const R = await relay();
  t.after(R.stop);
  const base = 'http://127.0.0.1:' + R.port;
  const sample = { channel: 't', page: '1', id: '000000', name: 'general', seat: 'S1', pid: '1' };
  const fill = (p) => p.replace(/\{(\w+)\}/g, (_, k) => (k === 'id' && /commands\/\{id\}/.test(p) ? '00000000-0000-0000-0000-000000000000'
    : k === 'id' && /terminals\/\{id\}/.test(p) ? '000000000000' : k === 'id' && /rounds\/\{id\}/.test(p) ? '00000000' : sample[k]));
  const ask = async (method, p) => {
    const ac = new AbortController();
    const r = await fetch(base + p, { method, signal: ac.signal, headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: method === 'POST' ? '{' : undefined });
    const type = r.headers.get('content-type') || '';
    const body = type.includes('json') ? await r.json() : null;
    ac.abort();
    return { status: r.status, type, body };
  };
  const missing = [];
  for (const { method, path: p } of ops(spec())) {
    const r = await ask(method, fill(p));
    const known = r.type.includes('event-stream') || (r.body && r.body.error !== 'not_found');
    if (!known) missing.push(method + ' ' + p + ': ' + r.status + ' ' + JSON.stringify(r.body));
  }
  assert.deepStrictEqual(missing, [], 'routes in docs/openapi.json that the relay does not know');
  const served = await fetch(base + '/docs/openapi.json');
  assert.strictEqual(served.status, 200);
  assert.match(served.headers.get('content-type'), /application\/json/);
  assert.deepStrictEqual(await served.json(), spec(), 'the relay serves the document at /docs/openapi.json');
  for (const [method, p] of [['GET', '/channels/t/no-such-route'], ['POST', '/channels/t/tickets/T-1/no-such-verb'], ['GET', '/channels/t/ready']]) {
    const r = await ask(method, p);
    assert.strictEqual(r.body && r.body.error, 'not_found', method + ' ' + p + ' is not a route, so the check above can tell');
  }
});

test('a change to the API needs a newer version, and a version needs a change', () => {
  const v1 = { info: { version: '1.0.0' }, paths: { '/a': {} } }, more = { ...v1, paths: { '/a': {}, '/b': {} } };
  assert.strictEqual(versionProblem(v1, v1), null);
  assert.match(versionProblem(v1, more), /must go up from 1.0.0/);
  assert.match(versionProblem(v1, { ...more, info: { version: '0.9.9' } }), /must go up/);
  assert.strictEqual(versionProblem(v1, { ...more, info: { version: '1.1.0' } }), null);
  assert.strictEqual(versionProblem(v1, { ...more, info: { version: '1.0.10' } }), null);
  assert.match(versionProblem(v1, { ...v1, info: { version: '1.0.1' } }), /no change to the API/);
});

test('a change to docs/openapi.json since main comes with a newer version', (t) => {
  let before;
  try { before = JSON.parse(git('show', git('merge-base', 'HEAD', 'origin/main') + ':docs/openapi.json')); } catch (e) {
    if (process.env.CI && /merge-base/.test(String(e.message))) assert.fail('CI has no origin/main to compare docs/openapi.json with. Check out with fetch-depth: 0.');
    t.skip('no docs/openapi.json at the merge base with main to compare with');
    return;
  }
  assert.strictEqual(versionProblem(before, spec()), null);
});
