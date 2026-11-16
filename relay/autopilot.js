// Autopilot: the relay runs tickets from Ready to merged by itself, one rung of article 5 that the
// person turns on and off with one switch. See docs/manual/roles.html#autopilot.
//
// While it is on, every RELAY_AUTOPILOT_TICK_MS (20 seconds):
//   1. Each task's PR is read with gh pr view, and relay/autopilot-plan.js says what to do with it:
//      merge it, mark its task done, tell its Dev to merge main for a conflict, hand it to the
//      person (Waiting on you, with the reason), or wait. Before a merge, relay/merge-hold.js asks whether
//      the PR holds all its Dev's work: a Dev still at work waits, and one idle or gone with work in its
//      checkout that is not pushed goes to the person.
//   2. While fewer than RELAY_AUTOPILOT_AT_ONCE tasks (1) are open, it starts the next Ready ticket a
//      person approved, in Board order. With "only" set, just those tickets. When every desk is taken, it
//      frees one of its own sessions the Lead may stop (freeADesk). If none is, it waits for a desk and
//      tries again on its next look. It turns itself off only for a start that fails for another reason.
// Reviews: relay/reviews.js starts the first review and, while Autopilot is on, a follow-up after each
// push. Each review asks the reviewer for a verdict, merge or fix, which it gives with
// ticket.js verdict before it posts. A verdict counts once its review is posted, and covers only the
// commit the reviewer read. After MAX_ROUNDS verdicts that still say fix, the person decides.
// It merges at most MAX_MERGES_A_DAY PRs a day, and never one that changes CLAUDE.md or the
// constitution. After a merge it pulls main into the relay's folder (relay/update.js), which
// restarts the relay once no session is busy if relay files changed. While that update waits, Autopilot
// goes on: it stops only once the restart begins.
// A task whose Dev or reviewer is stuck (stalled below) goes to Waiting on you, its session left running
// at its desk, and comes back to Autopilot by itself once that session moves again. One that nothing
// moved comes back once something does: a PR, a hook from its Dev, or a posted verdict (movedAgain).
//
// What it keeps (the switch, the verdicts, the day's merges, and one run record for each ticket it starts,
// relay/autopilot-runs.js) is in RELAY_AUTOPILOT_FILE, so a restart keeps it.
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const tickets = require('./tickets.js');
const reviews = require('./reviews.js');
const prComments = require('./pr-comments.js');
const update = require('./update.js');
const delivery = require('./delivery.js');
const { claim } = require('./lockfile.js');
const plan = require('./autopilot-plan.js');
const floor = require('./floor.js');
const chat = require('./chat.js');
const { livenessOf } = require('./liveness.js');
const nudge = require('./nudge.js');
const { holdOf } = require('./merge-hold.js');
const runs = require('./autopilot-runs.js');
const pushHold = require('./push-hold.js');
const pipeline = require('./pipeline.js');

const FILE = state.file('autopilot.json', 'RELAY_AUTOPILOT_FILE');
const GH = process.env.GH_CMD || 'gh';
const config = require('./config.js');
const AT_ONCE = () => config.get('autopilotAtOnce');
const MAX_ROUNDS = () => config.get('autopilotRounds'), MAX_MERGES_A_DAY = () => config.get('autopilotMerges');
const NOTES_KEPT = 30;
const BY = 'Autopilot';

const ownsFile = claim(FILE);
let store = {};
if (ownsFile) try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') {
    const aside = FILE + '.unreadable-' + Date.now();
    let kept = true;
    try { fs.renameSync(FILE, aside); } catch (e2) { kept = false; }
    if (kept) console.error('Could not read ' + FILE + '. Kept it as ' + aside);
  }
}
function save() {
  if (!ownsFile) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Could not save Autopilot to ' + FILE + ': ' + e.message); }
}
const chOf = (channel) => store[channel] || (store[channel] = { on: false, only: null, day: null, merged: 0, prs: {}, notes: [] });
const isOn = (channel) => !!(store[channel] && store[channel].on);
const recOf = (channel, pr) => { const c = chOf(channel); return c.prs[pr] || (c.prs[pr] = { verdicts: [], conflictAt: null, handedOver: null }); };
const today = () => new Date().toISOString().slice(0, 10);
const runsOf = (channel) => { const c = chOf(channel); return c.runs || (c.runs = {}); };
const runOf = (channel, task) => (task && runsOf(channel)[task.id]) || null;
function track(channel, task) {
  const run = runOf(channel, task);
  if (!run) return null;
  const rec = task.pr && chOf(channel).prs[task.pr];
  let changed = runs.fromTask(run, task, !!(rec && rec.mergedHead));
  for (const v of rec ? rec.verdicts : []) if (postOf(channel, v)) changed = runs.verdict(run, v) || changed;
  if (changed) save();
  return run;
}
function handRun(channel, task, reason) {
  const run = runOf(channel, task);
  if (run && runs.hand(run, reason, Date.now())) save();
}
const number = (pr) => '#' + pr.split('/').pop();
let ctx = null;
function note(channel, text) {
  const c = chOf(channel);
  c.notes.push({ at: new Date().toISOString(), text });
  c.notes = c.notes.slice(-NOTES_KEPT);
  save();
  if (ctx) ctx.log('Autopilot: ' + text);
}

