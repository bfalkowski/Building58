// The manager's watch: every managerWatchSeconds (60) the relay reads what it already keeps, looks for the six signs
// that work is stuck (relay/manager-watch-plan.js), and the manager says what it finds. See
// docs/manual/roles.html#manager-watch.
//
// What it reads: each task (relay/tasks.js), its Dev's session and the reviewers' sessions (relay/terminal.js,
// relay/liveness.js), each open task PR's checks from the shared lookup (relay/gh.js), Autopilot's finished runs
// (relay/autopilot.js) and the tickets in Ready (relay/tickets.js). It changes no status, session or PR. Its only
// writes are its own file, RELAY_MANAGER_WATCH_FILE, one ticket in Triage for each new problem, labelled manager, filed
// with relay/tickets.js, and, only while Let the manager lower the trust level is on and a stall that work cannot get
// past lasts, one step down the trust level (relay/trust-brake.js).
//
// Each problem is one note, kept with a sequence number. The room page reads them (GET /manager), puts each new one
// in Activity, and walks the manager to the desk it is about. A problem that lasts is one note and one ticket: the
// next look sees the same key and does nothing. When the sign is gone, the key is forgotten, so a problem that comes
// back is new. Answers only the room page on this computer, with the person's key.
'use strict';
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const autopilot = require('./autopilot.js');
const tickets = require('./tickets.js');
const pipeline = require('./pipeline.js');
const config = require('./config.js');
const gh = require('./gh.js');
const chat = require('./chat.js');
const { oneLine, keepLines } = require('./clean.js');
const { livenessOf } = require('./liveness.js');
const { claim } = require('./lockfile.js');
const plan = require('./manager-watch-plan.js');
const brake = require('./trust-brake.js');

const FILE = state.file('manager-watch.json', 'RELAY_MANAGER_WATCH_FILE');
const NOTES_KEPT = 30;
const FILE_PER_LOOK = 3;
const MAX_FAILED_HEADS = 20;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const BUILDING = ['building', 'changes_requested'];
const ON = () => config.get('managerWatchSeconds') > 0;

const ownsFile = claim(FILE);
let store = {};
if (ownsFile) try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') {
    const aside = FILE + '.unreadable-' + Date.now();
    try { fs.renameSync(FILE, aside); console.error('Could not read ' + FILE + '. Kept it as ' + aside); } catch (e2) { console.error('Could not keep ' + FILE + ': ' + e2.message); }
  }
}
function save() {
  if (!ownsFile) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Could not save the manager\'s watch to ' + FILE + ': ' + e.message); }
}
const chOf = (channel) => {
  const c = store[channel] || (store[channel] = {});
  return Object.assign(c, { open: c.open || {}, notes: c.notes || [], seq: c.seq || 0, checks: c.checks || {}, skipSince: c.skipSince || {}, lowered: c.lowered || [] });
};
let ctx = null;
const log = (text) => { if (ctx) ctx.log('Manager: ' + text); };
const ms = (v) => (typeof v === 'number' ? v : Date.parse(v) || 0);

const limits = () => ({
  buildingMs: config.get('managerBuildingMinutes') * 60000, checkFails: config.get('managerCheckFails'), briefMs: config.get('managerBriefMinutes') * 60000,
  slotMs: config.get('managerSlotMinutes') * 60000, handoffs: config.get('managerHandoffs'), skipMs: config.get('managerSkipMinutes') * 60000
});
const checkName = (c) => oneLine(c.name || c.context || '', 60);

async function failedChecks(channel, task) {
  const c = chOf(channel).checks;
  if (!PR_URL.test(task.pr || '') || gh.paused()) return [];
  let view;
  try { view = await gh.pr(task.pr, task.repo); } catch (e) { return []; }
  const head = String((view && view.headRefOid) || '');
  const mine = c[task.pr] || (c[task.pr] = {});
  const present = new Set(((view && view.statusCheckRollup) || []).map(checkName));
  if (present.size) for (const name of Object.keys(mine)) if (head && !present.has(name)) delete mine[name];
  for (const check of (view && view.statusCheckRollup) || []) {
    const name = checkName(check), result = String(check.conclusion || check.state || '').toUpperCase();
    if (!name || !head) continue;
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(result)) {
      const heads = mine[name] || (mine[name] = []);
      if (!heads.includes(head)) heads.push(head);
      if (heads.length > MAX_FAILED_HEADS) heads.splice(0, heads.length - MAX_FAILED_HEADS);
    } else if (result === 'SUCCESS') delete mine[name];
  }
  return Object.entries(mine).map(([name, heads]) => ({ name, heads: heads.length }));
}

