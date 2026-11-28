// The Floor as the Lead sees it: each running session, with the name the relay gave it (relay/seats.js),
// which the page shows too, its role, ticket and PR, its state, and whether it can be stopped. The Lead reads it with
// node relay/ticket.js floor. It reads only what the relay already knows, so it interrupts nobody.
// Whether each can be stopped comes from relay/stop-verdict.js. Above the sessions it shows each base branch
// whose latest CI run failed (relay/main-ci.js), with the run's link.
//
// A Lead the person let move the board can also stop one session, with node relay/ticket.js stop,
// while the relay runs with RELAY_LEAD_STOPS=1 (article 3, a rung in article 5). The relay asks the
// same verdict first, so it never stops a session the Floor calls not safe. Then it stops only the two
// kinds the Lead's brief names (leadMayStop): an automatic reviewer that has posted, and a Dev whose
// PR merged or whose task is Done, with nothing uncommitted or unpushed in its checkout. A task
// worker keeps its checkout and branch, so Bring back returns it.
//
// Like the terminal, this answers only the room page and the sessions on this machine.
'use strict';
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const chat = require('./chat.js');
const pipeline = require('./pipeline.js');
const mainCi = require('./main-ci.js');
const { redMain } = require('./needs-you-plan.js');
const { stopVerdict, leadMayStop, forReview } = require('./stop-verdict.js');
const { deskOf, pairReviewers } = require('./desk.js');
const { livenessOf, jobWords, stuckJobsOf, stuckJobWords } = require('./liveness.js');
const { tiredOf } = require('./lead-tired.js');
const { holdOf, unsavedWork } = require('./merge-hold.js');

const config = require('./config.js');
const LEAD_STOPS = () => config.get('leadStops');
const STOP_LIMIT = () => config.get('leadStopLimit');
const HOUR = 60 * 60 * 1000;
const stopsAt = new Map();

const minutes = (ms) => Math.max(0, Math.floor(ms / 60000));
function stateOf(t, now) {
  const lv = livenessOf(t, now);
  if (lv.state === 'waiting') return 'waiting on the person';
  if (lv.state === 'job') return 'job: its turn ended ' + minutes(now - lv.since) + ' min ago, and ' + jobWords(t);
  if (lv.state === 'quiet') return 'quiet: no hook for ' + minutes(now - lv.since) + ' min, its screen still moves';
  if (lv.state === 'stuck' && lv.cause === 'silent') return 'stuck: no hook and no output for ' + minutes(now - lv.since) + ' min';
  if (lv.state === 'stuck') return 'stuck: told ' + minutes(now - lv.since) + ' min ago and did not start, ' + t.stuck.why;
  const stuckJob = lv.state === 'idle' ? stuckJobsOf(t)[0] : null;
  return stuckJob ? stuckJobWords(stuckJob, now) : lv.state;
}
function roleOf(t) {
  if (t.lead) return 'Lead';
  if (t.role === 'pm') return 'PM';
  if (t.role === 'coo') return 'COO';
  if (t.role === 'security') return 'Security';
  if (t.role === 'reviewer') return 'reviewer';
  return t.task ? 'Dev' : 'session';
}
const nameOf = (t) => t.who || 'Session ' + String(t.sessionId).slice(0, 8);

const merged = (channel, pr) => chat.prMerged(channel, pr) || ((pipeline.of(pr) || {}).prState === 'MERGED');

function leadVerdict(channel, t, task, now) {
  const v = stopVerdict(t, task, now, terminal.questionOnScreen(t));
  if (!v.safe) return { safe: false, canStop: false, reason: v.reason };
  const kind = leadMayStop(t, task, merged(channel, task && task.pr));
  const unsaved = kind.may && t.task ? unsavedWork(task.worktree || t.cwd) : null;
  if (!kind.may || unsaved) return { safe: true, canStop: false, reason: 'not one the Lead may stop: ' + (unsaved || kind.reason) };
  return { safe: true, canStop: true, reason: kind.why + v.reason };
}

function deskFor(channel, t, task, work, verdict, now, needs) {
  const role = roleOf(t), pr = work.pr || (task && task.pr) || t.pr || t.reviewOf || null;
  const shown = role === 'reviewer' ? (pr && tasks.list(channel).find((x) => x.pr === pr)) || null : task;
  const lead = terminal.leadOf(channel);
  const pipe = shown && shown.pr === pr ? tasks.pipelineOf(shown) : null;
  const reviewer = pr ? terminal.all(channel).find((x) => x !== t && !x.exited && x.reviewOf === pr && !x.posted) || null : null;
  return deskOf({
    t, role, work, now, verdict,
    task: shown && Object.assign({}, shown, { pipeline: pipe }, needs ? needs.get(shown.id) || { needsYou: null, reviewRuns: false } : null),
    pipeline: pipe,
    review: pr ? require('./reviews.js').deskOf(channel, pr) : null,
    reviewing: !!reviewer,
    reviewer: reviewer ? reviewer.who || null : null,
    autopilot: shown ? require('./autopilot.js').deskOf(channel, shown) : null,
    leadMerges: !!(lead && lead.merge),
    merged: !!pr && merged(channel, pr),
  });
}

