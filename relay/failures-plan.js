// Shared failure channels, as plain functions of what the relay already keeps, so the tests run them on made-up
// data. relay/failures.js gathers the state and carries the actions out. See docs/manual/roles.html#failures.
//
//   failing(prs) -> Map of check name -> the open PRs on which that check failed
//   plan({ rooms, prs, now }) -> [{ do, key, ... }]
//
// A pr is { pr, open, merged, closed, failed: [check names], green }. A room is a failure channel that is open:
// { key, prs: [PR links], fixedBy: PR link or null, lastAt: ms of its last post }. One failure is one check
// name that failed on two or more open PRs. The actions:
//   open     no channel for that failure yet, and two or more open PRs show it
//   join     a channel is open and another open PR shows the same failure
//   fixed    a PR of an open channel merged, and the channel has no fix yet: its first merge is the fix
//   archive  every blocked PR passed the check or closed with none merged, and one is open and green,
//            or the fix merged and every PR the failure blocked has merged, closed or passed the check,
//            or the channel has had no post for QUIET_MS
'use strict';

const QUIET_MS = 24 * 60 * 60 * 1000;
const MIN_PRS = 2;

function failing(prs) {
  const out = new Map();
  for (const p of prs) {
    if (!p.open) continue;
    for (const key of p.failed || []) out.set(key, (out.get(key) || []).concat(p.pr));
  }
  return out;
}

const keyOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const roomNameOf = (key) => 'failure-' + key;

function cleared(p, key) {
  if (!p) return true;
  if (p.merged || p.closed) return true;
  return !!p.open && !!p.green && !(p.failed || []).includes(key);
}

function plan({ rooms, prs, now }) {
  const out = [], by = new Map(prs.map((p) => [p.pr, p]));
  const open = new Map(rooms.map((r) => [r.key, r]));
  for (const [key, links] of failing(prs)) {
    const room = open.get(key);
    if (!room && links.length >= MIN_PRS) out.push({ do: 'open', key, prs: links });
    else if (room) for (const pr of links) if (!room.prs.includes(pr)) out.push({ do: 'join', key, pr });
  }
  for (const room of rooms) {
    let fixedBy = room.fixedBy;
    if (!fixedBy) {
      const merged = room.prs.find((pr) => by.get(pr) && by.get(pr).merged);
      if (merged) { fixedBy = merged; out.push({ do: 'fixed', key: room.key, pr: merged }); }
    }
    const done = fixedBy && room.prs.every((pr) => cleared(by.get(pr), room.key));
    const gone = (pr) => !by.get(pr) || by.get(pr).closed || by.get(pr).merged;
    const passed = !fixedBy && room.prs.every((pr) => cleared(by.get(pr), room.key)) && !room.prs.every(gone);
    if (passed) out.push({ do: 'archive', key: room.key, why: 'every PR it blocked passed the check and no fix merged, so it was likely a flaky run' });
    else if (done) out.push({ do: 'archive', key: room.key, why: 'the fix merged and every PR it blocked has merged, closed or passed the check' });
    else if (now - room.lastAt >= QUIET_MS) out.push({ do: 'archive', key: room.key, why: 'it had no post for 24 hours' });
  }
  return out;
}

module.exports = { plan, failing, keyOf, roomNameOf, cleared, QUIET_MS, MIN_PRS };