function gh(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(GH, args, { cwd, timeout: 30000, env: Object.assign({}, process.env, { GH_PROMPT_DISABLED: '1' }) }, (err, out, errOut) => {
      if (err) reject(new Error(String(errOut || err.message).trim().split('\n')[0])); else resolve(out);
    });
  });
}
const git = (cwd, args) => new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 10000 }, (e, out) => (e ? reject(e) : resolve(out.trim()))));

const verdictAsk = () => ' Mark each finding blocking or not: only a bug, or something that does not do what the PR says, blocks. Before you post, run node ' +
  JSON.stringify(tickets.CLI) + ' verdict merge if nothing blocks, or verdict fix if something does. Then post.';
reviews.useAutopilot({ follows: isOn, ask: () => verdictAsk(),
  since: (channel, pr) => { const r = isOn(channel) && chOf(channel).prs[pr]; const v = r && postedOf(r).slice(-1)[0]; return v ? v.commit : null; } });

async function giveVerdict(channel, agent, kind) {
  const pr = agent.reviewOf || agent.pr;
  if (!pr) return [409, { ok: false, error: 'no_pr', message: 'Only a reviewer of a PR gives a verdict.' }];
  if (!['merge', 'fix'].includes(kind)) return [400, { ok: false, error: 'bad_verdict', message: 'A verdict is merge or fix.' }];
  if (agent.posted) return [409, { ok: false, error: 'posted', message: 'Your review is posted, so its verdict is kept as it was.' }];
  let commit;
  try { commit = await git(agent.cwd, ['rev-parse', 'HEAD']); } catch (e) { return [409, { ok: false, error: 'no_commit', message: 'Could not read the commit of this checkout: ' + e.message }]; }
  const rec = recOf(channel, pr);
  const mine = (v) => v.sessionId === agent.sessionId && !v.posted;
  rec.verdicts = rec.verdicts.filter((v) => !mine(v));
  const verdict = { kind, commit, sessionId: agent.sessionId, at: new Date().toISOString(), posted: (agent.posted && agent.posted.url) || null };
  const since = rec.handedOver && handedHeadOf(channel, rec);
  if (since && since !== commit) verdict.newWork = await git(agent.cwd, ['rev-list', '--first-parent', '--no-merges', '--count', since + '..' + commit]).then((n) => Number(n) > 0, () => false);
  rec.verdicts.push(verdict);
  save();
  note(channel, 'The review of PR ' + number(pr) + ' at ' + commit.slice(0, 7) + ' says ' + kind + '.');
  return [200, { ok: true, pr, kind, commit, message: 'Verdict kept: ' + kind + ' for ' + commit.slice(0, 7) + '. Now post your review.' }];
}
const unposted = (rec, t) => rec && rec.verdicts.find((x) => x.sessionId === t.sessionId && !x.posted);
terminal.onReviewPosted((channel, t) => {
  const v = unposted(chOf(channel).prs[t.reviewOf], t);
  if (v) { v.posted = t.posted.url; save(); holdPushes(channel); prComments.reviewPosted(channel, t.reviewOf, t.posted.url); }
});
terminal.onReviewDone((channel, t) => {
  const rec = chOf(channel).prs[t.reviewOf];
  if (rec && rec.verdicts.some((x) => x.sessionId === t.sessionId && x.posted)) return;
  if (isOn(channel) && t.reviewOf) note(channel, 'The review of PR ' + number(t.reviewOf) + ' was posted without a verdict, so it does not count. The next push brings another review.');
});
const looking = new Set();
const CLOCK_SKEW_MS = 60 * 1000;
terminal.onReviewTurnEnd(async (channel, t) => {
  const rec = chOf(channel).prs[t.reviewOf], v = unposted(rec, t);
  const m = String(t.reviewOf).match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
  if (!v || !m || looking.has(t.sessionId)) return;
  looking.add(t.sessionId);
  try {
    const login = JSON.parse(await gh(['api', 'user'])).login || null;
    const comments = JSON.parse(await gh(['api', '--paginate', '--slurp', 'repos/' + m[1] + '/issues/' + m[2] + '/comments?per_page=100'])).flat();
    const since = Math.min(Date.parse(t.startedAt) || Infinity, Date.parse(v.at) || Infinity) - CLOCK_SKEW_MS;
    const url = plan.reviewPostFor(comments, { login, since, commit: v.commit });
    if (!url || v.posted || rec.verdicts.some((x) => x.posted === url)) return;
    v.posted = url; save(); holdPushes(channel);
    prComments.reviewPosted(channel, t.reviewOf, url);
    note(channel, 'The review of PR ' + number(t.reviewOf) + ' at ' + v.commit.slice(0, 7) + ' is on the PR, though its post was not seen, so its verdict counts: ' + url);
  } catch (e) {
    console.error('Could not look on ' + t.reviewOf + ' for its review: ' + e.message);
  } finally { looking.delete(t.sessionId); }
});
const postedOf = (rec) => rec.verdicts.filter((v) => v.posted);
const latest = (rec) => postedOf(rec).slice(-1)[0] || rec.verdicts.slice(-1)[0] || null;
const REVIEW_WINDOW = 15 * 60 * 1000;
const REVIEW_PART = /#(pullrequestreview-|discussion_r)\d+$/;
function postOf(channel, v) {
  if (v.posted) return v.posted;
  const t = terminal.all(channel).find((x) => x.sessionId === v.sessionId && x.posted);
  return t ? t.posted.url : null;
}
prComments.useVerdicts((channel, pr, items) => {
  const r = store[channel] && store[channel].prs[pr];
  if (!r || !items.length) return null;
  const covers = (v, item) => {
    const post = postOf(channel, v);
    if (!post) return false;
    if (post === item.url) return true;
    const given = Date.parse(v.at);
    return post === pr && REVIEW_PART.test(item.url) && item.at !== null && item.at >= given - 5000 && item.at - given <= REVIEW_WINDOW;
  };
  const kindOf = (item) => { const v = r.verdicts.slice().reverse().find((x) => covers(x, item)); return v ? v.kind : null; };
  return items.every((item) => kindOf(item) === 'merge') ? 'merge' : null;
});
prComments.useHolds((channel, task, url) => {
  if (!mineTask(task) || task.state === 'done' || !task.pr) return;
  const rec = recOf(channel, task.pr);
  if (rec.handedOver) return;
  const v = rec.verdicts.filter((x) => postOf(channel, x)).pop();
  handOver(channel, task, rec, 'Its Dev says a finding the review marked non-blocking is a bug: ' + url, 'dev-says-bug', v ? v.commit : null);
});
prComments.useHandOvers((channel, task) => !!deskOf(channel, task).handedOver);
tickets.onFiled((channel, ticket, agent, at) => {
  if (!ticket || ticket.kind !== 'bug' || !store[channel] || !store[channel].runs) return;
  const text = String(ticket.title || '') + '\n' + String(ticket.body || '');
  let changed = false;
  for (const run of Object.values(store[channel].runs)) {
    if (run.mergedAt && run.ticket !== ticket.id && !(agent && agent.task === run.task) && runs.names(text, run)) changed = runs.fixAfter(run, ticket.id, at || Date.now()) || changed;
  }
  if (changed) save();
});
const roundsOf = (rec) => Math.max(0, postedOf(rec).length - (rec.roundsFrom || 0));