function seatOf(t, task) {
  const work = terminal.workOfTerm(t) || {};
  return { name: nameOf(t), named: !!t.who, role: roleOf(t), ticket: work.ticket || (task && task.ticket) || null };
}
function seatsOf(channel) {
  const taskOf = taskFinder(channel);
  return terminal.all(channel).map((t) => seatOf(t, taskOf(t)));
}
function openMenu(t) {
  const m = terminal.menuOf(t);
  return m ? { text: m.text, choices: m.choices, since: new Date(m.since).toISOString() } : null;
}
function rowOf(channel, t, task, now, needs) {
  const work = terminal.workOfTerm(t) || {};
  const verdict = leadVerdict(channel, t, task, now);
  const seat = seatOf(t, task);
  return {
    terminal: t.id, name: seat.name, named: seat.named, seat: t.lead ? 'lead' : t.standing ? 'pm' : null,
    role: seat.role, ticket: seat.ticket, title: (task && task.title) || t.title || null,
    pr: work.pr || (task && task.pr) || t.pr || null, state: stateOf(t, now), stuck: t.stuck && t.state === 'idle' ? { minutesAgo: minutes(now - t.stuck.at), why: t.stuck.why } : null, message: t.message || null,
    stuckJobs: stuckJobsOf(t).map((j) => ({ pid: j.pid, command: j.command, minutes: minutes(now - j.since) })),
    reviewWaits: !!work.reviewWaits, minutesSinceHook: t.hooked ? minutes(now - t.lastActAt) : null, safe: verdict.safe, canStop: verdict.canStop, why: verdict.reason,
    menu: openMenu(t),
    desk: deskFor(channel, t, task, work, verdict, now, needs),
    tired: t.lead ? tiredOf(t) : null,
    mergeHold: mergeHoldOf(channel, t, task, now),
    waitsOn: roleOf(t) === 'Dev' && task ? require('./pr-watch.js').lineOf(channel, task, now) : null,
  };
}
function mergeHoldOf(channel, t, task, now) {
  if (roleOf(t) !== 'Dev' || !task || !task.pr || task.state === 'done' || merged(channel, task.pr)) return null;
  const hold = holdOf(task, t, now);
  return hold ? hold.why : null;
}
function taskFinder(channel) {
  const taskList = tasks.list(channel);
  return (t) => (t.task && taskList.find((x) => x.id === t.task)) || taskList.find((x) => x.owner && x.owner.terminal === t.id) || null;
}
function pmOf(now) {
  const trust = require('./pm-trust.js'), at = require('./pm-sort.js').nextAt(now);
  return { trust: trust.level(), trustName: trust.nameOf(trust.level()), sortHours: config.get('pmSortHours'), nextSortAt: at ? new Date(at).toISOString() : null };
}
function floorOf(channel, now) {
  const taskOf = taskFinder(channel), needs = require('./needs-you.js').boardOf(channel, now);
  return pairReviewers(terminal.all(channel).map((t) => rowOf(channel, t, taskOf(t), now, needs)));
}

function pick(channel, who) {
  const want = String(who || '').trim().toLowerCase();
  if (!want) return [null, 400, 'bad_param', 'Say who to stop: the name ticket.js floor shows, or a task id.'];
  const taskOf = taskFinder(channel);
  const matches = terminal.all(channel).filter((t) => {
    const task = taskOf(t);
    return nameOf(t).toLowerCase() === want || t.id === want || (task && task.id === want);
  });
  if (!matches.length) return [null, 404, 'no_session', 'No running session is called ' + JSON.stringify(String(who).trim()) + '. Run ticket.js floor for the names.'];
  if (matches.length > 1) return [null, 409, 'ambiguous', matches.length + ' sessions are called ' + JSON.stringify(String(who).trim()) + '. Use a task id, or ask the person which one.'];
  return [matches[0]];
}

