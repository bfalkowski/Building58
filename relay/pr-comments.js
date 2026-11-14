// Review comments reach the Dev: for each task with a PR that is not done, the relay asks gh for new
// comments and reviews on that PR, and tells the task's Dev about them. See docs/manual/roles.html#findings.
//
// What it keeps is on the task in tasks.json, as task.reviews, so a restart neither loses nor repeats:
//   seen      every comment and review it has looked at, by id
//   own       links to comments the Dev's own session posted, from its hook events
//   watchingSince  when the relay learned of this PR from the Dev's hook, or, for a PR recorded before
//             this code ran, when it first asked gh about it. Comments from more than CLOCK_MARGIN before
//             then are news for the Dev, once, but move no card: a person or the Lead may have dealt with
//             them already.
//   pending   { pr, links, count, since, ended, before }: news the Dev has not been told yet, whether its
//             session has ended, and whether all of it was on the PR before the relay watched it
//   owesPost  { links, count }: the PR has not yet been told that the Dev was told
//   problem   why gh could not be asked, or null
//
// The message is typed through relay/delivery.js, so only while the Dev's session is idle. It has
// links and a count, never a comment's words. T-4's review loop can call tell() with its own news.
'use strict';
const { oneLine } = require('./clean.js');
const { execFile } = require('child_process');
const path = require('path');
const tasks = require('./tasks.js');
const terminal = require('./terminal.js');
const delivery = require('./delivery.js');
const chat = require('./chat.js');

const GH = process.env.GH_CMD || 'gh';
const GH_LIMIT = 20000;
const config = require('./config.js');  // reviewPollSeconds: how often to ask GitHub, 0 for never
const TICK = 2000;  // how often pending news is looked after. This never calls gh.
// GitHub stamps a comment in whole seconds on its own clock, and the watch starts on this computer's clock.
// A comment counts as from before the watch only when it is older than this, so one in the same second as
// the hook, or from a GitHub clock a little behind this one, is new and moves the card.
const CLOCK_MARGIN = 60 * 1000;
const MAX_LINKS = 5;  // the relay types in one burst, and Claude Code reads about 1024 bytes at a time
const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
const ITEM_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#(?:issuecomment-|pullrequestreview-|discussion_r)\d+$/;
// A comment that starts with one of these is not news for the Dev. DEV_MARK is what the Dev is told to
// start its replies with. TOLD_MARK starts the relay's own note that the Dev was told.
const DEV_MARK = '<!-- office:dev -->', TOLD_MARK = '<!-- office:told-dev -->';
// A Dev's reply that also has HOLD_MARK says a finding the review marked non-blocking is really a bug, so the
// PR goes to the person instead of being merged on that review's verdict (T-226, relay/autopilot.js).
const HOLD_MARK = '<!-- office:hold -->';
const KEY = (task) => 'review-' + task.id;
const KEY_ID = /^review-([0-9a-f]{6})$/;
const ENDED = 'Review waiting, Dev session has ended';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const clean = oneLine;
const plural = (n) => n + ' new comment' + (n === 1 ? '' : 's');
function stateOf(task) {
  if (!task.reviews) task.reviews = { seen: [], own: [], pending: null, owesPost: null, problem: null, checkedAt: null };
  return task.reviews;
}

