// Automatic reviews: the relay, not the page, starts them, so they start while the page is closed.
// See docs/manual/roles.html#auto-review.
//
//   The first review. A session runs gh pr create, and its hook sends the PR. While Review PRs
//   automatically is on (it starts on), the relay starts a reviewer in its own checkout of the PR,
//   once the PR's pipeline is green (relay/pipeline.js). A hook from a session the room does not run counts
//   only for a PR of a repo the room has a clone of (roomKnows in relay/checkouts.js). Any other PR is
//   ignored with a log line, since the person's global hooks report every session on this computer (T-192).
//   A review the checkout refuses as unrelated, of another project, is dropped and not tried again, and the
//   panel says so once, since a line may already say its review starts.
//   A follow-up review. While Review again after each push is on (it starts off, article 5), a reviewed
//   PR whose head is not the commit its last review read owes one (followUpOwed in office/reviews.js).
//   Each tick compares the head the pipeline last heard with that commit, so a push whose hook was lost,
//   say while the relay restarted, still gets its review. A push hook only asks GitHub sooner. The
//   reviewer starts once the Dev's turn ends and no review of that PR runs. Several pushes bring one
//   review, of the latest commit. The reviewer is told to check each finding of the earlier review.
//   With the pipeline off (pipelinePollSeconds 0) the relay knows no heads, so only the push hook
//   queues a follow-up, as before.
//   Either review waits for the pipeline. While it waits, no desk is used: the relay asks gh. A red
//   pipeline starts no review, and the Dev is told once for each commit. A push that turns it green
//   starts the review then.
//   Either review that finds every desk taken waits for one, and frees one by itself (makeRoom, T-374). Each
//   tick it stops at most one session, for the review that has waited longest, and only once no session it
//   stopped is still ending: the one relay/stop-verdict.js forReview picks. It says so in the news, and
//   Autopilot puts it on the PR's line. When it may stop none, the wait is a deadlock that Needs you names.
//
// Every review that starts, first, follow-up or Get a review, is told to the PR's Dev as a saved message:
// the PR, the commit the reviewer reads, and the reviewer's name. The relay names each session as it
// starts it (relay/seats.js). With no roster there is no name, and the message says A reviewer.
//
// Each PR gets at most MAX_AUTO_REVIEWS automatic reviews, the first one included. A push after that
// waits on the person: the Floor says so, and the Lead gets a saved message. Get a review is the
// person's own and is not counted, though it asks for a verdict like an automatic review. Which
// review starts, and when, is office/reviews.js, which the page also loads for Get a review. The
// switches, the counts and the commit each PR's last review read are
// kept in RELAY_REVIEWS_FILE, so a restart keeps them.
//
// The Lead asks for a review (T-98): POST /reviews/lead with { pr }, from ticket.js review, while the person's
// switch Let the Lead start reviews is on (off by default, article 5), or while Autopilot is on whatever the
// switch says (T-333; autopilot.follows, from relay/autopilot.js, says it is on). Only the Lead's token reaches it
// (relay/server.js); the person's key gets 403, since the page has Get a review. It is the review Get a review
// starts on a session with a PR: the same checkouts.create, brief and verdict ask, in its own checkout, and the
// reviewer posts and leaves. The relay refuses a PR that is no task's, one that a reviewer is reviewing or is
// about to, an ask with no desk free, and a PR that has had MAX_AUTO_REVIEWS. The Lead's reviews count in the
// same per-PR count as the automatic ones, taken before the start so two asks cannot both pass the limit, and
// given back if the start fails. It takes the place of a first review or a follow-up that waits, so a PR does
// not get two reviews. The Lead never reviews in its own session.
//
// Like the terminal, the routes answer only the room page and its sessions on this machine, while RELAY_TERMINAL=1.
'use strict';
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const terminal = require('./terminal.js');
const { livenessOf } = require('./liveness.js');
const tasks = require('./tasks.js');
const checkouts = require('./checkouts.js');
const delivery = require('./delivery.js');
const { claim } = require('./lockfile.js');
const reviewHistory = require('./review-history.js');
const prComments = require('./pr-comments.js');
const door = require('./gh.js');
const { PR_URL, prBrief, followBrief, followUps, followUpOwed } = require('../office/reviews.js');
const config = require('./config.js');
const pipeline = require('./pipeline.js');
const MAX_AUTO_REVIEWS = () => config.get('maxAutoReviews');

