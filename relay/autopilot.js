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
// What it keeps (the switch, the verdicts, the day's merges) is in RELAY_AUTOPILOT_FILE, so a restart keeps it.
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

const FILE = state.file('autopilot.json', 'RELAY_AUTOPILOT_FILE');
const GH = process.env.GH_CMD || 'gh';
const config = require('./config.js');
// Read at each use, so a change in Settings (relay/config.js) applies at once.
const AT_ONCE = () => config.get('autopilotAtOnce');
const MAX_ROUNDS = () => config.get('autopilotRounds'), MAX_MERGES_A_DAY = () => config.get('autopilotMerges');
const NOTES_KEPT = 30;
const BY = 'Autopilot';

// ---------- the store: { channel: { on, only, day, merged, prs: { pr: { verdicts, conflictAt, handedOver, mergedHead } }, stuck: { task id: { sessionId, from, at, stall, pr } }, notes } } ----------
const ownsFile = claim(FILE);
let store = {};
if (ownsFile) try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') {
    const aside = FILE + '.unreadable-' + Date.now();
    try { fs.renameSync(FILE, aside); console.error('Could not read ' + FILE + '. Kept it as ' + aside); } catch (e2) { /* nothing to keep */ }
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

// ---------- the reviews ----------
// What every review Autopilot gets asks for, after its own brief. The CLI path is quoted, as it can have spaces.
const verdictAsk = () => ' Mark each finding blocking or not: only a bug, or something that does not do what the PR says, blocks. Before you post, run node ' +
  JSON.stringify(tickets.CLI) + ' verdict merge if nothing blocks, or verdict fix if something does. Then post.';
// A follow-up reviews only what came after the last posted verdict: code no verdict covered gets the whole review again.
// Every review of a PR asks for a verdict, Autopilot on or not, automatic or from Get a review (relay/checkouts.js):
// relay/pr-comments.js reads it to leave the card alone after a review that blocks nothing.
reviews.useAutopilot({ follows: isOn, ask: () => verdictAsk(),
  since: (channel, pr) => { const r = isOn(channel) && chOf(channel).prs[pr]; const v = r && postedOf(r).slice(-1)[0]; return v ? v.commit : null; } });

