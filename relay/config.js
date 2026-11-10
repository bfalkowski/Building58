'use strict';
// Limits and timings the person changes in Settings while the relay runs (GET and POST /settings).
// Each is read where it is used, so a change applies at once, with no restart. A value set on the page
// wins over its environment variable, which wins over the default. The page's values are kept in
// RELAY_SETTINGS_FILE (settings.json in the state folder, relay/state.js). Reset takes a value back to the variable or
// the default.
//
// What stays at startup, and why: the port and the key (the page needs them to connect), where state
// is kept (the *_FILE settings, RELAY_TICKET_*), whether the terminal is on and which claude runs
// (a page must not be able to turn on running shells), the webhook's address and secret, and the
// supervisor's own flags.
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const skills = require('./skills.js');

const FILE = state.file('settings.json', 'RELAY_SETTINGS_FILE');

// scale turns the variable's unit into the setting's: a variable in ms for a setting in seconds is 1/1000.
// zero: 0 is a value of its own (it turns something off), not "use the default".
const SETTINGS = [
  { name: 'wipLimit', group: 'Work', label: 'WIP limit', unit: 'tasks', env: 'RELAY_WIP_LIMIT', def: 3, min: 1, max: 10,
    what: 'The most tasks that can be building at the same time. When this many are building, the relay refuses Start, Bring back, the Lead\'s starts and Autopilot\'s starts.' },
  { name: 'readyMinutes', group: 'Work', label: 'Wait for a new session for', unit: 'minutes', env: 'RELAY_READY_LIMIT', scale: 1 / 60000, def: 10, min: 1, max: 60,
    what: 'How long the relay waits for a new session to be ready for its brief. After this time, the relay stops waiting and says so.' },
  { name: 'leadCheckMinutes', group: 'Work', label: 'Lead check every', unit: 'minutes', env: 'RELAY_LEAD_CHECK_MS', scale: 1 / 60000, def: 5, min: 0, max: 240, zero: true,
    what: 'How often the relay types a check prompt into the Lead, to look for a stuck reviewer, a failed pipeline, a PR with no review, or a merged PR whose Dev still holds a desk. Only while a task is building, in review, has changes requested or is waiting on you. It waits until the Lead is idle, and a check that comes due while one still waits is dropped. 0 stops it.' },
  { name: 'stallMinutes', group: 'Work', label: 'A session is stuck after', unit: 'minutes', env: 'RELAY_STALL_MS', scale: 1 / 60000, def: 30, min: 5, max: 600,
    what: 'A session in a turn that sends no hook and prints nothing for this long is stuck. If it still prints, it is quiet instead, since Claude Code\'s spinner prints while it thinks. The Floor, Autopilot and the COO all use this time (relay/liveness.js).' },
  { name: 'leadStops', group: 'The Lead', label: 'Let the Lead stop sessions', kind: 'bool', env: 'RELAY_LEAD_STOPS', def: false,
    what: 'The Lead can stop a session that is done or idle, with ticket.js stop. The relay first checks that the session is safe to stop. The Lead must also have Let the Lead move the board. Unlike the Lead\'s other switches, this one stays on when you make a different session the Lead.' },
  { name: 'leadStopLimit', group: 'The Lead', label: 'Lead stops an hour', unit: 'stops', env: 'RELAY_LEAD_STOP_LIMIT', def: 6, min: 1, max: 60,
    what: 'The most sessions that the Lead can stop in one hour, on each channel. After that, the Lead gives the other sessions to you to stop.' },
  // No variable: it is on only if you turned it on in Settings, so a restart keeps it off until you do (T-128).
  { name: 'leadOrder', group: 'The Lead', label: 'Let the Lead set priority', kind: 'bool', def: false,
    what: 'The Lead can set the priority and the place in the work order of tickets in Triage or Ready, with ticket.js priority and ticket.js order. It is apart from Let the Lead move the board, and does not let the Lead start a ticket or change a status. The Board shows who last set each ticket\'s priority or place, and your change wins.' },
  { name: 'maxAutoReviews', group: 'Reviews', label: 'Automatic reviews per PR', unit: 'reviews', def: 3, min: 1, max: 10,
    what: 'The most automatic reviews that one PR gets, the first one included. After that, a push gets no review until you press Get a review.' },
  { name: 'reviewPollSeconds', group: 'Reviews', label: 'Check PRs for comments every', unit: 'seconds', env: 'RELAY_REVIEW_POLL_SECONDS', def: 60, min: 0, max: 3600, zero: true,
    what: 'How often the relay asks GitHub for new comments on each PR, to send them to the Dev. 0 stops it.' },
  { name: 'pipelinePollSeconds', group: 'Reviews', label: 'Check each PR\'s pipeline every', unit: 'seconds', env: 'RELAY_PIPELINE_POLL_SECONDS', def: 15, min: 0, max: 600, zero: true,
    what: 'How often the relay asks GitHub for the checks on each open PR. An automatic review waits until they pass, and the Board shows a PR whose checks are running or failed as waiting on the pipeline. 0 stops asking, and reviews start without waiting.' },
  { name: 'pipelineNoChecksSeconds', group: 'Reviews', label: 'Review a PR with no checks after', unit: 'seconds', env: 'RELAY_PIPELINE_NO_CHECKS_MS', scale: 1 / 1000, def: 120, min: 10, max: 3600,
    what: 'GitHub can take a moment to start a PR\'s checks. A PR with none waits this long for them, then its review starts with no pipeline. The same happens when gh cannot read the checks.' },
  { name: 'reviewRetrySeconds', group: 'Reviews', label: 'Try a review again after', unit: 'seconds', env: 'RELAY_REVIEW_RETRY_MS', scale: 1 / 1000, def: 60, min: 5, max: 3600,
    what: 'If a follow-up review cannot start, for example because all desks are full, the relay waits this long and tries again. It tries 3 times. A first review tries 3 times this way too, but when only a desk is missing it waits for a free desk instead.' },
  { name: 'reviewGraceSeconds', group: 'Reviews', label: 'A reviewer leaves after', unit: 'seconds', env: 'RELAY_REVIEW_GRACE_MS', scale: 1 / 1000, def: 30, min: 1, max: 600,
    what: 'After an automatic reviewer posts and its turn ends, the relay waits this long, then ends the session and frees its desk.' },
  { name: 'autopilotRounds', group: 'Autopilot', label: 'Review rounds', unit: 'rounds', def: 2, min: 1, max: 5,
    what: 'If this many reviews in a row still ask for fixes, Autopilot stops and puts the task in Waiting on you.' },
  { name: 'autopilotMerges', group: 'Autopilot', label: 'Merges a day', unit: 'merges', def: 10, min: 1, max: 50,
    what: 'The most PRs that Autopilot merges in one day. After that, a PR that is ready waits for you or for the next day.' },
  { name: 'autopilotAtOnce', group: 'Autopilot', label: 'Tickets at once', unit: 'tickets', env: 'RELAY_AUTOPILOT_AT_ONCE', def: 1, min: 1, max: 5,
    what: 'How many tasks Autopilot works on at the same time. The WIP limit also applies.' },
  { name: 'autopilotStallMinutes', group: 'Autopilot', label: 'Give you a stuck task after', unit: 'minutes', env: 'RELAY_AUTOPILOT_STALL_MS', scale: 1 / 60000, def: 30, min: 5, max: 1440,
    what: 'If an Autopilot task is stuck this long, Autopilot puts it in Waiting on you and can start the next ticket. Stuck means its Dev or a reviewer is at a question, a reviewer never started, or nothing running could move it.' },
  { name: 'autopilotTickSeconds', group: 'Autopilot', label: 'Check every', unit: 'seconds', env: 'RELAY_AUTOPILOT_TICK_MS', scale: 1 / 1000, def: 20, min: 5, max: 600,
    what: 'How often Autopilot checks its PRs and the Ready column.' },
  // No variable for the switch: it is on only if you turned it on in Settings, so a restart keeps it off until you do.
  { name: 'prWatch', group: 'PR watch', label: 'Watch each open PR', kind: 'bool', def: false,
    what: 'Every few minutes the relay reads each open task PR from GitHub and its Dev\'s session and checkout, and moves it to its next step: it asks for a review of a head no review read, tells the Dev once about blocking findings, a conflict with main, a failed check or commits it has not pushed, and tells the Lead when a PR is reviewed, green and clean. It merges nothing.' },
  { name: 'prWatchSeconds', group: 'PR watch', label: 'Watch PRs every', unit: 'seconds', env: 'RELAY_PR_WATCH_SECONDS', def: 120, min: 30, max: 3600,
    what: 'How often the PR watch reads each open task PR.' },
  { name: 'prWatchWaitMinutes', group: 'PR watch', label: 'Give you a PR that waits after', unit: 'minutes', env: 'RELAY_PR_WATCH_WAIT_MS', scale: 1 / 60000, def: 60, min: 5, max: 1440,
    what: 'A PR that has waited this long on its Dev, a reviewer, CI or the Lead shows as waiting on you, and the chat board says so once.' },
  { name: 'chatKeep', group: 'Chat and huddles', label: 'Posts kept in each chat channel', unit: 'posts', env: 'RELAY_CHAT_KEEP', def: 200, min: 10, max: 5000,
    what: 'How many posts each chat channel keeps. The relay deletes older posts.' },
  { name: 'chatPollSeconds', group: 'Chat and huddles', label: 'Check GitHub for the chat every', unit: 'seconds', env: 'RELAY_CHAT_POLL_SECONDS', def: 60, min: 0, max: 3600, zero: true,
    what: 'How often the relay asks GitHub about PRs, to post their news on the chat board. 0 stops it.' },
  { name: 'mainPollSeconds', group: 'Chat and huddles', label: 'Check whether main moved every', unit: 'seconds', env: 'RELAY_MAIN_POLL_SECONDS', def: 60, min: 0, max: 3600, zero: true,
    what: 'How often the relay asks origin where its default branch points, with git ls-remote in the relay\'s folder, to say in #office when it moved. 0 stops it.' },
  { name: 'chatRetrySeconds', group: 'Chat and huddles', label: 'Try a chat mention again after', unit: 'seconds', env: 'RELAY_CHAT_RETRY_MS', scale: 1 / 1000, def: 30, min: 5, max: 600,
    what: 'If a session was busy when someone mentioned it in the chat, the relay tries again to give it the mention after this long.' },
  { name: 'huddleAnswerSeconds', group: 'Chat and huddles', label: 'Wait for huddle answers for', unit: 'seconds', env: 'RELAY_HUDDLE_ANSWER_SECONDS', def: 180, min: 30, max: 1800,
    what: 'How long a huddle waits for each session to answer. After this time, the report shows the session with no answer.' },
  { name: 'huddleQuietMinutes', group: 'Chat and huddles', label: 'Quiet in a huddle after', unit: 'minutes', env: 'RELAY_HUDDLE_QUIET_MINUTES', def: 15, min: 1, max: 240,
    what: 'In a huddle report, a session that did nothing for this long shows as quiet.' },
  { name: 'cooGraceSeconds', group: 'COO and PM', label: 'The COO leaves after', unit: 'seconds', env: 'RELAY_COO_GRACE_MS', scale: 1 / 1000, def: 10, min: 1, max: 600,
    what: 'After the COO saves its report and its turn ends, the relay waits this long, then ends the COO\'s session.' },
  { name: 'securityGraceSeconds', group: 'COO and PM', label: 'The security officer leaves after', unit: 'seconds', env: 'RELAY_SECURITY_GRACE_MS', scale: 1 / 1000, def: 10, min: 1, max: 600,
    what: 'After the security officer saves its report and its turn ends, the relay waits this long, then ends its session.' },
  // No variable: it is on only if you turned it on in Settings, so a restart keeps it off until you do (T-45).
  { name: 'pmOrder', group: 'COO and PM', label: 'Let the PM set the order', kind: 'bool', def: false,
    what: 'The PM can set the priority and the place in the work order of tickets in Triage or Ready, with ticket.js priority and ticket.js order. It cannot move, start or change any other ticket. If more than one PM is running, only the newest can. The Board shows who last set each ticket\'s priority or place, and your change wins.' },
  { name: 'pmTalkMinutes', group: 'COO and PM', label: 'Keep the PM after you type for', unit: 'minutes', env: 'RELAY_PM_TALK_MINUTES', def: 30, min: 1, max: 600,
    what: 'After you type to the PM, nobody can stop the PM as idle for this long.' },
  // Each role's model and skills (relay/skills.js). No variables. A model starts empty, so nothing changes until you set one.
  ...[['lead', 'The Lead', 'pstack:recall'],
    ['dev', 'Devs', 'mattpocock-skills:tdd, mattpocock-skills:diagnosing-bugs, mattpocock-skills:codebase-design, pstack:blast-radius, pstack:principle-prove-it-works, mattpocock-skills:pr'],
    ['reviewer', 'Reviewers', 'mattpocock-skills:code-review, pstack:blast-radius'],
    ['pm', 'The PM', 'pstack:sharpen, mattpocock-skills:writing-for-agents'],
    ['coo', 'The COO', 'pstack:principle-explain-the-number'],
    ['security', 'The security officer', 'pstack:principle-explain-the-number']].flatMap(([role, who, def]) => [
    { name: role + 'Model', group: 'Models and skills', label: who + ': model', kind: 'text', def: '', check: skills.modelOk, rule: 'is empty, or a model name such as opus, sonnet, haiku or a full model id: letters, digits, dots, dashes and brackets, up to 64.',
      what: 'The model a new session runs on, as with claude --model. Empty: your own default. A session brought back with its conversation keeps the model it had.' },
    { name: role + 'Skills', group: 'Models and skills', label: who + ': skills', kind: 'skills', def, check: skills.skillsOk, about: skills.about, rule: 'is empty, or up to 12 skill names such as mattpocock-skills:tdd, split by commas or spaces.',
      what: 'Skills its brief names, where they fit. Only the ones installed here go in. Empty: the brief names none.' }])
];
const BY_NAME = new Map(SETTINGS.map((s) => [s.name, s]));

