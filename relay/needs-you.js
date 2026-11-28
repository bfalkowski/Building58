// The Needs you route: GET /channels/<channel>/needs-you answers the room page with one list of what the
// person has to do now. It reads only what the relay already keeps, so it asks gh and git nothing, and the
// page can read it often. relay/needs-you-plan.js holds the rules. See docs/manual/roles.html#needs-you.
//
// What it reads: each running session (relay/terminal.js) with its state from relay/liveness.js and any
// question on its screen; each task that is not done (relay/tasks.js); Autopilot's hand-over reason and, for a
// stall, the last review posted after it (relay/autopilot.js); whether a Dev still owes the continue prompt a
// restart saved for it (relay/sessions.js); whether a review of a PR runs, or could not start and the relay
// stopped trying (relay/reviews.js); whether a PR merged or closed
// (relay/tasks.js, relay/chat.js, relay/pipeline.js); and who may merge a PR, from the PR watch (relay/pr-watch.js) and the last huddle
// report (relay/huddles.js), when they have looked; reviews that wait for a desk the relay could not free
// (relay/reviews.js); and each saved message (relay/delivery.js) that has waited
// UNDELIVERED for a running session, unless that session is in a turn, waits on an answer, or has ended; and
// each other relay on this room's state folder (relay/old-relays.js); and each base branch whose latest CI run
// failed, from the last answer relay/main-ci.js kept; and the GitHub tickets whose notes are signed with another key (relay/tickets.js); and each ticket whose last write to the
// GitHub ticket store failed (relay/tickets.js); and the Claude Code the sessions run, when the room was not
// tested with it (relay/claude-version.js); and the skills the briefs use that are not installed, or plugins installed at another version than plugins.json pins (relay/skills.js). The
// huddle counts its headline from the same list, and boardOf gives the Board each task's item, so its Waiting
// on you column holds the tickets the list names.
//
// Like the terminal, this answers only the room page on this machine, with the person's key.
'use strict';
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const autopilot = require('./autopilot.js');
const reviews = require('./reviews.js');
const prWatch = require('./pr-watch.js');
const huddles = require('./huddles.js');
const pipeline = require('./pipeline.js');
const chat = require('./chat.js');
const { livenessOf, stuckJobsOf } = require('./liveness.js');
const delivery = require('./delivery.js');
const { owesContinue } = require('./sessions.js');
const { listOf } = require('./needs-you-plan.js');
const oldRelays = require('./old-relays.js');
const claudeVersion = require('./claude-version.js');
const mainCi = require('./main-ci.js');

const FRESH_MS = 60 * 1000;
const UNDELIVERED = Number(process.env.RELAY_UNDELIVERED_MS) > 0 ? Number(process.env.RELAY_UNDELIVERED_MS) : 15 * 60 * 1000;
const NOT_STUCK = new Set(['working', 'waiting', 'ended']);
const OFFICERS = ['pm', 'coo', 'security', 'reviewer'];
const roleOf = (t, task) => (t.lead ? 'Lead' : t.role === 'reviewer' ? 'reviewer' : OFFICERS.includes(t.role) ? t.role : task ? 'Dev' : 'session');

function closed(channel, pr) {
  const p = pipeline.of(pr);
  return chat.prMerged(channel, pr) || !!(p && (p.open === false || p.prState === 'MERGED' || p.prState === 'CLOSED'));
}
function onlyYouMerge(channel, pr, report) {
  const move = prWatch.moveOf(channel, pr);
  if (move && move.owner === 'you' && move.cause === 'protected') return move.why;
  if (move && move.owner === 'you' && move.cause === 'ready') return move.why + ' The Lead may not merge it.';
  const row = report && report.rows.find((r) => r.pr && r.pr.url === pr && r.mergeWhy);
  if (row && row.pr.state === 'OPEN' && row.pr.pipeline === 'passing') return row.mergeWhy;
  return null;
}
function noteOf(task) {
  const moved = (task.history || []).filter((h) => h.type === 'moved' && h.to === 'waiting_on_you').pop();
  return moved && moved.note ? moved.note : null;
}

function handedOf(channel, task) {
  const desk = autopilot.deskOf(channel, task), r = desk.reviewedSince, head = r && (pipeline.of(task.pr) || {}).head;
  return { handedOver: desk.handedOver, devSaysBug: !!desk.devSaysBug, outOfReviews: !!desk.outOfReviews, pushRefused: desk.pushRefused, reviewedSince: r ? { ...r, current: !head || head === r.commit } : null };
}