const FILE = state.file('reviews.json', 'RELAY_REVIEWS_FILE');
const RETRY_MS = () => config.get('reviewRetrySeconds') * 1000, MAX_TRIES = 3;
const TICK = 1000, NEWS_KEPT = 20, LEAD_KEEP = 12 * 60 * 60 * 1000;
const START_KEEP = 60 * 60 * 1000;
const ENDING_WAIT = 10 * 1000;

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
  } catch (e) { console.error('Could not save reviews to ' + FILE + ': ' + e.message); }
}
const chOf = (channel) => store[channel] || (store[channel] = { prs: {} });
let autopilot = { follows: () => false, ask: () => '', since: () => null, freed: () => {} };
const useAutopilot = (a) => { autopilot = a; checkouts.useAsk((channel) => a.ask(channel)); };
const followsPushes = (channel) => switchesOf(channel).again || autopilot.follows(channel);
const switchesOf = (channel) => { const c = chOf(channel); return { auto: c.auto !== false, again: c.again === true }; };
const recOf = (channel, pr) => chOf(channel).prs[pr] || null;
const number = (pr) => '#' + pr.split('/').pop();

const opened = new Map();
const starting = new Set();
const news = new Map();
const begun = [];
let newsSeq = 0, ctx = null;
function say(channel, text, state, id) {
  const list = news.get(channel) || [];
  list.push({ seq: ++newsSeq, at: new Date().toISOString(), text, state: state || '', terminal: id || null });
  news.set(channel, list.slice(-NEWS_KEPT));
  if (ctx) ctx.log(text);
}

const isReviewer = (t) => t.role === 'reviewer' || !!t.reviewOf;
function sessionOf(channel, ev) {
  const sid = String(ev.session_id || '');
  return terminal.all(channel).find((t) => (ev.terminal && t.id === ev.terminal) || (sid && t.sessionId.startsWith(sid))) || null;
}
function prOf(channel, t) {
  const w = tasks.workOf(channel, t);
  return (w && w.pr) || opened.get(t.id) || null;
}