// A reviewer's verdict on the PR it reviews, for the commit its checkout is at.
async function giveVerdict(channel, agent, kind) {
  const pr = agent.reviewOf || agent.pr;
  if (!pr) return [409, { ok: false, error: 'no_pr', message: 'Only a reviewer of a PR gives a verdict.' }];
  if (!['merge', 'fix'].includes(kind)) return [400, { ok: false, error: 'bad_verdict', message: 'A verdict is merge or fix.' }];
  if (agent.posted) return [409, { ok: false, error: 'posted', message: 'Your review is posted, so its verdict is kept as it was.' }];
  let commit;
  try { commit = await git(agent.cwd, ['rev-parse', 'HEAD']); } catch (e) { return [409, { ok: false, error: 'no_commit', message: 'Could not read the commit of this checkout: ' + e.message }]; }
  const rec = recOf(channel, pr);
  const mine = (v) => v.sessionId === agent.sessionId && !v.posted;  // a reviewer that changes its mind before it posts keeps one verdict
  rec.verdicts = rec.verdicts.filter((v) => !mine(v));
  // By session id, which a relay restart keeps, as it brings the reviewer back with its conversation.
  rec.verdicts.push({ kind, commit, sessionId: agent.sessionId, at: new Date().toISOString(), posted: (agent.posted && agent.posted.url) || null });
  save();
  note(channel, 'The review of PR ' + number(pr) + ' at ' + commit.slice(0, 7) + ' says ' + kind + '.');
  return [200, { ok: true, pr, kind, commit, message: 'Verdict kept: ' + kind + ' for ' + commit.slice(0, 7) + '. Now post your review.' }];
}
// A verdict counts once its review is on the PR. It is linked as the hook reports the post, so a prompt
// after it, which keeps the reviewer at its desk, does not lose it (T-230).
const unposted = (rec, t) => rec && rec.verdicts.find((x) => x.sessionId === t.sessionId && !x.posted);
terminal.onReviewPosted((channel, t) => {
  const v = unposted(chOf(channel).prs[t.reviewOf], t);
  if (v) { v.posted = t.posted.url; save(); }
});
terminal.onReviewDone((channel, t) => {
  const rec = chOf(channel).prs[t.reviewOf];
  if (rec && rec.verdicts.some((x) => x.sessionId === t.sessionId && x.posted)) return;
  if (isOn(channel) && t.reviewOf) note(channel, 'The review of PR ' + number(t.reviewOf) + ' was posted without a verdict, so it does not count. The next push brings another review.');
});
// A safety net for a post the hook never reported: when a reviewer's turn ends with its verdict kept but not
// linked, the relay looks on the PR for the review (relay/autopilot-plan.js, reviewPostFor). It counts from
// when the review started, or the verdict if that is earlier, as after a relay restart, less a minute for
// clocks that differ.
const looking = new Set();
terminal.onReviewTurnEnd(async (channel, t) => {
  const rec = chOf(channel).prs[t.reviewOf], v = unposted(rec, t);
  const m = String(t.reviewOf).match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
  if (!v || !m || looking.has(t.sessionId)) return;
  looking.add(t.sessionId);
  try {
    const login = JSON.parse(await gh(['api', 'user'])).login || null;  // each time, so gh auth switch applies at once
    const comments = JSON.parse(await gh(['api', '--paginate', '--slurp', 'repos/' + m[1] + '/issues/' + m[2] + '/comments?per_page=100'])).flat();
    const since = Math.min(Date.parse(t.startedAt) || Infinity, Date.parse(v.at) || Infinity) - 60 * 1000;
    const url = plan.reviewPostFor(comments, { login, since, commit: v.commit });
    if (!url || v.posted || rec.verdicts.some((x) => x.posted === url)) return;
    v.posted = url; save();
    note(channel, 'The review of PR ' + number(t.reviewOf) + ' at ' + v.commit.slice(0, 7) + ' is on the PR, though its post was not seen, so its verdict counts: ' + url);
  } catch (e) {
    console.error('Could not look on ' + t.reviewOf + ' for its review: ' + e.message);
  } finally { looking.delete(t.sessionId); }
});
const postedOf = (rec) => rec.verdicts.filter((v) => v.posted);
const latest = (rec) => postedOf(rec).slice(-1)[0] || rec.verdicts.slice(-1)[0] || null;
// For relay/pr-comments.js: 'merge' only when every item in the news ({ url, at }) is a review posted with a
// merge verdict. A verdict speaks only for its own review, so an older one never covers a newer comment:
// - gh pr comment prints the comment's link, so the verdict's post is that link.
// - gh pr review prints nothing, so its post is the PR's own link. It covers a review, or an inline comment,
//   on GitHub that came after the verdict and within REVIEW_WINDOW of it.
// A reviewer's post counts from the moment its hook says so (t.posted), not only once its session has ended
// (onReviewDone, REVIEW_GRACE later), since the comment check can deliver the news in between.
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
  // The newest verdict that covers each item speaks for it.
  const kindOf = (item) => { const v = r.verdicts.slice().reverse().find((x) => covers(x, item)); return v ? v.kind : null; };
  return items.every((item) => kindOf(item) === 'merge') ? 'merge' : null;
});
// The Dev says a finding the review marked non-blocking is really a bug (relay/pr-comments.js HOLD_MARK):
// the PR goes to the person rather than merging on that verdict.
prComments.useHolds((channel, task, url) => {
  if (!mineTask(task) || task.state === 'done' || !task.pr) return;
  const rec = recOf(channel, task.pr);
  if (rec.handedOver) return;
  handOver(channel, task, rec, 'Its Dev says a finding the review marked non-blocking is a bug: ' + url);
});
// Rounds count from the last time the person gave the task back, so they get the full number again.
const roundsOf = (rec) => Math.max(0, postedOf(rec).length - (rec.roundsFrom || 0));