function stopOne(channel, who, ctx, now) {
  if (!LEAD_STOPS()) return [403, { ok: false, error: 'lead_stops_off', message: 'The person has not let the Lead stop sessions. They turn it on with Let the Lead stop sessions in Settings. Tell them who could be stopped instead.' }];
  if (!ctx.agent || !ctx.agent.lead || !ctx.agent.board) return [403, { ok: false, error: 'lead_only', message: 'Only a Lead the person let move the board stops sessions this way. The page stops one with Stop this session.' }];
  const [t, status, error, message] = pick(channel, who);
  if (!t) return [status, { ok: false, error, message }];
  const task = taskFinder(channel)(t);
  const verdict = leadVerdict(channel, t, task, now);
  const row = { name: nameOf(t), role: roleOf(t), terminal: t.id, sessionId: t.sessionId, task: task ? task.id : null, pr: (task && task.pr) || t.pr || null };
  if (!verdict.safe) return [409, { ok: false, error: 'not_safe', message: 'Not stopped: ' + verdict.reason + '.', session: row }];
  if (!verdict.canStop) return [403, { ok: false, error: 'not_the_leads', message: 'Not stopped: ' + verdict.reason + '. The Lead stops only an automatic reviewer that has posted, or a Dev whose PR merged or whose task is Done, with all its work pushed. Leave this one to the person.', session: row }];
  const recent = (stopsAt.get(channel) || []).filter((at) => now - at < HOUR);
  if (recent.length >= STOP_LIMIT()) {
    stopsAt.set(channel, recent);
    return [429, { ok: false, error: 'limit', message: 'The Lead has stopped ' + recent.length + ' sessions in the last hour, the most it may (Lead stops an hour, in Settings). Give the rest to the person.', session: row }];
  }
  stopsAt.set(channel, recent.concat(now));
  terminal.stop(t);
  if (task) { tasks.record(task, { type: 'note', note: 'The Lead stopped its worker: ' + verdict.reason + '.' }); tasks.save(); }
  const named = row.name + ' (' + [row.role, task && 'task ' + task.id, 'session ' + row.sessionId].filter(Boolean).join(', ') + ')';
  ctx.log('The Lead stopped ' + named + ' on ' + channel + ': ' + verdict.reason);
  chat.announce(channel, 'The Lead stopped ' + named + ': ' + verdict.reason + '.', task && task.ticket);
  return [200, { ok: true, stopped: Object.assign(row, { why: verdict.reason }) }];
}

function endJob(channel, body, ctx, now, viaRung) {
  const stuckJobs = require('./stuck-jobs.js');
  const lead = !!ctx.agent;
  if (lead && !viaRung && !LEAD_STOPS()) return [403, { ok: false, error: 'lead_stops_off', message: 'The person has not let the Lead stop sessions, and ending a stuck job is part of it. They turn it on with Let the Lead stop sessions in Settings. Tell them which job is stuck instead.' }];
  if (lead && (!ctx.agent.lead || (!viaRung && !ctx.agent.board))) return [403, { ok: false, error: 'lead_only', message: 'Only a Lead the person let move the board ends a stuck job this way. The page ends one with End it.' }];
  const [t, status, error, message] = lead ? pick(channel, body && body.who) : [terminal.find(channel, String((body && body.who) || ''))];
  if (!t) return [status || 404, { ok: false, error: error || 'no_session', message: message || 'That session is not running.' }];
  const stuck = stuckJobsOf(t);
  const pid = Number.isInteger(body && body.pid) ? body.pid : stuck.length === 1 ? stuck[0].pid : null;
  if (!stuck.length) return [409, { ok: false, error: 'not_stuck', message: 'Nothing ended: ' + nameOf(t) + ' has no stuck job. A job is stuck after 30 minutes with no CPU and no new output.' }];
  if (pid === null) return [400, { ok: false, error: 'bad_param', message: nameOf(t) + ' has ' + stuck.length + ' stuck jobs. Say which one with pid: ' + stuck.map((j) => j.pid).join(', ') + '.' }];
  if (!stuck.some((j) => j.pid === pid)) return [409, { ok: false, error: 'not_stuck', message: 'Nothing ended: process ' + pid + ' is not a stuck job of ' + nameOf(t) + '.' }];
  if (!stuckJobs.endByPerson(channel, t, pid, lead ? 'The Lead' : 'The person', now)) return [409, { ok: false, error: 'host_old', message: 'Nothing ended: the session host does not know this message yet. Stop and start the office to use the new host.' }];
  ctx.log((lead ? 'The Lead' : 'The person') + ' ended stuck job ' + pid + ' of ' + nameOf(t) + ' on ' + channel + '.');
  return [200, { ok: true, ended: { name: nameOf(t), terminal: t.id, pid } }];
}