async function startReview(channel, body) {
  const key = channel + ' ' + body.pr;
  starting.add(key);
  try {
    const [status, out] = await checkouts.create(channel, Object.assign({ cols: 120, rows: 32, auto: true }, body), ctx);
    if (status >= 400) ctx.log('No reviewer for ' + body.pr + ': ' + out.message);
    return out;
  } catch (e) {
    return { ok: false, message: e.message };
  } finally { starting.delete(key); }
}
const startedNews = (channel, out, what) => say(channel, 'A reviewer is starting ' + what + '. Click them to watch.', 'wait', out.id);
async function firstReview(channel, pr, held) {
  const c = chOf(channel);
  c.prs[pr] = { count: 1, head: null, pending: null, waits: false, from: held.from };
  save();
  const out = await startReview(channel, { from: held.from, pr, prompt: prBrief(pr) + autopilot.ask(channel) });
  if (out.ok) { startedNews(channel, out, 'a review of PR ' + number(pr)); return; }
  const rec = c.prs[pr];
  if (!rec) return;
  rec.count = Math.max(0, rec.count - 1);
  if (rec.count || rec.head) { save(); return; }
  if (out.error === 'unrelated') { delete c.prs[pr]; delivery.drop(channel, 'pipeline ' + pr); save(); say(channel, 'No review of PR ' + number(pr) + ': it is of another project.'); return; }
  if (out.error === 'full') {
    rec.first = Object.assign({}, held, { desk: true });
    save();
    if (!held.desk) say(channel, 'No desk is free for the review of PR ' + number(pr) + '. It starts once a desk is free.', 'wait');
    return;
  }
  const tries = (held.tries || 0) + 1;
  if (tries < MAX_TRIES) { rec.first = Object.assign({}, held, { desk: false, tries, notBefore: Date.now() + RETRY_MS() }); save(); return; }
  gaveUp(channel, pr, rec, 'first', out);
}
function gaveUp(channel, pr, rec, which, out) {
  rec.failed = out.message || 'the relay did not say why.';
  save();
  const empty = which === 'empty';
  say(channel, empty ? 'The review of PR ' + number(pr) + ' came back empty twice. Press Get a review on its session.' : 'The ' + which + ' review of PR ' + number(pr) + ' could not start ' + MAX_TRIES + ' times: ' + rec.failed + ' Press Get a review on its session.', 'off');
  delivery.save(channel, { key: 'review-limit ' + pr, to: 'lead', expiresAt: Date.now() + LEAD_KEEP,
    text: empty ? 'The review of PR ' + pr + ' came back empty twice, so its review waits on the person. Tell them it is theirs to review or to start a review with Get a review.' : 'The automatic review of PR ' + pr + ' could not start ' + MAX_TRIES + ' times (' + rec.failed + '), so its review waits on the person. Tell them it is theirs to review or to start a review with Get a review.' });
}
async function history(channel, pr, used) {
  try {
    const got = await prComments.itemsOf(pr);
    if (got.failed) return '';
    return reviewHistory.text(got.items, { earlier: await reviewHistory.earlierOf(tasks.list(channel).find((t) => t.pr === pr), pr, door.pr), budget: Math.min(5500, 7800 - used) });
  } catch (e) { return ''; }
}
async function followUp(channel, pr, from) {
  const rec = recOf(channel, pr), p = rec.pending;
  rec.pending = null;
  if (!p.again) rec.count += 1;
  save();
  const base = followBrief(pr, autopilot.since(channel, pr)) + autopilot.ask(channel);
  const out = await startReview(channel, { from, pr, prompt: base + await history(channel, pr, base.length), unlessAt: p.again ? undefined : rec.head });
  if (out.ok && !out.unchanged) { startedNews(channel, out, 'a follow-up review of PR ' + number(pr)); return; }
  if (!p.again) rec.count = Math.max(0, rec.count - 1);
  if (out.ok) { save(); say(channel, 'PR ' + number(pr) + ' has no new commits since its last review, so no follow-up review started.'); return; }
  if (out.error === 'unrelated') { save(); return; }
  if (out.error === 'full') { needsDesk(channel, pr, rec, p); return; }
  const tries = (p.tries || 0) + 1;
  if (tries >= MAX_TRIES) { gaveUp(channel, pr, rec, 'follow-up', out); return; }
  if (!rec.pending) rec.pending = Object.assign({}, p, { tries, notBefore: Date.now() + RETRY_MS() });
  save();
}
function needsDesk(channel, pr, rec, p) {
  rec.pending = Object.assign({}, p, { desk: true });
  save();
  if (!p.desk) say(channel, 'No desk is free for the follow-up review of PR ' + number(pr) + '. It starts once a desk is free.', 'wait');
}
function waitOnPerson(channel, pr) {
  const rec = recOf(channel, pr);
  rec.pending = null;
  if (rec.waits) { save(); return; }
  rec.waits = true; save();
  say(channel, 'PR ' + number(pr) + ' has had ' + MAX_AUTO_REVIEWS() + ' automatic reviews, and has new commits. Press Get a review on its session for another.', 'off');
  delivery.save(channel, { key: 'review-limit ' + pr, to: 'lead', expiresAt: Date.now() + LEAD_KEEP,
    text: 'PR ' + pr + ' has had ' + MAX_AUTO_REVIEWS() + ' automatic reviews and has new commits since the last one, so its next review waits on the person. Tell them it is theirs to review or to start a review with Get a review.' });
}

