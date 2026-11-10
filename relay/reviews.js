// Automatic reviews: the relay, not the page, starts them, so they start while the page is closed.
// See docs/manual/roles.html#auto-review.
//
//   The first review. A session runs gh pr create, and its hook sends the PR. While Review PRs
//   automatically is on (it starts on), the relay starts a reviewer in its own checkout of the PR,
//   once the PR's pipeline is green (relay/pipeline.js).
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
//
// Every review that starts, first, follow-up or Get a review, is told to the PR's Dev as a saved message:
// the PR, the commit the reviewer reads, and the reviewer's name. The relay names each session as it
// starts it (relay/seats.js). With no roster there is no name, and the message says A reviewer.
//
// Each PR gets at most MAX_AUTO_REVIEWS automatic reviews, the first one included. A push after that
// waits on the person: the Floor says so, and the Lead gets a saved message. Get a review is the
// person's own and is not counted, though it asks for a verdict like an automatic review. Which review starts, and when, is office/reviews.js, which the page
// also loads for Get a review. The switches, the counts and the commit each PR's last review read are
// kept in RELAY_REVIEWS_FILE, so a restart keeps them.
//
// Like the terminal, the route answers only the room page on this machine, while RELAY_TERMINAL=1.
'use strict';
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const checkouts = require('./checkouts.js');
const delivery = require('./delivery.js');
const { claim } = require('./lockfile.js');
const { PR_URL, prBrief, followBrief, followUps, followUpOwed } = require('../office/reviews.js');
const config = require('./config.js');
const pipeline = require('./pipeline.js');
const MAX_AUTO_REVIEWS = () => config.get('maxAutoReviews');  // read at each use (Settings)

const FILE = state.file('reviews.json', 'RELAY_REVIEWS_FILE');
const RETRY_MS = () => config.get('reviewRetrySeconds') * 1000, MAX_TRIES = 3;  // a review that could not start, for example with every desk taken
const TICK = 1000, NEWS_KEPT = 20, LEAD_KEEP = 12 * 60 * 60 * 1000;
const START_KEEP = 60 * 60 * 1000;

// ---------- the store: { channel: { auto, again, prs: { pr: { count, head, pending, waits } } } } ----------
// count: automatic reviews started. head: the commit the last review read, and reviewedAt when it began.
// pending: a push waiting for its review, { from, dev, session, at, tries, notBefore }: dev is the Dev's desk,
// and session its session id, which finds it after a restart brings it back at a new desk. waits: past the limit, so
// the next review is the person's. queued: the head a follow-up was last queued for from the PR's state.
// from: a folder to make the PR's checkout from. closed: the pipeline heard it merged or closed.
// first: a new PR whose first review waits for its pipeline, { from, dev, at }, or could not start: then
// also { desk: true } while it waits for a free desk, or { tries, notBefore } before it tries again.
// failed: why the first review could not start MAX_TRIES times, so the next review is the person's. red: the commit whose
// failed pipeline its Dev was told about, so they are told once.
const ownsFile = claim(FILE);
let store = {};
if (ownsFile) try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') {  // keep a file we cannot read, rather than writing over it
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
  } catch (e) { console.error('Could not save reviews to ' + FILE + ': ' + e.message); }
}
const chOf = (channel) => store[channel] || (store[channel] = { prs: {} });
// Autopilot (relay/autopilot.js): while it is on, every push gets its follow-up. Each review of a PR asks for
// a verdict, Get a review too, so a clean one counts for Autopilot.
let autopilot = { follows: () => false, ask: () => '', since: () => null };
const useAutopilot = (a) => { autopilot = a; checkouts.useAsk((channel) => a.ask(channel)); };
const followsPushes = (channel) => switchesOf(channel).again || autopilot.follows(channel);
const switchesOf = (channel) => { const c = chOf(channel); return { auto: c.auto !== false, again: c.again === true }; };
const recOf = (channel, pr) => chOf(channel).prs[pr] || null;
const number = (pr) => '#' + pr.split('/').pop();

// What only this run needs: the PR each session opened, the reviews being made now, and news for the page.
const opened = new Map();  // terminal id -> PR link, for a session with no task to hold it
const starting = new Set();  // channel + ' ' + PR
const news = new Map();  // channel -> [{ seq, at, text, state }]
const begun = [];  // reviews that started and whose Dev is not told yet: { channel, pr, commit, reviewer, at }
let newsSeq = 0, ctx = null;
// News for the page, which shows each once. id is the reviewer it is about.
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

