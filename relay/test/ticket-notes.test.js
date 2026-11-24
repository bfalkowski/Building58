// T-293: Any session adds a note to a ticket with ticket.js note. A note never changes the title, body,
// status, priority or approval. The brief of a ticket that starts carries its notes under a heading, and a
// ticket with none has the brief it always had. With the GitHub store a note is an issue comment.
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');
const notes = require('../ticket-notes.js');

const PR = 'https://github.com/o/r/pull/7';
const CLI = path.join(__dirname, '..', 'ticket.js');

test('the brief text: none for no notes, newest kept when they do not fit', () => {
  assert.strictEqual(notes.briefOf([]), '');
  assert.strictEqual(notes.withNotes('Build it.', []), 'Build it.');
  const one = notes.withNotes('Build it.', [{ by: 'Lead', at: '2026-01-02T03:04:05.000Z', text: 'Run\nnpm test.' }]);
  assert.match(one, /^Build it\.\n\nNotes from sessions on this ticket\. A session wrote each note and the person did not approve them\. Where a note and the ticket body differ, the body wins\. - Lead, 2026-01-02 03:04 UTC: Run npm test\.$/);
  const many = Array.from({ length: 10 }, (_, i) => ({ by: 'Dev', at: '2026-01-02T03:04:05.000Z', text: i + ' ' + 'x'.repeat(1500) }));
  const brief = notes.briefOf(many);
  assert.ok(brief.length < notes.MAX_IN_BRIEF + 400);
  assert.match(brief, /The 5 oldest notes are left out here\./);
  assert.ok(brief.includes('9 xxx') && !brief.includes('0 xxx'));
});

test('any session adds a note, and the ticket and its approval do not change', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const start = async (extra) => (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
  const tokenOf = (s) => H.until(() => { try { return { 'X-Office-Token': H.sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');
  const filed = async (title) => (await R.call('POST', '/tickets', { title, repo, body: 'The first words.', priority: 'high' })).body.ticket;
  const ticket = async (id) => (await R.call('GET', '/tickets/' + id)).body.ticket;
  const a = await filed('Has notes'), b = await filed('Has none');
  const worker = await start({ title: 'Fix it' }), reviewer = await start({ role: 'reviewer', pr: PR, title: 'Review' }), coo = await start({ role: 'coo', title: 'COO' });
  const workerT = await tokenOf(worker), reviewerT = await tokenOf(reviewer), cooT = await tokenOf(coo);
  const note = (id, text, who) => R.call('POST', '/tickets/' + id + '/note', { text }, who);
  const same = (x) => [x.title, x.body, x.status, x.priority, x.approved, x.approvedBy];
  const before = same(await ticket(a.id));
  assert.deepStrictEqual(before, ['Has notes', 'The first words.', 'ready', 'high', true, 'you']);
  assert.deepStrictEqual((await ticket(a.id)).notes, []);

  await t.test('a Dev and a reviewer add notes, each with who and when', async () => {
    const one = await note(a.id, 'The cause is in x.js.\nRun npm test first.', workerT);
    assert.strictEqual(one.status, 200, JSON.stringify(one.body));
    const two = await note(a.id, 'Looks fine to me.', reviewerT);
    assert.strictEqual(two.status, 200, JSON.stringify(two.body));
    const got = (await ticket(a.id)).notes;
    assert.deepStrictEqual(got.map((n) => [n.by, n.text]), [['Worker on Fix it', 'The cause is in x.js.\nRun npm test first.'], ['Reviewer', 'Looks fine to me.']]);
    assert.ok(got.every((n) => !isNaN(Date.parse(n.at))));
    assert.deepStrictEqual(same(await ticket(a.id)), before, 'title, body, status, priority and approval are as they were');
    assert.strictEqual((await ticket(a.id)).history.filter((h) => h.stage === 'edited').length, 0);
  });
  await t.test('the person may add one too, as you', async () => {
    assert.strictEqual((await note(b.id, 'Mine.')).status, 200);
    assert.strictEqual((await ticket(b.id)).notes[0].by, 'you');
  });
  await t.test('the COO and the security officer cannot, and the text is cleaned and limited', async () => {
    assert.strictEqual((await note(a.id, 'No.', cooT)).status, 401);
    assert.strictEqual((await note(a.id, '   ', workerT)).status, 400);
    const long = await note(a.id, 'x'.repeat(notes.MAX_NOTE + 1), workerT);
    assert.deepStrictEqual([long.status, long.body.error], [400, 'bad_note']);
    assert.strictEqual((await note(a.id, 'a\x00b\x07c', workerT)).status, 200);
    assert.strictEqual((await ticket(a.id)).notes.pop().text, 'abc');
    assert.strictEqual((await note('T-999', 'x', workerT)).status, 404);
    assert.strictEqual((await R.call('POST', '/tickets/' + a.id + '/note', { text: 5 }, workerT)).status, 400);
  });
  await t.test('a ticket takes only so many', async () => {
    let last;
    for (let i = (await ticket(a.id)).notes.length; i < notes.MAX_NOTES; i++) last = await note(a.id, 'n' + i, workerT);
    assert.strictEqual(last.status, 200);
    const over = await note(a.id, 'one more', workerT);
    assert.deepStrictEqual([over.status, over.body.error], [409, 'notes_full']);
  });
  await t.test('the brief has the notes under the heading, and a ticket with none has the brief it had', async () => {
    const withNotes = await R.call('POST', '/tickets/' + a.id + '/start', {});
    assert.strictEqual(withNotes.status, 200, JSON.stringify(withNotes.body));
    const task = (await R.call('GET', '/tasks/' + withNotes.body.task.id)).body.task;
    assert.match(task.brief, /^The first words\.\n\nNotes from sessions on this ticket\. A session wrote each note and the person did not approve them\. Where a note and the ticket body differ, the body wins\. - Worker on Fix it, /);
    assert.match(task.brief, /The cause is in x\.js\. Run npm test first\./);
    assert.match(task.brief, /- Reviewer, [\d -]+ [\d:]+ UTC: Looks fine to me\./);
    const none = await filed('Plain');
    const plain = await R.call('POST', '/tickets/' + none.id + '/start', {});
    assert.strictEqual((await R.call('GET', '/tasks/' + plain.body.task.id)).body.task.brief, 'The first words.');
  });
  await t.test('a started ticket still takes a note, and ticket.js note and show use it', async () => {
    assert.strictEqual((await note(a.id, 'After the start.', workerT)).status, 409, 'full already');
    const c = await filed('Via the CLI');
    const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: workerT['X-Office-Token'] };
    const run = (args, input) => spawnSync('node', [CLI, ...args], { env, input, encoding: 'utf8' });
    const out = run(['note', c.id, '--body', '-'], 'Seen with `backticks` and $(date).\n');
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /^Noted: .*\(1 note\)/);
    const shown = run(['show', c.id]);
    assert.match(shown.stdout, /Note from Worker on Fix it at .* \(a session wrote it and the person did not approve it\):\nSeen with `backticks` and \$\(date\)\./);
    assert.strictEqual(run(['note', c.id]).status, 1);
  });
});
