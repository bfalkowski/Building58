// The PR watch: the relay keeps every open task PR moving by reading its state on a timer, not by waiting
// for a hook (T-106). A missed hook, a closed page, a relay restart or a quiet push then costs one look, not a
// night. See docs/manual/roles.html#pr-watch.
//
// While the person's switch Watch each open PR is on (Settings, off by default), every prWatchSeconds (120):
//   1. Each task with an open PR is read: the PR from GitHub (gh pr view: head, checks, mergeable), what the
//      relay keeps about its reviews (relay/reviews.js) and verdicts (relay/autopilot.js), its Dev's session
//      (relay/liveness.js), and the commits in its Dev's checkout that the PR does not have.
//   2. relay/pr-watch-plan.js says who owes the next move, and what to do about it:
//      - no review read the head: ask relay/reviews.js for one, within its limit on automatic reviews;
//      - blocking findings, a conflict with main, a failed check, or commits the idle Dev has not pushed: tell the
//        Dev, as a saved message (relay/delivery.js), which checks that a turn began after it and else marks the
//        Dev stuck (T-100);
//      - reviewed at the head, green and clean: tell the Lead. One that changes CLAUDE.md or the constitution
//        waits on the person.
//   3. Each PR has one line: who it waits on, and for how long. The Floor, the Board and ticket.js floor show it.
//      A PR that waits on anyone but the person for prWatchWaitMinutes (60) waits on the person, and the chat
//      board says so once.
// Each action is kept by PR, head commit and cause in RELAY_PR_WATCH_FILE, so a second look, or a look after a
// restart, does not do it again. A task that Autopilot moves is left to it. The watch merges nothing.
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const reviews = require('./reviews.js');
const autopilot = require('./autopilot.js');
const delivery = require('./delivery.js');
const chat = require('./chat.js');
const config = require('./config.js');
const plan = require('./pr-watch-plan.js');
const { livenessOf } = require('./liveness.js');
const { claim } = require('./lockfile.js');

const FILE = state.file('pr-watch.json', 'RELAY_PR_WATCH_FILE');
const GH = process.env.GH_CMD || 'gh';
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;
const ON = () => config.get('prWatch');
const LATE = () => config.get('prWatchWaitMinutes') * 60 * 1000;
const KEEP = 12 * 60 * 60 * 1000;  // how long a message waits to be typed

// ---------- the store: { channel: { prs: { pr: { head, owner, cause, why, since, seenAt, late, done: { 'head cause': at } } } } } ----------
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
  } catch (e) { console.error('Could not save the PR watch to ' + FILE + ': ' + e.message); }
}
const chOf = (channel) => store[channel] || (store[channel] = { prs: {} });
const number = (pr) => '#' + pr.split('/').pop();
let ctx = null;
const log = (text) => { if (ctx) ctx.log('PR watch: ' + text); };

function gh(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(GH, args, { cwd: cwd && fs.existsSync(cwd) ? cwd : undefined, timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: Object.assign({}, process.env, { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }) }, (err, out, errOut) => {
      if (err) reject(new Error(String(errOut || err.message).trim().split('\n')[0])); else resolve(out);
    });
  });
}
const git = (cwd, args) => new Promise((resolve, reject) => execFile('git', ['-C', cwd].concat(args), { timeout: 10000 }, (e, out) => (e ? reject(e) : resolve(String(out).trim()))));

// Commits in the Dev's checkout that the PR does not have: past the PR's head when git has that commit, else on
// no remote. null when there is no checkout, or git cannot say.
async function unpushedIn(dir, head) {
  if (!dir || !fs.existsSync(dir)) return null;
  try {
    const known = await git(dir, ['cat-file', '-e', head + '^{commit}']).then(() => true, () => false);
    const n = Number(await git(dir, known ? ['rev-list', '--count', 'HEAD', '^' + head] : ['rev-list', '--count', 'HEAD', '--not', '--remotes']));
    return Number.isFinite(n) && n > 0 ? { count: n, at: await git(dir, ['rev-parse', 'HEAD']) } : null;
  } catch (e) { return null; }
}