// ---------- gh ----------
function gh(args, input) {
  return new Promise((resolve) => {
    const child = execFile(GH, args, { timeout: GH_LIMIT, maxBuffer: 32 * 1024 * 1024, env: Object.assign({}, process.env, { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }) }, (err, stdout, stderr) => {
      if (!err) { resolve({ out: String(stdout) }); return; }
      resolve({ failed: err.code === 'ENOENT' ? 'gh is not installed' : err.killed ? 'gh did not answer in time' : clean(stderr, 200) || 'gh failed' });
    });
    child.stdin.on('error', () => { /* gh is missing, and the callback says so */ });
    child.stdin.end(input || '');
  });
}
// Issue comments, reviews and inline comments, each as { id, kind, url, body, state }.
const SOURCES = [['issues/{n}/comments', 'c'], ['pulls/{n}/reviews', 'r'], ['pulls/{n}/comments', 'i']];
async function itemsOf(pr) {
  const [, owner, repo, n] = pr.match(PR_URL);
  const items = [];
  for (const [where, kind] of SOURCES) {
    const r = await gh(['api', '--paginate', '--slurp', 'repos/' + owner + '/' + repo + '/' + where.replace('{n}', n) + '?per_page=100']);
    if (r.failed) return { failed: r.failed };
    let pages;
    try { pages = JSON.parse(r.out); } catch (e) { return { failed: 'gh sent something unreadable' }; }
    if (!Array.isArray(pages)) return { failed: 'gh sent something unreadable' };
    for (const x of pages.flat()) {
      if (!x || x.id == null) continue;
      items.push({ id: kind + x.id, kind, url: ITEM_URL.test(String(x.html_url)) ? x.html_url : pr, body: String(x.body || ''), state: x.state || null, at: Date.parse(x.submitted_at || x.created_at) || null });
    }
  }
  return { items };
}

// ---------- checking ----------
// Whether this comment is news for the Dev. Anything not known to be the Dev's or the relay's is news,
// so a mistake here tells the Dev too much, never too little.
function isNews(r, item) {
  if (r.own.includes(item.url)) return false;
  if (item.body.startsWith(DEV_MARK) || item.body.startsWith(TOLD_MARK)) return false;
  if (item.kind === 'r' && item.state === 'COMMENTED' && !item.body.trim()) return false;  // only holds inline comments, which count on their own
  return true;
}
async function check(channel, task) {
  const r = stateOf(task);
  if (r.owesPost) await postTold(task);
  if (!r.watchingSince) { r.watchingSince = new Date().toISOString(); tasks.save(); }
  const since = Date.parse(r.watchingSince);
  const got = await itemsOf(task.pr);
  if (got.failed) {
    if (r.problem !== got.failed) {
      log('Could not check ' + task.pr + ' for review comments, so it tries again: ' + got.failed);
      tasks.record(task, { type: 'note', note: 'Could not check the PR for comments: ' + got.failed + '. Trying again.' });
    }
    r.problem = got.failed; tasks.save();
    return false;
  }
  if (r.problem) { log('Checking ' + task.pr + ' for review comments works again.'); tasks.record(task, { type: 'note', note: 'Checking the PR for comments works again.' }); }
  r.problem = null; r.checkedAt = new Date().toISOString();
  // For the COO (relay/coo.js): comments on this PR that are not the Dev's or the relay's, and how many were
  // reviews that requested changes. They count from countedSince, so a PR from before this shows when they began.
  if (typeof r.comments !== 'number') { r.comments = 0; r.blocking = 0; r.countedSince = new Date().toISOString(); }
  const seen = new Set(r.seen), news = [];
  for (const item of got.items) {
    if (seen.has(item.id)) continue;
    if (item.kind === 'r' && item.state === 'PENDING') continue;  // a draft review: it is news once it is posted
    seen.add(item.id); r.seen.push(item.id);
    if (item.body.startsWith(DEV_MARK) && item.body.includes(HOLD_MARK)) held(channel, task, item.url);
    if (!isNews(r, item)) continue;
    news.push(item);
    r.comments++;
    if (item.kind === 'r' && item.state === 'CHANGES_REQUESTED') r.blocking++;
  }
  // A comment with no time counts as new, so a mistake moves the card rather than leaving it.
  if (news.length) tell(channel, task, task.pr, news.map((n) => n.url), { times: Object.fromEntries(news.map((n) => [n.url, n.at])), before: news.every((n) => n.at !== null && n.at < since - CLOCK_MARGIN), blocks: news.some((n) => n.kind === 'r' && n.state === 'CHANGES_REQUESTED') });
  else tasks.save();
  return true;
}
// One check of a task's PR at a time, so a poll and a look before a merge never tell the Dev twice.
const checking = new Map();
function checkOnce(channel, task) {
  if (!checking.has(task.id)) checking.set(task.id, check(channel, task).finally(() => checking.delete(task.id)));
  return checking.get(task.id);
}
// For relay/autopilot.js, just before it merges: whether the PR's comments could be read now, so a hold
// posted since the last poll counts. With comment checks off (reviewPollSeconds 0) nothing asks gh, so true.
async function checkNow(channel, task) {
  if (!(config.get('reviewPollSeconds') > 0) || !PR_URL.test(task.pr || '')) return true;
  try { return await checkOnce(channel, task); } catch (e) { log('Checking ' + task.pr + ' for review comments failed: ' + e.message); return false; }
}
function held(channel, task, url) {
  tasks.record(task, { type: 'review', note: 'The Dev says a finding marked non-blocking is a bug, so the PR waits on the person: ' + url });
  tasks.save();
  onHold(channel, task, url);
}