function passes(channel, pr, rec, held, lastHead) {
  if (!pipeline.on()) { rec.why = null; return true; }
  const p = pipeline.of(pr);
  const g = pipeline.gate(p, { heldAt: held.at, lastHead, now: Date.now(), grace: config.get('pipelineNoChecksSeconds') * 1000 });
  rec.why = g.go ? null : g.why;
  if (g.gone) { gone(channel, pr, rec, g.why); return false; }
  if (g.go) {
    if (rec.red) { rec.red = null; delivery.drop(channel, 'pipeline ' + pr); save(); }
    if (g.why) say(channel, 'PR ' + number(pr) + ': ' + g.why);
    return true;
  }
  if (g.red && rec.red !== p.head) failed(channel, pr, rec, held, p.head);
  return false;
}
function gone(channel, pr, rec, why) {
  delivery.drop(channel, 'pipeline ' + pr);
  if (rec.first && !rec.count && !rec.head) delete chOf(channel).prs[pr];
  else { delete rec.first; rec.pending = null; rec.why = null; }
  save();
  say(channel, 'No review of PR ' + number(pr) + ': ' + why);
}
function failed(channel, pr, rec, held, head) {
  rec.red = head; save();
  const dev = held.dev && terminal.find(channel, held.dev);
  const after = ' The review starts once a push turns it green.';
  if (!dev) { say(channel, 'The pipeline failed on PR ' + number(pr) + ', so no review started, and nobody could be told: its Dev\'s session has ended.' + after, 'off'); return; }
  delivery.save(channel, { key: 'pipeline ' + pr, terminal: dev.id, sessionId: dev.sessionId, expiresAt: Date.now() + LEAD_KEEP,
    text: 'The pipeline failed on ' + pr + ', so its review has not started. Run gh pr checks ' + pr + ' to see which check failed, fix it on your branch and push. The review starts once the checks pass.' });
  say(channel, 'The pipeline failed on PR ' + number(pr) + ', so no review started. Its Dev was told.' + after, 'off', dev.id);
}
const watched = (channel, r) => r.first || r.pending || (r.head && !r.closed && followsPushes(channel));
pipeline.watch(() => Object.entries(store).flatMap(([channel, c]) => Object.entries((c && c.prs) || {}).filter(([, r]) => watched(channel, r)).map(([pr, r]) => ({ pr, cwd: (r.first || r.pending || r).from || null }))));
function holdFirst(channel, pr, from, t) {
  chOf(channel).prs[pr] = { count: 0, head: null, pending: null, waits: false, from, first: { from, dev: t ? t.id : null, at: Date.now() } };
  save();
  pipeline.soon(pr, from);
  say(channel, 'PR ' + number(pr) + ' is open. Its review starts once its pipeline passes.', 'wait');
}
function queueFirst(channel, pr, from, t) {
  if (pipeline.on()) holdFirst(channel, pr, from, t); else firstReview(channel, pr, { from, dev: t ? t.id : null, at: Date.now() });
}
const startingIn = (channel) => [...starting].filter((k) => k.startsWith(channel + ' ')).length;
const deskFree = (channel) => terminal.all(channel).filter((t) => !t.exited).length + startingIn(channel) < terminal.DESKS;
const byWait = ([, a], [, b]) => ((a.first && a.first.at) || 0) - ((b.first && b.first.at) || 0);
function firstReviews(channel, c) {
  for (const [pr, r] of Object.entries(c.prs).sort(byWait)) {
    if (!r.first || starting.has(channel + ' ' + pr)) continue;
    if (!switchesOf(channel).auto) { delete c.prs[pr]; delivery.drop(channel, 'pipeline ' + pr); save(); continue; }
    if (r.first.desk ? !deskFree(channel) : Date.now() < (r.first.notBefore || 0)) continue;
    if (!passes(channel, pr, r, r.first, null) || !r.first) continue;
    firstReview(channel, pr, r.first);
  }
}

const deskWaitOf = (r) => (r.first && r.first.desk ? r.first : r.pending && r.pending.desk ? r.pending : null);
function deskQueue(channel) {
  const c = store[channel];
  if (!c || !c.prs) return [];
  return Object.entries(c.prs).filter(([pr, r]) => deskWaitOf(r) && !starting.has(channel + ' ' + pr))
    .sort(([, a], [, b]) => (deskWaitOf(a).at || 0) - (deskWaitOf(b).at || 0)).map(([pr]) => pr);
}
function waiting(channel) {
  const c = store[channel];
  if (!c || !c.prs) return [];
  const at = (r) => ((r.first || r.pending).at || 0);
  return Object.entries(c.prs).filter(([pr, r]) => (r.first || r.pending) && !r.why && !r.failed && !r.waits && !starting.has(channel + ' ' + pr))
    .sort(([, a], [, b]) => at(a) - at(b)).map(([pr]) => pr);
}
const unposted = (channel, pr) => terminal.all(channel).some((t) => !t.exited && isReviewer(t) && (t.reviewOf || t.pr) === pr && !t.posted);
const owesReview = (channel, pr) => { const r = recOf(channel, pr); return !!(r && (r.first || r.pending)) || starting.has(channel + ' ' + pr) || unposted(channel, pr); };
const unpostedLive = (channel, pr) => terminal.all(channel).some((t) => !t.exited && isReviewer(t) && (t.reviewOf || t.pr) === pr && !t.posted && livenessOf(t, Date.now()).state !== 'gone');
function owes(channel, pr) { return starting.has(channel + ' ' + pr) || unpostedLive(channel, pr) || waiting(channel).includes(pr); }
const deadlocks = new Map(), endingSince = new WeakMap();
function makeRoom(channel, now) {
  const queue = deskQueue(channel);
  if (!queue.length || deskFree(channel)) { deadlocks.delete(channel); return; }
  const ending = terminal.all(channel).filter((t) => !t.exited && t.stopped);
  for (const t of ending) if (!endingSince.has(t)) endingSince.set(t, now);
  if (ending.some((t) => now - endingSince.get(t) < ENDING_WAIT)) return;
  const pr = queue[0], rec = recOf(channel, pr);
  const row = require('./floor.js').freeForReview(channel, now, (p) => owesReview(channel, p), 'for the review of PR ' + number(pr));
  if (row) {
    deadlocks.delete(channel);
    rec.freed = 'The relay stopped ' + row.name + ' (' + row.role + (row.task ? ', task ' + row.task : '') + ') to free a desk for its review: ' + row.why + '.';
    save();
    say(channel, 'The relay stopped ' + row.name + ' (' + row.role + (row.task ? ', task ' + row.task : '') + ') to free a desk for the review of PR ' + number(pr) + ': ' + row.why + '.', 'wait');
    autopilot.freed(channel, pr, rec.freed);
    return;
  }
  if (!deadlocks.has(channel) || deadlocks.get(channel).prs[0] !== pr) say(channel, 'No desk is free for the review of PR ' + number(pr) + ', and the relay may stop no session for it. Stop one yourself.', 'off');
  deadlocks.set(channel, { prs: queue, taken: terminal.all(channel).filter((t) => !t.exited).length });
}
function deadlockOf(channel) {
  const d = deadlocks.get(channel);
  return d && deskQueue(channel).length && !deskFree(channel) ? d : null;
}
function deskLine(channel, pr) {
  const r = recOf(channel, pr);
  if (!r || !deskWaitOf(r)) return null;
  const d = deadlockOf(channel);
  if (d && d.prs.includes(pr)) return 'Its review waits for a desk: all ' + d.taken + ' are taken, and the relay may stop none of them.';
  return r.freed || 'Its review waits for a desk.';
}