// ---------- one look ----------
// Only tasks Autopilot started are its own. One it handed to the person stays with them, even when the
// relay moves its card for a review comment, until the person moves the card themselves. Only a merge
// of its PR is still seen: the task is done, as for any other.
const mineTask = (task) => task.by === BY;
const handedBack = (task, rec) => (task.history || []).some((h) => h.type === 'moved' && h.by === 'you' && h.at > rec.handedOverAt);
function held(channel, task) {
  const rec = task.pr && chOf(channel).prs[task.pr];
  if (!rec || !rec.handedOver) return task.state === 'waiting_on_you';
  if (!handedBack(task, rec)) return true;
  rec.handedOver = null; rec.handedOverAt = null; rec.roundsFrom = postedOf(rec).length; save();
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
  if (c.day !== today()) { c.day = today(); c.merged = 0; save(); }
  if (update.restarting()) return;  // the relay is about to restart: nothing new now
  movedAgain(channel);
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
  // GitHub can show a PR open for a while after it merged, with any merge state as it settles. A look in that
  // time does nothing: no second merge or count, no conflict for the Dev. If GitHub never shows it merged,
  // the stall check hands the task to the person.
  if (pr.state === 'OPEN' && rec.mergedHead === pr.headRefOid) { rec.why = 'Merged, but GitHub still shows the PR open.'; rec.act = 'wait'; return; }
  // Every file, past the first 100 that gh pr view lists, and the old name of each one renamed.
  if (pr.state === 'OPEN') {
    const m = task.pr.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
    try { files = JSON.parse(await gh(['api', '--paginate', '--slurp', 'repos/' + m[1] + '/pulls/' + m[2] + '/files?per_page=100'], task.repo)).flat().flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean); } catch (e) { rec.why = 'Could not list the PR\'s files: ' + e.message; return; }
  }
  const v = latest(rec);
  let d = plan.forPr(pr, files, v, roundsOf(rec), MAX_ROUNDS());
  // The PR must hold all its Dev's work first: nothing left in its checkout, and no answer to the latest review under way (T-203).
  const hold = d.act === 'merge' ? holdOf(task, terminal.find(channel, task.owner && task.owner.terminal), Date.now()) : null;
  if (hold) d = hold;
  rec.why = d.why; rec.act = d.act;
  if (d.act === 'done') markDone(channel, task);
  else if (d.act === 'merge') {
    const c = chOf(channel);
    if (c.merged >= MAX_MERGES_A_DAY()) { rec.why = 'Ready to merge, but Autopilot has merged ' + MAX_MERGES_A_DAY() + ' PRs today, its limit. Merge it yourself, or wait for tomorrow.'; return; }
    // The PR's comments once more, so a Dev's hold posted since the last poll stops this merge.
    if (!(await prComments.checkNow(channel, task))) { rec.why = 'Ready to merge, but its comments could not be read, so it waits for the next look.'; return; }
    if (rec.handedOver) return;
    if (task.reviews && task.reviews.pending) { rec.why = 'New review news came in as it was about to merge, so its Dev hears it first.'; rec.act = 'wait'; return; }
    // --match-head-commit: GitHub refuses if the Dev pushed after this look, so only the reviewed commit merges.
    try { await gh(['pr', 'merge', task.pr, '--merge', '--match-head-commit', pr.headRefOid], task.repo); } catch (e) {
      const now = await gh(['pr', 'view', task.pr, '--json', 'state,headRefOid'], task.repo).then(JSON.parse, () => null);
      if (now && now.state === 'MERGED') { counted(c, rec, pr.headRefOid); note(channel, 'Merged PR ' + number(task.pr) + ', though gh said: ' + e.message); return; }  // the next look marks it done
      if (now && now.headRefOid !== pr.headRefOid) { rec.why = 'New commits arrived as it was about to merge, so they get a review first.'; return; }
      handOver(channel, task, rec, 'gh pr merge failed: ' + e.message); return;
    }
    counted(c, rec, pr.headRefOid);
    note(channel, 'Merged PR ' + number(task.pr) + ' (' + (task.ticket || task.title) + '): ' + d.why);
  } else if (d.act === 'conflict') {
    if (rec.conflictAt === pr.headRefOid) return;
    rec.conflictAt = pr.headRefOid; save();
    delivery.save(channel, { key: 'autopilot-conflict ' + task.pr, terminal: task.owner && task.owner.terminal, sessionId: task.owner && task.owner.sessionId, expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      text: 'Your PR ' + task.pr + ' was reviewed, but it conflicts with main. Merge origin/main into your branch with a merge commit, keep both sides of each conflict, run npm test, and push only that merge, not fixes for the review\'s non-blocking findings. A follow-up review checks how you resolved it.' });
    note(channel, 'PR ' + number(task.pr) + ' conflicts with main, so its Dev was asked to merge main.');
  } else if (d.act === 'person') handOver(channel, task, rec, d.why);
}
// One merge of a PR's head counts once toward the day's limit.
function counted(c, rec, head) { rec.mergedHead = head; c.merged++; save(); }
function markDone(channel, task) {
  tasks.noteMerged(task);
  tasks.setState(channel, task, 'done', BY, 'PR ' + number(task.pr) + ' merged.');
  const w = terminal.find(channel, task.owner && task.owner.terminal);
  if (w && !w.exited && w.state !== 'working' && w.state !== 'waiting') terminal.stop(w);  // its work is merged, so its desk is free
  note(channel, (task.ticket || 'Task ' + task.id) + ' is done: PR ' + number(task.pr) + ' merged.');
  pullMain(channel);
}
// A task with the person is theirs, but once they merge its PR, it is done and its desk is free.
async function mergedYet(channel, task) {
  let pr;
  try { pr = JSON.parse(await gh(['pr', 'view', task.pr, '--json', 'state'], task.repo)); } catch (e) { return; }
  if (pr.state === 'MERGED') markDone(channel, task);
}
// Autopilot leaves it alone from here: the card says why.
function handOver(channel, task, rec, why) {
  rec.handedOver = why; rec.handedOverAt = new Date().toISOString(); save();
  tasks.setState(channel, task, 'waiting_on_you', BY, 'Autopilot: ' + why);
  note(channel, (task.ticket || 'Task ' + task.id) + ' waits on you: ' + why);
}
// The relay's folder gets the merged main, and restarts if its own files changed (relay/update.js).
function pullMain(channel) {
  update.run(ctx).then(([status, out]) => { if (status >= 400 || out.restart === false) note(channel, (status >= 400 ? 'Could not pull main into the relay\'s folder: ' : '') + out.message); })
    .catch((e) => note(channel, 'Could not pull main into the relay\'s folder: ' + e.message));
}
async function maybeStart(channel) {
  const c = chOf(channel);
  if (starting || tasks.busy() || update.restarting() || tasks.list(channel).filter((t) => open(channel, t)).length >= AT_ONCE()) return;
  if (c.merged >= MAX_MERGES_A_DAY()) return;
  starting = true;
  try {
    const all = await tickets.listAll(channel);
    const next = plan.nextTicket(all, (t) => !!tasks.ofTicket(channel, t), c.only);
    if (!next) { c.idle = c.only ? 'Every ticket you allowed is started or done.' : 'Nothing in Ready that a person approved and that is not blocked.'; return; }
    // The WIP limit counts every task being built, also ones Autopilot did not start, so it can be full
    // while Autopilot has room of its own. That is a wait, not a failure: the next tick tries again.
    const waitWip = (message) => { c.idle = 'Waiting for room under the WIP limit: ' + message; };
    if (tasks.building(channel) >= tasks.wipLimit()) { waitWip(tasks.building(channel) + ' tasks are being built, and the limit is ' + tasks.wipLimit() + '.'); return; }
    const wasWaiting = /^Waiting for a free desk/.test(c.idle || '');
    c.idle = null;
    let [status, out] = await tickets.startBy(channel, next, BY, ctx);
    if (out.error === 'wip_limit') { waitWip(out.message); return; }  // another start took the last slot first
    // A desk is freed only when a full Floor is what stops the start. A failed start leaves nothing behind.
    let why = null;
    if (out.error === 'full') {
      why = await freeADesk(channel);
      if (!why) { [status, out] = await tickets.startBy(channel, next, BY, ctx); why = 'a desk was freed, but another session took it first'; }
    }
    // A full Floor is a wait too: sessions end by themselves, and the next look tries again. The note
    // comes once, when the wait starts, and the idle line says it at every look.
    if (out.error === 'full') {
      const taken = terminal.all(channel).filter((t) => !t.exited).length;
      c.idle = 'Waiting for a free desk: ' + taken + ' of ' + terminal.DESKS + ' taken, ' + why + '.';
      if (!wasWaiting) note(channel, c.idle + ' ' + next.id + ' starts once one is free.');
      return;
    }
    if (status >= 400) { note(channel, 'Could not start ' + next.id + ': ' + out.message); c.on = false; save(); terminal.rebriefLead(channel); note(channel, 'Autopilot turned itself off. Turn it on again once that is fixed.'); return; }
    note(channel, 'Started ' + next.id + ': ' + next.title);
  } finally { starting = false; }
}

