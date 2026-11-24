// GET /metrics on a real relay, seeded with made-up run records, COO data, tasks and samples
// (relay/metrics.js, with the numbers made by relay/metrics-plan.js: see relay/test/metrics-plan.test.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relay, sessionToken, until } = require('./helpers.js');
const runs = require('../autopilot-runs.js');

const HOUR = 3600000, NOW = Date.now();
const ago = (h) => NOW - h * HOUR;
const iso = (at) => new Date(at).toISOString();
const PR = 'https://github.com/o/r/pull/1';

function seeded() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-metrics-')));
  const dir = path.join(home, '.office-world');
  fs.mkdirSync(dir, { recursive: true });
  const run = Object.assign(runs.start({ task: 'a1b2c3', ticket: 'T-1', kind: 'bug', at: ago(30) }), { prAt: iso(ago(29)), mergedAt: iso(ago(26)), mergedBy: 'Autopilot', pr: PR });
  const run2 = Object.assign(runs.start({ task: 'a1b2c4', ticket: 'T-2', kind: 'bug', at: ago(6) }), { prAt: iso(ago(5)), mergedAt: iso(ago(1)), mergedBy: 'Autopilot', pr: PR });
  const task = (id, ticket, from, to) => ({ id, ticket, title: 'SECRET TITLE', brief: 'SECRET BRIEF', state: 'done', pr: PR, createdAt: iso(ago(from)), history: [{ at: iso(ago(from)), type: 'created' }, { at: iso(ago(to)), type: 'merged', pr: PR }, { at: iso(ago(to)), type: 'moved', to: 'done', by: 'Autopilot' }] });
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ t: [task('a1b2c3', 'T-1', 30, 26), task('a1b2c4', 'T-2', 6, 1)] }));
  fs.writeFileSync(path.join(dir, 'autopilot.json'), JSON.stringify({ t: { on: false, only: null, day: null, merged: 0, prs: {}, notes: [], runs: { a1b2c3: run, a1b2c4: run2 } } }));
  fs.writeFileSync(path.join(dir, 'coo.json'), JSON.stringify({ t: { hands: [], events: [{ kind: 'stall', who: 'SECRET NAME', task: null, at: iso(ago(3)), endedAt: iso(ago(2)), ended: 'went on' }], reports: [] } }));
  const at = Math.floor(NOW / 300000) * 300000;
  fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify({ desks: { t: [[at - 600000, 3, 1, 1, 0, 4, 0], [at - 300000, 4, 1, 0, 0, 4, 0]] }, room: [[at - 600000, 40, 1048576 * 200, 1048576 * 2000]], reviews: [], pm: [], at: 0 }));
  return home;
}

test('the route answers each chart\'s numbers for 1, 7 and 30 days, and the CSV, for the person on this computer only', async (t) => {
  const home = seeded();
  const R = await relay({}, home);
  t.after(async () => { await R.kill(); await R.remove(); });

  const week = await R.call('GET', '/metrics');
  assert.strictEqual(week.status, 200);
  assert.strictEqual(week.body.range, '7d');
  assert.strictEqual(week.body.numbers.merged, 2);
  assert.strictEqual(week.body.numbers.medianMinutes, 270, 'the median of 4 hours and 5 hours');
  assert.strictEqual(week.body.numbers.noHelpShare, 100);
  assert.strictEqual(week.body.numbers.stalledHours, 1);
  assert.strictEqual(week.body.merged.days.reduce((a, d) => a + d.autopilot, 0), 2);
  assert.ok(week.body.desks.points.length > 0);
  assert.strictEqual(week.body.load.points[0].limitMb, 2000);

  const day = await R.call('GET', '/metrics?range=1d');
  assert.strictEqual(day.body.numbers.merged, 1, 'only the merge from 1 hour ago is in a day');
  assert.strictEqual(day.body.desks.points.length, 2, 'a day shows each 5 minutes');
  const month = await R.call('GET', '/metrics?range=30d');
  assert.strictEqual(month.body.numbers.merged, 2);

  assert.strictEqual((await R.call('GET', '/metrics?range=2d')).status, 400);
  assert.strictEqual((await R.call('GET', '/metrics?format=xml')).status, 400);

  const csv = await fetch(R.base + '/metrics?range=7d&format=csv', { headers: { Authorization: 'Bearer test-key' } });
  assert.strictEqual(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="building58-metrics-7d\.csv"/);
  const text = await csv.text();
  assert.match(text, /^chart,when,label,series,value\n/);
  assert.ok(text.includes('numbers,,,merged,2'));

  assert.ok(!/SECRET/.test(JSON.stringify(week.body) + text), 'no ticket title, brief or session name in the answer or the CSV');

  const other = await fetch(R.base + '/metrics', { headers: { Authorization: 'Bearer test-key', Host: 'example.com', Origin: 'https://evil.example' } });
  assert.strictEqual(other.status, 403, 'a page from another site gets nothing');
  const s = (await R.call('POST', '/terminals', { cwd: home })).body;
  const token = await until(() => { try { return sessionToken(s.sessionId); } catch (e) { return null; } }, 'the token');
  assert.strictEqual((await R.call('GET', '/metrics', null, { 'X-Office-Token': token })).status, 401, 'a session\'s own token does not read it');
});