// ---------- what it says ----------
const TEXT = {
  push: (pr, n) => 'Your checkout has ' + n + ' commit' + (n === 1 ? '' : 's') + ' that your PR ' + pr + ' does not have. Push them with a plain git push, so the PR holds all your work and gets its review.',
  conflict: (pr) => 'Your PR ' + pr + ' conflicts with main. Merge origin/main into your branch with a merge commit, keep both sides of each conflict, run the tests, and push only that merge.',
  red: (pr, head) => 'A check failed on your PR ' + pr + ' at ' + head.slice(0, 7) + '. Run gh pr checks ' + pr + ' to see which, fix it on your branch, and push.',
  fix: (pr, head) => 'The review of your PR ' + pr + ' at ' + head.slice(0, 7) + ' has blocking findings. Read it with gh pr view ' + pr + ' --comments, fix each blocking finding on your branch, and push. Do not push for its non-blocking findings.',
  ready: (pr, head, ticket) => 'PR ' + pr + (ticket ? ' (' + ticket + ')' : '') + ' is reviewed at its head ' + head.slice(0, 7) + ' with a merge verdict, its checks are green, and GitHub can merge it cleanly. If you may merge it and the merge conditions hold, merge it; if not, tell the person it is ready. This is from the relay\'s PR watch and grants nothing.',
};

// ---------- one look ----------
let looking = false;
async function tick() {
  if (looking || !ctx || !ON()) return;
  looking = true;
  try {
    for (const channel of tasks.channels()) await look(channel);
  } catch (e) { log(e.message); } finally { looking = false; }
}
const openTasks = (channel) => tasks.list(channel).filter((t) => t.state !== 'done' && PR_URL.test(t.pr || ''));
async function look(channel) {
  const c = chOf(channel), list = openTasks(channel);
  for (const pr of Object.keys(c.prs)) if (!list.some((t) => t.pr === pr)) forget(channel, pr);
  for (const task of list) {
    try { await lookAt(channel, task, Date.now()); } catch (e) { log('Could not look at ' + task.pr + ': ' + e.message); }
  }
}
// A PR that merged, closed, or whose task is done needs nothing more.
function forget(channel, pr) {
  delete chOf(channel).prs[pr];
  delivery.drop(channel, 'pr-watch ' + pr); delivery.drop(channel, 'pr-watch-lead ' + pr);
  save();
}
async function lookAt(channel, task, now) {
  const pr = JSON.parse(await gh(['pr', 'view', task.pr, '--json', 'state,headRefOid,mergeable,mergeStateStatus,statusCheckRollup'], task.repo));
  if (pr.state !== 'OPEN' || !pr.headRefOid) { forget(channel, task.pr); return; }
  const head = pr.headRefOid;
  const dev = terminal.find(channel, task.owner && task.owner.terminal);
  const lv = livenessOf(dev, now);
  const unpushed = await unpushedIn(task.worktree || (dev && dev.cwd), head);
  const verdict = autopilot.verdictOf(channel, task.pr);
  let files = null;
  if (verdict && verdict.kind === 'merge' && verdict.posted && verdict.commit === head) {
    const m = task.pr.match(PR_URL);
    files = JSON.parse(await gh(['api', '--paginate', '--slurp', 'repos/' + m[1] + '/pulls/' + m[2] + '/files?per_page=100'], task.repo)).flat().flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean);
  }
  const lead = terminal.leadOf(channel);
  const move = plan.nextMove({
    pr, task: { state: task.state, autopilot: autopilot.movesIt(channel, task) },
    dev: dev ? { state: lv.state, cause: lv.cause } : null,
    unpushed: unpushed ? unpushed.count : null,
    review: reviews.stateOf(channel, task.pr), verdict, files,
    leadMerges: !!(lead && lead.merge && !autopilot.isOn(channel)),
  });
  const rec = chOf(channel).prs[task.pr] || (chOf(channel).prs[task.pr] = { done: {} });
  // The wait counts only while the watch looks: after it was off, it starts again from now.
  const unseen = !rec.seenAt || now - rec.seenAt > 3 * config.get('prWatchSeconds') * 1000 + 60000;
  if (unseen || rec.head !== head || rec.owner !== move.owner || rec.cause !== move.cause) Object.assign(rec, { head, owner: move.owner, cause: move.cause, since: now, late: null });
  rec.why = move.why; rec.seenAt = now;
  // The push is kept by the commit to push too, so new local commits are told again.
  const key = head + ' ' + move.cause + (move.cause === 'push' && unpushed ? ' ' + unpushed.at : '');
  if (move.act && !rec.done[key]) {
    act(channel, task, move, { head, dev, unpushed, review: reviews.stateOf(channel, task.pr) });
    rec.done[key] = new Date(now).toISOString();
  }
  const late = plan.lateness(move, rec.since, now, LATE());
  rec.late = late ? late.why : null;
  if (late && !rec.done[head + ' late ' + move.cause]) {
    rec.done[head + ' late ' + move.cause] = new Date(now).toISOString();
    chat.announce(channel, 'PR ' + number(task.pr) + (task.ticket ? ' (' + task.ticket + ')' : '') + ' waits on you: ' + late.why, task.ticket);
    log('PR ' + number(task.pr) + ' waits on the person: ' + late.why);
  }
  // Only this head's actions are kept: a new head starts afresh.
  for (const k of Object.keys(rec.done)) if (!k.startsWith(head + ' ')) delete rec.done[k];
  save();
}
function act(channel, task, move, { head, dev, unpushed, review }) {
  const pr = task.pr;
  if (move.act === 'review') {
    const what = reviews.owe(channel, pr, { from: (dev && dev.cwd) || task.worktree || task.repo, dev, head });
    log('PR ' + number(pr) + ' had no review of ' + head.slice(0, 7) + ': ' + what + '.');
  } else if (move.act === 'tell-dev') {
    // The relay told the Dev of this failed check already, when the PR's review waited on it (relay/reviews.js).
    if (move.cause === 'red' && review && review.red === head) return;
    const text = move.cause === 'push' ? TEXT.push(pr, unpushed.count) : TEXT[move.cause](pr, head);
    delivery.save(channel, { key: 'pr-watch ' + pr, terminal: dev.id, sessionId: dev.sessionId, expiresAt: Date.now() + KEEP, text });
    log('Told the Dev of PR ' + number(pr) + ': ' + move.why);
  } else if (move.act === 'tell-lead') {
    delivery.save(channel, { key: 'pr-watch-lead ' + pr, to: 'lead', expiresAt: Date.now() + KEEP, text: TEXT.ready(pr, head, task.ticket) });
    log('Told the Lead PR ' + number(pr) + ' is ready: ' + move.why);
  }
}

