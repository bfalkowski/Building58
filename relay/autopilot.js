// Autopilot: the relay runs tickets from Ready to merged by itself, one rung of article 5 that the
// person turns on and off with one switch. See docs/manual/roles.html#autopilot.
//
// While it is on, every RELAY_AUTOPILOT_TICK_MS (20 seconds):
//   1. Each task's PR is read with gh pr view, and relay/autopilot-plan.js says what to do with it:
//      merge it, mark its task done, tell its Dev to merge main for a conflict (once more if a turn ends at
//      the same head, then the person decides: askToMergeMain), bring back its Dev when
//      a fix or a conflict needs one and none runs (bringBack), hand it to the person (Waiting on you,
//      with the reason), or wait. Before a merge, relay/merge-hold.js asks whether
//      the PR holds all its Dev's work: a Dev still at work waits, and one idle or gone with work in its
//      checkout that is not pushed goes to the person. A PR handed over only because it changes a file
//      only a person merges is still read at each look (follow): its reason follows its review, CI and
//      GitHub, and says ready for your merge when the same merge test passes. It is never merged here.
//   2. While fewer than RELAY_AUTOPILOT_AT_ONCE tasks (1) are open, it starts the next Ready ticket a
//      person approved, in Board order. With "only" set, just those tickets. While the latest CI run on the
//      ticket's base branch failed (relay/main-ci.js), it starts none, and its idle line says main is red. When every desk is taken, it
//      frees one of its own sessions the Lead may stop (freeADesk). If none is, it waits for a desk and
//      tries again on its next look. It turns itself off only for a start that fails for another reason.
// Reviews: relay/reviews.js starts the first review and, while Autopilot is on, a follow-up after each
// push. A review that waits for a desk goes before a start, and is not a stall: it frees a desk by itself,
// and the PR's line says whom it stopped, or that it may stop none (deskLine). Each review asks the
// reviewer for a verdict, merge or fix, which it gives with ticket.js verdict before it posts. A verdict
// counts once its review is posted, and covers only the commit the reviewer read. After MAX_ROUNDS verdicts that still say fix, the person decides.
// Fix it (POST /autopilot/fix, decideFix): the person, or the Lead under its merge rung, decides a finding a merge
// review marked non-blocking must be fixed. That is a fix verdict on the reviewed commit, which lifts the push hold.
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
const mainCi = require('./main-ci.js');
const { redMain } = require('./needs-you-plan.js');
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
const { oneLine } = require('./clean.js');

const FILE = state.file('autopilot.json', 'RELAY_AUTOPILOT_FILE');
const ghDoor = require('./gh.js');
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
  if (run) runs.hand(run, reason, Date.now());
  nudge.forget(channel, chOf(channel), task);
  save();
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

const gh = (args, cwd) => ghDoor.run(args, { cwd });
const git = (cwd, args) => new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 10000 }, (e, out) => (e ? reject(e) : resolve(out.trim()))));

const verdictAsk = () => ' Mark each finding blocking, fix now or follow-up. Blocking: a bug, or something that does not do what the PR says. ' +
  'Fix now: small and safe to fix in this PR, such as a wording fix, a missing test case, a named const or a doc line. Follow-up: real work outside this PR. ' +
  'Before you post, run node ' + JSON.stringify(tickets.CLI) + ' verdict merge only if no finding is blocking or fix now, or verdict fix if one is, so the Dev fixes it in this PR. Then post.';
