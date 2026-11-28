// Metrics: GET /channels/<channel>/metrics?range=1d|7d|30d answers the numbers behind office/metrics.html as
// JSON, or as CSV with &format=csv. relay/metrics-plan.js makes the answer. This file keeps what nothing
// else keeps, in RELAY_METRICS_FILE (metrics.json in the state folder) for 90 days:
//   a desk sample every 5 minutes: desks working, idle, waiting on the person, stuck and free, and whether
//     a base branch is red
//   a room sample every 5 minutes: the container's CPU and memory, from the cgroup files or /proc
//   when each review's session started, for the time a PR waited for its review
//   the PM's verdicts, once something writes them (notePm)
//   each session's Skill calls and its role, counted from Claude Code's transcript of the session
// It reads the rest from Autopilot's run records (relay/autopilot.js), the COO's store (relay/coo.js) and
// the tasks (relay/tasks.js). Like the terminal, it answers only the room page on this machine.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('./state.js');
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const autopilot = require('./autopilot.js');
const coo = require('./coo.js');
const mainCi = require('./main-ci.js');
const { livenessOf } = require('./liveness.js');
const { claim } = require('./lockfile.js');
const plan = require('./metrics-plan.js');
const jams = require('./jams.js');
const seatSteps = require('./seat-steps.js');
const skills = require('./skills.js');

const FILE = state.file('metrics.json', 'RELAY_METRICS_FILE');
const WATCH_MS = 10 * 1000;
const CGROUP = '/sys/fs/cgroup';

let store = plan.blank();
try { store = plan.shape(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) {
  if (e.code !== 'ENOENT') {
    const aside = FILE + '.unreadable-' + Date.now();
    try { fs.renameSync(FILE, aside); console.error('Could not read ' + FILE + '. Kept it as ' + aside); } catch (e2) { console.error('Could not read ' + FILE + ': ' + e.message); }
  }
}
const ownsFile = claim(FILE);
function save() {
  if (!ownsFile) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store) + '\n');
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Could not save the metrics to ' + FILE + ': ' + e.message); }
}

const channels = new Set(Object.keys(store.desks));
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; } };
let lastCpu = null;
function cpuNow() {
  const stat = read(CGROUP + '/cpu.stat'), usage = stat && stat.match(/^usage_usec (\d+)/m);
  if (usage) return { at: Date.now(), used: Number(usage[1]) };
  const proc = read('/proc/stat'), line = proc && proc.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  if (!line || line.length < 5) return null;
  const idle = line[3] + (line[4] || 0), total = line.reduce((a, b) => a + b, 0);
  return { at: Date.now(), busy: total - idle, total, host: true };
}
function roomNow() {
  const was = lastCpu, now = cpuNow();
  lastCpu = now;
  let cpu = null;
  if (was && now && was.host === now.host) {
    if (now.host) cpu = now.total > was.total ? ((now.busy - was.busy) / (now.total - was.total)) * os.cpus().length * 100 : null;
    else cpu = now.at > was.at ? ((now.used - was.used) / ((now.at - was.at) * 1000)) * 100 : null;
  }
  const current = Number((read(CGROUP + '/memory.current') || '').trim()), max = Number((read(CGROUP + '/memory.max') || '').trim());
  const total = (read('/proc/meminfo') || '').match(/^MemTotal:\s+(\d+) kB/m), free = (read('/proc/meminfo') || '').match(/^MemAvailable:\s+(\d+) kB/m);
  const limit = max > 0 && Number.isFinite(max) ? max : total ? Number(total[1]) * 1024 : os.totalmem();
  const memory = current > 0 ? current : total && free ? (Number(total[1]) - Number(free[1])) * 1024 : os.totalmem() - os.freemem();
  return cpu === null ? null : { cpu: Math.round(cpu * 10) / 10, memory: Math.round(memory), limit: Math.round(limit) };
}

