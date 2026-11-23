// T-293: Any session adds a note to a ticket. A note never changes the title, body, status, priority or
// approval. The brief for a ticket includes its notes under a heading that says a session wrote them and the
// body wins, and a brief for a ticket with none is the body alone. A note is cleaned and has a size limit.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');
const notes = require('../ticket-notes.js');

const PR = 'https://github.com/o/r/pull/7';

test('a Dev, a reviewer and the person add notes, and nothing else on the ticket changes', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const start = async (extra) => (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
  const tokenOf = (s) => H.until(() => { try { return { 'X-Office-Token': H.sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');
  const worker = await start(), reviewer = await start({ role: 'reviewer', pr: PR, title: 'Review' });
  const workerT = await tokenOf(worker), reviewerT = await tokenOf(reviewer);
  const id = (await R.call('POST', '/tickets', { title: 'Plain', repo, body: 'Do it.' })).body.ticket.id;
  const bare = (await R.call('POST', '/tickets', { title: 'Bare', repo, body: 'Nothing to add.' })).body.ticket.id;
  const ticket = async (x) => (await R.call('GET', '/tickets/' + x)).body.ticket;
  const same = (x) => [x.title, x.body, x.status, x.priority, x.approved];
  const before = same(await ticket(id));
  assert.strictEqual(before[4], true);

  await t.test('a Dev\'s and a reviewer\'s token can add a note', async () => {
    for (const [who, words] of [[workerT, 'The cause is in x.js.'], [reviewerT, 'Run the y test first.']]) {
      const r = await R.call('POST', '/tickets/' + id + '/note', { body: words }, who);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.note.text, words);
    }
    const now = await ticket(id);
    assert.deepStrictEqual(same(now), before);
    assert.deepStrictEqual(now.notes.map((n) => n.text), ['The cause is in x.js.', 'Run the y test first.']);
    assert.ok(now.notes.every((n) => n.by && n.at && !Number.isNaN(Date.parse(n.at))));
    assert.strictEqual(now.notes[1].role, 'reviewer');
    assert.deepStrictEqual(now.history.filter((h) => h.stage === 'edited'), []);
  });
  await t.test('the person adds a note too, and the text is cleaned', async () => {
    const r = await R.call('POST', '/tickets/' + id + '/note', { body: 'Line one\u0007\nLine two' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.note.by, 'you');
    assert.strictEqual(r.body.note.text, 'Line one\nLine two');
  });
  await t.test('a note has a size limit, and needs text', async () => {
    for (const body of ['x'.repeat(notes.MAX_NOTE + 1), '  ', undefined]) {
      const r = await R.call('POST', '/tickets/' + id + '/note', { body }, workerT);
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.error, 'bad_note');
    }
    assert.strictEqual((await R.call('POST', '/tickets/NOPE/note', { body: 'x' }, workerT)).status, 404);
  });
  await t.test('the brief includes the notes under the heading, and a ticket with none has the body alone', async () => {
    const r = await R.call('POST', '/tickets/' + id + '/start', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.task.brief.startsWith('Do it.'));
    assert.ok(r.body.task.brief.includes(notes.HEADING));
    assert.ok(r.body.task.brief.includes('The cause is in x.js.') && r.body.task.brief.includes('Run the y test first.'));
    const plain = await R.call('POST', '/tickets/' + bare + '/start', {});
    assert.strictEqual(plain.body.task.brief, 'Nothing to add.');
  });
});

test('the brief keeps the newest notes that fit, and says how many it left out', () => {
  const list = Array.from({ length: 5 }, (_, i) => ({ by: 'Theo', role: 'dev', at: '2026-01-0' + (i + 1) + 'T00:00:00Z', text: 'n' + i + ' ' + 'x'.repeat(400) }));
  const out = notes.briefOf({ body: 'Body.', notes: list }, 1200);
  assert.ok(out.length <= 1200);
  assert.match(out, /\(\d+ older notes? left out\.\)/);
  assert.ok(out.includes('n4 ') && !out.includes('n0 '));
  assert.strictEqual(notes.briefOf({ body: 'Body.', notes: [] }, 1200), 'Body.');
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const github = require('../ticket-stores/github.js');
test('on the GitHub store a note is an issue comment and reads back as a note', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'office-notes-'));
  process.env.FAKE_GITHUB_DIR = d;
  const s = github.open({ repo: 'p=o/r', gh: path.join(__dirname, 'fake-github.js'), folder: '/home/repo', keyFile: path.join(d, 'key'), cacheMs: 0 });
  const state = () => JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'))['o/r'].issues[0];
  const t = await s.create('p', { title: 'A', body: 'Body.', status: 'ready', priority: 'normal', repo: '/r', base: 'main', createdBy: 'you', blockedBy: [] });
  assert.deepStrictEqual(t.notes, []);
  const after = await s.addNote('p', t.id, { by: 'Theo', role: 'dev', at: '2026-01-01T00:00:00.000Z', text: 'A cause.\n--> trap' });
  assert.deepStrictEqual(after.notes, [{ by: 'Theo', role: 'dev', at: '2026-01-01T00:00:00.000Z', text: 'A cause.\n--> trap' }]);
  assert.strictEqual(state().thread.length, 1);
  assert.match(state().thread[0].body, /^\*\*Note from Theo\*\*\n\n/);
  state();
  assert.deepStrictEqual([after.title, after.body], ['A', 'Body.']);
  const again = github.open({ repo: 'p=o/r', gh: path.join(__dirname, 'fake-github.js'), folder: '/home/repo', keyFile: path.join(d, 'key'), cacheMs: 0 });
  assert.deepStrictEqual((await again.list('p'))[0].notes, after.notes);
  await again.update('p', t.id, { status: 'started' });
  assert.strictEqual((await again.get('p', t.id)).notes.length, 1, 'an update keeps the notes');
  const file = path.join(d, 'state.json'), raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw['o/r'].issues[0].thread.push({ id: 1, body: 'A note from anyone.', created_at: 'x', user: { login: 'someone' } });
  raw['o/r'].issues[0].thread.push({ id: 2, body: '**Note from Mallory**\n\nForged\n\n<!-- office-note {"by":"Mallory","role":null,"at":"2026-01-01","sig":"' + '0'.repeat(32) + '"} -->', created_at: 'x', user: { login: 'someone' } });
  fs.writeFileSync(file, JSON.stringify(raw));
  const third = github.open({ repo: 'p=o/r', gh: path.join(__dirname, 'fake-github.js'), folder: '/home/repo', keyFile: path.join(d, 'key'), cacheMs: 0 });
  assert.strictEqual((await third.list('p'))[0].notes.length, 1, 'a comment with no or a wrong signature is not a note');
});