async function boardOf(channel, now) {
  const c = chOf(channel), all = tasks.list(channel).filter((t) => t.state !== 'done');
  const terminals = terminal.all(channel);
  const out = { now, limits: limits(), tasks: [], seats: [], runs: [], ready: [] };
  for (const t of all) {
    const dev = terminal.find(channel, t.owner && t.owner.terminal), lv = dev ? livenessOf(dev, now) : null;
    const p = t.pr ? pipeline.of(t.pr) : null;
    out.tasks.push({
      id: t.id, ticket: t.ticket || null, title: t.title || null, repo: t.repo || null, state: t.state, slot: BUILDING.includes(t.state) && !t.movedBackByRelay,
      terminal: dev && !dev.exited ? dev.id : null, dev: !lv ? null : lv.state === 'gone' ? 'gone' : lv.state === 'waiting' ? 'waiting' : 'live',
      movedAt: Math.max(ms(t.createdAt), ms(t.updatedAt), dev ? dev.lastActAt || 0 : 0, p ? p.since || 0 : 0), since: ms(t.updatedAt) || ms(t.createdAt),
      checks: t.state !== 'done' && t.pr ? await failedChecks(channel, t) : []
    });
  }
  for (const pr of Object.keys(c.checks)) if (!all.some((t) => t.pr === pr)) delete c.checks[pr];
  for (const t of terminals) {
    if (t.stopped || !t.startedAt) continue;
    const task = t.reviewOf ? all.find((x) => x.pr === t.reviewOf) : all.find((x) => x.id === t.task || (x.owner && x.owner.terminal === t.id));
    if (t.reviewOf) out.seats.push({ terminal: t.id, role: 'reviewer', task: task ? task.id : null, ticket: task ? task.ticket || null : null, repo: task ? task.repo || null : null, who: chat.nameOf(t), startedAt: ms(t.startedAt), briefed: !!(t.talked || t.spoke) });
    else if (task && task.owner && task.owner.terminal === t.id) out.seats.push({ terminal: t.id, role: 'Dev', task: task.id, ticket: task.ticket || null, repo: task.repo || null, who: chat.nameOf(t), startedAt: ms(t.startedAt), briefed: task.briefed !== false });
  }
  if (autopilot.isOn(channel)) {
    const repoOf = (id) => (tasks.list(channel).find((x) => x.id === id) || {}).repo || null;
    out.runs = autopilot.endedRuns(channel).map((r) => ({ task: r.task, ticket: r.ticket, repo: repoOf(r.task), outcome: r.outcome }));
    const every = await tickets.listAll(channel);
    const seen = new Set();
    for (const t of every.filter((x) => x.status === 'ready' && x.repo && !tasks.ofTicket(channel, x))) {
      const rejected = (t.blockedBy || []).filter((id) => (every.find((x) => x.id === id) || {}).status === 'rejected');
      if (!rejected.length) continue;
      seen.add(t.id);
      if (!c.skipSince[t.id]) c.skipSince[t.id] = now;
      out.ready.push({ id: t.id, title: t.title, repo: t.repo, rejected, since: c.skipSince[t.id] });
    }
    for (const id of Object.keys(c.skipSince)) if (!seen.has(id)) delete c.skipSince[id];
  } else c.skipSince = {};
  return out;
}

function ticketFor(f) {
  const who = f.ticket || (f.task ? 'Task ' + f.task : 'the room');
  const title = oneLine(who + ': ' + f.say, 80);
  const body = keepLines([
    f.reason, '',
    f.title ? 'Ticket: ' + oneLine(f.title, 120) : '',
    'What to do: look at it, and fix the cause. If it is already fixed, close this ticket.',
    'Filed by the manager\'s watch (relay/manager-watch.js). It files one ticket for each new problem, and none again while the problem lasts.'
  ].filter((l, i, a) => l || a[i - 1] !== '').join('\n'));
  return { title, body };
}
async function file(channel, f) {
  const repo = f.repo || (tasks.list(channel).find((t) => t.repo) || {}).repo;
  if (!repo) return null;
  const [status, out] = await tickets.fileAsManager(channel, Object.assign({ repo }, ticketFor(f)));
  return status < 300 && out.ticket ? out.ticket.id : null;
}