function desksOf(channel, now) {
  const row = { working: 0, idle: 0, waiting: 0, stuck: 0 };
  for (const t of terminal.all(channel)) {
    const s = livenessOf(t, now).state;
    if (s === 'gone') continue;
    if (s === 'waiting') row.waiting++; else if (s === 'idle') row.idle++; else if (s === 'stuck') row.stuck++; else row.working++;
  }
  const taken = row.working + row.idle + row.waiting + row.stuck;
  return [row.working, row.idle, row.waiting, row.stuck, Math.max(0, terminal.DESKS - taken), mainCi.redOf(channel).length];
}
function tick(now) {
  const rows = {};
  for (const t of terminal.everyone()) channels.add(t.channel);
  for (const c of channels) rows[c] = desksOf(c, now);
  const room = roomNow();
  if (plan.take(store, now, rows, room)) save();
}
function watchReviews() {
  let changed = false;
  for (const t of terminal.everyone()) if (t.reviewOf) changed = plan.noteReview(store, t.reviewOf, t.round, Date.parse(t.startedAt) || Date.now()) || changed;
  if (changed) save();
}
const seen = new Map();
function watchSkills() {
  let changed = false;
  for (const t of terminal.everyone()) {
    const role = skills.roleOf({ task: t.task, role: t.role }, t, t.lead);
    const file = role && seatSteps.fileOf(t.cwd, t.sessionId, process.env.CLAUDE_CONFIG_DIR);
    if (!file) continue;
    let size;
    try { size = fs.statSync(file).size; } catch (e) { continue; }
    if (seen.get(file) === size) continue;
    seen.set(file, size);
    changed = plan.noteSkills(store, t.sessionId, role, Date.parse(t.startedAt) || Date.now(), seatSteps.read(file, { steps: false }).skills) || changed;
  }
  if (changed) save();
}
function start(channel) {
  if (channel) channels.add(channel);
  roomNow();
  setInterval(() => tick(Date.now()), 60 * 1000).unref();
  setInterval(watchReviews, WATCH_MS).unref();
  setInterval(watchSkills, 60 * 1000).unref();
}
function notePm(channel, verdict) {
  const n = (k) => Math.max(0, Number(verdict[k]) || 0);
  store.pm.push({ at: Date.now(), checked: n('checked'), held: n('held'), closed: n('closed'), merged: n('merged'), moved: n('moved'), hoursSaved: n('hoursSaved') });
  save();
}

function inputOf(channel, range, now) {
  const runs = Object.values(autopilot.runsKept(channel));
  const cooStore = coo.storeOf(channel);
  return { now, range, runs, tasks: tasks.list(channel), hands: cooStore.hands, events: cooStore.events, desks: store.desks[channel] || [], room: store.room, reviews: store.reviews, pm: store.pm, skills: store.skills, jams: jams.listOf(channel) };
}

async function handle(req, res, channel, rest, ctx) {
  if (rest !== '/metrics') return false;
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (req.method !== 'GET') { ctx.problem(res, 404, 'not_found', 'Metrics answers GET only.'); return true; }
  if (ctx.agent) { ctx.problem(res, 401, 'unauthorized', 'Only the person reads the metrics.'); return true; }
  const params = new URL(req.url, 'http://local').searchParams;
  const range = plan.rangeOf(params.get('range') || '7d'), format = params.get('format') || 'json';
  if (!range) { ctx.problem(res, 400, 'bad_param', 'range is 1d, 7d or 30d.'); return true; }
  if (!['json', 'csv'].includes(format)) { ctx.problem(res, 400, 'bad_param', 'format is json or csv.'); return true; }
  channels.add(channel);
  const data = plan.build(inputOf(channel, range, Date.now()));
  if (format === 'csv') ctx.send(res, 200, plan.csv(data), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="building58-metrics-' + range + '.csv"' });
  else ctx.send(res, 200, data);
  return true;
}

module.exports = { handle, start, notePm, tick, watchReviews, watchSkills, inputOf, FILE };
