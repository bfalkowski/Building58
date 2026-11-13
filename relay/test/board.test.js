// The Board in its own tab (T-13): the rules both pages draw with (office/board-model.js), and the
// page itself, which must poll and never hold a stream, since the room page already holds them.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { relay } = require('./helpers.js');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const model = () => require(path.join(ROOT, 'office', 'board-model.js'));
const ticket = (o) => Object.assign({ id: 'T-1', title: 'A', body: '', status: 'ready', priority: 'normal', repo: '/r/one', task: null, updatedAt: '2026-01-01T00:00:00.000Z' }, o);

test('Changes requested has its own column, apart from Building', () => {
  const { columnOf, COLUMNS } = model();
  assert.ok(COLUMNS.some((c) => c.id === 'changes_requested'));
  assert.strictEqual(columnOf(ticket({ status: 'started', task: { state: 'changes_requested' } })), 'changes_requested');
  assert.strictEqual(columnOf(ticket({ status: 'started', task: { state: 'building' } })), 'building');
});

test('each ticket lands in one column, or none if rejected', () => {
  const { columnOf } = model();
  assert.strictEqual(columnOf(ticket({ status: 'triage' })), 'triage');
  assert.strictEqual(columnOf(ticket({ status: 'started' })), 'building', 'a start whose task is not there yet');
  assert.strictEqual(columnOf(ticket({ status: 'started', task: { state: 'waiting_on_you' } })), 'waiting_on_you');
  assert.strictEqual(columnOf(ticket({ status: 'started', task: { state: 'some_new_state' } })), 'building', 'a state no column holds yet');
  assert.strictEqual(columnOf(ticket({ status: 'done' })), 'done');
  assert.strictEqual(columnOf(ticket({ status: 'rejected' })), null);
});

test('a task state goes in exactly one column', () => {
  const { COLUMNS } = model();
  const held = COLUMNS.flatMap((c) => c.holds);
  assert.strictEqual(new Set(held).size, held.length);
  for (const s of ['building', 'in_review', 'changes_requested', 'waiting_on_you', 'done']) assert.ok(held.includes(s), s);
});

test('the filter matches text, repo and priority together', () => {
  const { matches, filtering, repos } = model();
  const t = ticket({ id: 'T-7', title: 'Fix the lamp', body: 'It flickers', repo: '/r/one', priority: 'high' });
  assert.ok(matches(t, {}));
  assert.ok(matches(t, { text: 'LAMP' }));
  assert.ok(matches(t, { text: 'flicker' }), 'the body counts');
  assert.ok(matches(t, { text: 't-7' }), 'the id counts');
  assert.ok(!matches(t, { text: 'chair' }));
  assert.ok(matches(t, { repo: '/r/one', priority: 'high' }));
  assert.ok(!matches(t, { repo: '/r/two' }));
  assert.ok(!matches(t, { text: 'lamp', priority: 'low' }));
  assert.ok(!filtering({ text: '  ', repo: '', priority: '' }));
  assert.ok(filtering({ priority: 'low' }));
  assert.deepStrictEqual(repos([t, ticket({ repo: '/r/two' }), ticket({ repo: '/r/one' }), ticket({ repo: '' })]), ['/r/one', '/r/two']);
});

