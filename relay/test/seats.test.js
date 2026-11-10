// Who sits where, from relay/seats.js, and what a session's job does to its title, from office/seats.js.
// The relay decides the seats, saves them with its sessions and sends them in GET /terminals.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seatAll, nameAll, plainName } = require('../seats.js');
const roster = require('../../office/roster.js');
const { noteWork } = require('../../office/seats.js');
const { relay, makeRepo, until } = require('./helpers.js');

// The room's nine desks: the Lead's, then eight others in the roster's order.
const OTHERS = ['priya', 'marcus', 'june', 'theo', 'ines', 'sam', 'kai', 'noor'];
const people = [{ id: 'lead', lead: true }, ...OTHERS.map((id) => ({ id }))];
const setTitle = (S, title) => { S.title = title; };
const shuffle = (list, rand) => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// A small seeded random, so a failure can be run again.
const seeded = (seed) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// Many rooms after a restart and reload: any number of sessions, one of them perhaps the Lead, each
// remembered at any person or none, two at the same person, and some remembered that are not back yet.
function* offices() {
  for (let seed = 1; seed <= 400; seed++) {
    const rand = seeded(seed);
    const n = Math.floor(rand() * (people.length + 1));
    const sessions = Array.from({ length: n }, (_, i) => ({ id: 't' + i, at: '2026-11-07T10:0' + Math.floor(rand() * 10) + ':00Z' }));
    if (n && rand() < 0.6) sessions[Math.floor(rand() * n)].lead = true;
    const before = {};
    for (const s of sessions) if (rand() < 0.8) before[s.id] = people[Math.floor(rand() * people.length)].id;
    for (let i = 0; i < 2; i++) if (rand() < 0.3) before['gone' + i] = people[Math.floor(rand() * people.length)].id;
    yield { seed, rand, sessions, before };
  }
}
const otherDesksFull = (out) => OTHERS.every((p) => Object.values(out).includes(p));

test('whoever sits at the Lead\'s desk is the Lead, unless every other desk is full', () => {
  for (const { seed, sessions, before } of offices()) {
    const out = seatAll(people, sessions, before);
    const at = Object.keys(out).find((id) => out[id] === 'lead');
    const leadSession = sessions.find((s) => s.lead);
    if (leadSession) assert.strictEqual(out[leadSession.id], 'lead', 'the Lead is at its desk, seed ' + seed);
    if (at && !sessions.find((s) => s.id === at).lead) assert.ok(otherDesksFull(out), 'someone not the Lead is at its desk while another is free, seed ' + seed);
  }
});

test('no two sessions share a person, and every session has one while a desk is free', () => {
  for (const { seed, sessions, before } of offices()) {
    const out = seatAll(people, sessions, before);
    const who = Object.values(out);
    assert.strictEqual(new Set(who).size, who.length, 'a person twice, seed ' + seed);
    assert.deepStrictEqual(Object.keys(out).sort(), sessions.map((s) => s.id).sort(), 'everyone seated, seed ' + seed);
    assert.ok(who.every((p) => people.some((x) => x.id === p)), 'only people in the roster, seed ' + seed);
  }
});

test('a session keeps its person while that breaks no rule', () => {
  for (const { seed, sessions, before } of offices()) {
    const out = seatAll(people, sessions, before);
    for (const s of sessions) {
      const had = before[s.id];
      if (!had || s.lead) continue;
      const shared = sessions.some((o) => o !== s && before[o.id] === had);
      if (had !== 'lead' && !shared) assert.strictEqual(out[s.id], had, s.id + ' lost ' + had + ', seed ' + seed);
      // At the Lead's desk with no Lead here, and the others enough to fill every other desk, it stays.
      if (had === 'lead' && !shared && !sessions.some((o) => o.lead) && sessions.length - 1 >= OTHERS.length) assert.strictEqual(out[s.id], 'lead', 'seed ' + seed);
    }
    assert.deepStrictEqual(seatAll(people, sessions, out), out, 'asking again moves nobody, seed ' + seed);
  }
});

test('the relay\'s list order does not matter', () => {
  for (const { seed, rand, sessions, before } of offices()) {
    const out = seatAll(people, sessions, before);
    for (let i = 0; i < 3; i++) assert.deepStrictEqual(seatAll(people, shuffle(sessions, rand), before), out, 'seed ' + seed);
  }
});