// ---------- starting one ----------
// The same route Get a review uses, so the same checkout, and the reviewer leaves once it has posted.
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
// The page puts the reviewer's name in place of "A reviewer", once it has given them one.
const startedNews = (channel, out, what) => say(channel, 'A reviewer is starting ' + what + '. Click them to watch.', 'wait', out.id);
// held is what rec.first kept: { from, dev, at }, and after a failed start also tries, notBefore and desk.
async function firstReview(channel, pr, held) {
  const c = chOf(channel);
  c.prs[pr] = { count: 1, head: null, pending: null, waits: false, from: held.from };  // counted now, so a second hook cannot start it twice
  save();
  const out = await startReview(channel, { from: held.from, pr, prompt: prBrief(pr) + autopilot.ask(channel) });
  if (out.ok) { startedNews(channel, out, 'a review of PR ' + number(pr)); return; }
  const rec = c.prs[pr];
  if (!rec) return;  // the person's Get a review took its place
  rec.count = Math.max(0, rec.count - 1);
  if (rec.count || rec.head) { save(); return; }  // a review started some other way
  // No desk free: it waits for one, with no limit, since a desk always comes free in the end.
  if (out.error === 'full') {
    rec.first = Object.assign({}, held, { desk: true });
    save();
    if (!held.desk) say(channel, 'No desk is free for the review of PR ' + number(pr) + '. It starts once a desk is free.', 'wait');
    return;
  }
  const tries = (held.tries || 0) + 1;
  if (tries < MAX_TRIES) { rec.first = Object.assign({}, held, { desk: false, tries, notBefore: Date.now() + RETRY_MS() }); save(); return; }
  // It gave up: the PR waits on the person until a review of it starts, as past the limit.
  rec.failed = out.message || 'the relay did not say why.';
  save();
  say(channel, 'The first review of PR ' + number(pr) + ' could not start ' + MAX_TRIES + ' times: ' + rec.failed + ' Press Get a review on its session.', 'off');
  delivery.save(channel, { key: 'review-limit ' + pr, to: 'lead', expiresAt: Date.now() + LEAD_KEEP,
    text: 'The automatic review of PR ' + pr + ' could not start ' + MAX_TRIES + ' times (' + rec.failed + '), so its review waits on the person. Tell them it is theirs to review or to start a review with Get a review.' });
}
async function followUp(channel, pr, from) {
  const rec = recOf(channel, pr), p = rec.pending;
  rec.pending = null; rec.count += 1;  // counted now, so the next tick cannot start it twice
  save();
  const out = await startReview(channel, { from, pr, prompt: followBrief(pr, autopilot.since(channel, pr)) + autopilot.ask(channel), unlessAt: rec.head });
  if (out.ok && !out.unchanged) { startedNews(channel, out, 'a follow-up review of PR ' + number(pr)); return; }
  rec.count = Math.max(0, rec.count - 1);
  if (out.ok) { save(); say(channel, 'PR ' + number(pr) + ' has no new commits since its last review, so no follow-up review started.'); return; }
  const tries = (p.tries || 0) + 1;
  if (tries >= MAX_TRIES) say(channel, 'The follow-up review of PR ' + number(pr) + ' could not start ' + MAX_TRIES + ' times: ' + (out.message || '') + ' Press Get a review on its session.', 'off');
  else if (!rec.pending) rec.pending = Object.assign({}, p, { tries, notBefore: Date.now() + RETRY_MS() });  // a newer push waits on its own
  save();
}
// Past the limit: the PR waits on the person. The Floor shows it, and the Lead is told once.
function waitOnPerson(channel, pr) {
  const rec = recOf(channel, pr);
  rec.pending = null;
  if (rec.waits) { save(); return; }
  rec.waits = true; save();
  say(channel, 'PR ' + number(pr) + ' has had ' + MAX_AUTO_REVIEWS() + ' automatic reviews, and has new commits. Press Get a review on its session for another.', 'off');
  delivery.save(channel, { key: 'review-limit ' + pr, to: 'lead', expiresAt: Date.now() + LEAD_KEEP,
    text: 'PR ' + pr + ' has had ' + MAX_AUTO_REVIEWS() + ' automatic reviews and has new commits since the last one, so its next review waits on the person. Tell them it is theirs to review or to start a review with Get a review.' });
}