// ---------- what the Floor, the Board and ticket.js floor show ----------
// One line for a task's PR, from memory only, so drawing a desk or a card asks GitHub nothing.
function lineOf(channel, task, now) {
  if (!ON() || !task || !task.pr) return null;
  const r = store[channel] && store[channel].prs[task.pr];
  if (!r || !r.owner) return null;
  return plan.lineOf(r.late ? Object.assign({}, r, { owner: 'you', why: r.late, late: true }) : r, now || Date.now());
}

// ---------- GET /channels/{channel}/pr-watch ----------
async function handle(req, res, channel, rest, rctx) {
  if (rest !== '/pr-watch') return false;
  const deny = terminal.localOnly(req, rctx.port);
  if (deny) { rctx.problem(res, 403, 'local_only', deny); return true; }
  if (req.method !== 'GET') { rctx.problem(res, 404, 'not_found', 'The PR watch answers GET. Turn it on or off in Settings.'); return true; }
  if (rctx.agent) { rctx.problem(res, 401, 'unauthorized', 'Sessions read the PR watch\'s lines on the Floor.'); return true; }
  const now = Date.now();
  const prs = openTasks(channel).map((t) => Object.assign({ pr: t.pr, task: t.id, ticket: t.ticket || null, head: ((store[channel] || { prs: {} }).prs[t.pr] || {}).head || null }, lineOf(channel, t, now) || {}));
  rctx.send(res, 200, { ok: true, on: ON(), every: config.get('prWatchSeconds'), waitMinutes: config.get('prWatchWaitMinutes'), prs });
  return true;
}

function begin(relayCtx) {
  ctx = relayCtx;
  config.every('prWatchSeconds', tick, 5000);  // the first look comes soon after a start, so a restart costs little
}

module.exports = { handle, begin, lineOf, tick };