test('the filter keeps a label, or tickets with no label', () => {
  const { matches, filtering, NO_LABEL } = model();
  const a = { id: 'T-1', title: 'x', labels: ['flaky', 'ci'] }, b = { id: 'T-2', title: 'y' };
  assert.ok(matches(a, { label: 'ci' }));
  assert.ok(!matches(b, { label: 'ci' }));
  assert.ok(matches(b, { label: NO_LABEL }));
  assert.ok(!matches(a, { label: NO_LABEL }));
  assert.ok(filtering({ label: 'ci' }));
});
test('Done shows the first 8 the relay sends, and every older one when asked', () => {
  const { cardsOf, DONE_SHOWN } = model();
  // The relay sends Done latest first (relay/ticket-order.js, T-42), so T-11 here is the latest.
  const done = Array.from({ length: 12 }, (_, i) => ticket({ id: 'T-' + (11 - i), status: 'done', updatedAt: '2026-01-' + String(12 - i).padStart(2, '0') + 'T00:00:00.000Z' }));
  const some = cardsOf('done', done, {});
  assert.strictEqual(some.cards.length, DONE_SHOWN);
  assert.strictEqual(some.hidden, 4);
  assert.deepStrictEqual(some.cards.map((t) => t.id), done.slice(0, DONE_SHOWN).map((t) => t.id), 'in the order sent');
  const kept = cardsOf('done', done, { keep: 'T-0' });
  assert.ok(kept.cards.some((t) => t.id === 'T-0'), 'one you jumped to stays');
  const all = cardsOf('done', done, { all: true });
  assert.strictEqual(all.cards.length, 12);
  assert.strictEqual(all.hidden, 0);
});

test('a column keeps the order the relay sends, so the page and ticket.js list agree (T-42)', () => {
  const { cardsOf } = model();
  // relay/ticket-order.js puts the oldest first within a priority. The page must not reorder that.
  const sent = [ticket({ id: 'T-9', priority: 'high', createdAt: '1' }), ticket({ id: 'T-2', priority: 'normal', createdAt: '2' }), ticket({ id: 'T-1', priority: 'normal', createdAt: '3' }), ticket({ id: 'T-5', priority: 'low' })];
  assert.deepStrictEqual(cardsOf('ready', sent, {}).cards.map((t) => t.id), ['T-9', 'T-2', 'T-1', 'T-5']);
  const odd = [ticket({ id: 'x', priority: 'low' }), ticket({ id: 'y', priority: 'high' })];
  assert.deepStrictEqual(cardsOf('ready', odd, {}).cards.map((t) => t.id), ['x', 'y'], 'no sort of its own');
});

test('the board tab polls: it opens no event stream', () => {
  const html = read('office/board.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => path.join('office', m[1]));
  assert.ok(['tickets.js', 'board-model.js', 'ticket-history.js'].every((f) => scripts.some((s) => s.endsWith(f))), 'it uses the same board code as the room page, with who has each ticket (T-24)');
  for (const s of scripts) assert.doesNotMatch(read(s), /EventSource|text\/event-stream/, s + ' opens no stream');
  assert.doesNotMatch(html, /EventSource/);
});

test('the room page links the board tab, and both use one board', () => {
  const html = read('office/index.html');
  assert.match(html, /<a [^>]*id="board-tab"[^>]*target="_blank"/);
  assert.match(html, /<script src="board-model\.js"><\/script>\s*<script src="tickets\.js"><\/script>/);
  assert.match(read('office/tickets.js'), /board\.html/);
});

test('the relay serves the board tab', async (t) => {
  const R = await relay();
  t.after(() => R.stop());
  const r = await fetch('http://127.0.0.1:' + R.port + '/office/board.html?channel=t&key=test-key');
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /<title>Board<\/title>/);
});

test('a card names the seated people on its ticket, and no one else', () => {
  const { peopleOn } = model();
  const on = peopleOn([
    { ticket: 'T-1', role: 'Dev', named: true, name: 'Theo' },
    { ticket: 'T-1', role: 'reviewer', named: true, name: 'Ines' },
    { ticket: 'T-2', role: 'Dev', named: false, name: 'Session 1a2b3c4d' },
    { ticket: null, role: 'Lead', named: true, name: 'Kai' },
  ]);
  assert.deepStrictEqual(on.get('T-1'), ['Theo']);
  assert.strictEqual(on.has('T-2'), false, 'the room page has not seated them yet');
  assert.strictEqual(on.size, 1);
});

test('the Board takes its names from the model', () => {
  assert.match(read('office/tickets.js'), /people = M\.peopleOn\(await floor\(\)\)/);
});