const looked = new Map();
let looking = false;
async function look(channel, now) {
  const c = chOf(channel);
  const found = plan.findings(await boardOf(channel, now));
  const keys = new Set(found.map((f) => f.key));
  let filedNow = 0;
  for (const key of Object.keys(c.open)) if (!keys.has(key)) delete c.open[key];
  for (const f of found) {
    let rec = c.open[f.key];
    const isNew = !rec;
    if (isNew) rec = c.open[f.key] = { at: now, ticket: null, tries: 0 };
    if (!rec.ticket && rec.tries < 3 && filedNow < FILE_PER_LOOK) {
      rec.tries++; filedNow++;
      try { rec.ticket = (await file(channel, f)) || null; } catch (e) { log('Could not file a ticket for ' + f.key + ': ' + e.message); }
      if (rec.ticket) c.notes.filter((n) => n.key === f.key).forEach((n) => { n.filed = rec.ticket; });
    }
    if (isNew) {
      c.notes.push({ seq: ++c.seq, at: new Date(now).toISOString(), key: f.key, kind: f.kind, ticket: f.ticket, task: f.task, terminal: f.terminal, reason: f.reason, say: f.say, filed: rec.ticket });
      c.notes = c.notes.slice(-NOTES_KEPT);
      log(f.reason);
    }
    if (!rec.braked && brake.STALLS.has(f.kind) && config.get('managerLowersTrust')) {
      rec.braked = true;
      const out = brake.lower(channel, f, c.lowered, now);
      if (out && out.limit) log('Not lowering the trust level for ' + f.key + ': it was lowered ' + brake.PER_DAY + ' times in the last day already. The rest is yours.');
      else if (out) {
        c.notes.push({ seq: ++c.seq, at: new Date(now).toISOString(), key: f.key, kind: 'brake', ticket: f.ticket, task: f.task, terminal: f.terminal, reason: out.entry.said, say: out.entry.say, filed: null });
        c.notes = c.notes.slice(-NOTES_KEPT);
        log(out.entry.said);
      }
    }
  }
  looked.set(channel, { at: now, count: ((looked.get(channel) || {}).count || 0) + 1 });
  save();
}
async function tick() {
  if (looking || !ctx || !ON()) return;
  looking = true;
  try {
    for (const channel of tasks.channels()) await look(channel, Date.now());
  } catch (e) { log(e.message); } finally { looking = false; }
}

function viewOf(channel) {
  const c = chOf(channel);
  const l = looked.get(channel);
  return { ok: true, on: ON(), every: config.get('managerWatchSeconds'), looks: l ? l.count : 0, lastLook: l ? new Date(l.at).toISOString() : null, limits: { buildingMinutes: config.get('managerBuildingMinutes'), checkFails: config.get('managerCheckFails'), briefMinutes: config.get('managerBriefMinutes'), slotMinutes: config.get('managerSlotMinutes'), handoffs: config.get('managerHandoffs'), skipMinutes: config.get('managerSkipMinutes') },
    checks: Object.entries(c.checks).flatMap(([pr, mine]) => Object.entries(mine).map(([name, heads]) => ({ pr, name, commits: heads.length }))),
    lowersTrust: !!config.get('managerLowersTrust'), lowered: c.lowered.map((x) => Object.assign({}, x)), open: Object.entries(c.open).map(([key, r]) => ({ key, since: new Date(r.at).toISOString(), ticket: r.ticket })), notes: c.notes.map((n) => Object.assign({ filed: null }, n)) };
}

async function handle(req, res, channel, rest, rctx) {
  if (rest !== '/manager') return false;
  const deny = terminal.localOnly(req, rctx.port);
  if (deny) { rctx.problem(res, 403, 'local_only', deny); return true; }
  if (req.method !== 'GET') { rctx.problem(res, 404, 'not_found', 'The manager\'s watch answers GET. Change its limits in Settings.'); return true; }
  if (rctx.agent) { rctx.problem(res, 401, 'unauthorized', 'Only the person reads the manager\'s notes.'); return true; }
  rctx.send(res, 200, viewOf(channel));
  return true;
}

function begin(relayCtx) {
  ctx = relayCtx;
  config.every('managerWatchSeconds', tick, 5000);
}

module.exports = { handle, begin, tick };