let saved = {};
try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { saved = {}; }
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(saved, null, 2) + '\n');
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.error('Could not save the settings to ' + FILE + ': ' + e.message); }
}

// A value the page may set: in range, and an integer except for timings that tests set below a unit.
function valid(s, v) {
  if (s.check) return s.check(v);
  if (s.kind === 'bool') return typeof v === 'boolean';
  return typeof v === 'number' && Number.isInteger(v) && v >= s.min && v <= s.max;
}
// The variable, read as the code read it before: any number above 0, or 0 where 0 means off. It is
// not held to the page's range, so a test can still set a short timing.
function fromEnv(s) {
  const raw = s.env ? process.env[s.env] : undefined;
  if (raw === undefined) return undefined;
  if (raw === '') return s.zero ? 0 : undefined;  // Number('') was 0, which turned these polls off
  if (s.kind === 'bool') return raw === '1';
  const n = Number(raw) * (s.scale || 1);
  return Number.isFinite(n) && (n > 0 || (s.zero && n === 0)) ? n : undefined;
}
function sourceOf(s) {
  if (Object.prototype.hasOwnProperty.call(saved, s.name) && valid(s, saved[s.name])) return 'page';
  return fromEnv(s) !== undefined ? 'env' : 'default';
}
function get(name) {
  const s = BY_NAME.get(name);
  if (!s) throw new Error('No setting ' + name);
  const from = sourceOf(s);
  return from === 'page' ? saved[name] : from === 'env' ? fromEnv(s) : s.def;
}
const list = () => SETTINGS.map((s) => ({ name: s.name, group: s.group, label: s.label, unit: s.unit || null, kind: s.kind || 'number', env: s.env || null,
  value: get(s.name), from: sourceOf(s), def: s.def, min: s.min, max: s.max, what: s.what, ...(s.about ? s.about(get(s.name)) : {}) }));