function stateOf(channel, now, lastReport) {
  const all = terminal.all(channel), list = tasks.list(channel).filter((t) => t.state !== 'done');
  const taskOf = (t) => (t.task && list.find((x) => x.id === t.task)) || list.find((x) => x.owner && x.owner.terminal === t.id) || null;
  const seats = all.map((t) => {
    const task = taskOf(t), lv = livenessOf(t, now);
    return { terminal: t.id, who: chat.nameOf(t), role: roleOf(t, task), live: lv.state, cause: lv.cause, message: t.message || null, screen: lv.state === 'gone' ? null : terminal.questionOnScreen(t), task: task ? task.id : null, stuckWhy: t.stuck ? t.stuck.why : null, stuckJobs: lv.state === 'gone' ? [] : stuckJobsOf(t).map((j) => ({ pid: j.pid, command: j.command, minutes: Math.floor((now - j.since) / 60000) })), spoke: !!t.spoke, continuing: owesContinue(channel, t), fresh: !t.spoke && now - (Date.parse(t.startedAt) || 0) < FRESH_MS };
  });
  const report = lastReport || huddles.reportOf(channel);
  const reviewing = (pr) => all.some((x) => !x.exited && x.reviewOf === pr && !x.posted);
  const out = list.map((task) => ({
    id: task.id, repo: task.repo || null, ticket: task.ticket || null, title: task.title || null, state: task.state, pr: task.pr || null,
    prOpen: task.pr ? !closed(channel, task.pr) : null,
    prMerged: !!task.pr && tasks.prMerged(channel, task),
    prClosed: !!task.pr && !tasks.prMerged(channel, task) && (chat.prClosed(channel, task.pr) || (pipeline.of(task.pr) || {}).prState === 'CLOSED'),
    owner: task.owner && terminal.find(channel, task.owner.terminal) ? task.owner.terminal : null,
    note: noteOf(task), reviewRuns: !!task.pr && reviewing(task.pr), pipelineWaits: !!(tasks.pipelineOf(task) || {}).waits,
    ...handedOf(channel, task),
    bringBackWhy: autopilot.bringBackLate(task),
    reviewOwed: !!task.pr && !!(reviews.deskOf(channel, task.pr) || {}).followUp,
    reviewFailed: task.pr ? reviews.failedOf(channel, task.pr) : null,
    onlyYouMerge: task.pr ? onlyYouMerge(channel, task.pr, report) : null,
  }));
  const waits = delivery.pending(channel)
    .filter((d) => d.target && !d.typed && d.blocked && !NOT_STUCK.has(d.blocked) && d.savedAt && now - d.savedAt > UNDELIVERED)
    .sort((a, b) => a.savedAt - b.savedAt)
    .map((d) => ({ terminal: d.target, who: chat.nameOf(terminal.find(channel, d.target)), minutes: Math.floor((now - d.savedAt) / 60000), why: delivery.whyWaits(d.blocked) }));
  return { seats, tasks: out, waits, relays: oldRelays.list(), desks: reviews.deadlockOf(channel), mains: mainCi.redOf(channel), writes: require('./tickets.js').writeErrors(channel, now), unread: require('./tickets.js').unreadNotes(channel), claude: claudeVersion.current(), skills: require('./skills.js').lacking(), leadStuck: require('./lead-stuck.js').passedOf(channel), flakes: require('./flake.js').waitingOf(channel) };
}

async function handle(req, res, channel, rest, ctx) {
  if (rest !== '/needs-you') return false;
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (req.method !== 'GET') { ctx.problem(res, 404, 'not_found', 'Needs you answers GET only.'); return true; }
  if (ctx.agent) { ctx.problem(res, 401, 'unauthorized', 'Only the person reads Needs you.'); return true; }
  if (!terminal.ENABLED) { ctx.problem(res, 404, 'terminal_off', 'Needs you needs the terminal. Start the relay with npm run office, or with RELAY_TERMINAL=1.'); return true; }
  const items = listOf(stateOf(channel, Date.now()));
  ctx.send(res, 200, { ok: true, at: new Date().toISOString(), count: items.length, items });
  return true;
}

function boardOf(channel, now) {
  if (!terminal.ENABLED) return null;
  const state = stateOf(channel, now), items = listOf(state);
  return new Map(state.tasks.map((t) => [t.id, { needsYou: (items.find((i) => i.task === t.id) || {}).kind || null, reviewRuns: t.reviewRuns }]));
}

module.exports = { handle, stateOf, boardOf };
