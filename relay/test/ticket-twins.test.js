// Likely duplicates (T-202): when a ticket is filed, the open tickets of its repo that look like the
// same work, by the words of the title and the body. Filing still goes ahead.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');
const { likelyTwins } = require('../ticket-twins.js');

const t = (id, title, body, extra) => Object.assign({ id, title, body: body || '', status: 'triage', repo: '/r' }, extra);

test('the same hang filed in other words is a likely duplicate', () => {
  const open = [
    t('T-1', 'tickets.test.js hangs on the github store', 'The run never ends after the store test.'),
    t('T-2', 'Radio clips at high volume', 'Turn the radio down.'),
    t('T-3', 'Add a dark theme to the manual', ''),
  ];
  const got = likelyTwins({ title: 'Fix the hang in tickets.test.js', body: 'npm test hangs in the github store test and never ends.', repo: '/r' }, open);
  assert.deepStrictEqual(got.map((x) => x.id), ['T-1']);
});

test('different work with a shared word or two is not a duplicate', () => {
  const open = [
    t('T-1', 'Show the PR link on the task card', 'The card should link to the PR.'),
    t('T-2', 'Radio clips at high volume', ''),
  ];
  assert.deepStrictEqual(likelyTwins({ title: 'Show who is on each desk', body: 'A name over each desk.', repo: '/r' }, open), []);
  assert.deepStrictEqual(likelyTwins({ title: 'Fix the radio', body: '', repo: '/r' }, open), []);
});

test('only open tickets of the same repo count, and the best come first, at most three', () => {
  const same = 'The Lead brief misses the merge rung';
  const open = [
    t('T-1', same, '', { status: 'done' }),
    t('T-2', same, '', { status: 'rejected' }),
    t('T-3', same, '', { repo: '/other' }),
    t('T-4', 'The Lead brief misses the merge rung text', '', { status: 'started' }),
    t('T-5', 'Lead brief misses merge rung', '', { status: 'ready' }),
    t('T-6', 'Lead brief: the merge rung is missing', ''),
    t('T-7', 'The Lead brief misses the merge rung and more', ''),
    t('T-8', 'Lead brief merge rung', ''),
  ];
  const got = likelyTwins({ title: same, body: '', repo: '/r' }, open);
  assert.strictEqual(got.length, 3);
  assert.ok(got.every((x) => ['T-4', 'T-5', 'T-6', 'T-7', 'T-8'].includes(x.id)), JSON.stringify(got));
  assert.strictEqual(got[0].id, 'T-5', 'the closest match first');
  assert.deepStrictEqual(Object.keys(got[0]).sort(), ['id', 'status', 'title']);
});

test('the ticket itself is never its own duplicate', () => {
  const me = t('T-9', 'Warn about duplicate tickets', 'Compare titles.');
  assert.deepStrictEqual(likelyTwins(Object.assign({}, me), [me]), []);
});

test('filing warns about likely duplicates and still files, through the relay and ticket.js', async (tt) => {
  const R = await H.relay({});
  tt.after(R.stop);
  const repo = H.makeRepo(R.home);
  const first = (await R.call('POST', '/tickets', { title: 'tickets.test.js hangs on the github store', body: 'The run never ends.', repo })).body.ticket;
  await R.call('POST', '/tickets', { title: 'Radio clips at high volume', repo });

  const byPerson = await R.call('POST', '/tickets', { title: 'Fix the hang in tickets.test.js', body: 'It hangs on the github store.', repo });
  assert.strictEqual(byPerson.status, 201, 'filing still goes ahead');
  assert.deepStrictEqual(byPerson.body.likely, [{ id: first.id, title: first.title, status: 'ready' }]);
  const alone = await R.call('POST', '/tickets', { title: 'Paint the lobby blue', repo });
  assert.deepStrictEqual(alone.body.likely, []);

  const worker = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const token = await H.until(() => { try { return H.sessionToken(worker.sessionId); } catch (e) { return null; } }, 'the session');
  const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: token };
  const out = execFileSync('node', [path.join(H.ROOT, 'relay', 'ticket.js'), 'create', 'The github store test hangs', '--body', 'tickets.test.js never ends.'], { env, encoding: 'utf8' });
  assert.match(out, /^Filed: \S+ {2}The github store test hangs/);
  assert.match(out, new RegExp('Likely duplicates? of open tickets:\\n  ' + first.id + ' {2}tickets\\.test\\.js hangs on the github store {2}\\(ready\\)'));
  assert.match(out, /@Lead/, 'says how to stop it: ask the Lead to reject one');
  const quiet = execFileSync('node', [path.join(H.ROOT, 'relay', 'ticket.js'), 'create', 'Name each desk', '--body', 'A plate on each desk.'], { env, encoding: 'utf8' });
  assert.doesNotMatch(quiet, /Likely/);
});