const devOf = (channel, pr) => terminal.all(channel).find((t) => !t.exited && !isReviewer(t) && prOf(channel, t) === pr) || null;
function startText(pr, commit, name) {
  return 'A review of your PR ' + pr + ' started. ' + (name || 'A reviewer') + ' is reviewing commit ' + (commit || 'unknown') +
    '. You need not do anything now. Its findings come as a comment on the PR.';
}
function tellStarts(now) {
  for (const s of begun.slice()) {
    const r = terminal.find(s.channel, s.reviewer);
    begun.splice(begun.indexOf(s), 1);
    const dev = devOf(s.channel, s.pr), name = r && r.who;
    if (!dev) { if (ctx) ctx.log('A review of ' + s.pr + ' started, and no Dev\'s session holds that PR to tell.'); continue; }
    delivery.save(s.channel, { key: 'review-start ' + s.pr, terminal: dev.id, sessionId: dev.sessionId, expiresAt: now + START_KEEP, text: startText(s.pr, s.commit, name) });
  }
}

const reviewing = (channel, pr) => starting.has(channel + ' ' + pr) || terminal.all(channel).some((t) => !t.exited && isReviewer(t) && (t.reviewOf || t.pr) === pr);
function owedFollowUps(channel, c) {
  if (!pipeline.on()) return;
  const follows = followsPushes(channel), max = MAX_AUTO_REVIEWS();
  for (const [pr, rec] of Object.entries(c.prs)) {
    const seen = pipeline.of(pr);
    if (seen && (seen.open === false) !== !!rec.closed) { if (seen.open === false) rec.closed = true; else delete rec.closed; save(); }
    const owed = followUpOwed(rec, seen, { follows, reviewing: reviewing(channel, pr), max });
    if (owed === 'person') { waitOnPerson(channel, pr); continue; }
    if (owed !== 'review') continue;
    const dev = devOf(channel, pr), task = tasks.list(channel).find((x) => x.pr === pr);
    const from = (dev && dev.cwd) || rec.from || (task && task.repo);
    if (!from) continue;
    rec.pending = { from, dev: dev ? dev.id : null, session: dev ? dev.sessionId : null, at: Date.now(), tries: 0 };
    rec.queued = seen.head; rec.why = null;
    save();
  }
}