// A start needs one desk. When every desk is taken, Autopilot waits for a session that is already
// ending. If none ends, it stops the longest idle of its own sessions that the Lead may stop
// (relay/floor.js freeDesks): the Dev of a task it started, whose PR merged or whose task is Done,
// with all its work pushed, or a reviewer of such a task's PR that has posted. So a Dev still busy
// when its PR merged is stopped here, later. It works only on tasks it started (article 5), so every
// other session stays the person's. Each wait is up to STOP_WAIT. Returns null once a desk is free,
// or why none is, for the line that says Autopilot waits for a desk.
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

// A task that is stuck for STALL_MS goes to the person, so one stuck task does not hold its slot for good:
// - its Dev or a reviewer of its PR has been at a question or a permission prompt that long, or stuck in
//   a turn with no hook and no output that long (relay/liveness.js), or a reviewer never got its brief in
//   that time (stuckOn). That session is left running at its desk, and the task comes back once it moves
//   again (movedAgain). A quiet session, whose hooks are silent but whose screen still moves, is not stuck:
//   it may be thinking, and its task stays;
// - or nothing running could move it: no PR yet and its Dev idle or gone, or a PR with no reviewer running,
//   its Dev idle or gone, and no verdict on its current state, such as a review posted with none. An idle
//   Dev with no PR is nudged once first (relay/nudge.js). A Dev running a job (relay/liveness.js) is busy.
//   The task comes back once something moves it (movedAgain).
// In Waiting on you it no longer counts toward Autopilot's tasks at once or the WIP limit, so the next
// ticket can start. Desks stay the limit: the stuck session keeps its own.
const STALL_MS = () => config.get('autopilotStallMinutes') * 60 * 1000;
function stuckOn(channel, task, dev) {
  const found = [], now = Date.now();
  const asked = (t) => 'at a question' + (t.message ? ' (' + String(t.message).slice(0, 120) + ')' : '');
  // At a question, or stuck in a turn: the session itself holds the task.
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
    // A first prompt is held only while the relay restarts, so a brief held by that does not count.
    // A reviewer typed into whose hooks never reach the relay may be at work, so only talked or that counts.
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
    // Working, quiet or at a question: it may still move the task. Stuck ones are stuckOn's.
    const devBusy = dev && ['working', 'quiet', 'waiting', 'job'].includes(livenessOf(dev, Date.now()).state);
    const reviewing = task.pr && terminal.all(channel).some((t) => t.reviewOf === task.pr && livenessOf(t, Date.now()).state !== 'gone');
    const waitsOnCi = rec && /CI|GitHub says|PRs today/.test(rec.why || '');  // CI, GitHub or the day's limit will move it
    const stuck = !devBusy && !reviewing && !waitsOnCi;
    const key = channel + ' ' + task.id;
    if (!stuck) { stuckSince.delete(key); continue; }
    if (!stuckSince.has(key)) { stuckSince.set(key, Date.now()); continue; }
    if (Date.now() - stuckSince.get(key) < STALL_MS()) continue;
    if (nudge.first(channel, chOf(channel), task, dev, STALL_MS(), save)) { stuckSince.set(key, Date.now()); note(channel, (task.ticket || 'Task ' + task.id) + ': Autopilot nudged its Dev, which stopped without a PR.'); continue; }
    stuckSince.delete(key);
    const why = 'Nothing moved it for ' + Math.round(STALL_MS() / 60000) + ' minutes' + (rec && rec.why ? ' (' + rec.why + ')' : task.pr ? '' : ': ' + nudge.noPrWhy(channel, chOf(channel), task, dev, Date.now())) + '.';
    // Kept so the task comes back by itself once it moves again (movedAgain).
    const c = chOf(channel);
    (c.stuck || (c.stuck = {}))[task.id] = { stall: true, sessionId: dev ? dev.sessionId : null, from: task.state, pr: task.pr || null, at: new Date().toISOString() };
    if (rec) handOver(channel, task, rec, why);
    else { tasks.setState(channel, task, 'waiting_on_you', BY, 'Autopilot: ' + why); save(); note(channel, (task.ticket || 'Task ' + task.id) + ' waits on you: ' + why); }
  }
}
const stuckSince = new Map();
// The stuck session stays at its desk for the person to read and answer.
function park(channel, task, rec, on) {
  const name = chat.nameOf(on.t), mins = Math.round((Date.now() - on.since) / 60000);
  const why = 'Its ' + on.role + ' ' + name + ' ' + on.why + ' for ' + mins + ' minutes. The session is still open at its desk' +
    (on.brief ? ': look at it there.' : on.silent ? ': look at it there, and the task goes back to ' + (task.state === 'building' ? 'Building' : 'where it was') + ' once it moves again.' : ': answer it there, and the task goes back to ' + (task.state === 'building' ? 'Building' : 'where it was') + ' once it moves again.' +
      ' A relay restart keeps it at its question, but if the relay is stopped first, its question is gone: tell it to go on, or move the card.');
  const c = chOf(channel);
  (c.stuck || (c.stuck = {}))[task.id] = { sessionId: on.t.sessionId, from: task.state, brief: !!on.brief, at: new Date().toISOString() };
  if (rec) handOver(channel, task, rec, why);
  else { tasks.setState(channel, task, 'waiting_on_you', BY, 'Autopilot: ' + why); save(); note(channel, (task.ticket || 'Task ' + task.id) + ' waits on you: ' + why); }
}
// A task parked for a stuck session goes back where it was once that session moves again: a hook since
// the park says it did something, and it is not at a question. A task parked because nothing moved it
// (stalled) goes back once anything moves it: its Dev opens a PR, its Dev sends a hook, or a review of
// its PR is posted with a verdict, each after the park. A card the person moved is theirs as before.
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
    if (rec) { rec.handedOver = null; rec.handedOverAt = null; }
    save();
    tasks.setState(channel, task, s.from, BY, 'Autopilot: ' + why + ', so the task is back.');
    note(channel, (task.ticket || 'Task ' + task.id) + ' is back from Waiting on you: ' + why + '.');
  }
}
// A hook since the park, not at a question. A session brought back after a stop starts idle, so only a hook counts.
const hookedSince = (t, at) => !!t && !t.exited && t.state !== 'waiting' && (t.movedAt || 0) > Date.parse(at);
function stuckMoved(channel, s) {
  const t = terminal.all(channel).find((x) => x.sessionId === s.sessionId && !x.exited);
  return hookedSince(t, s.at) ? chat.nameOf(t) + ' moved again' : null;
}
// Its Dev is the one at its desk now, which can be a session brought back after the park.
function movedSinceStall(channel, task, s) {
  if (task.pr && !s.pr) return 'its Dev opened PR ' + number(task.pr);
  const dev = terminal.find(channel, task.owner && task.owner.terminal);
  if (hookedSince(dev, s.at)) return 'its Dev ' + chat.nameOf(dev) + ' moved again';
  const rec = task.pr && chOf(channel).prs[task.pr];
  const v = rec && rec.verdicts.find((x) => Date.parse(x.at) > Date.parse(s.at) && postOf(channel, x));
  return v ? 'a review of PR ' + number(task.pr) + ' was posted with the verdict ' + v.kind : null;
}

