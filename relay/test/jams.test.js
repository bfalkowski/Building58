// The jam log (relay/jams.js): POST /jams and GET /jams for the person only, kept 90 days, and counted in
// Stalls by kind on GET /metrics.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relay, sessionToken, until } = require('./helpers.js');
const jams = require('../jams.js');

const HOUR = 3600000;
const iso = (at) => new Date(at).toISOString();

test('make keeps a jam, refuses a bad one, and keeps nothing older than 90 days', () => {
  const now = Date.parse('2026-11-24T12:00:00.000Z');
  const ok = jams.make({ kind: 'dev-idle', ticket: 'T-5', pr: 'https://github.com/o/r/pull/5', since: '2026-11-24T10:00:00Z', fix: ' Nudged\nthe Dev. ', by: 'Sam' }, now);
  assert.deepStrictEqual(ok.jam, { at: iso(now), kind: 'dev-idle', ticket: 'T-5', pr: 'https://github.com/o/r/pull/5', since: '2026-11-24T10:00:00.000Z', fix: 'Nudged the Dev.', by: 'Sam' });
  assert.strictEqual(jams.make({ kind: 'other', fix: 'x' }, now).jam.by, 'you');
  for (const body of [{ kind: 'nope', fix: 'x' }, { kind: 'other' }, { kind: 'other', fix: '   ' }, { kind: 'other', fix: 'x'.repeat(201) }, { kind: 'other', fix: 'x', ticket: 'has space' }, { kind: 'other', fix: 'x', since: 'yesterday' }, { kind: 'other', fix: 'x', since: '2026-11-25T00:00:00Z' }, null]) {
    assert.ok(jams.make(body, now).error, JSON.stringify(body) + ' is refused');
  }
  const old = [{ at: iso(now - 91 * 24 * HOUR) }, { at: iso(now - 89 * 24 * HOUR) }];
  assert.deepStrictEqual(jams.prune(old, now), [old[1]]);
});

test('a jam posted with the person\'s key is kept and listed, a session\'s token gets 403, an unknown kind gets 400, and Stalls by kind counts it', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-jams-')));
  const R = await relay({}, home);
  t.after(async () => { await R.kill(); await R.remove(); });
  const since = iso(Date.now() - 3 * HOUR);

  const made = await R.call('POST', '/jams', { kind: 'no-first-review', ticket: 'T-9', since, fix: 'Pressed Get a review.', by: 'you' });
  assert.strictEqual(made.status, 201);
  assert.strictEqual(made.body.jam.kind, 'no-first-review');
  await R.call('POST', '/jams', { kind: 'tunnel-down', fix: 'Restarted it.' });

  const listed = await R.call('GET', '/jams?range=1d');
  assert.strictEqual(listed.status, 200);
  assert.deepStrictEqual(listed.body.jams.map((j) => j.kind), ['no-first-review', 'tunnel-down']);
  assert.strictEqual((await R.call('GET', '/jams?range=3d')).status, 400);
  assert.strictEqual((await R.call('POST', '/jams', { kind: 'bogus', fix: 'x' })).status, 400);
  assert.strictEqual((await R.call('POST', '/jams', { kind: 'other', fix: 'x', since: 'later' })).status, 400);

  const m = (await R.call('GET', '/metrics?range=7d')).body;
  const by = Object.fromEntries(m.stalls.kinds.map((k) => [k.kind, k]));
  assert.deepStrictEqual(by['no-first-review'].hand, { count: 1, hours: 3 });
  assert.deepStrictEqual(by['tunnel-down'].hand, { count: 1, hours: 0 });
  assert.strictEqual(m.numbers.jamsFixedByHand, 2);

  const s = (await R.call('POST', '/terminals', { cwd: home })).body;
  const token = await until(() => { try { return sessionToken(s.sessionId); } catch (e) { return null; } }, 'the token');
  const agent = { 'X-Office-Token': token };
  assert.strictEqual((await R.call('POST', '/jams', { kind: 'other', fix: 'x' }, agent)).status, 403);
  assert.strictEqual((await R.call('GET', '/jams', null, agent)).status, 403);
  const other = await fetch(R.base + '/jams', { headers: { Authorization: 'Bearer test-key', Host: 'example.com', Origin: 'https://evil.example' } });
  assert.strictEqual(other.status, 403, 'a page from another site gets nothing');
  assert.strictEqual((await R.call('GET', '/jams', null, { Authorization: 'Bearer wrong' })).status, 401);

  const file = JSON.parse(fs.readFileSync(path.join(home, '.office-world', 'jams.json'), 'utf8'));
  assert.strictEqual(file.t.length, 2, 'kept in jams.json in the state folder');
});