function tick() {
  if (!ctx) return;
  tellStarts(Date.now());
  for (const [channel, c] of Object.entries(store)) {
    if (!c || !c.prs) continue;
    firstReviews(channel, c);
    owedFollowUps(channel, c);
    const pending = new Map(Object.entries(c.prs).filter(([pr, r]) => r.pending && !starting.has(channel + ' ' + pr)).map(([pr, r]) => [pr, r.pending]));
    if (!pending.size) continue;
    if (!followsPushes(channel)) {
      for (const [pr, p] of pending) if (!p.watch) { c.prs[pr].pending = null; delete c.prs[pr].queued; pending.delete(pr); }
      save();
      if (!pending.size) continue;
    }
    const terms = terminal.all(channel).map((t) => ({ id: t.id, sessionId: t.sessionId, running: true, state: t.state, role: isReviewer(t) ? 'reviewer' : t.role, pr: t.reviewOf || t.pr }));
    const counts = Object.fromEntries(Object.entries(c.prs).map(([pr, r]) => [pr, r.count]));
    const { start, full } = followUps(pending, terms, counts, Date.now(), MAX_AUTO_REVIEWS());
    for (const pr of full) waitOnPerson(channel, pr);
    for (const s of start) {
      const rec = c.prs[s.pr];
      if (!passes(channel, s.pr, rec, rec.pending, rec.head) || !rec.pending) continue;
      if (deskFree(channel)) followUp(channel, s.pr, s.from); else needsDesk(channel, s.pr, rec, rec.pending);
    }
  }
  for (const channel of Object.keys(store)) makeRoom(channel, Date.now());
}

function noteHook(channel, ev) {
  if (!terminal.ENABLED || !ev || !ctx) return;
  const t = sessionOf(channel, ev);
  if (t && isReviewer(t)) return;
  if (ev.pr_url && PR_URL.test(ev.pr_url)) {
    if (t) opened.set(t.id, ev.pr_url);
    const from = ev.cwd || (t && t.cwd), pr = ev.pr_url;
    const owed = () => from && switchesOf(channel).auto && !recOf(channel, pr);
    if (owed() && t) queueFirst(channel, pr, from, t);
    else if (owed()) {
      checkouts.roomKnows(channel, pr).then((known) => {
        if (!known) ctx.log('PR ' + pr + ' is not of a repo the room works in, so it gets no automatic review.');
        else if (owed()) queueFirst(channel, pr, from, null);
      }).catch((e) => ctx.log('No review of ' + pr + ': ' + e.message));
    }
  }
  if (ev.pushed && t) {
    const pr = prOf(channel, t), rec = pr && recOf(channel, pr);
    if (rec && rec.first) { rec.first.dev = t.id; save(); pipeline.soon(pr, t.cwd); }
    else if (rec && followsPushes(channel) && pipeline.on()) { rec.from = t.cwd; save(); pipeline.soon(pr, t.cwd); }
    else if (rec && followsPushes(channel)) { rec.from = t.cwd; rec.pending = { from: t.cwd, dev: t.id, session: t.sessionId, at: Date.now(), tries: 0 }; rec.why = null; save(); }
  }
  tick();
}

checkouts.onReview((channel, pr, commit, reviewer) => {
  begun.push({ channel, pr, commit, reviewer, at: Date.now() });
  const c = chOf(channel);
  const rec = c.prs[pr] || (c.prs[pr] = { count: 0, head: null, pending: null, waits: false });
  rec.head = commit; rec.reviewedAt = Date.now(); delete rec.freed;
  if (rec.failed) { delete rec.failed; delivery.drop(channel, 'review-limit ' + pr); }
  if (!starting.has(channel + ' ' + pr)) { rec.waits = false; delete rec.first; rec.why = null; delivery.drop(channel, 'review-limit ' + pr); delivery.drop(channel, 'pipeline ' + pr); }
  save();
});

const workOf = tasks.workOf;
terminal.onWork((channel, t) => {
  const work = workOf(channel, t);
  if (isReviewer(t)) return work;
  const pr = (work && work.pr) || opened.get(t.id);
  const rec = pr && recOf(channel, pr);
  if (!rec || !(rec.waits || rec.failed)) return work;
  return Object.assign({ role: null, ticket: null, ticketAt: null, label: null }, work, { pr, reviewWaits: true });
});

