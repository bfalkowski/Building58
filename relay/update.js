// The Update button: brings merged changes into the relay's own folder. It fetches first and plans
// from what came in. Pages are read from disk on each request, so when only they changed it
// fast-forwards and the page just reloads. When the relay's own files changed, it waits only for what
// a restart still breaks (whoIsBusy), then fast-forwards and restarts the relay at once. Until then the
// folder stays as it was, so the old relay never serves new pages, the global hooks never run new code
// against the old relay, and calling the restart off leaves nothing behind. The sessions keep running
// in the session host, and the new relay takes each one back (relay/sessions.js).
// While it waits, it holds saved messages only for RELAY_UPDATE_HOLD_MS, and it never gives up waiting.
// See docs/manual/running.html#update and #update-hold.
//
// It runs git on this computer, so like the terminal it answers only the room page on this machine,
// and only while RELAY_TERMINAL=1.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const checkouts = require('./checkouts.js');
const huddles = require('./huddles.js');
const { RESTART } = require('./supervisor.js');
const coo = require('./coo.js');
const hostLink = require('./host-link.js');
const rollback = require('./rollback.js');
const config = require('./config.js');
const { livenessOf, jobsOf } = require('./liveness.js');
const noteForCoo = (channel, kind, detail) => { if (channel) coo.noteEvent(channel, kind, detail); };

const DIR = path.resolve(process.env.RELAY_UPDATE_DIR || path.join(__dirname, '..'));
const BRANCH = 'main';
const PULL = { timeout: 60000, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) };
const SUPERVISED = process.env.RELAY_SUPERVISED === '1';

const RUN = require('crypto').randomBytes(6).toString('hex');
let LOADED = null;
try { LOADED = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { /* not a git folder: Update says so when pressed */ }
function rolledBack() { const r = rollback.read().rollback; return r && LOADED && r.running === LOADED && !rollback.onBranch() ? r : null; }
let job = null;
let pulling = false;
let lastNote = null;
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
  return { state: job.state, from: job.from, to: job.to, files: job.files, startedAt: job.startedAt, waitingOn: waiting ? whoIsBusy() : [] };
}

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
  job.timer = setInterval(() => {
    if (!job || job.state !== 'waiting' || pulling || whoIsBusy().length) return;
    clearInterval(job.timer);
    job.state = 'restarting';
    ctx.log('Restarting the relay to run ' + job.to.slice(0, 7) + '. Every session keeps running, and the new relay takes it back.');
    setTimeout(async () => {
      const busy = whoIsBusy();
      if (busy.length) {
        lastNote = 'The restart was called off, since ' + busy.map((w) => w.title + ' (' + w.why + ')').join(', ') + ' started just before it. The relay\'s folder is as it was. Press Update again to wait for the next quiet moment.';
        ctx.log(lastNote); noteForCoo(channel, 'update_called_off', lastNote); job = null; return;
      }
      try { await fastForward(job.to); } catch (e) {
        lastNote = 'The restart was called off, since the relay\'s folder could not fast-forward to ' + job.to.slice(0, 7) + ': ' + e.message + ' The folder is as it was.';
        ctx.log(lastNote); noteForCoo(channel, 'update_failed', lastNote); job = null; return;
      }
      terminal.close(); process.exit(RESTART);
    }, 300);
  }, 500);
}

async function update(body, ctx, channel) {
  if (body.cancel) {
    if (job && job.state === 'waiting') {
      clearInterval(job.timer); job = null;
      lastNote = 'The restart was called off. Nothing was pulled, so the relay\'s folder is as it was. Press Update again to wait for the next quiet moment.';
      ctx.log(lastNote);
    }
    return [200, { ok: true, update: view() }];
  }
  if (job || pulling) return [409, { ok: false, error: 'updating', message: 'An update is already under way.', update: view() }];
  pulling = true;
  try { return await pullAndPlan(ctx, channel); } finally { pulling = false; }
}
async function pullAndPlan(ctx, channel) {
  lastNote = null;
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
  if (!relayFiles.length) return (await pullNow()) || [200, { ok: true, changed: true, from, to, files, reload: true, message: pulled + ' Only page files changed, so the page reloads.' }];
  const once = LOADED_ONCE.filter((f) => relayFiles.includes(f));
  const note = once.length ? ' ' + once.join(' and ') + (once.length > 1 ? ' changed too. They run' : ' changed too. It runs') + ' until you stop the relay yourself, so stop and start it once to use the new code.' : '';
  if (!SUPERVISED) {
    const failed = await pullNow();
    if (failed) return failed;
    return [200, { ok: true, changed: true, from, to, files, restart: false, message: pulled + ' The relay\'s own files changed, but this relay cannot restart itself. Stop it and start it again; every session comes back.' }];
  }
  job = { state: 'waiting', from, to, files: relayFiles, startedAt: new Date().toISOString(), timer: null };
  restartWhenQuiet(ctx, channel);
  return [202, { ok: true, changed: true, from, to, files, restart: true, run: RUN, message: fetchedWords + ' The relay pulls it and restarts once no session is in a turn. A session at a question stays at it. Until then the folder is as it was. Every session keeps running through it.' + note, update: view() }];
}

async function handle(req, res, channel, rest, ctx) {
  if (rest !== '/update') return false;
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (!terminal.ENABLED) { ctx.problem(res, 404, 'terminal_off', 'Update needs the terminal. Start the relay with npm run office, or with RELAY_TERMINAL=1.'); return true; }
  let out;
  if (req.method === 'GET') out = [200, { ok: true, dir: DIR, branch: BRANCH, run: RUN, update: view(), note: lastNote, rollback: rolledBack(), host: hostLink.gapWords() }];
  else if (req.method === 'POST') out = await update(await ctx.readJson(req), ctx, channel);
  if (!out) { ctx.problem(res, 404, 'not_found', 'Unknown update route.'); return true; }
  ctx.send(res, out[0], out[1]);
  return true;
}

const run = (ctx) => (pulling ? Promise.resolve([200, { ok: true, changed: false, message: 'A pull is already under way, and it gets this merge too.' }])
  : job && job.state === 'waiting' ? pullMore(ctx) : update({}, ctx));
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

module.exports = { handle, isRelayFile, run, updating, restarting, DIR };