// ---------- waiting for the pipeline ----------
// Whether a review that waits can start now. held is rec.first or rec.pending. lastHead is the commit the
// last review read, for a follow-up. A red pipeline is told to the Dev once for each commit.
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
// A PR that merged or closed while its review waited gets no review.
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
// PRs whose review waits are asked about until it starts. While a channel follows pushes, so is each
// reviewed PR that is still open, so its head is known without a hook.
const watched = (channel, r) => r.first || r.pending || (r.head && !r.closed && followsPushes(channel));
pipeline.watch(() => Object.entries(store).flatMap(([channel, c]) => Object.entries((c && c.prs) || {}).filter(([, r]) => watched(channel, r)).map(([pr, r]) => ({ pr, cwd: (r.first || r.pending || r).from || null }))));
// A new PR whose first review waits for its pipeline.
function holdFirst(channel, pr, from, t) {
  chOf(channel).prs[pr] = { count: 0, head: null, pending: null, waits: false, from, first: { from, dev: t ? t.id : null, at: Date.now() } };  // there now, so a second hook cannot hold it twice
  save();
  pipeline.soon(pr, from);
  say(channel, 'PR ' + number(pr) + ' is open. Its review starts once its pipeline passes.', 'wait');
}
const deskFree = (channel) => terminal.all(channel).filter((t) => !t.exited).length < terminal.DESKS;
function firstReviews(channel, c) {
  for (const [pr, r] of Object.entries(c.prs)) {
    if (!r.first || starting.has(channel + ' ' + pr)) continue;
    if (!switchesOf(channel).auto) { delete c.prs[pr]; delivery.drop(channel, 'pipeline ' + pr); save(); continue; }  // turned off while it waited
    if (r.first.desk ? !deskFree(channel) : Date.now() < (r.first.notBefore || 0)) continue;  // it could not start before: wait for a desk, or for the next try
    if (!passes(channel, pr, r, r.first, null) || !r.first) continue;
    firstReview(channel, pr, r.first);
  }
}

// ---------- telling the Dev that a review started ----------
// The Dev is the session, not a reviewer, whose PR this is: its task's PR, or the one it opened.
const devOf = (channel, pr) => terminal.all(channel).find((t) => !t.exited && !isReviewer(t) && prOf(channel, t) === pr) || null;
function startText(pr, commit, name) {
  return 'A review of your PR ' + pr + ' started. ' + (name || 'A reviewer') + ' is reviewing commit ' + (commit || 'unknown') +
    '. You need not do anything now. Its findings come as a comment on the PR.';
}
// A newer start of the same PR replaces an older one that is not typed yet, since the delivery key is the PR.
function tellStarts(now) {
  for (const s of begun.slice()) {
    const r = terminal.find(s.channel, s.reviewer);
    begun.splice(begun.indexOf(s), 1);
    const dev = devOf(s.channel, s.pr), name = r && r.who;
    if (!dev) { if (ctx) ctx.log('A review of ' + s.pr + ' started, and no Dev\'s session holds that PR to tell.'); continue; }
    delivery.save(s.channel, { key: 'review-start ' + s.pr, terminal: dev.id, sessionId: dev.sessionId, expiresAt: now + START_KEEP, text: startText(s.pr, s.commit, name) });
  }
}

