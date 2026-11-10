// The Board's order, worked out each time the list is shown, so closing a ticket writes no other one.
// Open tickets first: high, normal, low, and by place (rank) within a priority. Then done and
// rejected ones, the latest changed first, which is what the Done column shows. A ticket with no
// priority counts as normal.
//
// A ticket's place is its rank, a number: lower is worked first. A ticket saved before ranks has
// none, so its creation time in milliseconds stands in, and old tickets keep oldest first. One with
// no time either goes first, in the store's order, as before.
'use strict';
const RANK = { high: 0, normal: 1, low: 2 };
const CLOSED = ['done', 'rejected'];
const PRIORITY_OF = (t) => RANK[t.priority] ?? RANK.normal;
const closed = (t) => (CLOSED.includes(t.status) ? 1 : 0);
const text = (v) => String(v || '');
function placeOf(t) {
  if (typeof t.rank === 'number' && Number.isFinite(t.rank)) return t.rank;
  const at = Date.parse(t.createdAt);
  return Number.isFinite(at) ? at : -Infinity;
}
const byPlace = (a, b) => { const x = placeOf(a), y = placeOf(b); return x < y ? -1 : x > y ? 1 : 0; };

function compare(a, b) {
  return closed(a) - closed(b) ||
    (closed(a) ? text(b.updatedAt).localeCompare(text(a.updatedAt)) : PRIORITY_OF(a) - PRIORITY_OF(b) || byPlace(a, b) || text(a.createdAt).localeCompare(text(b.createdAt)));
}
// A new list: the one given is left as it was. Ties keep the store's order.
const boardOrder = (list) => list.map((t, i) => [t, i]).sort(([a, i], [b, j]) => compare(a, b) || i - j).map(([t]) => t);

// The open tickets of one priority, in Board order: the group a ticket moves inside.
const groupOf = (list, priority) => boardOrder(list.filter((t) => !closed(t) && (t.priority || 'normal') === priority));

// The rank that puts a ticket last in a priority: after every open ticket in it, and never before
// the time now, so a ticket filed later still goes after it.
function lastRank(list, priority, now) {
  const places = groupOf(list, priority).map(placeOf).filter(Number.isFinite);
  return Math.max(now, places.length ? Math.max(...places) + 1 : now);
}

// The ranks that put `moving` just before (or after) `target` in their priority. The work order is
// the tickets that `movable` lets through (Triage and Ready, in relay/tickets.js), so a Started one
// is neither a neighbour nor written. Usually that is one write, a rank between two neighbours. When
// there is no room between them, the movable tickets of that priority are numbered again, a thousand
// apart, in their new order. Returns [[id, rank]] for what changes.
const STEP = 1000;
function placeNear(list, moving, target, after, movable) {
  const group = groupOf(list, moving.priority || 'normal').filter((t) => t.id !== moving.id && (!movable || movable(t)));
  const at = group.findIndex((t) => t.id === target.id) + (after ? 1 : 0);
  const prev = group[at - 1], next = group[at];
  const lo = prev ? placeOf(prev) : null, hi = next ? placeOf(next) : null;
  let rank = null;
  if (lo === null && Number.isFinite(hi)) rank = hi - STEP;
  else if (hi === null && Number.isFinite(lo)) rank = lo + STEP;
  else if (Number.isFinite(lo) && Number.isFinite(hi)) rank = lo + (hi - lo) / 2;
  if (rank !== null && (lo === null || rank > lo) && (hi === null || rank < hi)) return [[moving.id, rank]];
  const order = group.slice(0, at).concat(moving, group.slice(at));
  const start = Math.min(...order.map(placeOf).filter(Number.isFinite), Date.now());
  return order.map((t, i) => [t.id, start + i * STEP]).filter(([id, r]) => { const t = order.find((x) => x.id === id); return t.rank !== r; });
}

module.exports = { boardOrder, groupOf, lastRank, placeNear };