const mineTask = (task) => task.by === BY;
const handedBack = (task, rec) => (task.history || []).some((h) => h.type === 'moved' && h.by === 'you' && h.at > rec.handedOverAt);
const ANSWERED_BY_REVIEW = ['dev-says-bug', 'ci-red'];
const OLD_REASONS = [[/^Its Dev says a finding the review marked non-blocking is a bug/, 'dev-says-bug'], [/^CI failed on the reviewed commit/, 'ci-red']];
const handedReasonOf = (rec) => rec.handedReason || (OLD_REASONS.find(([text]) => text.test(rec.handedOver || '')) || [])[1] || null;
function handedHeadOf(channel, rec) {
  if (rec.handedOverHead) return rec.handedOverHead;
  const before = rec.verdicts.filter((v) => Date.parse(v.at) <= Date.parse(rec.handedOverAt) && postOf(channel, v)).pop();
  return before ? before.commit : null;
}
function answeredByReview(channel, rec) {
  const reason = handedReasonOf(rec);
  if (!ANSWERED_BY_REVIEW.includes(reason)) return null;
  const v = rec.verdicts.filter((x) => postOf(channel, x)).pop(), head = handedHeadOf(channel, rec);
  if (!v || v.kind !== 'merge' || !v.commit || !head || v.commit === head || Date.parse(v.at) <= Date.parse(rec.handedOverAt)) return null;
  return reason === 'dev-says-bug' && !v.newWork ? null : v;
}
const dropHandOver = (rec) => { rec.handedOver = null; rec.handedOverAt = null; rec.handedOverHead = null; rec.handedReason = null; };
function held(channel, task) {
  const rec = task.pr && chOf(channel).prs[task.pr];
  if (!rec || !rec.handedOver) return task.state === 'waiting_on_you';
  if (handedBack(task, rec)) { dropHandOver(rec); rec.roundsFrom = postedOf(rec).length; save(); return false; }
  const v = answeredByReview(channel, rec);
  if (!v) return true;
  dropHandOver(rec); rec.roundsFrom = postedOf(rec).length; save();
  const why = 'a review of ' + v.commit.slice(0, 7) + ', a newer commit than the hand-over, says merge';
  if (task.state === 'waiting_on_you') tasks.setState(channel, task, 'in_review', BY, 'Autopilot: ' + why + ', so the task is back.');
  note(channel, (task.ticket || 'Task ' + task.id) + ' is back from Waiting on you: ' + why + '.');
  return false;
}
const open = (channel, task) => mineTask(task) && task.state !== 'done' && !held(channel, task);
let ticking = false, starting = false;
async function tick() {
  if (ticking || !ctx) return;
  ticking = true;
  try {
    for (const channel of Object.keys(store)) if (isOn(channel)) await look(channel);
  } catch (e) { if (ctx) ctx.log('Autopilot: ' + e.message); } finally { ticking = false; }
}
async function look(channel) {
  const c = chOf(channel);
  if (c.day !== today()) { c.day = today(); c.merged = 0; runs.prune(runsOf(channel), Date.now()); save(); }
  if (update.restarting()) return;
  movedAgain(channel);
  holdPushes(channel);
  for (const task of tasks.list(channel).filter(mineTask)) track(channel, task);
  for (const task of tasks.list(channel).filter((t) => t.pr && mineTask(t) && t.state !== 'done')) {
    if (held(channel, task)) await mergedYet(channel, task); else await lookAt(channel, task);
  }
  stalled(channel);
  await maybeStart(channel);
}
async function lookAt(channel, task) {
  const rec = recOf(channel, task.pr);
  let pr = null, files = null;
  try { pr = JSON.parse(await gh(['pr', 'view', task.pr, '--json', 'state,headRefOid,mergeStateStatus,statusCheckRollup'], task.repo)); } catch (e) { rec.why = 'gh pr view failed: ' + e.message; return; }
  if (pr.state === 'OPEN' && rec.mergedHead === pr.headRefOid) { rec.why = 'Merged, but GitHub still shows the PR open.'; rec.act = 'wait'; return; }
  if (pr.state === 'OPEN') {
    const m = task.pr.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
    try { files = JSON.parse(await gh(['api', '--paginate', '--slurp', 'repos/' + m[1] + '/pulls/' + m[2] + '/files?per_page=100'], task.repo)).flat().flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean); } catch (e) { rec.why = 'Could not list the PR\'s files: ' + e.message; return; }
  }
  const v = latest(rec);
  let d = plan.forPr(pr, files, v, roundsOf(rec), MAX_ROUNDS());
  const hold = d.act === 'merge' ? holdOf(task, terminal.find(channel, task.owner && task.owner.terminal), Date.now()) : null;
  if (hold) d = hold;
  rec.why = d.why; rec.act = d.act;
  if (d.act === 'done') markDone(channel, task);
  else if (d.act === 'merge') {
    const c = chOf(channel);
    if (c.merged >= MAX_MERGES_A_DAY()) { rec.why = 'Ready to merge, but Autopilot has merged ' + MAX_MERGES_A_DAY() + ' PRs today, its limit. Merge it yourself, or wait for tomorrow.'; return; }
    if (!(await prComments.checkNow(channel, task))) { rec.why = 'Ready to merge, but its comments could not be read, so it waits for the next look.'; return; }
    if (rec.handedOver) return;
    if (task.reviews && task.reviews.pending) { rec.why = 'New review news came in as it was about to merge, so its Dev hears it first.'; rec.act = 'wait'; return; }
    try { await gh(['pr', 'merge', task.pr, '--merge', '--match-head-commit', pr.headRefOid], task.repo); } catch (e) {
      const now = await gh(['pr', 'view', task.pr, '--json', 'state,headRefOid'], task.repo).then(JSON.parse, () => null);
      if (now && now.state === 'MERGED') { counted(channel, task, rec, pr.headRefOid); note(channel, 'Merged PR ' + number(task.pr) + ', though gh said: ' + e.message); return; }
      if (now && now.headRefOid !== pr.headRefOid) { rec.why = 'New commits arrived as it was about to merge, so they get a review first.'; return; }
      handOver(channel, task, rec, 'gh pr merge failed: ' + e.message, 'merge-failed', pr.headRefOid); return;
    }
    counted(channel, task, rec, pr.headRefOid);
    note(channel, 'Merged PR ' + number(task.pr) + ' (' + (task.ticket || task.title) + '): ' + d.why);
  } else if (d.act === 'conflict') {
    if (rec.conflictAt === pr.headRefOid) return;
    rec.conflictAt = pr.headRefOid; save();
    delivery.save(channel, { key: 'autopilot-conflict ' + task.pr, terminal: task.owner && task.owner.terminal, sessionId: task.owner && task.owner.sessionId, expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      text: 'Your PR ' + task.pr + ' was reviewed, but it conflicts with main. Merge origin/main into your branch with a merge commit, keep both sides of each conflict, run npm test, and push only that merge, not fixes for the review\'s non-blocking findings. A follow-up review checks how you resolved it.' });
    note(channel, 'PR ' + number(task.pr) + ' conflicts with main, so its Dev was asked to merge main.');
  } else if (d.act === 'person') handOver(channel, task, rec, d.why, d.reason, (v && v.commit) || pr.headRefOid);
}
function counted(channel, task, rec, head) {
  const c = chOf(channel), run = runOf(channel, task);
  rec.mergedHead = head; c.merged++;
  if (run) runs.merged(run, Date.now(), BY);
  save();
}
function markDone(channel, task) {
  tasks.noteMerged(task);
  const run = track(channel, task), rec = task.pr && chOf(channel).prs[task.pr];
  if (run && runs.merged(run, Date.now(), rec && rec.mergedHead ? BY : 'you')) save();
  tasks.setState(channel, task, 'done', BY, 'PR ' + number(task.pr) + ' merged.');
  const w = terminal.find(channel, task.owner && task.owner.terminal);
  if (w && !w.exited && w.state !== 'working' && w.state !== 'waiting') terminal.stop(w);
  note(channel, (task.ticket || 'Task ' + task.id) + ' is done: PR ' + number(task.pr) + ' merged.');
  pullMain(channel);
}
async function mergedYet(channel, task) {
  let pr;
  try { pr = JSON.parse(await gh(['pr', 'view', task.pr, '--json', 'state'], task.repo)); } catch (e) { return; }
  if (pr.state === 'MERGED') markDone(channel, task);
}
function handOver(channel, task, rec, why, reason, head) {
  rec.handedOver = why; rec.handedOverAt = new Date().toISOString(); rec.handedReason = reason; rec.handedOverHead = head || null; save();
  handRun(channel, task, reason);
  tasks.setState(channel, task, 'waiting_on_you', BY, 'Autopilot: ' + why);
  note(channel, (task.ticket || 'Task ' + task.id) + ' waits on you: ' + why);
}
function pullMain(channel) {
  update.run(ctx).then(([status, out]) => { if (status >= 400 || out.restart === false) note(channel, (status >= 400 ? 'Could not pull main into the relay\'s folder: ' : '') + out.message); })
    .catch((e) => note(channel, 'Could not pull main into the relay\'s folder: ' + e.message));
}
async function maybeStart(channel) {
  const c = chOf(channel);
  if (starting || tasks.busy() || update.restarting() || tasks.list(channel).filter((t) => open(channel, t)).length >= AT_ONCE()) return;
  if (c.merged >= MAX_MERGES_A_DAY()) return;
  const held = tickets.heldWhy(channel);
  if (held) { c.idle = held; return; }
  starting = true;
  try {
    const all = await tickets.listAll(channel);
    const next = plan.nextTicket(all, (t) => !!tasks.ofTicket(channel, t), c.only);
    if (!next) { c.idle = c.only ? plan.whyNoneAllowed(all, (t) => !!tasks.ofTicket(channel, t), c.only) : 'Nothing in Ready that a person approved and that is not blocked, on hold, replaced or waiting on a design ticket.'; return; }
    const waitWip = (message) => { c.idle = 'Waiting for room under the WIP limit: ' + message; };
    if (tasks.building(channel) >= tasks.wipLimit()) { waitWip(tasks.building(channel) + ' tasks are being built, and the limit is ' + tasks.wipLimit() + '.'); return; }
    const wasWaiting = /^Waiting for a free desk/.test(c.idle || '');
    c.idle = null;
    let [status, out] = await tickets.startBy(channel, next, BY, ctx);
    let why = null;
    if (out.error === 'full') {
      why = await freeADesk(channel);
      if (!why) { [status, out] = await tickets.startBy(channel, next, BY, ctx); why = 'a desk was freed, but another session took it first'; }
    }
    if (out.error === 'wip_limit') { waitWip(out.message); return; }
    if (out.error === 'full') {
      const taken = terminal.all(channel).filter((t) => !t.exited).length;
      c.idle = 'Waiting for a free desk: ' + taken + ' of ' + terminal.DESKS + ' taken, ' + why + '.';
      if (!wasWaiting) note(channel, c.idle + ' ' + next.id + ' starts once one is free.');
      return;
    }
    if (out.task) runsOf(channel)[out.task.id] = runs.start({ task: out.task.id, ticket: next.id, kind: next.kind, at: out.task.createdAt || Date.now() });
    if (status >= 400) { note(channel, 'Could not start ' + next.id + ': ' + out.message); c.on = false; save(); terminal.rebriefLead(channel); note(channel, 'Autopilot turned itself off. Turn it on again once that is fixed.'); return; }
    note(channel, 'Started ' + next.id + ': ' + next.title);
  } finally { starting = false; }
}

