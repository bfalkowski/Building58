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
const { relay, makeRepo, until, sessionToken } = require('./helpers.js');
const agentHeaders = (token) => ({ 'X-Office-Token': token });
const api = require('../api-schemas.js');

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

test('each security entry maps a scheme name to a list, and each name is a declared scheme', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'openapi.json'), 'utf8'));
  const schemes = Object.keys(doc.components.securitySchemes);
  assert.ok(doc.security.length);
  for (const entry of doc.security) for (const [name, scopes] of Object.entries(entry)) {
    assert.ok(schemes.includes(name), name + ' is declared');
    assert.ok(Array.isArray(scopes), name + ' maps to a list');
  }
  assert.strictEqual(new Set(doc.security.map((e) => Object.keys(e)[0])).size, doc.security.length, 'no scheme twice');
});

test('the build refuses a page with no version, or a route with a parameter it has no pattern for', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  assert.throws(() => build(html.replace(/<code id="api-version">[^<]+<\/code>/, '')), /api-version/);
  assert.throws(() => build(html.replace('<code>GET /tickets/{id}</code>', '<code>GET /tickets/{nope}</code>')), /No pattern for \{nope\}/);
  assert.ok(rows(html).length >= 70, 'the manual\'s tables still list the routes');
});

test('each operation has its own description, and each tag a readable name and a description', () => {
  const s = spec(), seen = new Map();
  for (const { method, path: p, op } of ops(s)) {
    const about = op.description.split('\n\nTokens:')[0].split('\n\nFrom ')[0];
    assert.ok(!seen.has(about), method + ' ' + p + ' has the same description as ' + seen.get(about) + ': give each its own row in ' + PAGE);
    seen.set(about, method + ' ' + p);
  }
  const used = new Set(ops(s).map(({ op }) => op.tags[0]));
  assert.deepStrictEqual(s.tags.map((t) => t.name).sort(), [...used].sort(), 'the tags listed are the tags the operations use');
  for (const t of s.tags) {
    assert.match(t.name, /^[A-Z][A-Za-z]*(?: [a-z]+)*$/, 'tag ' + t.name + ' reads as words, not a path');
    assert.ok(t.description && !t.description.includes('\n'), 'tag ' + t.name + ' has a one-line description');
  }
  assert.throws(() => build(fs.readFileSync(PAGE, 'utf8').replace('<code>GET /floor</code>', '<code>GET /nowhere</code>')), /No tag for GET \/channels\/\{channel\}\/nowhere/);
});

test('each request schema has an example, and each example fits its schema', () => {
  const bad = [];
  for (const name of new Set(Object.values(api.REQUESTS))) {
    const examples = api.SCHEMAS[name].examples;
    if (!Array.isArray(examples) || !examples.length) { bad.push(name + ' has no example'); continue; }
    for (const e of examples) for (const p of api.check(api.SCHEMAS[name], e)) bad.push(name + ': ' + p);
  }
  assert.deepStrictEqual(bad, [], 'request schemas whose example is missing or does not fit');
  assert.deepStrictEqual(api.check(api.SCHEMAS.TaskMove, { to: 'shipped' }), ['"to" is one of "building", "in_review", "changes_requested", "waiting_on_you", "done".'], 'the check above can tell a bad example');
});

