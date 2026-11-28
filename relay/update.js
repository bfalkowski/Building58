// The Update button: brings merged changes into the relay's own folder. It fetches first and plans
// from what came in. Pages are read from disk on each request, so when only they changed it
// fast-forwards and the page just reloads. When the relay's own files changed, it waits only for what
// a restart still breaks (whoIsBusy), then fast-forwards and restarts the relay at once. Until then the
// folder stays as it was, so the old relay never serves new pages, the global hooks never run new code
// against the old relay, and calling the restart off leaves nothing behind. The sessions keep running
// in the session host, and the new relay takes each one back (relay/sessions.js).
// While it waits, it holds saved messages only for RELAY_UPDATE_HOLD_MS. After Update waits at most, it restarts anyway.
// See docs/manual/running.html#update and #update-hold.
//
// While RELAY_ROLLBACK=1, it takes main forward one merge at a time instead. A merge that changes no
// relay file goes in at once and is checked on this relay. One that changes relay files restarts the
// relay, and the next relay carries the loop on once the supervisor's check passes (begin, called from
// relay/server.js). The loop stops at the first failed check, at its limit, or when the person stops it
// between steps (relay/update-steps.js, docs/manual/running.html#update-steps).
//
// It runs git on this computer, so like the terminal it answers only the room page on this machine,
// and only while RELAY_TERMINAL=1.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const checkouts = require('./checkouts.js');
const huddles = require('./huddles.js');
const { RESTART } = require('./supervisor.js');
const coo = require('./coo.js');
const hostLink = require('./host-link.js');
const rollback = require('./rollback.js');
const steps = require('./update-steps.js');
const config = require('./config.js');
const state = require('./state.js');
const { livenessOf, jobsOf } = require('./liveness.js');
const noteForCoo = (channel, kind, detail) => { if (channel) coo.noteEvent(channel, kind, detail); };

const DIR = path.resolve(process.env.RELAY_UPDATE_DIR || path.join(__dirname, '..'));
const BRANCH = 'main';
const PULL = { timeout: 60000, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) };
const SUPERVISED = process.env.RELAY_SUPERVISED === '1';
const STEPPING = () => SUPERVISED && rollback.ON();