// ---------- routes under /channels/{channel}/autopilot ----------
function view(channel) {
  const c = chOf(channel);
  const prs = tasks.list(channel).filter((t) => mineTask(t) && t.pr && c.prs[t.pr]).map((t) => {
    const r = c.prs[t.pr];
    return { pr: t.pr, ticket: t.ticket, task: t.id, state: t.state, rounds: roundsOf(r), verdict: (latest(r) || {}).kind || null, act: r.act || null, why: r.handedOver || r.why || null };
  });
  return { ok: true, on: !!c.on, only: c.only, atOnce: AT_ONCE(), maxRounds: MAX_ROUNDS(), maxMerges: MAX_MERGES_A_DAY(), mergedToday: c.day === today() ? c.merged : 0, idle: c.idle || null, paused: update.restarting(), prs, notes: c.notes.slice(-10) };
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
      const ids = only.map((x) => String(x).trim().toUpperCase()).filter(Boolean);
      if (ids.some((x) => !/^T-\d{1,6}$/.test(x))) { rctx.problem(res, 400, 'bad_param', '"only" lists ticket ids like T-12.'); return true; }
      c.only = ids.length ? ids : null;
    }
    if (body.on !== undefined && body.on !== c.on) {
      c.on = body.on;
      c.idle = null;  // a new run says again what it waits for
      terminal.rebriefLead(channel);  // the Lead's brief says whether Autopilot is on (relay/lead-brief.js)
      note(channel, 'Turned ' + (c.on ? 'on' : 'off') + ' by the person' + (c.on && c.only ? ', for ' + c.only.join(', ') + ' only' : '') + '.');
    }
    // A list belongs to one run. Off clears it, so the next time on means every approved Ready ticket
    // unless the person types a new list. The page refills its box from here every 2 seconds.
    if (!c.on) c.only = null;
    save();
    if (c.on) setImmediate(tick);
  }
  rctx.send(res, 200, view(channel));
  return true;
}