test('the relay serves docs/openapi.json, each route in it answers, and a made-up one does not', async (t) => {
  const R = await relay();
  t.after(R.stop);
  const base = 'http://127.0.0.1:' + R.port;
  const sample = { channel: 't', page: '1', id: '000000', name: 'general', seat: 'S1', pid: '1', role: 'coo' };
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

test('real answers fit their schemas: tickets, tasks, sessions, the Floor, events and a command', async (t) => {
  const R = await relay();
  t.after(R.stop);
  const repo = makeRepo(R.home), wrong = [];
  const fitted = new Set();
  const fit = (key, r) => {
    fitted.add(key);
    const name = api.RESPONSES[key];
    assert.ok(name, key + ' has a response schema');
    assert.ok(r.status >= 200 && r.status < 300, key + ': ' + r.status + ' ' + JSON.stringify(r.body));
    for (const p of api.check(api.SCHEMAS[name], r.body)) wrong.push(key + ': ' + p);
    return r.body;
  };
  const made = fit('POST /tickets', await R.call('POST', '/tickets', { title: 'A ticket', body: 'Its body.', priority: 'high', kind: 'bug', labels: ['flaky'], repo }));
  fit('GET /tickets', await R.call('GET', '/tickets'));
  fit('GET /tickets/{id}', await R.call('GET', '/tickets/' + made.ticket.id));
  fit('POST /tickets/{id}/edit', await R.call('POST', '/tickets/' + made.ticket.id + '/edit', { title: 'A ticket, edited', mark: 'hold' }));
  const task = fit('POST /tasks', await R.call('POST', '/tasks', { title: 'Some work', repo })).task;
  await until(async () => (await R.screen(task.owner.terminal)).includes('GOT['), 'the task brief');
  fit('GET /tasks', await R.call('GET', '/tasks'));
  fit('GET /tasks/{id}', await R.call('GET', '/tasks/' + task.id));
  fit('POST /tasks/{id}/move', await R.call('POST', '/tasks/' + task.id + '/move', { to: 'in_review' }));
  fit('GET /terminals', await R.call('GET', '/terminals'));
  fit('GET /floor', await R.call('GET', '/floor'));
  await R.call('POST', '/events', { events: [{ type: 'worker.doing', who: 'sam' }] });
  const events = fit('GET /events', await R.call('GET', '/events'));
  assert.strictEqual(events.events.length, 1, 'the event posted is in the list');
  const sent = await R.call('POST', '/commands', { action: 'state', wait: false });
  assert.deepStrictEqual([sent.status, sent.body.error], [503, 'no_page'], 'no page is open, so a command cannot be sent');
  assert.deepStrictEqual(wrong, [], 'answers that do not fit their schema');
  assert.deepStrictEqual(Object.keys(api.RESPONSES).filter((k) => !['GET /commands/{id}'].includes(k)).filter((k) => !fitted.has(k)), [], 'every response schema but a command\'s result is checked against a real answer');
});

test('the relay refuses each request that breaks its schema: a wrong type with bad_type, a wrong value with the route\'s own error', async (t) => {
  const R = await relay();
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const id = (await R.call('POST', '/tickets', { title: 'To edit', repo })).body.ticket.id;
  const task = (await R.call('POST', '/tasks', { title: 'To move', repo })).body.task;
  const reviewer = (await R.call('POST', '/terminals', { cwd: repo, role: 'reviewer', pr: 'https://github.com/o/r/pull/7', title: 'Review' })).body;
  const reviewerT = agentHeaders(await until(() => { try { return sessionToken(reviewer.sessionId); } catch (e) { return null; } }, 'the reviewer\'s token'));
  const who = { 'POST /autopilot/verdict': reviewerT };
  const routes = { 'POST /tickets': ['/tickets', { title: 'Fine', repo }], 'POST /tickets/{id}/edit': ['/tickets/' + id + '/edit', { title: 'Fine' }],
    'POST /tasks': ['/tasks', { title: 'Fine', repo }], 'POST /tasks/{id}/move': ['/tasks/' + task.id + '/move', { to: 'building' }],
    'POST /commands': ['/commands', { action: 'state', wait: false }], 'POST /autopilot/verdict': ['/autopilot/verdict', { kind: 'merge' }] };
  assert.deepStrictEqual(Object.keys(routes).sort(), Object.keys(api.REQUESTS).sort(), 'each request schema is checked here');
  const refused = [];
  for (const [key, [p, good]] of Object.entries(routes)) {
    const schema = api.SCHEMAS[api.REQUESTS[key]];
    assert.deepStrictEqual(api.check(schema, good), [], key + ': the good body fits its schema');
    for (const [field, sub] of Object.entries(schema.properties)) {
      const types = [].concat(sub.type || []);
      const bad = types.includes('number') || types.includes('array') ? { x: 1 } : 12345;
      const r = await R.call('POST', p, { ...good, [field]: types.includes('number') && types.includes('string') ? true : bad }, who[key]);
      if (r.status !== 400 || r.body.error !== 'bad_type') refused.push(key + ' ' + field + ' of the wrong type: ' + r.status + ' ' + JSON.stringify(r.body));
    }
    const values = [];
    for (const [field, sub] of Object.entries(schema.properties)) {
      if (sub.enum) values.push([field, 'not-one-of-them']);
      if (sub.maxLength) values.push([field, 'x'.repeat(sub.maxLength + 1)]);
      if (sub.minLength) values.push([field, '']);
    }
    for (const field of schema.required || []) values.push([field, undefined]);
    for (const [field, value] of values) {
      const body = { ...good, [field]: value };
      if (value === undefined) delete body[field];
      assert.ok(api.check(schema, body).length, key + ' ' + field + ' = ' + JSON.stringify(value) + ' breaks the schema');
      const r = await R.call('POST', p, body, who[key]);
      if (r.status === 403 || r.status === 401) refused.push(key + ' ' + field + ': refused for who sent it, not for the value: ' + r.status);
      else if (!(r.status >= 400 && r.status < 500) || r.body.ok !== false) refused.push(key + ' ' + field + ' = ' + JSON.stringify(value) + ' was not refused: ' + r.status + ' ' + JSON.stringify(r.body));
    }
  }
  assert.deepStrictEqual(refused, [], 'requests that break a schema but were not refused as they should be');
});