const listeners = [];
const onChange = (fn) => listeners.push(fn);
// { values: { name: value }, reset: [name] }. All or nothing: one bad value changes none.
function set(body) {
  const values = body && typeof body.values === 'object' && body.values ? body.values : {};
  const reset = Array.isArray(body && body.reset) ? body.reset : [];
  for (const [k, v] of Object.entries(values)) {
    const s = BY_NAME.get(k);
    if (!s) return [400, { ok: false, error: 'unknown_setting', message: 'There is no setting ' + String(k).slice(0, 40) + '.' }];
    if (s.check && !valid(s, v)) return [400, { ok: false, error: 'bad_value', message: s.label + ' ' + s.rule }];
    if (!valid(s, v)) return [400, { ok: false, error: 'bad_value', message: s.label + (s.kind === 'bool' ? ' is on or off.' : ' is a whole number from ' + s.min + ' to ' + s.max + '.') }];
  }
  for (const k of reset) if (!BY_NAME.has(k)) return [400, { ok: false, error: 'unknown_setting', message: 'There is no setting ' + String(k).slice(0, 40) + '.' }];
  const changed = [];
  for (const k of reset) if (Object.prototype.hasOwnProperty.call(saved, k)) { delete saved[k]; changed.push(k); }
  for (const [k, v] of Object.entries(values)) if (saved[k] !== v) { saved[k] = v; changed.push(k); }
  if (changed.length) {
    save();
    console.log('Settings changed on the page: ' + changed.map((k) => k + ' = ' + get(k)).join(', '));
    for (const fn of listeners) { try { fn(changed); } catch (e) { console.error('A settings listener failed: ' + e.message); } }
  }
  return [200, { ok: true, changed, settings: list() }];
}

