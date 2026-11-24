// What the manager sees (relay/manager-watch.js): six signs that work is stuck, read from a board the watch
// builds from what the relay already keeps. Plain functions with no side effects, so the tests can give each
// sign a fake board. See docs/manual/roles.html#manager-watch.
//
//   findings(board) -> [{ key, kind, ticket, task, terminal, repo, title, reason, say }]
//
// board:
//   now, limits { buildingMs, checkFails, briefMs, slotMs, handoffs, skipMs }
//   tasks   [{ id, ticket, title, repo, state, slot, terminal, dev: 'live' | 'waiting' | 'gone' | null, movedAt, since, checks: [{ name, heads }] }]
//           slot: the task counts toward the WIP limit. movedAt: the latest hook, push or PR change. since: when the task last changed.
//   seats   [{ terminal, role: 'Dev' | 'reviewer', task, ticket, repo, who, startedAt, briefed }]
//   runs    [{ task, ticket, repo, outcome: 'handed' | 'merged' }], oldest first
//   ready   [{ id, title, repo, rejected: [ids], since }]
// key says which problem it is, so a problem that lasts is one problem: the same key on the next look is the
// same finding. reason is the full words for Activity and the ticket, say is the short line in the manager's bubble.
'use strict';

const minutes = (ms) => Math.max(1, Math.round(ms / 60000));
const who = (t) => t.ticket || 'Task ' + t.id;
const finding = (key, kind, t, reason, say) => ({ key, kind, ticket: t.ticket || null, task: t.id || t.task || null, terminal: t.terminal || null, repo: t.repo || null, title: t.title || null, reason, say });

function quiet(board) {
  return board.tasks.filter((t) => t.state === 'building' && t.dev !== 'waiting' && t.movedAt && board.now - t.movedAt >= board.limits.buildingMs).map((t) => {
    const m = minutes(board.now - t.movedAt);
    return finding('quiet ' + t.id, 'quiet', t, who(t) + ' is in Building, and no hook, push or PR change came for ' + m + ' minutes.', who(t) + ' has not moved in ' + m + ' minutes.');
  });
}
function checks(board) {
  const out = [];
  for (const t of board.tasks) {
    for (const c of t.checks || []) {
      if (c.heads < board.limits.checkFails) continue;
      out.push(finding('check ' + t.id + ' ' + c.name, 'check', t, 'The check ' + c.name + ' failed on ' + c.heads + ' commits of the PR of ' + who(t) + ', one after the other.', 'The ' + c.name + ' check keeps failing on ' + who(t) + '.'));
    }
  }
  return out;
}
function unbriefed(board) {
  return board.seats.filter((s) => !s.briefed && s.startedAt && board.now - s.startedAt >= board.limits.briefMs).map((s) => {
    const m = minutes(board.now - s.startedAt), name = s.ticket || (s.task ? 'Task ' + s.task : s.who);
    const reason = s.role === 'reviewer'
      ? 'The reviewer ' + s.who + ' of ' + (name || 'a PR') + ' never got its first prompt, ' + m + ' minutes after it started.'
      : 'The Dev ' + s.who + ' of ' + name + ' never got its brief, ' + m + ' minutes after it started.';
    return finding('brief ' + s.terminal, s.role === 'reviewer' ? 'prompt' : 'brief', Object.assign({}, s, { id: s.task }), reason, s.role === 'reviewer' ? s.who + ' has not been given the review.' : s.who + ' never got the brief for ' + name + '.');
  });
}
function slots(board) {
  return board.tasks.filter((t) => t.slot && (t.dev === 'gone' || t.dev === null) && t.since && board.now - t.since >= board.limits.slotMs).map((t) => {
    const m = minutes(board.now - t.since);
    return finding('slot ' + t.id, 'slot', t, who(t) + ' holds a building slot with no Dev, for ' + m + ' minutes.', who(t) + ' holds a slot and has no Dev.');
  });
}
function handoffs(board) {
  const streak = [];
  for (const r of board.runs.slice().reverse()) {
    if (r.outcome !== 'handed') break;
    streak.unshift(r);
  }
  if (streak.length < board.limits.handoffs) return [];
  const names = streak.map((r) => r.ticket || 'Task ' + r.task);
  const last = streak[streak.length - 1];
  return [finding('handoffs', 'handoffs', { ticket: null, id: last.task, repo: last.repo }, 'Autopilot handed ' + streak.length + ' tasks in a row to Waiting on you: ' + names.join(', ') + '.', 'Autopilot has given ' + streak.length + ' tasks in a row to you.')];
}
function skipped(board) {
  return board.ready.filter((r) => r.rejected.length && r.since && board.now - r.since >= board.limits.skipMs).map((r) => {
    const them = r.rejected.join(', ');
    return finding('skip ' + r.id, 'skip', { ticket: r.id, repo: r.repo, title: r.title }, r.id + ' is in Ready, and Autopilot skips it because ' + them + ' ' + (r.rejected.length === 1 ? 'was' : 'were') + ' rejected.', r.id + ' waits on ' + them + ', which was rejected.');
  });
}

function findings(board) {
  const held = slots(board), heldTasks = new Set(held.map((f) => f.task));
  return [].concat(quiet(board).filter((f) => !heldTasks.has(f.task)), checks(board), unbriefed(board), held, handoffs(board), skipped(board));
}

module.exports = { findings };