// ---------- a follow-up owed from the PR's state ----------
// Each tick, a reviewed PR whose head moved gets its follow-up queued, as if its push had been heard
// (followUpOwed). Its Dev, whose turn it waits for, is the session that holds the PR now. The checkout
// is made from that session's folder, else from the folder the PR's reviews came from, else its task's repo.
const reviewing = (channel, pr) => starting.has(channel + ' ' + pr) || terminal.all(channel).some((t) => !t.exited && isReviewer(t) && (t.reviewOf || t.pr) === pr);
function owedFollowUps(channel, c) {
  if (!pipeline.on()) return;  // no heads are known
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

// Every second, and after each hook: the pushes whose review can start now.
function tick() {
  if (!ctx) return;
  tellStarts(Date.now());
  for (const [channel, c] of Object.entries(store)) {
    if (!c || !c.prs) continue;
    firstReviews(channel, c);
    owedFollowUps(channel, c);
    const pending = new Map(Object.entries(c.prs).filter(([pr, r]) => r.pending && !starting.has(channel + ' ' + pr)).map(([pr, r]) => [pr, r.pending]));
    if (!pending.size) continue;
    // A review the PR watch asked for (relay/pr-watch.js) starts while follow-ups are off. Others wait for the switch.
    if (!followsPushes(channel)) {
      for (const [pr, p] of pending) if (!p.watch) { c.prs[pr].pending = null; delete c.prs[pr].queued; pending.delete(pr); }
      save();
      if (!pending.size) continue;
    }
    const terms = terminal.all(channel).map((t) => ({ id: t.id, sessionId: t.sessionId, running: true, state: t.state, role: isReviewer(t) ? 'reviewer' : t.role, pr: t.reviewOf || t.pr }));
    const counts = Object.fromEntries(Object.entries(c.prs).map(([pr, r]) => [pr, r.count]));
    const { start, full } = followUps(pending, terms, counts, Date.now(), MAX_AUTO_REVIEWS());
    for (const pr of full) waitOnPerson(channel, pr);
    for (const s of start) { const rec = c.prs[s.pr]; if (passes(channel, s.pr, rec, rec.pending, rec.head) && rec.pending) followUp(channel, s.pr, s.from); }
  }
}

// ---------- what the hooks say ----------
// relay/server.js calls this after relay/tasks.js has recorded a task's PR, and after relay/terminal.js
// has set each session's state, so a Stop here is already idle.
function noteHook(channel, ev) {
  if (!terminal.ENABLED || !ev || !ctx) return;
  const t = sessionOf(channel, ev);
  if (t && isReviewer(t)) return;  // a reviewer is never reviewed
  if (ev.pr_url && PR_URL.test(ev.pr_url)) {
    if (t) opened.set(t.id, ev.pr_url);
    const from = ev.cwd || (t && t.cwd);
    if (from && switchesOf(channel).auto && !recOf(channel, ev.pr_url)) {
      if (pipeline.on()) holdFirst(channel, ev.pr_url, from, t); else firstReview(channel, ev.pr_url, { from, dev: t ? t.id : null, at: Date.now() });
    }
  }
  if (ev.pushed && t) {
    const pr = prOf(channel, t), rec = pr && recOf(channel, pr);
    if (rec && rec.first) { rec.first.dev = t.id; save(); pipeline.soon(pr, t.cwd); }  // the first review, still waiting, reads the latest commit anyway
    else if (rec && followsPushes(channel) && pipeline.on()) { rec.from = t.cwd; save(); pipeline.soon(pr, t.cwd); }  // the next tick compares the head GitHub has with the one last reviewed
    else if (rec && followsPushes(channel)) { rec.from = t.cwd; rec.pending = { from: t.cwd, dev: t.id, session: t.sessionId, at: Date.now(), tries: 0 }; rec.why = null; save(); }  // no heads are known: a newer push replaces an older one
  }
  tick();
}

// Every review relay/checkouts.js starts for a PR: the commit it read. One the relay did not start is
// a person's Get a review, which gives the PR a review to follow up, and takes it off the person.
checkouts.onReview((channel, pr, commit, reviewer) => {
  begun.push({ channel, pr, commit, reviewer, at: Date.now() });
  const c = chOf(channel);
  const rec = c.prs[pr] || (c.prs[pr] = { count: 0, head: null, pending: null, waits: false });
  rec.head = commit; rec.reviewedAt = Date.now();
  delete rec.failed;  // a review started, so the first one that could not start is no longer the person's
  // A person's review while the first one waits for the pipeline is that PR's first review.
  if (!starting.has(channel + ' ' + pr)) { rec.waits = false; delete rec.first; rec.why = null; delivery.drop(channel, 'review-limit ' + pr); delivery.drop(channel, 'pipeline ' + pr); }
  save();
});

// The Floor and the session list show a PR that waits on the person on its Dev's row.
const workOf = tasks.workOf;
terminal.onWork((channel, t) => {
  const work = workOf(channel, t);
  if (isReviewer(t)) return work;
  const pr = (work && work.pr) || opened.get(t.id);
  const rec = pr && recOf(channel, pr);
  if (!rec || !(rec.waits || rec.failed)) return work;
  return Object.assign({ role: null, ticket: null, ticketAt: null, label: null }, work, { pr, reviewWaits: true });
});

// ---------- routes under /channels/{channel}/reviews ----------
function view(channel) {
  const c = chOf(channel), s = switchesOf(channel);
  const prs = Object.entries(c.prs).map(([pr, r]) => ({ pr, count: r.count, head: r.head, pending: !!r.pending, waits: !!r.waits, held: !!r.first, desk: !!(r.first && r.first.desk), failed: r.failed || null, pipeline: (r.first || r.pending) && pipeline.on() ? pipeline.summary(pr) : null, why: r.why || null }));
  return { ok: true, auto: s.auto, again: s.again, max: MAX_AUTO_REVIEWS(), prs, news: news.get(channel) || [] };
}
async function handle(req, res, channel, rest, rctx) {
  if (!/^\/reviews(\/|$)/.test(rest)) return false;
  if (rest !== '/reviews' || !['GET', 'POST'].includes(req.method)) { rctx.problem(res, 404, 'not_found', 'Unknown reviews route.'); return true; }
  const deny = terminal.localOnly(req, rctx.port);
  if (deny) { rctx.problem(res, 403, 'local_only', deny); return true; }
  if (!terminal.ENABLED) { rctx.problem(res, 404, 'terminal_off', 'Automatic reviews need the terminal. Start the relay with npm run office, or with RELAY_TERMINAL=1.'); return true; }
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

// The relay calls this once it listens, with what starting a session needs.
function begin(relayCtx) {
  ctx = relayCtx;
  pipeline.begin();
  setInterval(tick, TICK).unref();
}

// ---------- for the PR watch (relay/pr-watch.js) ----------
// What the relay keeps about a PR's reviews, from memory only: the commit its last review read, whether one runs,
// whether its next review waits on the person (waits, failed), waits to start (held), or is off, and the head whose
// failed pipeline its Dev was told about (red). null: no record.
function stateOf(channel, pr) {
  const r = recOf(channel, pr), running = reviewing(channel, pr);
  if (!r) return switchesOf(channel).auto ? (running ? { head: null, running } : null) : { head: null, running, off: true };
  return { head: r.head || null, running, waits: !!r.waits, failed: !!r.failed, held: !!(r.first || r.pending), off: !switchesOf(channel).auto, red: r.red || null };
}
// The PR watch saw that no review read the PR's head, and asks for one. A PR with no record gets its first review, as
// if its hook had been heard. One with a record gets a follow-up, counted against the limit like any other, even
// while Review again after each push is off. dev is its Dev's session, or null. Returns what happened, in words.
function owe(channel, pr, { from, dev, head }) {
  if (!terminal.ENABLED || !ctx || !PR_URL.test(pr) || !from) return 'no review: nothing to make its checkout from';
  if (reviewing(channel, pr)) return 'a review runs';
  if (!switchesOf(channel).auto) return 'Review PRs automatically is off';
  const rec = recOf(channel, pr);
  if (!rec) {
    if (pipeline.on()) holdFirst(channel, pr, from, dev); else firstReview(channel, pr, { from, dev: dev ? dev.id : null, at: Date.now() });
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

// What a desk on the Floor shows about a PR's automatic reviews (relay/desk.js), from memory only.
function deskOf(channel, pr) {
  const r = pr && recOf(channel, pr);
  // held: the review waits on CI. A first review waits only on the pipeline. A follow-up also waits for
  // the Dev's turn to end, so it counts only while the pipeline gate gave a reason (rec.why, in passes).
  // desk: the first review could not start for want of a desk and waits for one. failed: it gave up.
  // A first review that waits for its next try is neither.
  const desk = !!(r && r.first && r.first.desk), retry = !!(r && r.first && r.first.tries);
  return r ? { count: r.count || 0, waits: !!r.waits, held: !desk && !retry && !!(r.first || (r.pending && r.why)), desk, failed: !!r.failed } : null;
}

module.exports = { handle, noteHook, begin, useAutopilot, deskOf, startText, stateOf, owe };