test('a task waiting on its pipeline stays in Building (T-11)', () => {
  const { columnOf } = model();
  const waits = (state, p) => ticket({ status: 'started', task: { state, pipeline: p } });
  assert.strictEqual(columnOf(waits('in_review', { state: 'pending', waits: true })), 'building');
  assert.strictEqual(columnOf(waits('waiting_on_you', { state: 'red', waits: true })), 'building');
  assert.strictEqual(columnOf(waits('in_review', { state: 'green', waits: false })), 'in_review', 'a green pipeline goes to its column');
  assert.strictEqual(columnOf(waits('changes_requested', { state: 'red', waits: false })), 'changes_requested');
});

test('a card names its assignee once, and adds only other seated people (T-24)', () => {
  const { alsoWith } = model();
  assert.deepStrictEqual(alsoWith(['Priya'], { name: 'Priya', role: 'dev' }), [], 'already named as the assignee');
  assert.deepStrictEqual(alsoWith(['Priya', 'Theo'], { name: 'Priya', role: 'dev' }), ['Theo']);
  assert.deepStrictEqual(alsoWith(['Priya'], null), ['Priya'], 'no assignee recorded');
  assert.deepStrictEqual(alsoWith([], { name: 'Priya' }), []);
});

test('a long Triage or Ready column folds into one group per priority, high first', () => {
  const { groupsOf, GROUP_FROM } = model();
  const many = (n) => Array.from({ length: n }, (_, i) => ticket({ id: 'T-' + i, priority: ['high', 'normal', 'low', 'urgent', undefined][i % 5] }));
  assert.strictEqual(groupsOf('ready', many(GROUP_FROM - 1)), null, 'a short column shows every card');
  const g = groupsOf('ready', many(GROUP_FROM + 3));
  assert.deepStrictEqual(g.map((x) => x.priority), ['high', 'normal', 'low']);
  assert.deepStrictEqual(g[1].cards.map((t) => t.id), ['T-1', 'T-3', 'T-4', 'T-6', 'T-8', 'T-9'], 'an unknown or missing priority is normal, in the order sent');
  assert.ok(groupsOf('triage', many(GROUP_FROM)), 'Triage folds too');
  assert.strictEqual(groupsOf('building', many(20)), null, 'other columns never fold');
  const done = groupsOf('done', many(2));
  assert.deepStrictEqual(done.map((x) => [x.key, x.label, x.cards.length]), [['all', 'Latest', 2]], 'Done is one group, however few');
  assert.strictEqual(groupsOf('done', []), null, 'an empty Done has no group');
  assert.deepStrictEqual(g.map((x) => x.label), ['High', 'Normal', 'Low']);
  assert.deepStrictEqual(groupsOf('ready', many(GROUP_FROM).map((t) => Object.assign(t, { priority: 'low' }))).map((x) => x.priority), ['low'], 'only the priorities it has');
});
test('by label, a long Triage or Ready column folds into one group per label, A to Z, then No label', () => {
  const { groupsOf, GROUP_FROM } = model();
  const cards = Array.from({ length: GROUP_FROM }, (_, i) => ({ id: 'T-' + i, priority: 'normal', labels: i === 0 ? ['tests', 'flaky'] : i < 3 ? ['flaky'] : [] }));
  const g = groupsOf('ready', cards, 'label');
  assert.deepStrictEqual(g.map((x) => x.label), ['flaky', 'tests', 'No label']);
  assert.deepStrictEqual(g.map((x) => x.cards.map((t) => t.id)), [['T-0', 'T-1', 'T-2'], ['T-0'], cards.slice(3).map((t) => t.id)], 'a ticket with two labels is in both');
  assert.ok(g.every((x) => x.key.startsWith('label:')), 'keys apart from the priority groups');
  assert.strictEqual(groupsOf('ready', cards.slice(1), 'label'), null, 'a short column still shows every card');
  assert.deepStrictEqual(groupsOf('ready', cards).map((x) => x.label), ['Normal'], 'by priority unless asked');
});