// ---------- telling the Dev ----------
// News for a task's Dev: saved with the task first, then typed when the Dev is idle. With before: true,
// it was all on the PR before the relay watched it, so telling the Dev moves no card. A link already
// waiting is not news again, so the count is the links waiting, and noteHook keeps the two together.
function tell(channel, task, pr, links, opts) {
  const before = !!(opts && opts.before);
  const r = stateOf(task);
  const added = [...new Set(links)].filter((l) => !(r.pending && r.pending.links.includes(l)));
  if (!added.length) { tasks.save(); return; }  // check() leaves saving what it has seen to this
  const p = r.pending || (r.pending = { pr, links: [], count: 0, since: new Date().toISOString(), before });
  p.before = p.before && before;
  p.blocks = !!(p.blocks || (opts && opts.blocks));
  p.times = Object.assign(p.times || {}, (opts && opts.times) || {});  // when each was posted, for matching a verdict to its review
  p.count += added.length;
  p.links.push(...added);
  tasks.record(task, { type: 'review', note: plural(added.length) + ' on the PR' + (before ? ' from before the room watched it' : '') + ', waiting to tell the Dev.' });
  tasks.save();
  if (!before) chat.reviewNews(channel, task, added.length);
  queue(channel, task);
}
// Given the news items ({ url, at }), 'merge' when every one is a review a reviewer posted with a merge
// verdict, or null (relay/autopilot.js sets this).
let verdictOf = () => null, onHold = () => {};
const useVerdicts = (fn) => { verdictOf = fn; };
const useHolds = (fn) => { onHold = fn; };
// After a merge verdict every push makes the review stale and brings another round, so the Dev does not
// push for it: what is worth doing goes to one follow-up ticket instead.
const FIX = 'Read each one with gh, then fix or dispute each finding, reply on the PR, and push.';
const MERGE = 'The review\'s verdict says merge, so do not push for its findings. Read each one with gh and reply on the PR. Put the non-blocking findings worth doing into one follow-up ticket for this PR with node ' + path.join(__dirname, 'ticket.js') +
  ' create "Title" --body - and a quoted heredoc, naming the PR and each finding, then stop. If you think a finding marked non-blocking is really a bug, say so in a reply that starts with ' + DEV_MARK + ' and has ' + HOLD_MARK + ' on its next line, and push no fix: the PR then waits on the person. A failing check and a conflict with main are still yours: fix the check, or merge main, and push only that.';