test('a Dev remembered at the Lead\'s desk and the Lead elsewhere trade places in one pass, in either order', () => {
  // PR #134: after a restart the T-148 Dev had the Lead's desk, and the real Lead showed as June.
  const before = { dev: 'lead', boss: 'june', pm: 'priya' };
  for (const list of [[{ id: 'dev' }, { id: 'boss', lead: true }, { id: 'pm' }], [{ id: 'boss', lead: true }, { id: 'pm' }, { id: 'dev' }]]) {
    const out = seatAll(people, list, before);
    assert.strictEqual(out.boss, 'lead');
    assert.notStrictEqual(out.dev, 'lead');
    assert.strictEqual(out.pm, 'priya', 'nobody else moves');
    assert.strictEqual(out.dev, 'marcus', 'the Dev takes the first free person');
  }
});

test('the Lead\'s desk goes to someone else only when every other desk is full', () => {
  const eight = OTHERS.map((p, i) => ({ id: 'x' + i }));
  const had = Object.fromEntries(eight.map((s, i) => [s.id, OTHERS[i]]));
  assert.strictEqual(seatAll(people, [{ id: 'new' }], {}).new, 'priya');
  assert.strictEqual(seatAll(people, eight.concat({ id: 'new' }), had).new, 'lead');
  // With no Lead here, a session at the Lead's desk moves off once another desk is free.
  assert.strictEqual(seatAll(people, [{ id: 'new' }], { new: 'lead' }).new, 'priya');
  // When the Lead's desk and one other are free for two, the one that had the Lead's desk keeps it.
  const seven = eight.slice(0, 7);
  const out = seatAll(people, seven.concat({ id: 'b', at: '1' }, { id: 'a', at: '2' }), Object.assign({ a: 'lead' }, had));
  assert.deepStrictEqual([out.a, out.b], ['lead', 'noor']);
});

test('a new session passes over a person held for a session that is not back yet', () => {
  assert.strictEqual(seatAll(people, [{ id: 'new' }], { coming: 'priya' }).new, 'marcus');
  // Unless nobody else is free.
  const seven = OTHERS.slice(1).map((p, i) => ({ id: 'x' + i }));
  const had = Object.fromEntries(seven.map((s, i) => [s.id, OTHERS[i + 1]]));
  assert.strictEqual(seatAll(people, seven.concat({ id: 'new' }), Object.assign({ coming: 'priya' }, had)).new, 'priya');
});

test('the Lead made at another desk moves to its own at once, and whoever was there moves off', () => {
  assert.deepStrictEqual(seatAll(people, [{ id: 'a', lead: true }, { id: 'b' }], { a: 'priya', b: 'lead' }), { a: 'lead', b: 'priya' });
});

test('a replaced Lead stops showing The Lead, and takes titles again', () => {
  const S = { id: 'a', title: '' };
  noteWork(S, { title: 'Old work', work: { role: 'lead', label: 'The Lead · Old work' } }, setTitle);
  assert.strictEqual(S.work.label, 'The Lead · Old work');
  assert.strictEqual(S.title, 'Old work');
  assert.ok(!S.tasked);
  noteWork(S, { title: 'Old work', work: null }, setTitle);
  assert.strictEqual(S.work, null);
  assert.strictEqual(S.title, 'Old work');
  assert.ok(!S.tasked, 'so a hook\'s new title can replace it');
});
test('a ticket\'s label still holds the title', () => {
  const S = { id: 'a', title: '' };
  noteWork(S, { title: 'Claude\'s own', work: { role: 'dev', label: 'T-1 · A ticket' } }, setTitle);
  assert.strictEqual(S.title, 'T-1 · A ticket');
  assert.ok(S.tasked);
});

// The names: a desk is a look, and the name each session shows comes from the roster's pool.
const named = [{ id: 'lead', name: 'Lead', kind: 'man', lead: true }, ...roster.workers.map((w) => ({ id: w.id, name: w.name, kind: w.kind }))];
const kindOf = (name) => Object.keys(roster.names).find((k) => roster.names[k].includes(name));

// A name prints in the Lead's terminal (the Floor, ticket.js stop), so it keeps no character that
// moves or hides text there: control characters, zero-width ones and bidi controls (PR 39 review, N6).
test('a name loses the characters that hide or reorder text in a terminal', () => {
  const hidden = ['\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069', '\u061c', '\ufeff', '\u00ad', '\u034f', '\u180e', '\u2060', '\u2061', '\u2062', '\u2063', '\u2064'];
  for (const c of hidden) assert.strictEqual(plainName('Pri' + c + 'ya'), 'Priya', 'U+' + c.charCodeAt(0).toString(16).toUpperCase());
  assert.strictEqual(plainName('\u202eayirP'), 'ayirP', 'a right-to-left override goes, and the letters stay as typed');
  assert.strictEqual(plainName(' Ana\x1b[31m  Lee\n'), 'Ana [31m Lee', 'control characters become a space, and spaces collapse');
  assert.strictEqual(plainName('Zoë Ōta'), 'Zoë Ōta', 'letters that are not ASCII stay');
  assert.strictEqual(plainName('x'.repeat(50)).length, 40, 'at most 40 characters');
  assert.strictEqual(plainName('x'.repeat(39) + '\u{1f600}y'), 'x'.repeat(39) + '\u{1f600}', 'the cut never leaves half an emoji');
  assert.strictEqual(plainName('\u200b\u202e'), '', 'nothing left is empty');
  assert.strictEqual(plainName(null), '');
});

