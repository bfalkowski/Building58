// Who sits where: which person in the roster each of the relay's sessions is. relay/terminal.js asks
// each time its sessions or its Lead change, saves the answer with its sessions, and sends it in
// GET /terminals. The room page draws it, and the Floor and ticket history use the same names.
// See docs/manual/roles.html#seats.
//
// seatAll (people, sessions, before) returns { session id: person id }.
//   people   the roster in its order: [{ id, lead }]. The one with lead: true is the Lead's desk.
//   sessions the running sessions: [{ id, lead, at }]. lead marks the session you made the Lead.
//            at is when it started, and only breaks ties, so the list's order never matters.
//   before   { session id: person id }, what each had before. An id that is not running yet, such as a
//            session the relay is still bringing back, holds its person: others pass over them while
//            anyone else is free.
//
// The rules, in order:
//   1. The Lead sits at the Lead's desk.
//   2. Anyone else keeps the person they had, if that person is free and is not the Lead's desk.
//   3. Anyone left takes the first free person nobody is holding, then anyone free. The Lead's desk
//      comes last, so it goes to someone who is not the Lead only when every other desk is full, and
//      then to the one who had it before.
// So /clear and /resume keep the person, since the session id here is the terminal's, which they keep.
//
// nameAll (people, names, sessions, seats, before, used, seed) returns { session id: name }. A desk is a
// look; the name a session shows comes from the roster's pool, so the same few names do not come back
// again and again.
//   people   as for seatAll, each with its name and kind ('woman' or 'man').
//   names    the pool: { kind: [name] }. A desk's name comes from the list of its kind, so it fits the look.
//   seats    what seatAll gave.
//   before   { session id: name }, what each was called before. As for seatAll, an id not running yet
//            holds its name.
//   used     { name: when it was last given or given up }, this room's own record.
//   seed     this room's own word, so two rooms go through the names in different orders.
//
// The rules, in order:
//   1. The Lead at the Lead's desk is called by the desk's name. So is anyone at a desk whose kind
//      has no names.
//   2. Anyone else keeps the name they had, if it fits their desk and nobody before them kept it.
//   3. Anyone left takes the least recently used name of their desk's kind that nobody has and nobody
//      is holding, then any that nobody has. Names never used come first, in this room's own order.
'use strict';
const { oneLine } = require('./clean.js');

const earlier = (a, b) => (a.lead ? 0 : 1) - (b.lead ? 0 : 1) || String(a.at || '').localeCompare(String(b.at || '')) || String(a.id).localeCompare(String(b.id));

function seatAll(people, sessions, before) {
  before = before || {};
  const desk = people.find((p) => p.lead) || null;
  const known = new Set(people.map((p) => p.id));
  const order = sessions.filter((s) => s && s.id).slice().sort(earlier);
  const live = new Set(order.map((s) => String(s.id)));
  const out = {}, taken = new Set();
  const sit = (s, id) => { out[s.id] = id; taken.add(id); };

  const lead = order.find((s) => s.lead);
  if (lead && desk) sit(lead, desk.id);
  for (const s of order) {
    const had = before[s.id];
    if (!(s.id in out) && known.has(had) && !taken.has(had) && !(desk && had === desk.id)) sit(s, had);
  }
  const held = new Set(Object.keys(before).filter((id) => !live.has(id)).map((id) => before[id]));
  const left = order.filter((s) => !(s.id in out));
  const others = () => people.filter((p) => !p.lead && !taken.has(p.id));
  // Every other desk is full for the ones left, so the Lead's desk goes first to the one who had it.
  const keeper = desk && !taken.has(desk.id) && left.length > others().length ? left.find((s) => before[s.id] === desk.id) : null;
  if (keeper) sit(keeper, desk.id);
  for (const s of left) {
    if (s === keeper) continue;
    const free = others();
    const p = free.find((x) => !held.has(x.id)) || free[0] || (desk && !taken.has(desk.id) ? desk : null);
    if (p) sit(s, p.id);
  }
  return out;
}

// A name's place in a room's own order: a small hash of the room's word and the name.
function rank(seed, name) {
  let h = 2166136261;
  for (const c of String(seed) + '\n' + name) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

function nameAll(people, names, sessions, seats, before, used, seed) {
  before = before || {}; used = used || {}; names = names || {};
  const byId = new Map(people.map((p) => [p.id, p]));
  const order = sessions.filter((s) => s && s.id && byId.has(seats[s.id])).slice().sort(earlier);
  const live = new Set(order.map((s) => String(s.id)));
  const out = {}, taken = new Set();
  const key = (n) => String(n).toLowerCase();
  const sit = (s, n) => { out[s.id] = n; taken.add(key(n)); };
  const rest = [];
  for (const s of order) {
    const p = byId.get(seats[s.id]);
    const pool = p.lead && s.lead ? null : names[p.kind];
    if (pool && pool.length) rest.push([s, pool, p]); else sit(s, p.name);
  }
  for (const [s, pool] of rest) {
    const had = before[s.id];
    if (had && pool.includes(had) && !taken.has(key(had))) sit(s, had);
  }
  const held = new Set(Object.keys(before).filter((id) => !live.has(id)).map((id) => key(before[id])));
  const sooner = (a, b) => String(used[a] || '').localeCompare(String(used[b] || '')) || rank(seed, a) - rank(seed, b);
  for (const [s, pool, p] of rest) {
    if (s.id in out) continue;
    const free = pool.filter((n) => !taken.has(key(n))).sort(sooner);
    sit(s, free.find((n) => !held.has(key(n))) || free[0] || p.name);
  }
  return out;
}

// A name as the relay keeps it: what prints in the Lead's terminal (the Floor, ticket.js stop) and
// on the page. Control characters become a space. Characters that hide or reorder text in a terminal
// go: zero-width and invisible ones (U+00AD, U+034F, U+180E, U+200B to U+200D, U+2060 to U+2064,
// U+FEFF), and bidi marks and controls (U+200E, U+200F, U+061C, U+202A to U+202E, U+2066 to U+2069),
// so a name cannot hide or flip the text after it. Then spaces collapse, and it keeps 40 characters,
// counted by code point so the cut never leaves half an emoji (a lone surrogate). Returns '' when nothing is left.
// U+034F is a combining mark, so it sits outside the brackets, where lint would read it as joined to the one before.
const HIDDEN = /\u034f|[\u00ad\u180e\u200b-\u200f\u2060-\u2064\u202a-\u202e\u2066-\u2069\u061c\ufeff]/g;
function plainName(v) {
  const one = oneLine(String(v == null ? '' : v).replace(HIDDEN, ''));
  return Array.from(one).slice(0, 40).join('');
}

module.exports = { seatAll, nameAll, plainName };