const refuse = (status, error, message) => [status, { ok: false, error, message }];
async function leadReview(channel, body, agent) {
  if (!config.get('leadReviews') && !autopilot.follows(channel)) return refuse(403, 'forbidden', 'The person has not let the Lead start reviews. They turn it on with Let the Lead start reviews in Settings, or turn on Autopilot. Until then, tell them which PR needs a review, so they press Get a review. Never review it in your own session.');
  if (!agent.lead || !terminal.all(channel).includes(agent)) return refuse(403, 'forbidden', 'This session is no longer running as the Lead.');
  const pr = String((body && body.pr) || '').trim();
  if (!PR_URL.test(pr)) return refuse(400, 'bad_pr', 'A PR link looks like https://github.com/owner/repo/pull/1.');
  const task = tasks.list(channel).find((x) => x.pr === pr);
  if (!task) return refuse(404, 'not_a_task', pr + ' is not the PR of any task on the Board, so the relay does not review it. The person can press Get a review.');
  if (reviewing(channel, pr)) return refuse(409, 'reviewing', 'A reviewer is already reviewing ' + pr + '. Wait for it to post.');
  if (!deskFree(channel)) return refuse(409, 'full', 'No desk is free for a reviewer. Wait for one, or stop a session that is done.');
  const c = chOf(channel), max = MAX_AUTO_REVIEWS();
  if (((c.prs[pr] && c.prs[pr].count) || 0) >= max) return refuse(409, 'limit', pr + ' has had ' + max + ' reviews the relay started, the limit for one PR. Its next review is the person\'s: tell them, so they review it or press Get a review.');
  const fresh = !c.prs[pr], rec = c.prs[pr] || (c.prs[pr] = { count: 0, head: null, pending: null, waits: false });
  const dev = devOf(channel, pr), from = (dev && dev.cwd) || rec.from || task.repo;
  rec.count = (rec.count || 0) + 1; rec.from = from;
  const held = { first: rec.first, pending: rec.pending };
  delete rec.first; rec.pending = null; rec.why = null;
  save();
  const out = await startReview(channel, { from, pr, prompt: prBrief(pr) + autopilot.ask(channel), by: 'Lead' });
  if (!out.ok) {
    if (fresh && !rec.head && c.prs[pr] === rec) delete c.prs[pr];
    rec.count = Math.max(0, rec.count - 1);
    if (held.first && !rec.head) rec.first = held.first;
    if (held.pending && !rec.pending) rec.pending = held.pending;
    save();
    return refuse(out.error === 'full' ? 409 : 502, out.error || 'not_started', 'The review of ' + pr + ' did not start: ' + (out.message || 'the relay did not say why.'));
  }
  delivery.drop(channel, 'pipeline ' + pr);
  tasks.record(task, { type: 'review_asked', by: 'Lead' }); tasks.save();
  startedNews(channel, out, 'a review of PR ' + number(pr) + ' that the Lead asked for');
  ctx.log('The Lead asked for a review of ' + pr + ' (' + rec.count + ' of ' + max + ').');
  return [201, { ok: true, pr, reviewer: out.who || null, id: out.id, count: rec.count, max }];
}

function view(channel) {
  const c = chOf(channel), s = switchesOf(channel);
  const prs = Object.entries(c.prs).map(([pr, r]) => ({ pr, count: r.count, head: r.head, pending: !!r.pending, waits: !!r.waits, held: !!r.first, desk: !!(r.first && r.first.desk), failed: r.failed || null, pipeline: (r.first || r.pending) && pipeline.on() ? pipeline.summary(pr) : null, why: r.why || null }));
  return { ok: true, auto: s.auto, again: s.again, max: MAX_AUTO_REVIEWS(), prs, news: news.get(channel) || [] };
}
async function handle(req, res, channel, rest, rctx) {
  if (!/^\/reviews(\/|$)/.test(rest)) return false;
  const lead = rest === '/reviews/lead' && req.method === 'POST';
  if (!lead && (rest !== '/reviews' || !['GET', 'POST'].includes(req.method))) { rctx.problem(res, 404, 'not_found', 'Unknown reviews route.'); return true; }
  const deny = terminal.localOnly(req, rctx.port);
  if (deny) { rctx.problem(res, 403, 'local_only', deny); return true; }
  if (!terminal.ENABLED) { rctx.problem(res, 404, 'terminal_off', 'Automatic reviews need the terminal. Start the relay with npm run office, or with RELAY_TERMINAL=1.'); return true; }
  if (lead) {
    if (!rctx.agent) { rctx.problem(res, 403, 'forbidden', 'Only the Lead asks here, with ticket.js review. Press Get a review on a session instead.'); return true; }
    const [status, out] = await leadReview(channel, await rctx.readJson(req), rctx.agent);
    rctx.send(res, status, out);
    return true;
  }
  if (req.method === 'POST') {
    const body = await rctx.readJson(req), c = chOf(channel);
    for (const k of ['auto', 'again']) {
      if (body[k] === undefined) continue;
      if (typeof body[k] !== 'boolean') { rctx.problem(res, 400, 'bad_param', '"' + k + '" is true or false.'); return true; }
      c[k] = body[k];
      rctx.log((k === 'auto' ? 'Review PRs automatically' : 'Review again after each push') + ' is ' + (body[k] ? 'on' : 'off') + ' on ' + channel);
    }
    if (!followsPushes(channel)) for (const r of Object.values(c.prs)) if (r.pending && !r.pending.watch) { r.pending = null; delete r.queued; }
    save();
  }
  rctx.send(res, 200, view(channel));
  return true;
}