test('the roster has 50 names, half for each kind of desk, one word each, apart from the desks\' names', () => {
  assert.deepStrictEqual([roster.names.woman.length, roster.names.man.length], [25, 25]);
  const all = roster.names.woman.concat(roster.names.man).map((n) => n.toLowerCase());
  assert.strictEqual(new Set(all).size, 50, 'no name twice');
  assert.ok(all.every((n) => /^[a-z]+$/.test(n)), 'one word each, so an @mention finds it');
  for (const p of named) assert.ok(!all.includes(p.name.toLowerCase()), p.name + ' is a desk\'s own name');
  for (const w of roster.workers) assert.ok(roster.names[w.kind], w.id + ' has a kind with names');
});

test('a name fits its desk, nobody shares one, and the Lead at its desk is Lead', () => {
  for (const { seed, sessions, before } of offices()) {
    const seats = seatAll(named, sessions, before);
    const out = nameAll(named, roster.names, sessions, seats, {}, {}, 'room ' + seed);
    const names = Object.values(out);
    assert.strictEqual(new Set(names).size, names.length, 'a name twice, seed ' + seed);
    for (const s of sessions) {
      const desk = named.find((p) => p.id === seats[s.id]);
      if (desk.lead && s.lead) assert.strictEqual(out[s.id], 'Lead', 'seed ' + seed);
      else assert.strictEqual(kindOf(out[s.id]), desk.kind, out[s.id] + ' at ' + desk.id + ', seed ' + seed);
    }
    assert.deepStrictEqual(nameAll(named, roster.names, sessions, seats, out, {}, 'room ' + seed), out, 'asking again renames nobody, seed ' + seed);
  }
});

test('a name does not come back until the others of its kind have been used', () => {
  const used = {}, seen = [];
  let clock = Date.parse('2026-11-08T09:00:00Z');
  for (let i = 0; i < 60; i++) {
    const s = [{ id: 't' + i }];
    const n = nameAll(named, roster.names, s, { ['t' + i]: 'priya' }, {}, used, 'room A')['t' + i];
    used[n] = new Date(clock += 60000).toISOString();
    seen.push(n);
  }
  assert.strictEqual(new Set(seen.slice(0, 25)).size, 25, 'the first 25 are all different');
  assert.deepStrictEqual(seen.slice(25, 50), seen.slice(0, 25), 'then the least recently used comes first');
});

test('two rooms go through the names in different orders', () => {
  const day = (seed) => { const used = {}; let clock = 0; return Array.from({ length: 8 }, () => { const n = nameAll(named, roster.names, [{ id: 'x' }], { x: 'marcus' }, {}, used, seed).x; used[n] = String(++clock).padStart(4, '0'); return n; }); };
  const a = day('/Users/me/.office-world'), b = day('/Users/me/.office-world-b');
  assert.notDeepStrictEqual(a, b);
  assert.ok(a.filter((n) => b.includes(n)).length < 8, 'not the same names: ' + a + ' / ' + b);
});

test('a name held for a session not back yet is passed over, and a session keeps its name', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }];
  const seats = { a: 'priya', b: 'june' };
  const first = nameAll(named, roster.names, [{ id: 'a' }], { a: 'priya' }, {}, {}, 'x').a;
  const out = nameAll(named, roster.names, sessions, seats, { a: 'Hana', 'saved q': first }, {}, 'x');
  assert.strictEqual(out.a, 'Hana', 'kept');
  assert.notStrictEqual(out.b, first, 'the held name is passed over');
  const moved = nameAll(named, roster.names, [{ id: 'a' }], { a: 'marcus' }, { a: 'Hana' }, {}, 'x');
  assert.strictEqual(kindOf(moved.a), 'man', 'a desk of the other kind takes a new name');
});

// Through the relay: GET /terminals says who each session is, from the room's roster, and the
// relay keeps it through a restart.
const terminals = async (R) => (await R.call('GET', '/terminals')).body.terminals;
const seatsOf = (list) => Object.fromEntries(list.map((t) => [t.sessionId, t.seat]));
const sorted = (rows) => rows.slice().sort((a, b) => String(a[0]).localeCompare(String(b[0])));

