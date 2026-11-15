// Review comments reach the Dev: for each task with a PR that is not done, and each session with no
// task that opened a PR (relay/session-prs.js, T-293), the relay asks gh for new comments and reviews on
// that PR, and tells the Dev about them. See docs/manual/roles.html#findings.
//
// A session's watch is shaped like a task, so the code below calls both a task. Only a real task has a
// card to move, a ticket's chat to tell, or Autopilot to hold. A session's watch ends when the person
// stops the session, or when gh says the PR is merged or closed.
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
//   posted    { url, at, seen }: the room's latest automatic review of the PR, posted so its verdict
//             counts. The post starts a check at once, and relay/merge-hold.js holds a merge until a check
//             that worked has listed that link (seen), since GitHub may list a new comment late (T-229). A
//             link that is not a comment's is seen by the first check that worked and began after it. A
//             check asked for while one runs waits for it, then runs on its own, since the one under way
//             may have begun before the post.
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
const sessionPrs = require('./session-prs.js');

const GH = process.env.GH_CMD || 'gh';
const GH_LIMIT = 20000;
const config = require('./config.js');
const TICK = 2000;
const CLOCK_MARGIN = 60 * 1000;
const MAX_LINKS = 5;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
const ITEM_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#(?:issuecomment-|pullrequestreview-|discussion_r)\d+$/;
const DEV_MARK = '<!-- office:dev -->', TOLD_MARK = '<!-- office:told-dev -->';
const HOLD_MARK = '<!-- office:hold -->';
const KEY = (task) => 'review-' + task.id;
const KEY_ID = /^review-([0-9a-f]{6}|session-[\w-]+)$/;
const ENDED = 'Review waiting, Dev session has ended';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const clean = oneLine;
const plural = (n) => n + ' new comment' + (n === 1 ? '' : 's');
const saveOf = (task) => (task.session ? sessionPrs.save() : tasks.save());
const recordOf = (task, entry) => (task.session ? sessionPrs.record(task, entry) : tasks.record(task, entry));
const findOf = (channel, id) => tasks.list(channel).find((t) => t.id === id) || sessionPrs.list(channel).find((w) => w.id === id) || null;
const whose = (task) => (task.session ? 'session ' + task.owner.sessionId.slice(0, 8) : 'task ' + task.id);
const watched = (channel) => tasks.list(channel).filter((t) => t.state !== 'done').concat(sessionPrs.list(channel));
function stateOf(task) {
  if (!task.reviews) task.reviews = { seen: [], own: [], pending: null, owesPost: null, problem: null, checkedAt: null };
  return task.reviews;
}