function begin(relayCtx) {
  ctx = relayCtx;
  pipeline.begin();
  setInterval(tick, TICK).unref();
}

function stateOf(channel, pr) {
  const r = recOf(channel, pr), running = reviewing(channel, pr);
  if (!r) return switchesOf(channel).auto ? (running ? { head: null, running } : null) : { head: null, running, off: true };
  return { head: r.head || null, running, waits: !!r.waits, failed: !!r.failed, held: !!(r.first || r.pending), off: !switchesOf(channel).auto, red: r.red || null };
}
function owesFirst(channel, pr) {
  return !!ctx && terminal.ENABLED && PR_URL.test(pr) && switchesOf(channel).auto && !reviewing(channel, pr) && !recOf(channel, pr);
}
function owe(channel, pr, { from, dev, head }) {
  if (!terminal.ENABLED || !ctx || !PR_URL.test(pr) || !from) return 'no review: nothing to make its checkout from';
  if (reviewing(channel, pr)) return 'a review runs';
  if (!switchesOf(channel).auto) return 'Review PRs automatically is off';
  const rec = recOf(channel, pr);
  if (!rec) {
    queueFirst(channel, pr, from, dev);
    return 'its first review';
  }
  if (rec.first || rec.pending) return 'a review waits to start';
  if (rec.head === head) return 'a review read it';
  if (rec.waits || rec.failed) return 'its next review is the person\'s';
  if ((rec.count || 0) >= MAX_AUTO_REVIEWS()) { waitOnPerson(channel, pr); return 'its automatic reviews are used up'; }
  rec.pending = { from, dev: dev ? dev.id : null, session: dev ? dev.sessionId : null, at: Date.now(), tries: 0, watch: true };
  rec.queued = head; rec.from = from; rec.why = null;
  save();
  return 'a follow-up review';
}

tasks.events.on('found', (channel, task) => {
  if (recOf(channel, task.pr)) { if (ctx) ctx.log('PR ' + task.pr + ' found by its branch already has a review record.'); return; }
  const dev = terminal.find(channel, task.owner && task.owner.terminal);
  const what = owe(channel, task.pr, { from: (dev && dev.cwd) || task.worktree || task.repo, dev, head: null });
  if (ctx) ctx.log('PR ' + task.pr + ' found by its branch: ' + what + '.');
});

function deskOf(channel, pr) {
  const r = pr && recOf(channel, pr);
  const desk = !!(r && deskWaitOf(r)), retry = !desk && !!(r && r.first && r.first.tries);
  return r ? { count: r.count || 0, waits: !!r.waits, held: !desk && !retry && !!(r.first || (r.pending && r.why)), desk, retry, failed: !!r.failed } : null;
}

function reviewCounted(channel, pr) {
  const rec = recOf(channel, pr);
  if (rec && rec.empties) { delete rec.empties; save(); }
}
function reviewEmpty(channel, pr) {
  const rec = recOf(channel, pr);
  if (!rec) return false;
  rec.empties = (rec.empties || 0) + 1;
  if (rec.empties >= 2) { gaveUp(channel, pr, rec, 'empty', { message: 'the review came back empty.' }); return false; }
  if (rec.first || rec.pending) { save(); say(channel, 'The review of PR ' + number(pr) + ' came back empty. A review already waits to start.', 'wait'); return true; }
  const dev = devOf(channel, pr), from = (dev && dev.cwd) || rec.from;
  if (!from) { gaveUp(channel, pr, rec, 'empty', { message: 'the review came back empty.' }); return false; }
  rec.pending = { from, dev: dev ? dev.id : null, session: dev ? dev.sessionId : null, at: Date.now(), tries: 0, watch: true, again: true };
  rec.why = null;
  save();
  say(channel, 'The review of PR ' + number(pr) + ' came back empty. A new review starts.', 'wait');
  return true;
}

const failedOf = (channel, pr) => { const r = pr && recOf(channel, pr); return (r && r.failed) || null; };

module.exports = { handle, noteHook, begin, useAutopilot, deskOf, stateOf, owe, owesFirst, owes, waiting, deskQueue, deskLine, deadlockOf, failedOf, reviewCounted, reviewEmpty };