// GET /settings and POST /settings: only the room page on this computer, with the key. No session's token.
async function handle(req, res, channel, rest, rctx) {
  if (rest !== '/settings') return false;
  const deny = require('./terminal').localOnly(req, rctx.port);
  if (deny) { rctx.problem(res, 403, 'local_only', deny); return true; }
  if (rctx.agent) { rctx.problem(res, 401, 'unauthorized', 'Only the person changes the settings.'); return true; }
  if (req.method === 'GET') { rctx.send(res, 200, { ok: true, file: FILE, settings: list() }); return true; }
  if (req.method !== 'POST') { rctx.problem(res, 404, 'not_found', 'Settings answers GET and POST.'); return true; }
  const [status, out] = set(await rctx.readJson(req));
  rctx.send(res, status, out);
  return true;
}

// Runs fn every setting seconds (or unitMs, for a setting in minutes), reading the setting each time, so a change applies from the next run.
// While it is 0 (off) nothing runs, and it looks again every 5 seconds, so turning it on needs no restart.
// The first run comes after at most firstMs, as the timers before this did.
// A change on the page sets the timer again at once, so a shorter interval does not wait out the old one.
function every(name, fn, firstMs, unitMs = 1000) {
  let first = true, timer = null;
  const next = () => {
    const ms = get(name) * unitMs;
    const wait = ms > 0 ? (first && firstMs ? Math.min(ms, firstMs) : ms) : 5000;
    timer = setTimeout(() => { if (get(name) > 0) { first = false; fn(); } next(); }, wait);
    timer.unref();
  };
  onChange((names) => { if (names.includes(name)) { clearTimeout(timer); next(); } });
  next();
}

module.exports = { get, list, set, onChange, every, handle, SETTINGS, FILE };