reviews.useAutopilot({ follows: isOn, ask: () => verdictAsk(),
  since: (channel, pr) => { const r = isOn(channel) && chOf(channel).prs[pr]; const v = r && postedOf(r).slice(-1)[0]; return v ? v.commit : null; },
  freed: (channel, pr, text) => {
    const task = tasks.list(channel).find((x) => x.pr === pr);
    if (!isOn(channel) || !task || !mineTask(task)) return;
    const rec = recOf(channel, pr);
    rec.why = text; rec.act = 'wait'; save();
    note(channel, (task.ticket || 'Task ' + task.id) + ': ' + text);
  } });

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
    terminal.reviewFound(channel, t, url);
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
    if (!held(channel, task)) await lookAt(channel, task);
    else if (handedReasonOf(recOf(channel, task.pr)) === 'protected-file') await follow(channel, task);
    else await mergedYet(channel, task);
  }
  stalled(channel);
  await maybeStart(channel);
}
async function readPr(task, rec) {
  let pr = null, files = null;
  try { pr = await ghDoor.pr(task.pr, task.repo); } catch (e) { rec.why = 'gh pr view failed: ' + e.message; return null; }
  if (pr.state === 'OPEN') {
    try { files = await ghDoor.files(task.pr, pr.headRefOid, task.repo); } catch (e) { rec.why = 'Could not list the PR\'s files: ' + e.message; return null; }
  }
  return { pr, files };
}
function mergeTest(channel, task, rec, decide) {
  const dev = terminal.find(channel, task.owner && task.owner.terminal);
  const d = decide(latest(rec), !dev || dev.exited);
  return (d.act === 'merge' && holdOf(task, dev, Date.now())) || d;
}
function forPersonMerge(channel, task, rec, pr, locked) {
  const v = latest(rec);
  return plan.forPersonMerge(pr, locked, v, mergeTest(channel, task, rec, (x, gone) => plan.forReviewed(pr, x, roundsOf(rec), MAX_ROUNDS(), gone)));
}
async function follow(channel, task) {
  const rec = recOf(channel, task.pr), got = await readPr(task, rec);
  if (!got) return;
  if (got.pr.state === 'MERGED') { markDone(channel, task); return; }
  const locked = plan.lockedOf(got.files);
  if (got.pr.state !== 'OPEN' || !locked.length) return;
  const f = forPersonMerge(channel, task, rec, got.pr, locked);
  if (f.why !== rec.handedOver) {
    rec.handedOver = f.why; save();
    tasks.record(task, { type: 'note', note: 'Autopilot: ' + f.why }); tasks.save();
  }
  readyNow(channel, task, rec, f);
}
function readyNow(channel, task, rec, f) {
  if (rec.ready === f.ready) return;
  rec.ready = f.ready; save();
  if (!f.ready || rec.readyTold === f.ready) return;
  rec.readyTold = f.ready; save();
  note(channel, (task.ticket || 'Task ' + task.id) + ', PR ' + number(task.pr) + ': ' + f.why);
}
async function lookAt(channel, task) {
  const rec = recOf(channel, task.pr);
  const got = await readPr(task, rec);
  if (!got) return;
  const { pr, files } = got;
  if (pr.state === 'OPEN' && rec.mergedHead === pr.headRefOid) { rec.why = 'Merged, but GitHub still shows the PR open.'; rec.act = 'wait'; return; }
  const v = latest(rec);
  let d = mergeTest(channel, task, rec, (x, gone) => plan.forPr(pr, files, x, roundsOf(rec), MAX_ROUNDS(), gone));
  rec.why = d.why; rec.act = d.act;
  if (d.act === 'wait') rec.why = reviews.deskLine(channel, task.pr) || rec.why;
  if (d.act === 'done') markDone(channel, task);
  else if (d.act === 'merge') {
    const c = chOf(channel);
    if (c.merged >= MAX_MERGES_A_DAY()) { rec.why = 'Ready to merge, but Autopilot has merged ' + MAX_MERGES_A_DAY() + ' PRs today, its limit. Merge it yourself, or wait for tomorrow.'; return; }
    if (!(await prComments.checkNow(channel, task))) { rec.why = 'Ready to merge, but its comments could not be read, so it waits for the next look.'; return; }
    if (rec.handedOver) return;
    if (task.reviews && task.reviews.pending) { rec.why = 'New review news came in as it was about to merge, so its Dev hears it first.'; rec.act = 'wait'; return; }
    const again = await ghDoor.pr(task.pr, task.repo, { fresh: true }).catch((e) => ({ failed: e.message }));
    if (again.failed) { rec.why = 'Ready to merge, but gh could not read the PR again just before: ' + again.failed; rec.act = 'wait'; return; }
    const last = mergeTest(channel, task, rec, (x, gone) => plan.forPr(again, files, x, roundsOf(rec), MAX_ROUNDS(), gone));
    if (last.act !== 'merge') { rec.why = last.why; rec.act = last.act; return; }
    try { await gh(['pr', 'merge', task.pr, '--merge', '--match-head-commit', pr.headRefOid], task.repo); } catch (e) {
      const now = await ghDoor.pr(task.pr, task.repo, { fresh: true }).catch(() => null);
      if (now && now.state === 'MERGED') { counted(channel, task, rec, pr.headRefOid); note(channel, 'Merged PR ' + number(task.pr) + ', though gh said: ' + e.message); return; }
      if (now && now.headRefOid !== pr.headRefOid) { rec.why = 'New commits arrived as it was about to merge, so they get a review first.'; return; }
      handOver(channel, task, rec, 'gh pr merge failed: ' + e.message, 'merge-failed', pr.headRefOid); return;
    }
    counted(channel, task, rec, pr.headRefOid);
    note(channel, 'Merged PR ' + number(task.pr) + ' (' + (task.ticket || task.title) + '): ' + d.why);
  } else if (d.act === 'conflict') askToMergeMain(channel, task, rec, pr, terminal.find(channel, task.owner && task.owner.terminal));
  else if (d.act === 'bring-back') bringBack(channel, task, rec, d, d.for === 'fix' ? v.commit : pr.headRefOid, pr);
  else if (d.act === 'person' && d.reason === 'protected-file') {
    const f = forPersonMerge(channel, task, rec, pr, plan.lockedOf(files));
    handOver(channel, task, rec, f.why, d.reason, pr.headRefOid);
    readyNow(channel, task, rec, f);
  } else if (d.act === 'person') handOver(channel, task, rec, d.why, d.reason, (v && v.commit) || pr.headRefOid);
}
const CONFLICT_KEY = (task) => 'autopilot-conflict ' + task.pr;
const CONFLICT_ASKS = 2;
const MERGE_MAIN = ' Merge origin/main into your branch with a merge commit, keep both sides of each conflict, run npm test, and push only that merge, not fixes for the review\'s follow-up findings. A follow-up review checks how you resolved it.';
function conflictAsk(channel, task, rec, pr) {
  const again = rec.conflictAsks > 1;
  const text = (again ? 'Your PR ' + task.pr + ' still conflicts with main at ' + pr.headRefOid.slice(0, 7) + ', and your last turn ended without a merge of main.'
    : 'Your PR ' + task.pr + ' was reviewed, but it conflicts with main.') + MERGE_MAIN;
  delivery.save(channel, { key: CONFLICT_KEY(task), terminal: task.owner && task.owner.terminal, sessionId: task.owner && task.owner.sessionId, expiresAt: Date.now() + 12 * 60 * 60 * 1000, text,
    on: (what) => { if (what === 'delivered' && rec.conflictAt === pr.headRefOid) { rec.conflictTypedAt = Date.now(); save(); } } });
}
function droppedAsk(rec, dev) {
  if (!rec.conflictTypedAt) return false;
  if (!dev || dev.exited) return true;
  return dev.state === 'idle' && (dev.turnAt || 0) >= rec.conflictTypedAt;
}
function askToMergeMain(channel, task, rec, pr, dev) {
  const pending = delivery.pending(channel).some((d) => d.key === CONFLICT_KEY(task));
  if (rec.conflictAt === pr.headRefOid) {
    if (pending) { conflictAsk(channel, task, rec, pr); return false; }
    if (!droppedAsk(rec, dev)) return false;
    if ((rec.conflictAsks || 1) >= CONFLICT_ASKS) {
      handOver(channel, task, rec, 'Its Dev was asked twice to merge main into PR ' + number(task.pr) + ' at ' + pr.headRefOid.slice(0, 7) + ', and each turn ended without it. Merge main yourself, or tell the Dev to, then move the card back to Autopilot.', 'conflict-dropped', pr.headRefOid);
      return true;
    }
    rec.conflictAsks = (rec.conflictAsks || 1) + 1;
    note(channel, 'PR ' + number(task.pr) + ' still conflicts with main after its Dev\'s turn ended, so its Dev was asked once more.');
  } else {
    rec.conflictAsks = 1;
    note(channel, 'PR ' + number(task.pr) + ' conflicts with main, so its Dev was asked to merge main.');
  }
  rec.conflictAt = pr.headRefOid; rec.conflictTypedAt = null; save();
  conflictAsk(channel, task, rec, pr);
  return false;
}
const WAITS_FOR_ROOM = ['wip_limit', 'full', 'running'];
function bringBack(channel, task, rec, d, commit, pr) {
  const name = task.ticket || 'Task ' + task.id, what = d.for === 'fix' ? 'the fixes the last review asks for' : 'a merge of main';
  const step = ' Press Bring back on its task, then move its card back to Autopilot.';
  const key = d.for + ' ' + commit;
  if (rec.broughtBack === key) { handOver(channel, task, rec, 'Its Dev was brought back once for ' + what + ' at ' + commit.slice(0, 7) + ', and is not running again.' + step, 'dev-gone', commit); return; }
  if (d.for === 'conflict' && askToMergeMain(channel, task, rec, pr, terminal.find(channel, task.owner && task.owner.terminal))) return;
  const [status, out] = tasks.resume(channel, task, {}, ctx, BY);
  if (status < 400) {
    rec.broughtBack = key; rec.act = 'wait'; rec.why = 'Autopilot brought its Dev back for ' + what + '.'; save();
    note(channel, name + ': its Dev was not running, so Autopilot brought it back for ' + what + '.');
    return;
  }
  if (WAITS_FOR_ROOM.includes(out.error)) { rec.act = 'wait'; rec.why = 'Its Dev is not running, and Autopilot brings it back for ' + what + ' once it can: ' + out.message; return; }
  handOver(channel, task, rec, 'Its Dev is not running, and Autopilot could not bring it back for ' + what + ': ' + out.message + step, 'dev-gone', commit);
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
  try { pr = await ghDoor.pr(task.pr, task.repo); } catch (e) { return; }
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
  if (starting || tasks.busy() || update.restarting()) return;
  const limit = MAX_MERGES_A_DAY();
  if (c.merged >= limit) {
    const why = 'Autopilot merged ' + c.merged + ' PR' + (c.merged === 1 ? '' : 's') + ' today, its limit. It starts again tomorrow, or raise Merges a day in Settings.';
    if (c.idle !== why) { c.idle = why; note(channel, why); }
    return;
  }
  if (/^Autopilot merged \d+ PRs? today, its limit\./.test(c.idle || '')) { c.idle = null; save(); }
  if (tasks.list(channel).filter((t) => open(channel, t)).length >= AT_ONCE()) return;
  const held = tickets.heldWhy(channel);
  if (held) { c.idle = held; return; }
  starting = true;
  try {
    const all = await tickets.listAll(channel);
    const next = plan.nextTicket(all, (t) => !!tasks.ofTicket(channel, t), c.only);
    if (!next) { c.idle = c.only ? plan.whyNoneAllowed(all, (t) => !!tasks.ofTicket(channel, t), c.only) : 'Nothing in Ready that a person approved and that is not blocked, on hold, replaced or waiting on a design ticket.'; return; }
    const main = await mainCi.check(channel, next.repo, next.base || await tasks.git(next.repo, ['symbolic-ref', '--short', 'HEAD']).catch(() => 'main'));
    if (main && main.state === 'red') { c.idle = 'Main is red, so ' + next.id + ' waits: ' + redMain({ name: path.basename(next.repo), branch: main.branch, run: main.run }); return; }
    const waitWip = (message) => { c.idle = 'Waiting for room under the WIP limit: ' + message; };
    const building = tasks.building(channel);
    if (building >= tasks.wipLimit()) { waitWip(building + (building === 1 ? ' task is' : ' tasks are') + ' being built, and the limit is ' + tasks.wipLimit() + '.'); return; }
    const queued = reviews.waiting(channel);
    if (queued.length) { c.idle = 'Waiting for the review of PR ' + number(queued[0]) + ' to start: it goes first.'; return; }
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
  nudge.watch(channel, chOf(channel), save);
  for (const task of tasks.list(channel).filter((t) => open(channel, t))) {
    const rec = task.pr ? recOf(channel, task.pr) : null;
    const dev = terminal.find(channel, task.owner && task.owner.terminal);
    const on = stuckOn(channel, task, dev);
    if (on) { stuckSince.delete(channel + ' ' + task.id); park(channel, task, rec, on); continue; }
    const devBusy = dev && ['working', 'quiet', 'waiting', 'job'].includes(livenessOf(dev, Date.now()).state);
    const reviewing = task.pr && terminal.all(channel).some((t) => t.reviewOf === task.pr && livenessOf(t, Date.now()).state !== 'gone');
    const waitsOnCi = rec && /CI|GitHub says|PRs today/.test(rec.why || '');
    const waitsForDesk = !!task.pr && reviews.owes(channel, task.pr);
    const stuck = !devBusy && !reviewing && !waitsOnCi && !waitsForDesk;
    const key = channel + ' ' + task.id;
    if (!stuck) { stuckSince.delete(key); continue; }
    if (!stuckSince.has(key)) { stuckSince.set(key, Date.now()); continue; }
    if (Date.now() - stuckSince.get(key) < STALL_MS()) continue;
    if (nudge.first(channel, chOf(channel), task, dev, STALL_MS(), save)) { stuckSince.set(key, Date.now()); note(channel, (task.ticket || 'Task ' + task.id) + ': Autopilot nudged its Dev, which stopped without a PR.'); continue; }
    stuckSince.delete(key);
    const why = 'Nothing moved it for ' + Math.round(STALL_MS() / 60000) + ' minutes' + (rec && rec.why ? ' (' + rec.why + ')' : task.pr ? '' : ': ' + nudge.noPrWhy(channel, chOf(channel), task, dev, Date.now())) + '.';
    const c = chOf(channel);
    (c.stuck || (c.stuck = {}))[task.id] = { stall: true, forReview: !!task.pr && !!rec && rec.why === plan.WAITS_FOR_REVIEW, sessionId: dev ? dev.sessionId : null, from: task.state, pr: task.pr || null, at: new Date().toISOString() };
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
  if (s.forReview && task.pr && reviews.owes(channel, task.pr)) return 'a review of PR ' + number(task.pr) + ' started';
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
    return { pr: t.pr, ticket: t.ticket, task: t.id, state: t.state, rounds: roundsOf(r), verdict: (latest(r) || {}).kind || null, act: r.act || null, why: r.handedOver || r.why || null, ready: (r.handedOver && r.ready) || null };
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
  if (rest === '/autopilot/fix' && req.method === 'POST') {
    const agent = rctx.agent;
    if (agent && !agent.lead) { rctx.problem(res, 401, 'unauthorized', 'Only the person, and the Lead under its merge rung, decide that a finding must be fixed.'); return true; }
    if (agent && !agent.merge) { rctx.problem(res, 403, 'forbidden', 'The person has not let the Lead merge. Fix it lifts a push hold, so the Lead may use it only while Let the Lead merge is on. Tell the person instead.'); return true; }
    const body = await rctx.readJson(req), task = findTask(channel, String(body.task || '').trim());
    if (!task) { rctx.problem(res, 404, 'not_a_task', 'No task has that id, ticket or PR.'); return true; }
    const [status, out] = decideFix(channel, task, agent ? 'Lead' : 'you');
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

const HELD_URL = /https:\/\/github\.com\/\S+#issuecomment-\d+$/;
function decideFix(channel, task, by) {
  const rec = task && task.pr && store[channel] && store[channel].prs[task.pr];
  const v = rec && postedOf(rec).slice(-1)[0];
  if (!task || !task.pr || task.state === 'done') return [409, { ok: false, error: 'no_pr', message: 'Only a task with an open PR has a push hold to lift.' }];
  if (!v || v.kind !== 'merge' || !v.commit) return [409, { ok: false, error: 'no_merge_verdict', message: 'The latest posted verdict on PR ' + number(task.pr) + ' does not say merge, so there is no push hold to lift.' }];
  const who = by === 'you' ? 'You' : 'The Lead', held = handedReasonOf(rec) === 'dev-says-bug' ? (String(rec.handedOver || '').match(HELD_URL) || [])[0] : null;
  rec.verdicts.push({ kind: 'fix', commit: v.commit, by, sessionId: null, at: new Date().toISOString(), posted: 'decided by ' + by });
  dropHandOver(rec); rec.roundsFrom = postedOf(rec).length; rec.act = 'wait'; rec.why = null;
  if (chOf(channel).stuck) delete chOf(channel).stuck[task.id];
  save();
  holdPushes(channel, task);
  const why = who + ' decided a finding on PR ' + number(task.pr) + ' must be fixed, so the review of ' + v.commit.slice(0, 7) + ' counts as fix.';
  if (task.state === 'changes_requested') tasks.record(task, { type: 'note', note: why }); else tasks.setState(channel, task, 'changes_requested', by, why);
  tasks.save();
  delivery.save(channel, { key: 'autopilot-fix ' + task.pr, terminal: task.owner && task.owner.terminal, sessionId: task.owner && task.owner.sessionId, expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    text: (by === 'you' ? 'The person' : 'The Lead') + ' decided that a finding on your PR ' + task.pr + ' must be fixed in this PR' + (held ? ', as you said in ' + oneLine(held, 200) : '') + '. Fix it, run the tests, and push. The push hold is lifted, and a follow-up review checks the fix.' });
  note(channel, (task.ticket || 'Task ' + task.id) + ': ' + why + ' The push hold is lifted.');
  return [200, { ok: true, pr: task.pr, task: task.id, commit: v.commit, message: why + ' The push hold is lifted, and its Dev is told to fix it.' }];
}
const findTask = (channel, what) => tasks.list(channel).find((x) => what && (x.id === what || x.ticket === what || x.pr === what)) || null;

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
  const since = handed && handedReasonOf(r) === 'stalled' && r.verdicts.filter((x) => Date.parse(x.at) > Date.parse(r.handedOverAt) && postOf(channel, x)).pop();
  const reviewedSince = since ? { kind: since.kind, commit: since.commit, url: postOf(channel, since) } : null;
  return { on: isOn(channel), mine: !!task && mineTask(task), act: (r && r.act) || null, why: handed || (r && r.why) || null, verdict: v && v.posted ? v.kind : null, verdictAt: v && v.posted ? v.commit || null : null, handedOver: handed, devSaysBug: !!handed && handedReasonOf(r) === 'dev-says-bug', reviewedSince };
}

const LEAD_KEEPS = 'stop a session the Floor calls safe to stop, move a task to Done once its PR has merged, and ask the relay to review a task\'s PR';
function leadRefusal(channel, to, merged) {
  if (!isOn(channel) || (to === 'done' && merged)) return null;
  return [403, { ok: false, error: 'autopilot', message: 'Autopilot is on, so only the relay starts and merges work. The Lead keeps three rights: ' + LEAD_KEEPS + '. ' +
    (to === 'done' ? 'The relay has not seen this PR merge, so it stays where it is.' : 'Leave this to Autopilot, or tell the person.') }];
}

function verdictOf(channel, pr) {
  const r = store[channel] && store[channel].prs[pr], v = r && latest(r);
  return v ? { kind: v.kind, commit: v.commit, posted: postOf(channel, v) } : null;
}
const movesIt = (channel, task) => isOn(channel) && mineTask(task);

module.exports = { handle, begin, isOn, deskOf, leadRefusal, LEAD_KEEPS, verdictOf, movesIt };