function personStop(channel, body, ctx, now) {
  const taskOf = taskFinder(channel);
  const all = terminal.all(channel).filter((t) => !t.exited && !t.stopped);
  const asked = body && body.all === true ? all : all.filter((t) => t.id === String((body && body.who) || ''));
  if (!(body && body.all === true) && !asked.length) return [404, { ok: false, error: 'no_session', message: 'That session is not running.' }];
  const stopped = [], kept = [];
  for (const t of asked) {
    const task = taskOf(t), v = leadVerdict(channel, t, task, now);
    const row = { name: nameOf(t), role: roleOf(t), terminal: t.id, task: task ? task.id : null };
    if (!v.safe || !v.canStop) { if (!body.all) kept.push(Object.assign(row, { reason: v.reason })); continue; }
    terminal.stop(t);
    if (task) { tasks.record(task, { type: 'note', note: 'You stopped its worker from the Floor: ' + v.reason + '.' }); tasks.save(); }
    ctx.log('The person stopped ' + row.name + ' (' + row.role + ') on ' + channel + ' from the Floor: ' + v.reason);
    stopped.push(Object.assign(row, { why: v.reason }));
  }
  if (kept.length) return [409, { ok: false, error: 'not_safe', message: 'Not stopped: ' + kept[0].reason + '.', kept }];
  return [200, { ok: true, stopped }];
}

function stopForDesk(channel, t, task, by, why, purpose) {
  terminal.stop(t);
  const what = 'to free a desk' + (purpose ? ' ' + purpose : '');
  if (task) { tasks.record(task, { type: 'note', note: by + ' stopped its worker ' + what + ': ' + why + '.' }); tasks.save(); }
  const row = { t, name: nameOf(t), role: roleOf(t), task: task ? task.id : null, why };
  chat.announce(channel, by + ' stopped ' + row.name + ' (' + row.role + (task ? ', task ' + task.id : '') + ') ' + what + ': ' + why + '.', task && task.ticket);
  return row;
}
function freeDesks(channel, need, now, by, pick) {
  const taskOf = taskFinder(channel);
  const free = terminal.all(channel).filter((t) => !t.exited && !t.stopped)
    .sort((a, b) => (a.lastActAt || 0) - (b.lastActAt || 0));
  const stopped = [];
  for (const t of free) {
    if (stopped.length >= need) break;
    if (t.lead) continue;
    const task = taskOf(t);
    if (!pick(t, task)) continue;
    const v = leadVerdict(channel, t, task, now);
    if (!v.canStop) continue;
    stopped.push(stopForDesk(channel, t, task, by, v.reason));
  }
  return stopped;
}
function freeForReview(channel, now, waits, purpose) {
  const taskOf = taskFinder(channel);
  const candidates = terminal.all(channel).filter((t) => !t.exited && !t.stopped).map((t) => {
    const task = taskOf(t), verdict = stopVerdict(t, task, now, terminal.questionOnScreen(t));
    if (!verdict.safe) return null;
    const isMerged = !!task && !!task.pr && merged(channel, task.pr);
    const finished = !!(t.task && task && (task.state === 'done' || isMerged));
    return { t, task, verdict, merged: isMerged, unsaved: finished ? unsavedWork(task.worktree || t.cwd) : null, waits: !!(task && task.pr && waits(task.pr)) };
  }).filter(Boolean);
  const pick = forReview(candidates);
  return pick ? stopForDesk(channel, pick.t, pick.task, 'The relay', pick.why, purpose) : null;
}

async function handle(req, res, channel, rest, ctx) {
  if (!/^\/floor(\/|$)/.test(rest)) return false;
  const isRead = rest === '/floor' && req.method === 'GET', isStop = rest === '/floor/stop' && req.method === 'POST', isEnd = rest === '/floor/end-job' && req.method === 'POST';
  if (!isRead && !isStop && !isEnd) { ctx.problem(res, 404, 'not_found', 'Unknown floor route.'); return true; }
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (!terminal.ENABLED) { ctx.problem(res, 404, 'terminal_off', 'The floor needs the terminal. Start the relay with npm run office, or with RELAY_TERMINAL=1.'); return true; }
  if (isRead) { ctx.send(res, 200, { ok: true, sessions: floorOf(channel, Date.now()), pm: pmOf(Date.now()), leadEnded: terminal.leadEndedOf(channel), mainRed: mainCi.redOf(channel).map((m) => ({ branch: m.branch, repo: m.name, url: m.run.url || null, says: 'Red: ' + redMain(m) })) }); return true; }
  const body = await ctx.readJson(req);
  if (isEnd) { const [code, answer] = endJob(channel, body, ctx, Date.now()); ctx.send(res, code, answer); return true; }
  const [status, out] = ctx.agent ? stopOne(channel, body.who, ctx, Date.now()) : personStop(channel, body, ctx, Date.now());
  ctx.send(res, status, out);
  return true;
}

module.exports = { handle, floorOf, seatsOf, personStop, freeDesks, freeForReview, merged, LEAD_STOPS, pick, nameOf, endJob };