function begin(relayCtx) {
  ctx = relayCtx;
  config.every('autopilotTickSeconds', tick);  // reads the interval each time, and sets the timer again when it changes
}

// What a desk on the Floor shows about a task's PR (relay/desk.js): what Autopilot last decided at
// its last look, from memory only, so drawing a desk asks GitHub nothing.
function deskOf(channel, task) {
  const r = task && task.pr && store[channel] && store[channel].prs[task.pr];
  const v = r ? latest(r) : null;
  return { on: isOn(channel), mine: !!task && mineTask(task), act: (r && r.act) || null, why: (r && r.why) || null, verdict: v && v.posted ? v.kind : null, verdictAt: v && v.posted ? v.commit || null : null, handedOver: (r && r.handedOver) || null };
}

// While Autopilot is on (level 5, T-161), only the relay starts and merges work, and the Lead keeps two
// rights. One is its stop (relay/floor.js), with the same verdict, switch and hourly limit. The other is
// below: a task to Done once its PR has merged. Every other move and every start the Lead asks for is
// refused here, with the same words as the level on the page, article 5 and the Lead's brief.
// to is the column, or 'start'. merged says whether the relay has seen the PR merge. Returns a refusal or null.
const LEAD_KEEPS = 'stop a session the Floor calls safe to stop, and move a task to Done once its PR has merged';
function leadRefusal(channel, to, merged) {
  if (!isOn(channel) || (to === 'done' && merged)) return null;
  return [403, { ok: false, error: 'autopilot', message: 'Autopilot is on, so only the relay starts and merges work. The Lead keeps two rights: ' + LEAD_KEEPS + '. ' +
    (to === 'done' ? 'The relay has not seen this PR merge, so it stays where it is.' : 'Leave this to Autopilot, or tell the person.') }];
}

// For the PR watch (relay/pr-watch.js): the latest verdict a reviewer gave on a PR, Autopilot on or not, since every
// review asks for one, and whether Autopilot moves a task, which the watch then leaves to it.
function verdictOf(channel, pr) {
  const r = store[channel] && store[channel].prs[pr], v = r && latest(r);
  return v ? { kind: v.kind, commit: v.commit, posted: postOf(channel, v) } : null;
}
const movesIt = (channel, task) => isOn(channel) && mineTask(task);

module.exports = { handle, begin, isOn, deskOf, leadRefusal, LEAD_KEEPS, verdictOf, movesIt };