const STOP_WAIT = 5000;
function itsOwn(channel, t, task) {
  if (t.reviewOf) return tasks.list(channel).some((x) => mineTask(x) && x.pr === t.reviewOf);
  return !!task && mineTask(task);
}
async function ended(list) {
  for (const until = Date.now() + STOP_WAIT; !list.some((t) => t.exited) && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
  return list.some((t) => t.exited);
}
async function freeADesk(channel) {
  const ending = terminal.all(channel).filter((t) => !t.exited && t.stopped);
  if (ending.length && await ended(ending)) return null;
  const stopped = floor.freeDesks(channel, 1, Date.now(), BY, (t, task) => itsOwn(channel, t, task));
  for (const s of stopped) note(channel, 'Stopped ' + s.name + ' (' + s.role + (s.task ? ', task ' + s.task : '') + ') to free a desk: ' + s.why + '.');
  if (!stopped.length) return ending.length ? 'a session that was ending did not end within ' + STOP_WAIT / 1000 + ' seconds, and none safe to stop' : 'none safe to stop';
  if (await ended(stopped.map((s) => s.t))) return null;
  return 'Autopilot stopped ' + stopped[0].name + ' to free a desk, but it did not end within ' + STOP_WAIT / 1000 + ' seconds';
}

const STALL_MS = () => config.get('autopilotStallMinutes') * 60 * 1000;
function stuckOn(channel, task, dev) {
  const found = [], now = Date.now();
  const asked = (t) => 'at a question' + (t.message ? ' (' + String(t.message).slice(0, 120) + ')' : '');
  const held = (t, role) => {
    const lv = livenessOf(t, now);
    if (lv.state === 'waiting') return { t, role, since: lv.since || now, why: asked(t) };
    if (lv.state === 'stuck' && lv.cause === 'silent') return { t, role, since: lv.since, why: 'has sent no hook and printed nothing', silent: true };
    return null;
  };
  const devHeld = dev && held(dev, 'Dev');
  if (devHeld) found.push(devHeld);
  for (const r of task.pr ? terminal.all(channel).filter((x) => x.reviewOf === task.pr && !x.exited && !x.stopped) : []) {
    const h = held(r, 'reviewer');
    if (h) found.push(h);
    else if (!r.talked && !(r.spoke && !r.hooked) && !update.restarting()) found.push({ t: r, role: 'reviewer', since: Date.parse(r.startedAt) || Date.now(), why: 'has not started on its brief', brief: true });
  }
  return found.filter((x) => Date.now() - x.since >= STALL_MS()).sort((a, b) => a.since - b.since)[0] || null;
}
function stalled(channel) {
  for (const task of tasks.list(channel).filter((t) => open(channel, t))) {
    const rec = task.pr ? recOf(channel, task.pr) : null;
    const dev = terminal.find(channel, task.owner && task.owner.terminal);
    const on = stuckOn(channel, task, dev);
    if (on) { stuckSince.delete(channel + ' ' + task.id); park(channel, task, rec, on); continue; }
    const devBusy = dev && ['working', 'quiet', 'waiting', 'job'].includes(livenessOf(dev, Date.now()).state);
    const reviewing = task.pr && terminal.all(channel).some((t) => t.reviewOf === task.pr && livenessOf(t, Date.now()).state !== 'gone');
    const waitsOnCi = rec && /CI|GitHub says|PRs today/.test(rec.why || '');
    const stuck = !devBusy && !reviewing && !waitsOnCi;
    const key = channel + ' ' + task.id;
    if (!stuck) { stuckSince.delete(key); continue; }
    if (!stuckSince.has(key)) { stuckSince.set(key, Date.now()); continue; }
    if (Date.now() - stuckSince.get(key) < STALL_MS()) continue;
    if (nudge.first(channel, chOf(channel), task, dev, STALL_MS(), save)) { stuckSince.set(key, Date.now()); note(channel, (task.ticket || 'Task ' + task.id) + ': Autopilot nudged its Dev, which stopped without a PR.'); continue; }
    stuckSince.delete(key);
    const why = 'Nothing moved it for ' + Math.round(STALL_MS() / 60000) + ' minutes' + (rec && rec.why ? ' (' + rec.why + ')' : task.pr ? '' : ': ' + nudge.noPrWhy(channel, chOf(channel), task, dev, Date.now())) + '.';
    const c = chOf(channel);
    (c.stuck || (c.stuck = {}))[task.id] = { stall: true, sessionId: dev ? dev.sessionId : null, from: task.state, pr: task.pr || null, at: new Date().toISOString() };
    if (rec) handOver(channel, task, rec, why, 'stalled');
    else { handRun(channel, task, 'stalled'); tasks.setState(channel, task, 'waiting_on_you', BY, 'Autopilot: ' + why); save(); note(channel, (task.ticket || 'Task ' + task.id) + ' waits on you: ' + why); }
  }
}
const stuckSince = new Map();
function park(channel, task, rec, on) {
  const name = chat.nameOf(on.t), mins = Math.round((Date.now() - on.since) / 60000);
  const why = 'Its ' + on.role + ' ' + name + ' ' + on.why + ' for ' + mins + ' minutes. The session is still open at its desk' +
    (on.brief ? ': look at it there.' : on.silent ? ': look at it there, and the task goes back to ' + (task.state === 'building' ? 'Building' : 'where it was') + ' once it moves again.' : ': answer it there, and the task goes back to ' + (task.state === 'building' ? 'Building' : 'where it was') + ' once it moves again.' +
      ' A relay restart keeps it at its question, but if the relay is stopped first, its question is gone: tell it to go on, or move the card.');
  const c = chOf(channel);
  (c.stuck || (c.stuck = {}))[task.id] = { sessionId: on.t.sessionId, from: task.state, brief: !!on.brief, at: new Date().toISOString() };
  const reason = on.brief ? 'reviewer-not-started' : on.silent ? 'silent' : 'question';
  if (rec) handOver(channel, task, rec, why, reason);
  else { handRun(channel, task, reason); tasks.setState(channel, task, 'waiting_on_you', BY, 'Autopilot: ' + why); save(); note(channel, (task.ticket || 'Task ' + task.id) + ' waits on you: ' + why); }
}
function movedAgain(channel) {
  const c = chOf(channel);
  for (const [id, s] of Object.entries(c.stuck || {})) {
    const task = tasks.list(channel).find((x) => x.id === id);
    const theirs = task && (task.history || []).some((h) => h.type === 'moved' && h.by === 'you' && h.at > s.at);
    if (!task || task.state !== 'waiting_on_you' || theirs) { delete c.stuck[id]; save(); continue; }
    const why = s.stall ? movedSinceStall(channel, task, s) : stuckMoved(channel, s);
    if (!why) continue;
    delete c.stuck[id];
    const rec = task.pr && c.prs[task.pr];
    if (rec) dropHandOver(rec);
    save();
    tasks.setState(channel, task, s.from, BY, 'Autopilot: ' + why + ', so the task is back.');
    note(channel, (task.ticket || 'Task ' + task.id) + ' is back from Waiting on you: ' + why + '.');
  }
}
const hookedSince = (t, at) => !!t && !t.exited && t.state !== 'waiting' && (t.movedAt || 0) > Date.parse(at);
function stuckMoved(channel, s) {
  const t = terminal.all(channel).find((x) => x.sessionId === s.sessionId && !x.exited);
  return hookedSince(t, s.at) ? chat.nameOf(t) + ' moved again' : null;
}
function movedSinceStall(channel, task, s) {
  if (task.pr && !s.pr) return 'its Dev opened PR ' + number(task.pr);
  const dev = terminal.find(channel, task.owner && task.owner.terminal);
  if (hookedSince(dev, s.at)) return 'its Dev ' + chat.nameOf(dev) + ' moved again';
  const rec = task.pr && chOf(channel).prs[task.pr];
  const v = rec && rec.verdicts.find((x) => Date.parse(x.at) > Date.parse(s.at) && postOf(channel, x));
  return v ? 'a review of PR ' + number(task.pr) + ' was posted with the verdict ' + v.kind : null;
}

function view(channel) {
  const c = chOf(channel);
  const prs = tasks.list(channel).filter((t) => mineTask(t) && t.pr && c.prs[t.pr]).map((t) => {
    const r = c.prs[t.pr];
    return { pr: t.pr, ticket: t.ticket, task: t.id, state: t.state, rounds: roundsOf(r), verdict: (latest(r) || {}).kind || null, act: r.act || null, why: r.handedOver || r.why || null };
  });
  const all = Object.values(c.runs || {}).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  const record = { today: runs.dayOf(all, today()), keptDays: runs.KEEP_DAYS, recent: all.slice(-10).map(runs.viewOf) };
  return { ok: true, on: !!c.on, only: c.only, atOnce: AT_ONCE(), maxRounds: MAX_ROUNDS(), maxMerges: MAX_MERGES_A_DAY(), mergedToday: c.day === today() ? c.merged : 0, idle: c.idle || null, paused: update.restarting(), prs, notes: c.notes.slice(-10), runs: record };
}
async function handle(req, res, channel, rest, rctx) {
  if (!/^\/autopilot(\/|$)/.test(rest)) return false;
  const deny = terminal.localOnly(req, rctx.port);
  if (deny) { rctx.problem(res, 403, 'local_only', deny); return true; }
  if (!terminal.ENABLED) { rctx.problem(res, 404, 'terminal_off', 'Autopilot needs the terminal. Start the relay with npm run office.'); return true; }
  if (rest === '/autopilot/verdict' && req.method === 'POST') {
    if (!rctx.agent) { rctx.problem(res, 403, 'reviewers_only', 'A verdict comes from a reviewer session.'); return true; }
    const body = await rctx.readJson(req);
    const [status, out] = await giveVerdict(channel, rctx.agent, String(body.kind || ''));
    rctx.send(res, status, out); return true;
  }
  if (rest !== '/autopilot' || !['GET', 'POST'].includes(req.method)) { rctx.problem(res, 404, 'not_found', 'Unknown Autopilot route.'); return true; }
  if (rctx.agent) { rctx.problem(res, 401, 'unauthorized', 'Only the person turns Autopilot on or off.'); return true; }
  if (req.method === 'POST') {
    const body = await rctx.readJson(req), c = chOf(channel);
    if (body.on !== undefined && typeof body.on !== 'boolean') { rctx.problem(res, 400, 'bad_param', '"on" is true or false.'); return true; }
    if (body.only !== undefined) {
      const only = Array.isArray(body.only) ? body.only : String(body.only || '').split(/[\s,]+/);
      const items = only.map((x) => String(x).trim()).filter(Boolean).map((x) => (/^t-\d{1,6}$/i.test(x) ? x.toUpperCase() : x.toLowerCase()));
      if (items.some((x) => !/^T-\d{1,6}$/.test(x) && !/^[a-z][a-z0-9-]{0,23}$/.test(x))) { rctx.problem(res, 400, 'bad_param', '"only" lists ticket ids like T-12 and labels like flaky.'); return true; }
      c.only = items.length ? [...new Set(items)] : null;
    }
    if (body.on !== undefined && body.on !== c.on) {
      c.on = body.on;
      c.idle = null;
      terminal.rebriefLead(channel);
      note(channel, 'Turned ' + (c.on ? 'on' : 'off') + ' by the person' + (c.on && c.only ? ', for ' + c.only.join(', ') + ' only' : '') + '.');
    }
    if (!c.on) c.only = null;
    save();
    if (c.on) setImmediate(tick);
  }
  rctx.send(res, 200, view(channel));
  return true;
}

function holdPushes(channel, only) {
  for (const task of tasks.list(channel)) {
    if (!task.pr || !task.worktree || (only && task !== only)) continue;
    try { pushHold.sync(task, verdictOf(channel, task.pr), pipeline.of(task.pr)); } catch (e) { if (ctx) ctx.log('Could not mark the push hold of ' + task.worktree + ': ' + e.message); }
  }
}
tasks.events.on('state', (channel, task) => holdPushes(channel, task));
tasks.events.on('pr', (channel, task) => holdPushes(channel, task));

function begin(relayCtx) {
  ctx = relayCtx;
  for (const channel of tasks.channels()) holdPushes(channel);
  config.every('autopilotTickSeconds', tick);
}

function deskOf(channel, task) {
  const r = task && task.pr && store[channel] && store[channel].prs[task.pr];
  const v = r ? latest(r) : null;
  const handed = r && r.handedOver && !handedBack(task, r) ? r.handedOver : null;
  return { on: isOn(channel), mine: !!task && mineTask(task), act: (r && r.act) || null, why: handed || (r && r.why) || null, verdict: v && v.posted ? v.kind : null, verdictAt: v && v.posted ? v.commit || null : null, handedOver: handed };
}

const LEAD_KEEPS = 'stop a session the Floor calls safe to stop, and move a task to Done once its PR has merged';
function leadRefusal(channel, to, merged) {
  if (!isOn(channel) || (to === 'done' && merged)) return null;
  return [403, { ok: false, error: 'autopilot', message: 'Autopilot is on, so only the relay starts and merges work. The Lead keeps two rights: ' + LEAD_KEEPS + '. ' +
    (to === 'done' ? 'The relay has not seen this PR merge, so it stays where it is.' : 'Leave this to Autopilot, or tell the person.') }];
}

function verdictOf(channel, pr) {
  const r = store[channel] && store[channel].prs[pr], v = r && latest(r);
  return v ? { kind: v.kind, commit: v.commit, posted: postOf(channel, v) } : null;
}
const movesIt = (channel, task) => isOn(channel) && mineTask(task);

module.exports = { handle, begin, isOn, deskOf, leadRefusal, LEAD_KEEPS, verdictOf, movesIt };
