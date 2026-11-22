// Moving a room's open tickets from the local store to GitHub issues (relay/move-tickets.js), against the
// fake GitHub the store tests use, so no test talks to GitHub.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const github = require('../ticket-stores/github.js');
const { move, fieldsOf } = require('../move-tickets.js');

const fakeGh = path.join(__dirname, 'fake-github.js');
function setup() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'move-tickets-'));
  process.env.FAKE_GITHUB_DIR = d;
  const store = github.open({ repo: 'office=o/r', gh: fakeGh, folder: '/home/repo', keyFile: path.join(d, 'key'), cacheMs: 0 });
  const issues = () => JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'))['o/r'].issues;
  const base = { channel: 'office', to: 'o/r', folder: '/new/repo', closedFile: path.join(d, 'closed.json'), movedFile: path.join(d, 'moved.json') };
  return { d, store, issues, base };
}
const t = (id, status, more) => Object.assign({ id, title: 'Ticket ' + id, body: 'Do ' + id + '.', status, priority: 'normal', repo: '/Users/me/repo', base: 'main', createdBy: 'you', blockedBy: [], createdAt: '2026-11-01T00:00:00Z' }, more);

test('open tickets become issues in order, closed ones are saved, and blockers use the new numbers', async () => {
  const { d, store, issues, base } = setup();
  const tickets = [t('T-3', 'ready', { blockedBy: ['T-1', 'T-2'] }), t('T-1', 'started'), t('T-2', 'done'), t('T-4', 'rejected'), t('T-5', 'triage', { priority: 'high' })];
  const r = await move(Object.assign({ tickets, store }, base));
  assert.deepStrictEqual(r.map, { 'T-1': '1', 'T-3': '2', 'T-5': '3' });
  assert.deepStrictEqual([r.moved, r.closed, r.linked], [3, 2, 1]);
  const [one, three, five] = await Promise.all(['1', '2', '3'].map((id) => store.get('office', id)));
  assert.strictEqual(one.status, 'ready', 'a started ticket comes over as ready');
  assert.strictEqual(three.status, 'ready');
  assert.deepStrictEqual(three.blockedBy, ['1'], 'T-1 moved, so it blocks by its issue; T-2 is done, so it is left out');
  assert.deepStrictEqual([five.status, five.priority], ['triage', 'high']);
  assert.strictEqual(one.repo, '/new/repo');
  assert.match(issues()[0].body, /^Do T-1\.\n\nMoved from T-1\./);
  const closed = JSON.parse(fs.readFileSync(base.closedFile, 'utf8'));
  assert.deepStrictEqual(closed.tickets.map((x) => x.id), ['T-2', 'T-4']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('a run that stopped goes on where it stopped, and files no ticket twice', async () => {
  const { d, store, issues, base } = setup();
  const tickets = [t('T-1', 'ready'), t('T-2', 'ready'), t('T-3', 'ready')];
  const limit = () => fs.writeFileSync(path.join(d, 'fail.json'), JSON.stringify({ fail: 'secondary rate limit', match: 'POST' }));
  await assert.rejects(move(Object.assign({ tickets, store, say: limit }, base)), /rate limit/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(base.movedFile, 'utf8')).map, { 'T-1': '1' });
  fs.rmSync(path.join(d, 'fail.json'));
  const r = await move(Object.assign({ tickets, store }, base));
  assert.deepStrictEqual(Object.keys(r.map), ['T-1', 'T-2', 'T-3']);
  assert.strictEqual(issues().filter((i) => /Moved from T-1\./.test(i.body)).length, 1, 'T-1 is filed once');
  fs.rmSync(d, { recursive: true, force: true });
});

test('a ticket that looks like it holds a secret stops the move before anything is written', async () => {
  const { d, store, base } = setup();
  const leak = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const r = await move(Object.assign({ tickets: [t('T-1', 'ready'), t('T-2', 'ready', { body: 'token: ' + leak })], store }, base));
  assert.strictEqual(r.stopped, 'secrets');
  assert.deepStrictEqual(r.hits.map((h) => h.id), ['T-2']);
  assert.ok(!fs.existsSync(path.join(d, 'state.json')), 'nothing reached GitHub');
  assert.ok(!fs.existsSync(base.closedFile));
  fs.rmSync(d, { recursive: true, force: true });
});

test('a dry run writes nothing', async () => {
  const { d, store, base } = setup();
  const r = await move(Object.assign({ tickets: [t('T-1', 'started'), t('T-2', 'done')], store, dryRun: true }, base));
  assert.deepStrictEqual([r.open, r.closed, r.started], [1, 1, ['T-1']]);
  assert.ok(!fs.existsSync(path.join(d, 'state.json')) && !fs.existsSync(base.closedFile) && !fs.existsSync(base.movedFile));
  assert.deepStrictEqual(Object.keys(fieldsOf(t('T-1', 'ready'), null)).sort(), ['base', 'body', 'createdBy', 'priority', 'repo', 'status', 'title']);
  fs.rmSync(d, { recursive: true, force: true });
});