function gh(args, input) {
  return new Promise((resolve) => {
    const child = execFile(GH, args, { timeout: GH_LIMIT, maxBuffer: 32 * 1024 * 1024, env: Object.assign({}, process.env, { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }) }, (err, stdout, stderr) => {
      if (!err) { resolve({ out: String(stdout) }); return; }
      resolve({ failed: err.code === 'ENOENT' ? 'gh is not installed' : err.killed ? 'gh did not answer in time' : clean(stderr, 200) || 'gh failed' });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}
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

function isNews(r, item) {
  if (r.own.includes(item.url)) return false;
  if (item.body.startsWith(DEV_MARK) || item.body.startsWith(TOLD_MARK)) return false;
  if (item.kind === 'r' && item.state === 'COMMENTED' && !item.body.trim()) return false;
  return true;
}
async function closed(pr) {
  const [, owner, repo, n] = pr.match(PR_URL);
  const r = await gh(['api', 'repos/' + owner + '/' + repo + '/pulls/' + n]);
  if (r.failed) return { failed: r.failed };
  try { return { closed: JSON.parse(r.out).state === 'closed' }; } catch (e) { return { failed: 'gh sent something unreadable' }; }
}
function endSession(channel, w, why) {
  if (!sessionPrs.end(channel, w.id)) return;
  delivery.drop(channel, KEY(w));
  log('Stopped watching ' + w.pr + ' for ' + whose(w) + ': ' + why + '.');
}
async function check(channel, task) {
  const r = stateOf(task);
  if (r.owesPost) await postTold(task);
  if (task.session) {
    const pr = await closed(task.pr);
    if (pr.closed) { endSession(channel, task, 'the PR is merged or closed'); return true; }
  }
  if (!r.watchingSince) { r.watchingSince = new Date().toISOString(); saveOf(task); }
  const since = Date.parse(r.watchingSince);
  const from = new Date().toISOString();
  const got = await itemsOf(task.pr);
  if (got.failed) {
    if (r.problem !== got.failed) {
      log('Could not check ' + task.pr + ' for review comments, so it tries again: ' + got.failed);
      recordOf(task, { type: 'note', note: 'Could not check the PR for comments: ' + got.failed + '. Trying again.' });
    }
    r.problem = got.failed; saveOf(task);
    return false;
  }
  if (r.problem) { log('Checking ' + task.pr + ' for review comments works again.'); recordOf(task, { type: 'note', note: 'Checking the PR for comments works again.' }); }
  r.problem = null; r.checkedAt = new Date().toISOString();
  const p = r.posted;
  if (p && !p.seen && (ITEM_URL.test(p.url) ? got.items.some((i) => i.url === p.url) : from >= p.at)) p.seen = true;
  if (typeof r.comments !== 'number') { r.comments = 0; r.blocking = 0; r.countedSince = new Date().toISOString(); }
  const seen = new Set(r.seen), news = [];
  for (const item of got.items) {
    if (seen.has(item.id)) continue;
    if (item.kind === 'r' && item.state === 'PENDING') continue;
    seen.add(item.id); r.seen.push(item.id);
    if (item.body.startsWith(DEV_MARK) && item.body.includes(HOLD_MARK)) held(channel, task, item.url);
    if (!isNews(r, item)) continue;
    news.push(item);
    r.comments++;
    if (item.kind === 'r' && item.state === 'CHANGES_REQUESTED') r.blocking++;
  }
  if (news.length) tell(channel, task, task.pr, news.map((n) => n.url), { times: Object.fromEntries(news.map((n) => [n.url, n.at])), before: news.every((n) => n.at !== null && n.at < since - CLOCK_MARGIN), blocks: news.some((n) => n.kind === 'r' && n.state === 'CHANGES_REQUESTED') });
  else saveOf(task);
  return true;
}
const checking = new Map();
async function checkOnce(channel, task) {
  while (checking.has(task.id)) await checking.get(task.id).catch(() => {});
  const p = check(channel, task).finally(() => checking.delete(task.id));
  checking.set(task.id, p);
  return p;
}
async function checkNow(channel, task) {
  if (!(config.get('reviewPollSeconds') > 0) || !PR_URL.test(task.pr || '')) return true;
  try { return await checkOnce(channel, task); } catch (e) { log('Checking ' + task.pr + ' for review comments failed: ' + e.message); return false; }
}
function held(channel, task, url) {
  recordOf(task, { type: 'review', note: 'The Dev says a finding marked non-blocking is a bug, so the PR waits on the person: ' + url });
  saveOf(task);
  if (!task.session) onHold(channel, task, url);
}

function tell(channel, task, pr, links, opts) {
  const before = !!(opts && opts.before);
  const r = stateOf(task);
  const added = [...new Set(links)].filter((l) => !(r.pending && r.pending.links.includes(l)));
  if (!added.length) { saveOf(task); return; }
  const p = r.pending || (r.pending = { pr, links: [], count: 0, since: new Date().toISOString(), before });
  p.before = p.before && before;
  p.blocks = !!(p.blocks || (opts && opts.blocks));
  p.times = Object.assign(p.times || {}, (opts && opts.times) || {});
  p.count += added.length;
  p.links.push(...added);
  recordOf(task, { type: 'review', note: plural(added.length) + ' on the PR' + (before ? ' from before the room watched it' : '') + ', waiting to tell the Dev.' });
  saveOf(task);
  if (!before && !task.session) chat.reviewNews(channel, task, added.length);
  queue(channel, task);
}
let verdictOf = () => null, onHold = () => {};
const useVerdicts = (fn) => { verdictOf = fn; };
const useHolds = (fn) => { onHold = fn; };
const FIX = 'Read each one with gh, then fix or dispute each finding, reply on the PR, and push.';
const MERGE = 'The review\'s verdict says merge, so do not push for its findings. Read each one with gh and reply on the PR. Put the non-blocking findings worth doing into one follow-up ticket for this PR with node ' + path.join(__dirname, 'ticket.js') +
  ' create "Title" --body - and a quoted heredoc, naming the PR and each finding, then stop. If you think a finding marked non-blocking is really a bug, say so in a reply that starts with ' + DEV_MARK + ' and has ' + HOLD_MARK + ' on its next line, and push no fix: the PR then waits on the person. A failing check and a conflict with main are still yours: fix the check, or merge main, and push only that.';
const PUSH_HOLD = ' Until a later review says fix or the PR merges, git push in the task\'s checkout refuses any commit but a merge of main.';
const mergeVerdict = (channel, p) => !p.before && !p.blocks && verdictOf(channel, p.pr, p.links.map((url) => ({ url, at: (p.times || {})[url] || null }))) === 'merge';
function message(p, merge, session) {
  const shown = p.links.slice(0, MAX_LINKS), more = p.count - shown.length;
  const what = p.before ? p.count + ' comment' + (p.count === 1 ? '' : 's') + ' that ' + (p.count === 1 ? 'was' : 'were') + ' there before the room watched it, some maybe dealt with already' : plural(p.count);
  return 'There is news on your pull request ' + p.pr + ': ' + what + ', at ' + shown.join(' ') + (more > 0 ? ' and ' + more + ' more on the PR' : '') +
    '. ' + (merge ? MERGE + (session ? '' : PUSH_HOLD) : FIX) + ' Start each reply you post with ' + DEV_MARK + ' so the room does not send it back to you.';
}
const queuedFor = new Map();
const ownerOf = (task) => (task.owner ? task.owner.terminal + '/' + task.owner.sessionId : '');
function queue(channel, task) {
  const p = task.reviews.pending;
  queuedFor.set(channel + '/' + task.id, ownerOf(task));
  delivery.save(channel, { key: KEY(task), terminal: task.owner && task.owner.terminal, sessionId: task.owner && task.owner.sessionId, text: message(p, p.merge = mergeVerdict(channel, p), task.session), on: (what) => { if (what === 'delivered') delivered(channel, task.id, p); } });
}
function delivered(channel, id, p) {
  const task = findOf(channel, id);
  if (!task || !task.reviews || task.reviews.pending !== p) return;
  const r = task.reviews;
  r.pending = null;
  r.owesPost = { links: p.links, count: p.count };
  const clean = !!p.merge;
  const note = 'Told the Dev about ' + plural(p.count) + (p.before ? ' from before the room watched the PR, so the card stays' : clean ? '. The review\'s verdict says merge, so the card stays' : '') + '.';
  recordOf(task, { type: 'review', note });
  log('Told the Dev of ' + whose(task) + ' about ' + plural(p.count) + ' on ' + p.pr + (p.before ? ', from before it watched the PR' : ''));
  if (!task.session && !p.before && !clean && task.state !== 'changes_requested' && task.state !== 'done') tasks.moveBack(channel, task, note);
  saveOf(task);
  postTold(task);
}
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
    recordOf(task, { type: 'note', note: 'Could not say on the PR that the Dev was told, and the task is done, so the relay stopped trying: ' + res.failed });
    saveOf(task);
    return;
  }
  if (res.failed) { log('Could not say on ' + task.pr + ' that the Dev was told, so it tries again: ' + res.failed); return; }
  const url = (res.out.match(/https:\/\/github\.com\/\S+#issuecomment-\d+/) || [])[0];
  if (url) r.own.push(url);
  if (r.owesPost === owed) r.owesPost = null;
  saveOf(task);
}

const sessionOf = (channel, ev) => {
  const sid = String((ev && ev.session_id) || '');
  const t = sid && terminal.all(channel).find((x) => x.sessionId.startsWith(sid));
  return t && !t.task && !t.role && !t.lead && !t.reviewOf && !t.round ? t : null;
};
const ofHook = (channel, ev) => {
  const task = tasks.ofHook(channel, ev);
  if (task) return task;
  const t = sessionOf(channel, ev);
  return t ? sessionPrs.list(channel).find((w) => w.owner.terminal === t.id || w.owner.sessionId === t.sessionId) || null : null;
};
function watchFrom(channel, ev) {
  if (!ev || !ev.pr_url || !PR_URL.test(ev.pr_url)) return;
  let task = tasks.ofHook(channel, ev);
  if (!task) {
    const t = sessionOf(channel, ev);
    if (!t) return;
    const old = ofHook(channel, ev);
    if (old && old.pr !== ev.pr_url) delivery.drop(channel, KEY(old));
    task = sessionPrs.watch(channel, t, ev.pr_url);
    if (!old || old.pr !== ev.pr_url) log('Watching ' + ev.pr_url + ' for ' + whose(task) + ', which has no task.');
  }
  if (task.pr !== ev.pr_url) return;
  const r = stateOf(task);
  if (!r.watchingSince) { r.watchingSince = new Date().toISOString(); saveOf(task); }
}
function noteHook(channel, ev) {
  watchFrom(channel, ev);
  const url = ev && ev.posted && ev.posted.url;
  if (!url || !ITEM_URL.test(url)) return;
  const task = ofHook(channel, ev);
  if (!task) return;
  const r = stateOf(task);
  if (!r.own.includes(url)) r.own.push(url);
  const p = r.pending;
  if (p && p.links.includes(url)) {
    p.links = p.links.filter((l) => l !== url); p.count -= 1;
    if (p.count <= 0) { r.pending = null; delivery.drop(channel, KEY(task)); } else queue(channel, task);
  }
  saveOf(task);
}

const live = (channel, task) => task.owner && terminal.all(channel).find((t) => !t.stopped && (t.id === task.owner.terminal || t.sessionId === task.owner.sessionId));
const allChannels = () => [...new Set(tasks.channels().concat(sessionPrs.channels()))];
function followSessions(channel) {
  for (const w of sessionPrs.list(channel)) {
    const t = terminal.find(channel, w.owner.terminal);
    if (t && t.sessionId !== w.owner.sessionId && t.sessionId.length === 36) { w.owner.sessionId = t.sessionId; sessionPrs.save(); }
  }
}
function tick() {
  for (const channel of allChannels()) {
    followSessions(channel);
    const waiting = new Set(delivery.pending(channel).map((d) => d.key));
    const list = tasks.list(channel).concat(sessionPrs.list(channel));
    for (const key of waiting) {
      const id = (key.match(KEY_ID) || [])[1];
      if (id && !list.some((t) => t.id === id && t.reviews && t.reviews.pending)) delivery.drop(channel, key);
    }
    for (const task of list) {
      if (task.state === 'done' && task.reviews && task.reviews.owesPost) postTold(task, true);
      const p = task.reviews && task.reviews.pending;
      if (!p) continue;
      if (task.state === 'done') {
        task.reviews.pending = null; delivery.drop(channel, KEY(task));
        tasks.record(task, { type: 'review', note: 'The Dev was not told about ' + plural(p.count) + ', because the task is done.' }); tasks.save();
        continue;
      }
      const gone = !live(channel, task);
      if (gone && !p.ended) { p.ended = true; recordOf(task, { type: 'review', note: ENDED + '. Bring it back to deliver it.' }); saveOf(task); log(whose(task) + ': ' + ENDED + '.'); }
      else if (!gone && p.ended) { p.ended = false; saveOf(task); }
      if (!waiting.has(KEY(task)) || queuedFor.get(channel + '/' + task.id) !== ownerOf(task)) queue(channel, task);
    }
  }
}
function reviewPosted(channel, pr, url) {
  if (!(config.get('reviewPollSeconds') > 0)) return;
  const task = watched(channel).find((x) => x.pr === pr);
  if (!task || !PR_URL.test(task.pr)) return;
  stateOf(task).posted = { url: String(url || ''), at: new Date().toISOString(), seen: false };
  saveOf(task);
  checkOnce(channel, task).catch((e) => log('Checking ' + task.pr + ' for review comments failed: ' + e.message));
}
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (const channel of allChannels()) {
      for (const task of watched(channel)) {
        if (!PR_URL.test(task.pr || '')) continue;
        try { await checkOnce(channel, task); } catch (e) { log('Checking ' + task.pr + ' for review comments failed: ' + e.message); }
      }
    }
  } finally { polling = false; }
}

setImmediate(() => { for (const channel of allChannels()) for (const task of tasks.list(channel).concat(sessionPrs.list(channel))) if (task.reviews && task.reviews.pending) queue(channel, task); });
terminal.onEnd((channel, t, code, closing) => {
  if (closing || !t.stopped) return;
  for (const w of sessionPrs.list(channel).filter((x) => x.owner.terminal === t.id || x.owner.sessionId === t.sessionId)) endSession(channel, w, 'the person stopped the session');
});
config.every('reviewPollSeconds', poll, 5000);
setInterval(tick, TICK).unref();


module.exports = { noteHook, tell, poll, checkNow, reviewPosted, useVerdicts, useHolds, DEV_MARK, TOLD_MARK, HOLD_MARK };