const RUN = require('crypto').randomBytes(6).toString('hex');
let LOADED = null;
try { LOADED = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { /* not a git folder: Update says so when pressed */ }
function rolledBack() { const r = rollback.read().rollback; return r && LOADED && (r.running === LOADED || r.running === rollback.head()) && !rollback.onBranch() ? r : null; }
const FORCED_FILE = state.file('update-forced.json');
const TOOL_WAIT_MS = 60000;
const TOOL_STALE_MS = 10 * 60 * 1000;
const lastForced = () => { try { return Date.parse(JSON.parse(fs.readFileSync(FORCED_FILE, 'utf8')).at) || 0; } catch (e) { return 0; } };
const WAIT_LIMIT = () => config.get('updateWaitMinutes') * 60 * 1000;
const FORCED_EVERY = () => config.get('updateForcedMinutes') * 60 * 1000;
const forceAt = (waitSince) => { const last = lastForced(); return Math.max(waitSince + WAIT_LIMIT(), last ? last + FORCED_EVERY() : 0); };
const toolOpen = () => terminal.everyone().some((t) => t.toolAt && Date.now() - t.toolAt < TOOL_STALE_MS);
const minutesOf = (ms) => Math.max(0, Math.round(ms / 60000));
let job = null;
let pulling = false;
let lastNote = null, noteAt = null;
let lastReloads = 0;
const HOLD = () => config.get('updateHoldMinutes') * 60 * 1000;
terminal.holdWhileUpdating({
  updating: () => !!job,
  restarting: () => !!job && job.state === 'restarting',
  holding: () => !!job && (job.state === 'restarting' || Date.now() - Date.parse(job.startedAt) < HOLD())
});

const isRelayFile = (f) => f.startsWith('relay/') && !f.startsWith('relay/test/');
const LOADED_ONCE = ['relay/supervisor.js', 'relay/session-host.js', 'relay/pty-bridge.py'];
const JOB_LIMIT = () => config.get('autopilotStallMinutes') * 60 * 1000;
const jobWaited = (t) => { const j = livenessOf(t, Date.now()).state === 'job' && jobsOf(t); return !!j && Date.now() - (j.since || Date.now()) < JOB_LIMIT(); };

const ENTER_COUNTS = 5000;
const PRINTS = 5000;
const answered = (t) => t.answeredAt >= (t.waitingAt || 0) && Date.now() - Math.max(t.answeredAt, t.lastOutAt || 0) < PRINTS;
function whoIsBusy() {
  const refreshing = terminal.everyone().filter((t) => t.refresh).map((t) => ({ terminal: t.id, title: 'The Lead', why: 'refreshing' }));
  const out = refreshing.concat(terminal.everyone().filter((t) => !t.refresh).map((t) => {
    const why = t.typingFirst ? 'the relay is typing its first prompt' : t.state === 'working' ? 'in a turn' : t.state === 'waiting' ? (answered(t) ? 'answered its question, so it is in a turn' : null)
      : Date.now() - (t.lastEnterAt || 0) < ENTER_COUNTS ? 'just sent a prompt' : t.drafting ? 'has text in its prompt'
        : t.spoke && !t.hooked ? 'no hooks reach the relay from it, so it may be in a turn' : null;
    return why && { terminal: t.id, title: t.title || path.basename(t.cwd), why };
  }).filter(Boolean));
  for (const t of terminal.everyone()) if (t.posted && !out.some((w) => w.terminal === t.id)) out.push({ terminal: t.id, title: t.title || 'A reviewer', why: 'has posted its review and is about to leave' });
  if (tasks.busy()) out.push({ terminal: null, title: 'A new task', why: 'starting' });
  if (huddles.busy()) out.push({ terminal: null, title: 'A huddle', why: 'waiting for answers' });
  if (checkouts.busy()) out.push({ terminal: null, title: 'A new checkout', why: 'being made' });
  for (const t of terminal.everyone()) if (jobWaited(t) && !out.some((w) => w.terminal === t.id)) out.push({ terminal: t.id, title: t.title || path.basename(t.cwd), why: 'running a job' });
  return out;
}
function view() {
  if (!job) return null;
  const waiting = job.state === 'waiting';
  const v = { state: job.state, from: job.from, to: job.to, files: job.files, startedAt: job.startedAt, waitingOn: waiting ? whoIsBusy() : [] };
  if (waiting && job.waitSince) Object.assign(v, { waitedMinutes: minutesOf(Date.now() - job.waitSince), restartsAnywayAt: new Date(forceAt(job.waitSince)).toISOString() });
  if (job.steps) {
    const s = job.steps[Math.min(job.at, job.steps.length - 1)];
    v.step = { at: Math.min(job.at + 1, job.steps.length), of: job.steps.length, sha: s.sha, pr: s.pr, name: steps.name(s), later: job.later, reloads: job.reloads, stopping: !!job.stop };
  }
  return v;
}
const note = (ctx, text, channel, kind) => { lastNote = text; noteAt = Date.now(); ctx.log(text); if (kind) noteForCoo(channel, kind, text); };

async function refusal() {
  const branch = await tasks.git(DIR, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '');
  if (branch !== BRANCH) {
    const back = branch ? null : rolledBack();
    const why = back ? ' It went back to ' + back.running.slice(0, 7) + ' when ' + back.failed.slice(0, 7) + ' failed its check. Fix main first.' : '';
    return [409, { ok: false, error: 'not_main', rollback: back, message: 'The relay\'s folder ' + DIR + ' is ' + (branch ? 'on ' + branch : 'not on a branch') + ', not ' + BRANCH + ', so Update will not pull there.' + why + ' Check out ' + BRANCH + ' in that folder first.' }];
  }
  const changed = await tasks.git(DIR, ['diff', '--name-only', 'HEAD']);
  if (changed) {
    const files = changed.split('\n');
    return [409, { ok: false, error: 'local_changes', files, message: 'The relay\'s folder ' + DIR + ' has local changes, so Update will not pull there: ' + files.join(', ') + '. Commit them or put them away first.' }];
  }
  return null;
}

async function fetchMain() {
  try { await tasks.git(DIR, ['fetch', '--quiet'], PULL); } catch (e) {
    return { refused: [409, { ok: false, error: 'pull_failed', message: 'git fetch in ' + DIR + ' failed: ' + e.message }] };
  }
  const to = await tasks.git(DIR, ['rev-parse', '--verify', '--quiet', BRANCH + '@{upstream}']).catch(() => '');
  if (!to) return { refused: [409, { ok: false, error: 'pull_failed', message: BRANCH + ' in ' + DIR + ' has no upstream branch, so Update has nothing to pull. Set one with git branch -u.' }] };
  const head = await tasks.git(DIR, ['rev-parse', 'HEAD']);
  const ff = await tasks.git(DIR, ['merge-base', '--is-ancestor', head, to]).then(() => true, () => false);
  if (!ff) return { refused: [409, { ok: false, error: 'pull_failed', message: BRANCH + ' in ' + DIR + ' has commits its upstream does not, so it cannot fast-forward. Sort it out by hand. Update never merges.' }] };
  return { from: head, to };
}
async function fastForward(to) {
  const refused = await refusal();
  if (refused) throw new Error(refused[1].message);
  await tasks.git(DIR, ['merge', '--ff-only', '--quiet', to], PULL);
}

function restartWhenQuiet(ctx, channel) {
  clearInterval(job.timer);
  job.waitSince = job.waitSince || Date.now(); job.forcing = 0; job.fetching = false;
  job.timer = setInterval(() => {
    if (!job || job.state !== 'waiting' || pulling || job.fetching) return;
    if (!whoIsBusy().length) return restartNow(ctx, channel, false);
    if (Date.now() < forceAt(job.waitSince)) return;
    job.forcing = job.forcing || Date.now();
    if (toolOpen() && Date.now() - job.forcing < TOOL_WAIT_MS) return;
    job.fetching = true;
    run(ctx).catch(() => {}).then(() => { if (job) { job.fetching = false; if (job.state === 'waiting') restartNow(ctx, channel, true); } });
  }, 500);
}
function restartNow(ctx, channel, forced) {
  clearInterval(job.timer);
  job.state = 'restarting';
  const to = job.next || job.to;
  const waited = Date.now() - job.waitSince;
  ctx.log((forced ? 'The update has waited ' + minutesOf(waited) + ' minutes, so it restarts the relay anyway to run ' : 'Restarting the relay to run ') + to.slice(0, 7) + (job.steps ? ', ' + stepWords() : '') + '. Every session keeps running, and the new relay takes it back.');
  setTimeout(async () => {
    const busy = forced ? [] : whoIsBusy();
    if (busy.length) {
      const who = busy.map((w) => w.title + ' (' + w.why + ')').join(', ');
      if (job.steps) return endLoop(ctx, stoppedBefore('the restart was called off, since ' + who + ' started just before it.'), 'update_called_off');
      note(ctx, 'The restart was called off, since ' + who + ' started just before it. The relay\'s folder is as it was. The update waits for the next quiet moment, and its limit still counts from when it first waited.', channel, 'update_called_off');
      job.state = 'waiting';
      return restartWhenQuiet(ctx, channel);
    }
    try { await fastForward(to); } catch (e) {
      if (job.steps) return endLoop(ctx, stoppedBefore('the relay\'s folder could not fast-forward to ' + to.slice(0, 7) + ': ' + e.message), 'update_failed');
      note(ctx, 'The restart was called off, since the relay\'s folder could not fast-forward to ' + to.slice(0, 7) + ': ' + e.message + ' The folder is as it was.', channel, 'update_failed');
      job = null; return;
    }
    if (forced) {
      const text = 'Forced restart after ' + minutesOf(waited) + ' minutes of waiting, to run ' + to.slice(0, 7) + '. Sessions in a turn: ' + terminal.everyone().filter((t) => t.state === 'working').length + '.';
      noteForCoo(job.channel || channel, 'update_forced', text);
      try { fs.mkdirSync(path.dirname(FORCED_FILE), { recursive: true }); fs.writeFileSync(FORCED_FILE, JSON.stringify({ at: new Date().toISOString(), to, waitedMs: waited }) + '\n'); } catch (e) { ctx.log('Could not save the time of the forced restart: ' + e.message); }
    }
    if (job.steps) saveLoop(ctx);
    terminal.close(); process.exit(RESTART);
  }, 300);
}

async function update(body, ctx, channel) {
  if (body.cancel) {
    if (job && job.steps) {
      if (job.state === 'waiting') endLoop(ctx, stoppedBefore('you stopped it.'), null);
      else if (job.state !== 'restarting' && !job.stop) { job.stop = true; ctx.log('Update stops after ' + stepWords() + ', as asked.'); }
      return [200, { ok: true, update: view() }];
    }
    if (job && job.state === 'waiting') {
      clearInterval(job.timer); job = null;
      note(ctx, 'The restart was called off. Nothing was pulled, so the relay\'s folder is as it was. Press Update again to wait for the next quiet moment.', channel, null);
    }
    return [200, { ok: true, update: view() }];
  }
  if (job || pulling) return [409, { ok: false, error: 'updating', message: 'An update is already under way.', update: view() }];
  pulling = true;
  try { return await pullAndPlan(ctx, channel); } finally { pulling = false; }
}
async function pullAndPlan(ctx, channel) {
  lastNote = null; noteAt = null;
  const refused = await refusal();
  if (refused) return refused;
  const fetched = await fetchMain();
  if (fetched.refused) { noteForCoo(channel, 'update_failed', fetched.refused[1].message); return fetched.refused; }
  const { from, to } = fetched;
  const diff = async (a) => (a === to ? [] : (await tasks.git(DIR, ['diff', '--name-only', a, to])).split('\n').filter(Boolean));
  const files = await diff(from);
  const relayFiles = (LOADED ? await diff(LOADED).catch(() => files) : files).filter(isRelayFile);
  if (from === to && !relayFiles.length) return [200, { ok: true, changed: false, message: 'Already up to date.' }];
  const fetchedWords = from === to ? 'Nothing new to pull, but this relay runs older code than ' + to.slice(0, 7) + '.' : 'Fetched ' + from.slice(0, 7) + '..' + to.slice(0, 7) + '.';
  ctx.log('Update: ' + fetchedWords + ' ' + files.length + ' files changed, ' + relayFiles.length + ' relay files differ from the code this relay runs.');
  const pullNow = async () => {
    try { await fastForward(to); } catch (e) {
      noteForCoo(channel, 'update_failed', 'git merge --ff-only failed: ' + e.message);
      return [409, { ok: false, error: 'pull_failed', message: 'Could not fast-forward ' + DIR + ' to ' + to.slice(0, 7) + ': ' + e.message }];
    }
    return null;
  };
  const pulled = from === to ? fetchedWords : 'Pulled ' + from.slice(0, 7) + '..' + to.slice(0, 7) + '.';
  if (STEPPING() && from !== to) return startLoop(ctx, channel, from, to, files, relayFiles);
  if (!relayFiles.length) return (await pullNow()) || [200, { ok: true, changed: true, from, to, files, reload: true, message: pulled + ' Only page files changed, so the page reloads.' }];
  const once = LOADED_ONCE.filter((f) => relayFiles.includes(f));
  const onceNote = once.length ? ' ' + once.join(' and ') + (once.length > 1 ? ' changed too. They run' : ' changed too. It runs') + ' until you stop the relay yourself, so stop and start it once to use the new code.' : '';
  if (!SUPERVISED) {
    const failed = await pullNow();
    if (failed) return failed;
    return [200, { ok: true, changed: true, from, to, files, restart: false, message: pulled + ' The relay\'s own files changed, but this relay cannot restart itself. Stop it and start it again; every session comes back.' }];
  }
  job = { state: 'waiting', from, to, files: relayFiles, startedAt: new Date().toISOString(), timer: null };
  restartWhenQuiet(ctx, channel);
  return [202, { ok: true, changed: true, from, to, files, restart: true, run: RUN, message: fetchedWords + ' The relay pulls it and restarts once no session is in a turn. A session at a question stays at it. Until then the folder is as it was. Every session keeps running through it.' + onceNote, update: view() }];
}

async function handle(req, res, channel, rest, ctx) {
  if (rest !== '/update') return false;
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (!terminal.ENABLED) { ctx.problem(res, 404, 'terminal_off', 'Update needs the terminal. Start the relay with npm run office, or with RELAY_TERMINAL=1.'); return true; }
  let out;
  if (req.method === 'GET') out = [200, { ok: true, dir: DIR, branch: BRANCH, run: RUN, update: view(), note: lastNote, noteAt, reloads: lastReloads, steps: STEPPING(), rollback: rolledBack(), host: hostLink.gapWords() }];
  else if (req.method === 'POST') out = await update(await ctx.readJson(req), ctx, channel);
  if (!out) { ctx.problem(res, 404, 'not_found', 'Unknown update route.'); return true; }
  ctx.send(res, out[0], out[1]);
  return true;
}

const run = (ctx) => (pulling ? Promise.resolve([200, { ok: true, changed: false, message: 'A pull is already under way, and it gets this merge too.' }])
  : job && job.steps && job.state !== 'restarting' ? pullMoreSteps(ctx) : job && job.state === 'waiting' ? pullMore(ctx) : update({}, ctx));
const calledOffAsFetched = () => [200, { ok: true, changed: false, restart: false, message: 'The restart was called off as it fetched, so nothing was pulled. Press Update to pull the new code.' }];
async function pullMore(ctx) {
  pulling = true;
  try {
    const refused = await refusal();
    if (refused) return refused;
    const fetched = await fetchMain();
    if (fetched.refused) return fetched.refused;
    const { to } = fetched;
    if (!job) return calledOffAsFetched();
    const from = job.to;
    if (from === to) return [200, { ok: true, changed: false, restart: true, message: 'Already up to date.' }];
    const words = 'Fetched ' + from.slice(0, 7) + '..' + to.slice(0, 7) + '.';
    const files = job.files;
    const relayFiles = LOADED ? await tasks.git(DIR, ['diff', '--name-only', LOADED, to]).then((out) => out.split('\n').filter(isRelayFile), () => files) : files;
    if (!job) return calledOffAsFetched();
    job.to = to; job.files = relayFiles;
    ctx.log('Update: fetched ' + from.slice(0, 7) + '..' + to.slice(0, 7) + ' into the update that waits. The restart pulls and runs ' + to.slice(0, 7) + '.');
    return [200, { ok: true, changed: true, from, to, restart: true, message: words + ' It goes into the update that waits.', update: view() }];
  } finally { pulling = false; }
}
const updating = () => !!job || pulling;
const restarting = () => !!job && job.state === 'restarting';
const waiting = () => !!job && !job.steps && (job.state === 'waiting' || job.state === 'restarting');

const onceWords = (once) => (once && once.length ? ' ' + once.join(' and ') + (once.length > 1 ? ' changed too. They run' : ' changed too. It runs') + ' until you stop the relay yourself, so stop and start it once to use the new code.' : '');
const onceIn = (files) => LOADED_ONCE.filter((f) => files.includes(f));
const stepWords = () => (job.at + 1) + ' of ' + job.steps.length + ', ' + steps.name(job.steps[job.at]);
const waits = (n) => (n > 1 ? ' wait' : ' waits');
function whereItStands(i, pass) {
  const done = job.steps.slice(0, i), wait = job.steps.slice(pass ? i : i + 1);
  const waitWords = (wait.length ? steps.names(wait) : '') + (job.later ? (wait.length ? ' and ' : '') + job.later + ' more' : '');
  return (done.length ? ' ' + steps.names(done) + (done.length > 1 ? ' are' : ' is') + ' in.' : '')
    + (wait.length || job.later ? ' ' + waitWords + waits(wait.length + job.later) + ' for the next Update.' : '');
}
const stoppedBefore = (why) => 'Update stopped at ' + stepWords() + ', before its restart: ' + why + whereItStands(job.at, true) + ' The relay\'s folder stays on ' + (job.at ? job.steps[job.at - 1].sha : job.from).slice(0, 7) + ', the commit before it.';
function endLoop(ctx, text, kind) {
  if (!job) return;
  clearInterval(job.timer);
  steps.clear();
  lastReloads = job.reloads || 0;
  const channel = job.channel, once = job.once;
  job = null;
  note(ctx, text + onceWords(once), channel, kind);
}
function saveLoop(ctx) {
  job.onceBefore = job.once || [];
  job.once = [...new Set(job.onceBefore.concat(onceIn(job.files)))];
  try {
    steps.write({ dir: DIR, channel: job.channel || null, from: job.from, to: job.to, steps: job.steps, at: job.at, later: job.later, once: job.once, onceBefore: job.onceBefore, startedAt: job.startedAt, restartAt: new Date().toISOString() });
  } catch (e) { ctx.log('Could not save the Update loop, so it ends with this step: ' + e.message); }
}
const stepFailed = (ctx) => (e) => endLoop(ctx, 'Update stopped at ' + stepWords() + ': ' + e.message, 'update_failed');

async function startLoop(ctx, channel, from, to, files, relayFiles) {
  let all;
  try { all = await steps.list(DIR, from, to); } catch (e) { return [409, { ok: false, error: 'pull_failed', message: 'Could not list the merges ' + from.slice(0, 7) + '..' + to.slice(0, 7) + ': ' + e.message }]; }
  const now = all.slice(0, steps.LIMIT());
  job = { state: 'stepping', from, to: now[now.length - 1].sha, files: [], steps: now, at: 0, later: all.length - now.length, reloads: 0, stop: false, once: [], channel: channel || null, startedAt: new Date().toISOString(), timer: null, next: null };
  const words = 'Fetched ' + from.slice(0, 7) + '..' + to.slice(0, 7) + ': ' + all.length + (all.length === 1 ? ' merge' : ' merges') + (job.later ? ', ' + now.length + ' of them in this run' : '') + '. Update takes them one at a time, oldest first: ' + steps.names(now) + '.';
  ctx.log('Update: ' + words);
  nextStep(ctx).catch(stepFailed(ctx));
  return [202, { ok: true, changed: true, from, to, files, restart: true, run: RUN, message: words + ' Each one that changes the relay restarts it, and the next goes in only once the new relay passes its check.' + onceWords(onceIn(relayFiles)), update: view() }];
}

async function nextStep(ctx) {
  if (!job) return;
  const all = job.steps.length;
  if (job.stop) return endLoop(ctx, 'Update stopped after ' + job.at + ' of ' + all + ', as asked.' + whereItStands(job.at, true), null);
  if (job.at >= all) return endLoop(ctx, 'Update is done: ' + all + (all === 1 ? ' merge' : ' merges') + ' in, one at a time, and each passed its check.' + (job.later ? ' ' + job.later + ' more' + waits(job.later) + ' for the next Update.' : ''), null);
  const step = job.steps[job.at];
  job.next = step.sha; job.state = 'stepping';
  const relayFiles = LOADED ? (await tasks.git(DIR, ['diff', '--name-only', LOADED, step.sha])).split('\n').filter(isRelayFile) : null;
  if (!job) return;
  if (relayFiles && !relayFiles.length) return pageStep(ctx, step);
  job.state = 'waiting'; job.files = relayFiles || [];
  ctx.log('Update: ' + stepWords() + ' changes relay files, so the relay restarts on it once no session is in a turn.' + onceWords(onceIn(job.files)));
  restartWhenQuiet(ctx, job.channel);
}

async function pageStep(ctx, step) {
  ctx.log('Update: ' + stepWords() + ' changes no relay file, so it goes in with no restart.');
  try { await fastForward(step.sha); } catch (e) { return endLoop(ctx, stoppedBefore('the relay\'s folder could not fast-forward to ' + step.sha.slice(0, 7) + ': ' + e.message), 'update_failed'); }
  if (!job) return;
  job.reloads++;
  const r = await pageCheck(ctx.port);
  if (!job) return;
  if (!r.ok) {
    const prev = job.at ? job.steps[job.at - 1].sha : job.from;
    let back = 'Update went back to ' + prev.slice(0, 7) + ', so only that merge is out.';
    try { rollback.checkout(prev); rollback.noteRollback(step.sha, prev, r.why); } catch (e) { back = 'Update could not go back to ' + prev.slice(0, 7) + ', so the folder is on ' + step.sha.slice(0, 7) + ': ' + e.message; }
    return endLoop(ctx, 'Update stopped at ' + stepWords() + ' (' + step.sha.slice(0, 7) + '): it failed its check, since ' + r.why + '. ' + back + whereItStands(job.at, false) + ' Fix it on main, check out main in the relay\'s folder, and press Update.', 'update_failed');
  }
  rollback.passed(step.sha);
  job.at++;
  return nextStep(ctx);
}

async function pageCheck(port) {
  const base = 'http://' + rollback.host() + ':' + port, end = Date.now() + 15000;
  let why = 'it did not answer /health';
  while (Date.now() < end) {
    try {
      const h = await fetch(base + '/health', { signal: AbortSignal.timeout(3000) });
      if (!h.ok) why = '/health answered ' + h.status;
      else {
        const page = await fetch(base + '/office/', { signal: AbortSignal.timeout(3000) });
        const text = await page.text();
        if (page.ok && /<html/i.test(text)) return { ok: true };
        why = 'it answered /health but not the room page (' + page.status + ')';
      }
    } catch (e) { why = 'it did not answer: ' + e.message; }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, why };
}

function begin(ctx) {
  const loop = steps.read(DIR);
  if (!loop) return;
  if (!STEPPING()) { steps.clear(); note(ctx, 'An Update going through merges one at a time ended, since this relay runs without RELAY_ROLLBACK=1.', loop.channel, null); return; }
  const back = rollback.read().rollback;
  const r = steps.resume(loop, { loaded: LOADED, back: back && Date.parse(back.at) >= Date.parse(loop.restartAt) ? back : null, now: Date.now() });
  job = Object.assign({}, loop, { state: 'checking', files: [], reloads: 0, stop: false, timer: null, next: loop.steps[loop.at] && loop.steps[loop.at].sha });
  if (r.go === 'drop') { job.once = []; endLoop(ctx, 'An Update going through merges one at a time ended, since ' + r.why + '.', null); return; }
  if (r.go === 'failed') {
    job.once = loop.onceBefore || [];
    endLoop(ctx, 'Update stopped at ' + stepWords() + ' (' + r.step.sha.slice(0, 7) + '): the new relay failed its check, since ' + r.why + '. Update went back to ' + String(back.running).slice(0, 7) + ', so only that merge is out.' + whereItStands(job.at, false) + ' Fix it on main, check out main in the relay\'s folder, and press Update.', 'update_failed');
    return;
  }
  job.once = loop.once || [];
  ctx.log('Update: ' + stepWords() + ' is in. Waiting for the supervisor\'s check of this relay before the next step.');
  const within = rollback.WITHIN() + 30000, end = Date.now() + within;
  job.timer = setInterval(() => {
    if (!job || job.state !== 'checking') return;
    const g = rollback.read();
    if (g.commit === LOADED && Date.parse(g.at) >= Date.parse(loop.restartAt)) {
      clearInterval(job.timer); steps.clear();
      ctx.log('Update: ' + stepWords() + ' passed its check.');
      job.at++;
      nextStep(ctx).catch(stepFailed(ctx));
    } else if (Date.now() > end) {
      endLoop(ctx, 'Update stopped at ' + stepWords() + ': the new relay did not pass its check within ' + Math.round(within / 1000) + ' seconds after it took its sessions back, and did not roll back. The terminal where the relay runs says why.' + whereItStands(job.at, false), 'update_failed');
    }
  }, 500);
}

async function pullMoreSteps(ctx) {
  pulling = true;
  try {
    const refused = await refusal();
    if (refused) return refused;
    const fetched = await fetchMain();
    if (fetched.refused) return fetched.refused;
    if (!job || !job.steps) return calledOffAsFetched();
    const more = await steps.list(DIR, job.to, fetched.to);
    if (!job || !job.steps) return calledOffAsFetched();
    if (!more.length) return [200, { ok: true, changed: false, restart: true, message: 'Already up to date.' }];
    const take = more.slice(0, Math.max(0, steps.LIMIT() - job.steps.length));
    job.steps.push(...take); job.later = more.length - take.length;
    if (take.length) job.to = take[take.length - 1].sha;
    const words = take.length ? steps.names(take) + ' joined the Update under way, as ' + (job.steps.length - take.length + 1) + (take.length > 1 ? ' to ' + job.steps.length : '') + ' of ' + job.steps.length + '.' : '';
    const later = job.later ? ' ' + job.later + ' more' + waits(job.later) + ' for the next Update, since a run takes at most ' + steps.LIMIT() + ' merges.' : '';
    ctx.log('Update: ' + words + later);
    return [200, { ok: true, changed: true, restart: true, message: (words + later).trim(), update: view() }];
  } finally { pulling = false; }
}

module.exports = { handle, isRelayFile, run, updating, restarting, waiting, begin, DIR };