test('the relay seats its sessions, and the Floor uses the same names', async (t) => {
  const R = await relay();
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const a = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const b = (await R.call('POST', '/terminals', { cwd: repo })).body;
  assert.deepStrictEqual([a.seat, b.seat], ['priya', 'marcus'], 'the first free desks, past the Lead\'s desk');
  assert.deepStrictEqual([kindOf(a.who), kindOf(b.who)], ['woman', 'man'], 'names from the pool that fit the desks: ' + a.who + ', ' + b.who);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: b.id })).status, 200);
  assert.deepStrictEqual(sorted((await terminals(R)).map((x) => [x.id, x.seat, x.who])), sorted([[a.id, 'priya', a.who], [b.id, 'lead', 'Lead']]), 'the Lead takes its desk at once');
  const floor = (await R.call('GET', '/floor')).body.sessions;
  assert.deepStrictEqual(sorted(floor.map((r) => [r.terminal, r.name])), sorted([[a.id, a.who], [b.id, 'Lead']]));
  assert.strictEqual((await R.call('POST', '/terminals/names', { names: { [a.id]: 'Lead' } })).status, 404, 'a page cannot rename anyone');
  await R.call('POST', '/terminals/' + a.id + '/stop', {});
  await until(async () => (await terminals(R)).length === 1, 'a to stop');
  const c = (await R.call('POST', '/terminals', { cwd: repo })).body;
  assert.strictEqual(c.seat, 'priya', 'a desk is free again once its session ends');
  assert.notStrictEqual(c.who, a.who, 'but its name waits for the others');
});

test('a day of sessions uses many names, and two rooms show different names at once', async (t) => {
  const A = await relay(), B = await relay();
  t.after(async () => { for (const R of [A, B]) { await R.kill().catch(() => {}); R.remove(); } });
  const repoA = makeRepo(A.home), repoB = makeRepo(B.home);
  const day = [];
  for (let i = 0; i < 12; i++) {
    const s = (await A.call('POST', '/terminals', { cwd: repoA })).body;
    day.push(s.who);
    await A.call('POST', '/terminals/' + s.id + '/stop', {});
    await until(async () => (await terminals(A)).length === 0, 'it to stop');
  }
  assert.strictEqual(new Set(day).size, 12, 'twelve sessions at one desk, twelve names: ' + day);
  const inA = [], inB = [];
  for (let i = 0; i < 4; i++) {
    inA.push((await A.call('POST', '/terminals', { cwd: repoA })).body.who);
    inB.push((await B.call('POST', '/terminals', { cwd: repoB })).body.who);
  }
  assert.notDeepStrictEqual(inA, inB, 'each room goes through the names in its own order');
  const record = JSON.parse(fs.readFileSync(path.join(A.home, '.office-world', 'names.json'), 'utf8'));
  assert.ok(day.concat(inA).every((n) => record[n]), 'each room keeps its own record of the names it used');
});

test('after a restart the Lead is at the Lead\'s desk, and everyone else keeps their person', async (t) => {
  // The saved list from 2026-11-07: a Dev at the Lead's desk, the Lead at June's.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
  const repo = makeRepo(home);
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const saved = { t: [
    { sessionId: ids[0], talked: true, cwd: repo, title: 'T-148 work', seat: 'lead', who: 'Ivan' },
    { sessionId: ids[1], talked: true, cwd: repo, title: 'Lead work', lead: true, seat: 'june' },
    { sessionId: ids[2], talked: true, cwd: repo, title: 'Other work', seat: 'theo', who: 'Hugo' },
  ] };
  const file = path.join(home, '.office-world', 'sessions.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(saved));
  const R = await relay({ RELAY_RESUME: '1' }, home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const list = await until(async () => { const l = await terminals(R); return l.length === 3 && l; }, 'three back');
  assert.deepStrictEqual(seatsOf(list), { [ids[0]]: 'priya', [ids[1]]: 'lead', [ids[2]]: 'theo' });
  const whoOf = (l) => Object.fromEntries(l.map((x) => [x.sessionId, x.who]));
  const now = whoOf(list);
  assert.deepStrictEqual([now[ids[1]], now[ids[2]]], ['Lead', 'Hugo'], 'the Lead is Lead, and the one that kept its desk keeps its name');
  assert.strictEqual(kindOf(now[ids[0]]), 'woman', 'the one that left the Lead\'s desk for Priya\'s takes a name that fits it');
  // The seats are saved with the sessions, so the next restart starts from them.
  await until(() => {
    const now = JSON.parse(fs.readFileSync(file, 'utf8')).t || [];
    return now.length === 3 && JSON.stringify(seatsOf(now)) === JSON.stringify(seatsOf(list));
  }, 'the seats saved');
});
