// The Update button: brings merged changes into the relay's own folder. It fetches first and plans
// from what came in. Pages are read from disk on each request, so when only they changed it
// fast-forwards and the page just reloads. When the relay's own files changed, it waits only for what
// a restart still breaks (whoIsBusy), then fast-forwards and restarts the relay at once. Until then the
// folder stays as it was, so the old relay never serves new pages, the global hooks never run new code
// against the old relay, and calling the restart off leaves nothing behind. The sessions keep running
// in the session host, and the new relay takes each one back (relay/sessions.js).
// See docs/manual/running.html#update.
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
const rollback = require('./rollback.js');
const config = require('./config.js');
const { livenessOf, jobsOf } = require('./liveness.js');
// An Update that did not finish is a measure for the COO.
const noteForCoo = (channel, kind, detail) => { if (channel) coo.noteEvent(channel, kind, detail); };

const DIR = path.resolve(process.env.RELAY_UPDATE_DIR || path.join(__dirname, '..'));
const BRANCH = 'main';
const PULL = { timeout: 60000, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) };
const SUPERVISED = process.env.RELAY_SUPERVISED === '1';

// Changes with each start, so a page can tell the relay restarted even if it never saw it gone.
const RUN = require('crypto').randomBytes(6).toString('hex');
// HEAD of DIR when this relay started. When DIR is the relay's own folder, as it is unless
// RELAY_UPDATE_DIR is set (the tests set it), that is the commit this relay's code came from. Relay
// files changed since then need a restart, even if they were pulled by a git pull run by hand.
let LOADED = null;
try { LOADED = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { /* not a git folder: Update says so when pressed */ }
// When the supervisor went back to this relay's commit because the new code failed its check
// (relay/rollback.js): { failed, running, why, at }. The page says so.
// Once a person checks out a branch there, the rollback is over, even on the same commit.
function rolledBack() { const r = rollback.read().rollback; return r && LOADED && r.running === LOADED && !rollback.onBranch() ? r : null; }
// The update under way: { state: 'waiting' | 'restarting', from, to, files, startedAt, timer }.
// to is the fetched commit the folder fast-forwards to just before the restart.
let job = null;
// True while a press of Update is checking and fetching, before any job exists.
let pulling = false;
// Why the last restart did not happen, for the page.
let lastNote = null;
// While there is one, the relay types no saved delivery into any session, and while it restarts, no first
// prompt either (relay/terminal.js).
terminal.holdWhileUpdating(() => !!job, () => !!job && job.state === 'restarting');

// What the running relay loads. Tests do not, and the supervisor is loaded only once, at the start.
const isRelayFile = (f) => f.startsWith('relay/') && !f.startsWith('relay/test/');
// These load once and run until you stop the relay.
const LOADED_ONCE = ['relay/supervisor.js', 'relay/session-host.js', 'relay/pty-bridge.py'];
// A session out of its turn with a command still running, such as npm test in the background, is busy
// (relay/liveness.js, job). It is waited for until its oldest job has run for Autopilot's stall time, so a
// command that never ends cannot hold the update for good. The restart does not end the job either way.
const JOB_LIMIT = () => config.get('autopilotStallMinutes') * 60 * 1000;
const jobWaited = (t) => { const j = livenessOf(t, Date.now()).state === 'job' && jobsOf(t); return !!j && Date.now() - (j.since || Date.now()) < JOB_LIMIT(); };

// What a restart still breaks. Every session runs on in the session host through it, and nothing can
// be typed into one while no relay runs, so the restart cuts nothing off. What it can lose is a hook
// sent in the second or two with no relay, and what lives only in this relay's memory.
// - A session in a turn: its Stop could come in that gap and be lost. The relay would then keep it
//   working, and type nothing into it, until its next hook, which may not come until a person speaks.
//   A hook takes a moment to arrive, so Enter pressed in the last few seconds counts as a turn starting.
//   A session spoken to that no hook has reached could be in a turn, so it is waited for too: a session
//   brought back is in that state until its first hook.
//   A session at a question that a person answered is back in its turn, though no hook says so until
//   its next tool or its end, so it is waited for while it still prints: Claude Code's spinner prints
//   all through a turn. One that went quiet, say after Esc, holds nothing.
// - Text left in a prompt: the new relay does not know it is there, and could type a message onto it.
// - A first prompt the relay is typing. A first prompt is typed while the update waits, and only the
//   restart holds it, so it is waited for from when its text is in the prompt until its turn ends. One
//   still waiting when the restart begins is saved with its session and typed after the restart.
// A session at a question nobody answered is not waited for: only the relay can answer it, so it is
// still at its question when the new relay takes it back. A saved delivery waiting to go in is not
// waited for either, since none is typed during an update: it reaches the session after the restart.
const ENTER_COUNTS = 5000;
const PRINTS = 5000;  // an answered session that printed this recently is still in its turn
const answered = (t) => t.answeredAt >= (t.waitingAt || 0) && Date.now() - Math.max(t.answeredAt, t.lastOutAt || 0) < PRINTS;
function whoIsBusy() {
  // A refresh of the Lead lives only in memory, and the Lead is idle between its steps. Restarted
  // then, say after the notes and before /clear, the Lead would come back with no next step.
  const refreshing = terminal.everyone().filter((t) => t.refresh).map((t) => ({ terminal: t.id, title: 'The Lead', why: 'refreshing' }));
  const out = refreshing.concat(terminal.everyone().filter((t) => !t.refresh).map((t) => {
    const why = t.typingFirst ? 'the relay is typing its first prompt' : t.state === 'working' ? 'in a turn' : t.state === 'waiting' ? (answered(t) ? 'answered its question, so it is in a turn' : null)
      : Date.now() - (t.lastEnterAt || 0) < ENTER_COUNTS ? 'just sent a prompt' : t.drafting ? 'has text in its prompt'
        : t.spoke && !t.hooked ? 'no hooks reach the relay from it, so it may be in a turn' : null;
    return why && { terminal: t.id, title: t.title || path.basename(t.cwd), why };
  }).filter(Boolean));
  // A reviewer that has posted leaves within moments (relay/terminal.js, reviewDone). Stopped now, it
  // would come back with nothing to say it is done.
  for (const t of terminal.everyone()) if (t.posted && !out.some((w) => w.terminal === t.id)) out.push({ terminal: t.id, title: t.title || 'A reviewer', why: 'has posted its review and is about to leave' });
  if (tasks.busy()) out.push({ terminal: null, title: 'A new task', why: 'starting' });
  // An open huddle lives only in memory. Its questions are not typed during the update, so it waits
  // out its answer time (3 minutes by default) with the answers it already has.
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

// Why Update will not pull here, or null.
async function refusal() {
  const branch = await tasks.git(DIR, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '');
  if (branch !== BRANCH) {
    const back = branch ? null : rolledBack();
    const why = back ? ' It went back to ' + back.running.slice(0, 7) + ' when ' + back.failed.slice(0, 7) + ' failed its check. Fix main first.' : '';
    return [409, { ok: false, error: 'not_main', rollback: back, message: 'The relay\'s folder ' + DIR + ' is ' + (branch ? 'on ' + branch : 'not on a branch') + ', not ' + BRANCH + ', so Update will not pull there.' + why + ' Check out ' + BRANCH + ' in that folder first.' }];
  }
  // Staged or not. Files git does not track do not stop a pull, and git says so if one is in the way.
  const changed = await tasks.git(DIR, ['diff', '--name-only', 'HEAD']);
  if (changed) {
    const files = changed.split('\n');
    return [409, { ok: false, error: 'local_changes', files, message: 'The relay\'s folder ' + DIR + ' has local changes, so Update will not pull there: ' + files.join(', ') + '. Commit them or put them away first.' }];
  }
  return null;
}

// Fetches main's upstream and gives the commit it points at, as git pull would merge it. Nothing
// in the folder changes. Refuses when main cannot fast-forward to it. It reads main@{upstream}, not
// FETCH_HEAD: any fetch in this folder, such as a task's check of its base (relay/tasks.js),
// rewrites FETCH_HEAD, and may name another branch there for merge.
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
// Moves the folder to the fetched commit. The folder must still be on main with no local changes.
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
    // A moment for the page's last status check to get its answer. A turn could start in that
    // moment, so the check runs once more, and a session that became busy calls the restart off.
    setTimeout(async () => {
      const busy = whoIsBusy();
      if (busy.length) {
        lastNote = 'The restart was called off, since ' + busy.map((w) => w.title + ' (' + w.why + ')').join(', ') + ' started just before it. The relay\'s folder is as it was. Press Update again to wait for the next quiet moment.';
        ctx.log(lastNote); noteForCoo(channel, 'update_called_off', lastNote); job = null; return;
      }
      // Only now does the folder change, and the relay exits right after. A turn that starts during
      // the merge is not checked for: the folder already moved, so going on is the only way the code
      // that runs matches it, and every session runs on through the restart.
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
  // Relay files since the code this relay runs, which may be older than this pull.
  const relayFiles = (LOADED ? await diff(LOADED).catch(() => files) : files).filter(isRelayFile);
  if (from === to && !relayFiles.length) return [200, { ok: true, changed: false, message: 'Already up to date.' }];
  const fetchedWords = from === to ? 'Nothing new to pull, but this relay runs older code than ' + to.slice(0, 7) + '.' : 'Fetched ' + from.slice(0, 7) + '..' + to.slice(0, 7) + '.';
  ctx.log('Update: ' + fetchedWords + ' ' + files.length + ' files changed, ' + relayFiles.length + ' relay files differ from the code this relay runs.');
  // A page or a restart by hand needs the new files now, so these pull at once.
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

// Routes under /channels/{channel}/update.
async function handle(req, res, channel, rest, ctx) {
  if (rest !== '/update') return false;
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (!terminal.ENABLED) { ctx.problem(res, 404, 'terminal_off', 'Update needs the terminal. Start the relay with npm run office, or with RELAY_TERMINAL=1.'); return true; }
  let out;
  if (req.method === 'GET') out = [200, { ok: true, dir: DIR, branch: BRANCH, run: RUN, update: view(), note: lastNote, rollback: rolledBack() }];
  else if (req.method === 'POST') out = await update(await ctx.readJson(req), ctx, channel);
  if (!out) { ctx.problem(res, 404, 'not_found', 'Unknown update route.'); return true; }
  ctx.send(res, out[0], out[1]);
  return true;
}

// Autopilot pulls after each merge it sees (relay/autopilot.js). While an update waits for a quiet
// moment it goes on, and starts nothing only once the restart begins. A merge in that wait is fetched
// into the same update, so the restart pulls and runs it too.
// A pull already under way gets the merge too, since Autopilot pulls only once GitHub shows it merged.
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
