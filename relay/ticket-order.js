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
const boardOrder = (list) => list.map((t, i) => [t, i]).sort(([a, i], [b, j]) => compare(a, b) || i - j).map(([t]) => t);

const groupOf = (list, priority) => boardOrder(list.filter((t) => !closed(t) && (t.priority || 'normal') === priority));

function lastRank(list, priority, now) {
  const places = groupOf(list, priority).map(placeOf).filter(Number.isFinite);
  return Math.max(now, places.length ? Math.max(...places) + 1 : now);
}

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