// Chosen once, when the message is made (queue), and kept on the news for the card (delivered).
// Merge only when the news is all reviews posted with a merge verdict and none requested changes, as for the card.
const mergeVerdict = (channel, p) => !p.before && !p.blocks && verdictOf(channel, p.pr, p.links.map((url) => ({ url, at: (p.times || {})[url] || null }))) === 'merge';
function message(p, merge) {
  const shown = p.links.slice(0, MAX_LINKS), more = p.count - shown.length;
  const what = p.before ? p.count + ' comment' + (p.count === 1 ? '' : 's') + ' that ' + (p.count === 1 ? 'was' : 'were') + ' there before the room watched it, some maybe dealt with already' : plural(p.count);
  return 'There is news on your pull request ' + p.pr + ': ' + what + ', at ' + shown.join(' ') + (more > 0 ? ' and ' + more + ' more on the PR' : '') +
    '. ' + (merge ? MERGE : FIX) + ' Start each reply you post with ' + DEV_MARK + ' so the room does not send it back to you.';
}
// Which session each task's news was saved for, so tick can tell when Bring back has replaced it.
const queuedFor = new Map();  // channel/task id -> terminal/session id
const ownerOf = (task) => (task.owner ? task.owner.terminal + '/' + task.owner.sessionId : '');
function queue(channel, task) {
  const p = task.reviews.pending;
  queuedFor.set(channel + '/' + task.id, ownerOf(task));
  delivery.save(channel, { key: KEY(task), terminal: task.owner && task.owner.terminal, sessionId: task.owner && task.owner.sessionId, text: message(p, p.merge = mergeVerdict(channel, p)), on: (what) => { if (what === 'delivered') delivered(channel, task.id, p); } });
}
function delivered(channel, id, p) {
  const task = tasks.list(channel).find((t) => t.id === id);
  if (!task || !task.reviews || task.reviews.pending !== p) return;
  const r = task.reviews;
  r.pending = null;
  r.owesPost = { links: p.links, count: p.count };
  // A review whose verdict says merge (ticket.js verdict, kept by relay/autopilot.js) blocks nothing, so the
  // card stays where it is, unless a review on GitHub itself requested changes or other news came with it.
  // With no verdict, it moves as before.
  const clean = !!p.merge;  // what the message said, so the card and the message agree
  const note = 'Told the Dev about ' + plural(p.count) + (p.before ? ' from before the room watched the PR, so the card stays' : clean ? '. The review\'s verdict says merge, so the card stays' : '') + '.';
  tasks.record(task, { type: 'review', note });
  log('Told the Dev of task ' + task.id + ' about ' + plural(p.count) + ' on ' + p.pr + (p.before ? ', from before it watched the PR' : ''));
  if (!p.before && !clean && task.state !== 'changes_requested' && task.state !== 'done') tasks.moveBack(channel, task, note);
  tasks.save();
  postTold(task);
}
// The PR says the Dev was told, so anyone reading it can see the review was picked up. With last: true
// the task is done, so nothing would try again: the note is given up whether or not it went out.
const posting = new Set();
async function postTold(task, last) {
  const r = task.reviews;
  if (!r.owesPost || posting.has(task.id)) return;
  posting.add(task.id);
  const owed = r.owesPost, shown = owed.links.slice(0, MAX_LINKS);
  const body = TOLD_MARK + '\nThe room told the Dev of this pull request about ' + plural(owed.count) + ': ' + shown.join(' ') + (owed.count > shown.length ? ' and more.' : '.') + '\n';
  const res = await gh(['pr', 'comment', task.pr, '--body-file', '-'], body);
  posting.delete(task.id);
  if (res.failed && last) {
    if (r.owesPost === owed) r.owesPost = null;
    log('Could not say on ' + task.pr + ' that the Dev was told, and the task is done, so it stopped trying: ' + res.failed);
    tasks.record(task, { type: 'note', note: 'Could not say on the PR that the Dev was told, and the task is done, so the relay stopped trying: ' + res.failed });
    tasks.save();
    return;
  }
  if (res.failed) { log('Could not say on ' + task.pr + ' that the Dev was told, so it tries again: ' + res.failed); return; }
  const url = (res.out.match(/https:\/\/github\.com\/\S+#issuecomment-\d+/) || [])[0];
  if (url) r.own.push(url);
  if (r.owesPost === owed) r.owesPost = null;
  tasks.save();
}

// The watch starts when the relay learns of the PR, not at its first check. A review posted in
// between is new, and moves the card. relay/server.js calls this after tasks.noteHook records the PR.
function watchFrom(channel, ev) {
  if (!ev || !ev.pr_url) return;
  const task = tasks.ofHook(channel, ev);
  if (!task || task.pr !== ev.pr_url) return;
  const r = stateOf(task);
  if (!r.watchingSince) { r.watchingSince = new Date().toISOString(); tasks.save(); }
}
// The Dev's own comment is not news for it. A hook can arrive after a check saw the comment, so it
// also comes out of news not yet typed.
function noteHook(channel, ev) {
  watchFrom(channel, ev);
  const url = ev && ev.posted && ev.posted.url;
  if (!url || !ITEM_URL.test(url)) return;
  const task = tasks.ofHook(channel, ev);
  if (!task) return;
  const r = stateOf(task);
  if (!r.own.includes(url)) r.own.push(url);
  const p = r.pending;
  if (p && p.links.includes(url)) {
    p.links = p.links.filter((l) => l !== url); p.count -= 1;
    if (p.count <= 0) { r.pending = null; delivery.drop(channel, KEY(task)); } else queue(channel, task);
  }
  tasks.save();
}

// ---------- keeping pending news on its way ----------
const live = (channel, task) => task.owner && terminal.all(channel).find((t) => !t.stopped && (t.id === task.owner.terminal || t.sessionId === task.owner.sessionId));
function tick() {
  for (const channel of tasks.channels()) {
    const waiting = new Set(delivery.pending(channel).map((d) => d.key));
    const list = tasks.list(channel);
    for (const key of waiting) {  // news for a task that was cleaned up has nobody to go to
      const id = (key.match(KEY_ID) || [])[1];
      if (id && !list.some((t) => t.id === id && t.reviews && t.reviews.pending)) delivery.drop(channel, key);
    }
    for (const task of list) {
      // A done task is never checked again, so a note still owed on its PR goes out now or not at all.
      if (task.state === 'done' && task.reviews && task.reviews.owesPost) postTold(task, true);
      const p = task.reviews && task.reviews.pending;
      if (!p) continue;
      if (task.state === 'done') {
        task.reviews.pending = null; delivery.drop(channel, KEY(task));
        tasks.record(task, { type: 'review', note: 'The Dev was not told about ' + plural(p.count) + ', because the task is done.' }); tasks.save();
        continue;
      }
      // The ticket asked for Waiting on you here. That moves a card forward past Building, which
      // article 1 of docs/constitution.md leaves to a person, so the card says so and the move is yours.
      const gone = !live(channel, task);
      if (gone && !p.ended) { p.ended = true; tasks.record(task, { type: 'review', note: ENDED + '. Bring it back to deliver it.' }); tasks.save(); log('Task ' + task.id + ': ' + ENDED + '.'); }
      else if (!gone && p.ended) { p.ended = false; tasks.save(); }
      // After a restart, a session that was gone a day, or Bring back that started over with a new session.
      if (!waiting.has(KEY(task)) || queuedFor.get(channel + '/' + task.id) !== ownerOf(task)) queue(channel, task);
    }
  }
}
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (const channel of tasks.channels()) {
      for (const task of tasks.list(channel).slice()) {
        if (task.state === 'done' || !PR_URL.test(task.pr || '')) continue;
        try { await checkOnce(channel, task); } catch (e) { log('Checking ' + task.pr + ' for review comments failed: ' + e.message); }
      }
    }
  } finally { polling = false; }
}

// The relay's callbacks are not saved, so news already waiting is queued again with them. That waits until
// the relay has loaded, so relay/autopilot.js has given its verdicts and the message says the right thing.
setImmediate(() => { for (const channel of tasks.channels()) for (const task of tasks.list(channel)) if (task.reviews && task.reviews.pending) queue(channel, task); });
config.every('reviewPollSeconds', poll, 5000);
setInterval(tick, TICK).unref();


module.exports = { noteHook, tell, poll, checkNow, useVerdicts, useHolds, DEV_MARK, TOLD_MARK, HOLD_MARK };
