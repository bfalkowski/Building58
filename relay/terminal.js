// The Claude Code panel's back end: runs `claude` in pseudo-terminals on this machine and
// passes them to the room page. Each terminal is one session, and one worker in the room.
// Their processes run in the session host (relay/session-host.js, through relay/host-link.js), so a
// relay restart leaves them running, and the new relay takes each one back as it was. Stopping the
// relay for good ends them, and they come back with claude --resume when it starts (relay/sessions.js).
// Off unless the relay starts with RELAY_TERMINAL=1, which `npm run office` sets.
//
// A terminal that runs Claude Code can run any command, so it answers only the room page
// itself, on this machine: the connection must come from 127.0.0.1, the address must be
// localhost or 127.0.0.1 (not a tunnel's name), and a browser request must come from the
// relay's own page (its Origin). Other websites, tunnels and other computers get 403, even
// with the right key.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('./state.js');
const hook = require('./office-hook.js');
const leadTired = require('./lead-tired.js');
const STATUS_LINE = { type: 'command', command: 'node ' + JSON.stringify(path.join(__dirname, 'status-line.js')), padding: 0 };
const link = require('./host-link.js');

const ENABLED = process.env.RELAY_TERMINAL === '1';
const CLAUDE = process.env.CLAUDE_CMD || 'claude';
const KEEP = 256 * 1024;  // output kept for a page that connects later
const MAX_TERMINALS = 9;  // one per desk
const OUT_BATCH = Number(process.env.RELAY_OUT_BATCH_MS) >= 1 ? Number(process.env.RELAY_OUT_BATCH_MS) : 16;  // output goes to pages in batches, about 60 a second. Tests make it longer.
// Nobody builds more tasks than this at once (relay/tasks.js). It lives here because the number you let
// the Lead start up to has to stay under it.
const config = require('./config.js');
// Read at each use, so a change in Settings (relay/config.js) applies at once.
const wipLimit = () => config.get('wipLimit');
const TAIL = 16 * 1024, SETTLED = 1500, AFTER_TRUST = 400;
const { claim } = require('./lockfile.js');
const sessionEnv = require('./session-env.js');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const channels = new Map();  // channel -> Map(terminal id -> terminal)
function termsOf(channel) {
  if (!channels.has(channel)) channels.set(channel, new Map());
  return channels.get(channel);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const LOCAL_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function localOnly(req, port) {
  if (!LOCAL_ADDRS.has(req.socket.remoteAddress)) return 'The terminal only answers this computer.';
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) return 'The terminal only answers http://localhost:' + port + ', not ' + host + '.';
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let o; try { o = new URL(origin); } catch (e) { return 'Bad Origin.'; }
    if (!LOCAL_HOSTS.has(o.hostname) || String(o.port || 80) !== String(port)) return 'The terminal only answers the room page served by this relay.';
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'The terminal only answers the room page served by this relay.';
  return null;
}
function expand(dir) {
  const d = String(dir || '~').trim() || '~';
  return path.resolve(d === '~' ? os.homedir() : d.startsWith('~/') ? path.join(os.homedir(), d.slice(2)) : d);
}
function find(channel, id) { return id ? termsOf(channel).get(id) || null : null; }

// ---------- who sits where: the relay picks each session's person (relay/seats.js) ----------
// The roster comes from the world that runs the sessions (relay/server.js): the Lead's desk, then one
// person for each other desk, and the pool of names. t.seat is the desk's person id and t.who the name
// the session shows, from the pool for the desk's kind. Both are saved with the sessions, so a restart
// keeps them, and GET /terminals sends them, so the page only draws them. Without a roster nobody has
// a name, and the Floor says Session and the start of the id.
const { seatAll, nameAll, plainName } = require('./seats.js');
let roster = [], pool = {};
const NAME = /^[A-Za-z][A-Za-z'-]{0,23}$/;
function setRoster(r) {
  const people = r && r.lead ? [Object.assign({}, r.lead, { lead: true })].concat((r.workers || []).slice(0, MAX_TERMINALS - 1)) : [];
  roster = people.filter((p) => p && typeof p.id === 'string').map((p, i) => ({ id: p.id, name: plainName(p.name) || plainName(p.id) || 'Desk ' + (i + 1), lead: !!p.lead, kind: typeof p.kind === 'string' ? p.kind : null }));
  // One word each, once each, and none a desk's own name or Lead, so a name finds one session.
  const seen = new Set(roster.map((p) => p.name.toLowerCase()).concat('lead'));
  pool = {};
  for (const [kind, list] of Object.entries((r && r.names) || {})) {
    pool[kind] = (Array.isArray(list) ? list : []).filter((n) => typeof n === 'string' && NAME.test(n) && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
  }
}
// This room's own record of when each name was last given or given up, in its state folder, so a
// name does not come back until the others have been used. Its seed is the state folder, so a second
// room, which has its own folder, goes through the names in another order.
const NAMES_FILE = state.file('names.json', 'RELAY_NAMES_FILE');
const NAME_SEED = state.dir();
let used = null;
const inUse = new Map();  // channel -> the names its sessions had at the last reseat
function usedNames() {
  if (used) return used;
  try { used = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')) || {}; } catch (e) { used = {}; }
  if (typeof used !== 'object' || Array.isArray(used)) used = {};
  return used;
}
function saveNames() {
  try {
    fs.mkdirSync(path.dirname(NAMES_FILE), { recursive: true });
    const tmp = NAMES_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(used, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, NAMES_FILE);
  } catch (e) { console.error('Could not save the names used: ' + e.message); }
}
// Seats and names saved for sessions the relay is still bringing back, so nobody new takes them meanwhile.
const held = new Map();  // channel -> { 'saved ' + session id: person id }
const heldNames = new Map();  // channel -> { 'saved ' + session id: name }
function holdSeats(channel, list) {
  const m = {}, n = {};
  for (const s of list) {
    if (s && s.seat && s.sessionId) m['saved ' + s.sessionId] = s.seat;
    if (s && typeof s.who === 'string' && s.sessionId) n['saved ' + s.sessionId] = s.who;
  }
  held.set(channel, m); heldNames.set(channel, n);
}
// Asked whenever a channel's sessions or its Lead change. A change of name reaches ticket history.
function reseat(channel) {
  if (!roster.length) return;
  const list = all(channel), before = Object.assign({}, held.get(channel));
  for (const t of list) if (t.seat) before[t.id] = t.seat;
  const sessions = list.map((t) => ({ id: t.id, lead: t.lead, at: t.startedAt }));
  const out = seatAll(roster, sessions, before);
  const had = Object.assign({}, heldNames.get(channel));
  for (const t of list) if (t.who) had[t.id] = t.who;
  const record = usedNames(), now = new Date().toISOString();
  const called = nameAll(roster, pool, sessions, out, had, record, NAME_SEED);
  let moved = false, stamped = false;
  const names = new Set();
  for (const t of list) {
    const seat = out[t.id] || null, who = called[t.id] || null;
    if (seat !== (t.seat || null)) { t.seat = seat; moved = true; }
    if (who !== (t.who || null)) { t.who = who; moved = true; if (who && isPooled(who)) { record[who] = now; stamped = true; } }
    if (who) names.add(who);
    if (t.who && namer) namer(channel, t);
  }
  // A name given up is the most recently used, so it waits for the others.
  for (const n of inUse.get(channel) || []) if (!names.has(n) && isPooled(n)) { record[n] = now; stamped = true; }
  inUse.set(channel, names);
  if (stamped) saveNames();
  if (moved) saveSessions();
}
const isPooled = (n) => Object.values(pool).some((list) => list.includes(n));
// Tasks know which ticket a session is on, and they need this file, so they pass the answer in.
let describeWork = null;
const onWork = (fn) => { describeWork = fn; };
const workOfTerm = (t) => (describeWork ? describeWork(t.channel, t) : null);
// The title you gave a session with /rename (relay/office-hook.js), as plain text, or null.
const customTitleOf = (v) => (typeof v === 'string' && v.replace(/\s+/g, ' ').trim().slice(0, 60)) || null;
function info(t) {
  return { id: t.id, who: t.who || null, seat: t.seat || null, cwd: t.cwd, from: t.from, project: hook.projectOf(t.cwd), sessionId: t.sessionId, title: t.title, customTitle: t.customTitle || null, task: t.task, role: t.role, pr: t.pr, work: describeWork ? describeWork(t.channel, t) : null, talked: t.talked, lead: !!t.lead, owesBrief: !!t.owesBrief, briefHeld: !!(t.owesBrief && briefHeld(t)), hooksSilent: !!(t.spoke && !t.hooked), board: !!t.board, merge: !!t.merge, starts: t.starts || 0, startsLeft: t.startsLeft || 0, lastStart: t.lastStart || null, startedAt: t.startedAt, running: !t.exited, exitCode: t.exitCode, hooks: t.hooks, state: t.state, message: t.message, lastActAt: t.lastActAt, replay: t.outSize, refresh: t.refresh ? t.refresh.phase : null, refreshNote: t.refreshNote || null, tired: leadTired.tiredOf(t) };
}

// The Lead's session, in a file so it outlives the relay. It always holds the current one: a new
// Lead overwrites it. Only what was in the file when the relay started is offered back.
//
// You choose the Lead: sitting at the Lead's desk is only a free seat. One session on a channel is
// the Lead (t.lead). It stays the Lead through /clear and Bring back, and the relay keeps the file
// up to date itself. A file written before you could choose may name a session that got there by
// accident, so it is the Lead again only through Bring back (lead: true on the start), which the relay
// also does by itself when it starts with no Lead running (startLead, unless RELAY_LEAD=0). Answering
// No, or using Resume with its id, gives a plain session. Bring back also restores permission to move
// the board, if the file says you granted it.
//
// Moving the board is a second choice (board: true). Starting tickets is a third (starts: N, the number
// of tasks building below which it may start one; 0 is off), with a total for the grant (startsLeft).
// Each start uses one, and the last one turns the permission off. Merging is a fourth (merge: true): the
// relay checks nothing before a merge, so it changes only the brief, and a change re-types the brief.
// The Lead holds each through /clear and
// Bring back. /clear moves them off the old id at once, so that id cannot bring back a second holder,
// and the next save writes them under the new one.
const LEAD_FILE = state.file('lead.json', 'RELAY_LEAD_FILE');
let leads = new Map();
try { leads = new Map(Object.entries(JSON.parse(fs.readFileSync(LEAD_FILE, 'utf8')))); } catch (e) { /* none yet, or unreadable: the next Lead replaces it */ }
const offered = new Map(leads);
const ownsLeadFile = claim(LEAD_FILE);
function saveLeads() {
  if (!ownsLeadFile) return;
  fs.mkdirSync(path.dirname(LEAD_FILE), { recursive: true });
  const tmp = LEAD_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(leads), null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, LEAD_FILE);
}
function restoreOf(channel) {
  const lead = offered.get(channel);
  return lead && ![...termsOf(channel).values()].some((t) => t.sessionId === lead.sessionId) ? lead : null;
}
// The running session you made the Lead, or null. A Lead saved in the file but not running is not one.
function leadOf(channel) {
  return [...termsOf(channel).values()].find((t) => !t.exited && t.lead) || null;
}
function clearSavedGrants(channel) {
  const saved = leads.get(channel);
  if (saved && (saved.board || saved.starts || saved.merge)) { saved.board = false; saved.merge = false; saved.starts = 0; saved.startsLeft = 0; saveLeads(); }
}
const MAX_TOTAL = 20;
// How many tasks may be building for the Lead to start one: a whole number from 1 to one under the WIP limit.
function startsProblem(n) {
  if (wipLimit() < 2) return 'The WIP limit is ' + wipLimit() + ', so there is no room under it for the Lead to start tickets. Raise the WIP limit in Settings first.';
  if (!Number.isInteger(n) || n < 1 || n >= wipLimit()) return 'Let the Lead start while fewer than 1' + (wipLimit() > 2 ? ' to ' + (wipLimit() - 1) : '') + ' tasks are building. It has to stay under the WIP limit of ' + wipLimit() + '.';
  return null;
}
function totalProblem(n) {
  return Number.isInteger(n) && n >= 1 && n <= MAX_TOTAL ? null : 'Give the Lead a total of 1 to ' + MAX_TOTAL + ' starts. The permission turns off when it has used them.';
}
// A saved grant past a WIP limit lowered since, or with no starts left, is off.
const keptStarts = (g) => (g && !startsProblem(Number(g.starts)) && !totalProblem(Number(g.startsLeft)) ? { starts: Number(g.starts), startsLeft: Number(g.startsLeft) } : { starts: 0, startsLeft: 0 });
// The Lead started a ticket (relay/tickets.js): one fewer left, and at none the permission turns off.
// The page announces it from lastStart.
function useStart(channel, t, ticket) {
  t.startsLeft = Math.max(0, (t.startsLeft || 0) - 1);
  if (!t.startsLeft) t.starts = 0;
  t.lastStart = { ticket: ticket.id, title: ticket.title, at: new Date().toISOString(), left: t.startsLeft };
  if (t.lead && t.talked && UUID.test(t.sessionId)) { try { saveLead(channel, t); } catch (e) { console.error('Could not save the Lead: ' + e.message); } }
  saveSessions();
}
// The Lead's job. See relay/lead-brief.js for why it stays short. It is built when it is saved, so it
// says whether the Lead may merge at that moment.
const { leadBrief } = require('./lead-brief.js');
const skills = require('./skills.js');  // each role's model and skills
// Both go in as saved deliveries (relay/delivery.js), which needs this file, so it is loaded when used.
const delivery = () => require('./delivery.js');
const BRIEF_KEY = 'lead-brief', NOT_LEAD_KEY = (t) => 'no-longer-lead ' + t.id;
// A Lead that may merge and is replaced is told it may not, since its conversation still says it may.
const NO_LONGER_LEAD = 'You are no longer the Lead of this room. Never merge a pull request: merging stays with the person.';
// It waits for the same safe moment as any note, and is dropped if the session is made the Lead again.
function tellNoLongerLead(channel, t) {
  delivery().save(channel, { key: NOT_LEAD_KEY(t), terminal: t.id, sessionId: t.sessionId, text: NO_LONGER_LEAD,
    on: (what, why) => { if (what !== 'delivered') console.log('A replaced Lead was not told it may no longer merge: ' + why); } });
}
// It goes in only while hooks say the session is idle, or a new conversation has just begun. Silence
// and timers never count: text and Enter at an open prompt answer it, so typing on a guess can approve
// a command nobody read. Esc sends no hook, so after an interrupted turn or Esc at a prompt the brief
// waits for the next prompt to finish, or for /clear. With no hook reaching this relay, a session that
// has been spoken to could be at a prompt, so it waits too. It is a first brief: nothing else is typed
// into the Lead before it. It counts as in once it is typed, not once a turn begins, since a Lead with
// no hooks reaching the relay is still briefed, and the told check after it tries once more and then
// says the Lead is stuck. It waits for as long as that session is the Lead, and a new Lead's brief
// takes its place. It says whether the Lead may merge, so a change to that switch saves it again,
// with the new words.
// It also says whether Autopilot is on, so Autopilot saves it again when it turns on or off (rebriefLead).
const briefHeld = (t) => t.state !== 'idle' || (t.spoke && !t.hooked);
const autopilotOn = (channel) => require('./autopilot.js').isOn(channel);  // it loads after this file
function briefLead(channel, t) {
  t.owesBrief = true;
  delivery().save(channel, { key: BRIEF_KEY, to: 'lead', terminal: t.id, sessionId: t.sessionId, first: true, text: (leadBrief(__dirname, { merge: !!t.merge, autopilot: autopilotOn(channel) }) + skills.brief('lead')).trim(), on: (what, why) => {
    t.owesBrief = false; saveSessions();
    if (what !== 'delivered') { console.error('The Lead was not briefed: ' + why); return; }
    // The brief is a conversation now, even if no hook reaches this relay to say so.
    if (t.lead && UUID.test(t.sessionId)) { try { saveLead(channel, t); } catch (e) { console.error('Could not save the Lead: ' + e.message); } }
  } });
}
function rebriefLead(channel) {
  const t = leadOf(channel);
  if (t && !t.exited) briefLead(channel, t);
}
// Every running session, in a file so the next relay can take them back from the host, or bring them
// back with claude --resume after a stop (relay/sessions.js). It is written whenever what it holds
// changes, and left alone while the relay stops, since those sessions are the ones to come back.
const SESSIONS_FILE = state.file('sessions.json', 'RELAY_SESSIONS_FILE');
let lastRun = {};
try { lastRun = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch (e) { /* none yet, or unreadable: the next save replaces it */ }
const ownsSessionsFile = claim(SESSIONS_FILE);
let closing = false, savedText = null;
function keepOf(t) {
  // talked: whether this session id has a conversation for claude --resume to find. Only a hook's prompt,
  // or a start with --resume, says so, and /clear takes it back. Enter alone is not enough: it may have
  // answered the question about trusting the folder, and a resume with no conversation fails.
  return { sessionId: t.sessionId, seat: t.seat || undefined, who: t.who || undefined, talked: !!t.talked, cwd: t.cwd, from: t.from, title: t.title, customTitle: t.customTitle || undefined, task: t.task, role: t.role, pr: t.pr,
    lead: !!t.lead, board: !!t.board, merge: !!t.merge, starts: t.starts || 0, startsLeft: t.startsLeft || 0, owesBrief: !!t.owesBrief, owesPrompt: t.owesPrompt || undefined, reviewOf: t.reviewOf || undefined, round: t.round || undefined, posted: t.posted || undefined, cols: t.cols, rows: t.rows,
    // What a relay needs to take the session back from the host as it is (start).
    terminal: t.id, state: t.state, message: t.message || undefined, waitingAt: t.state === 'waiting' ? t.waitingAt : undefined, hooked: !!t.hooked, heard: !!t.heard, spoke: !!t.spoke, hookAt: t.hookAt || undefined };
}
// Sessions brought back that could not come back: start refused them, or they ended within a few
// seconds, for example because `claude --resume` failed. They stay on the list, marked failed, so the
// next start tries again, up to MAX_TRIES times. Their conversations are still there for Resume.
const FAIL_WITHIN = 10 * 1000, MAX_TRIES = 3;
const failed = new Map();  // channel -> [saved session, with failed: true, tries, why, failedAt]
const failedOf = (channel) => failed.get(channel) || [];
function forgetFailed(channel, sessionId) {
  const list = failedOf(channel).filter((f) => f.sessionId !== sessionId);
  if (list.length) failed.set(channel, list); else failed.delete(channel);
}
function markFailed(channel, saved, why) {
  forgetFailed(channel, saved.sessionId);
  const tries = (saved.tries || 0) + 1;
  if (tries >= MAX_TRIES) {
    console.error('Gave up bringing back session ' + saved.sessionId + ' in ' + saved.cwd + ' after ' + tries + ' tries (' + why + '). Put that id in Resume to try by hand.');
  } else {
    console.error('Session ' + saved.sessionId + ' in ' + saved.cwd + ' could not come back (' + why + '). The next start tries again, or put that id in Resume.');
    failed.set(channel, failedOf(channel).concat([Object.assign({}, saved, { failed: true, tries, why, failedAt: new Date().toISOString() })]));
  }
  saveSessions();
}
// Whether a session on the failed list was in that folder or under it, so its checkout stays for the next try.
function failedIn(dir) {
  const want = real(dir);
  for (const list of failed.values()) for (const f of list) if (f.cwd && (real(f.cwd) === want || real(f.cwd).startsWith(want + path.sep))) return true;
  return false;
}
// The saved session relay/sessions.js is bringing back while it calls start, through tasks or not.
let restoring = null;
function bringingBack(saved, fn) { restoring = saved; try { return fn(); } finally { restoring = null; } }

function saveSessions() {
  if (!ownsSessionsFile || closing) return;
  const all = {};
  for (const channel of new Set([...channels.keys(), ...failed.keys()])) {
    const list = [...termsOf(channel).values()].filter((t) => !t.exited && UUID.test(t.sessionId)).map(keepOf).concat(failedOf(channel));
    if (list.length) all[channel] = list;
  }
  const text = JSON.stringify(all, null, 2) + '\n';
  if (text === savedText) return;
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    const tmp = SESSIONS_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, SESSIONS_FILE);
    savedText = text;
  } catch (e) { console.error('Could not save the sessions to ' + SESSIONS_FILE + ': ' + e.message); }
}
// What was running when the last relay stopped, once. A relay that does not own the file gets nothing.
function takeLastRun() { const out = ownsSessionsFile ? lastRun : {}; lastRun = {}; return out; }

function saveLead(channel, t) {
  leads.set(channel, { sessionId: t.sessionId, cwd: t.cwd, title: t.title || null, board: !!t.board, merge: !!t.merge, starts: t.starts || 0, startsLeft: t.startsLeft || 0, savedAt: new Date().toISOString() });
  saveLeads();
}
// A new conversation or a new title reaches the file without anyone asking.
function keepLeadSaved(channel, t) {
  if (!t.talked || !UUID.test(t.sessionId)) return;
  const saved = leads.get(channel);
  if (saved && saved.sessionId === t.sessionId && (saved.title || null) === (t.title || null) && !!saved.board === !!t.board && !!saved.merge === !!t.merge && (saved.starts || 0) === (t.starts || 0) && (saved.startsLeft || 0) === (t.startsLeft || 0)) return;
  try { saveLead(channel, t); } catch (e) { console.error('Could not save the Lead: ' + e.message); }
}
function setLead(channel, body) {
  if (body.asked) { offered.delete(channel); return [200, { ok: true }]; }
  if (body.refresh === true) return startRefresh(channel);
  if (body.refresh === false) return stopRefresh(channel);
  // Taking a permission back always works, whoever holds it and whichever session is named. Taking back
  // starts leaves work already running alone. A request that also grants something goes on below.
  // Taking back merging re-types the brief, so a Lead that was told it may merge is told it may not.
  const takeBoard = body.board === false, takeStarts = body.starts === 0 || body.starts === false, takeMerge = body.merge === false;
  if (takeBoard || takeStarts || takeMerge) {
    const saved = leads.get(channel);
    for (const x of termsOf(channel).values()) {
      if (takeBoard) x.board = false;
      if (takeStarts) x.starts = x.startsLeft = 0;
      if (takeMerge && x.merge) { x.merge = false; if (x.lead && !x.exited) briefLead(channel, x); }
    }
    if (saved && ((takeBoard && saved.board) || (takeStarts && saved.starts) || (takeMerge && saved.merge))) { if (takeBoard) saved.board = false; if (takeStarts) saved.starts = saved.startsLeft = 0; if (takeMerge) saved.merge = false; saveLeads(); }
    saveSessions();
    if (body.board !== true && !(body.starts > 0) && body.merge !== true) return [200, Object.assign({ ok: true }, takeBoard ? { board: false } : {}, takeStarts ? { starts: 0 } : {}, takeMerge ? { merge: false } : {})];
  }
  const t = find(channel, String(body.terminal || ''));
  if (!t || t.exited) return [404, { ok: false, error: 'no_terminal', message: 'No such session on this channel.' }];
  if (t.task || t.role) return [409, { ok: false, error: 'task', message: 'Only a plain session can be the saved Lead.' }];
  // lead: true grants only to the Lead there is now (Settings sends it). A page that has not seen another
  // session made the Lead, in another tab, must not make the old one the Lead again.
  if (body.lead === true && !t.lead) return [409, { ok: false, error: 'not_lead', message: 'That session is no longer the Lead. Settings shows the Lead there is now: look again, then press it.' }];
  if (!UUID.test(t.sessionId)) return [409, { ok: false, error: 'bad_session', message: 'The full session id is not known yet.' }];
  if (body.board === true && !t.talked) return [409, { ok: false, error: 'no_conversation', message: 'This session needs a conversation before it can move the board. Send it a prompt, then press the button again.' }];
  if (body.merge === true && !t.talked) return [409, { ok: false, error: 'no_conversation', message: 'This session needs a conversation before it can merge. Send it a prompt, then press the button again.' }];
  if (body.starts !== undefined && !takeStarts) {
    const problem = startsProblem(body.starts) || totalProblem(body.total);
    if (problem) return [400, { ok: false, error: 'bad_starts', message: problem }];
    if (!t.talked) return [409, { ok: false, error: 'no_conversation', message: 'This session needs a conversation before it can start tickets. Send it a prompt, then press the button again.' }];
  }
  const board = body.board === true || !!t.board, merge = body.merge === true || (!takeMerge && !!t.merge), isNew = !t.lead;
  const mergeChanged = !isNew && merge !== !!t.merge;
  const granting = body.starts !== undefined && !takeStarts;
  const starts = granting ? body.starts : t.starts || 0, startsLeft = granting ? body.total : t.startsLeft || 0;
  offered.delete(channel);
  for (const other of termsOf(channel).values()) if (other !== t && other.refresh) endRefresh(other, 'Another session was made the Lead, so the refresh stopped.', false);
  for (const other of termsOf(channel).values()) if (other !== t && other.merge && !other.exited) tellNoLongerLead(channel, other);
  delivery().drop(channel, NOT_LEAD_KEY(t));  // it is the Lead again
  for (const other of termsOf(channel).values()) { if (other !== t) other.owesBrief = false; other.lead = other === t; other.board = other === t && board; other.merge = other === t && merge; other.starts = other === t ? starts : 0; other.startsLeft = other === t ? startsLeft : 0; }  // a new Lead takes them from the old one
  reseat(channel);  // the Lead takes its own desk at once
  // With no conversation yet there is nothing to come back to. The brief starts one, and saves it then.
  if (t.talked) saveLead(channel, t); else clearSavedGrants(channel);
  if (isNew || mergeChanged) briefLead(channel, t);
  saveSessions();
  return [200, { ok: true, lead: true, board, merge, starts, startsLeft }];
}
// The relay's own Lead, once it has taken back and brought back its sessions (relay/sessions.js). With a
// Lead running it does nothing, so there is never a second. The saved Lead comes back first, as Bring back
// brings it, with the permissions the file says you granted. If there is none, or it cannot come back, a
// new plain session in cwd is made the Lead, with every permission off. Either way the panel offers
// nothing back, since there is a Lead. It starts nothing while an update is under way.
function startLead(channel, cwd, ctx) {
  if (leadOf(channel)) return;
  if (updating()) { ctx.log('No Lead started on ' + channel + ': an update is under way.'); return; }
  const offer = restoreOf(channel);
  offered.delete(channel);
  const startNew = (why) => {
    if (leadOf(channel) || closing) return;
    const r = start(channel, { cwd }, ctx, null, { newLead: true });
    ctx.log(r.status < 400 ? why + 'Started a new Lead in ' + cwd + ' on ' + channel + '.' : why + 'Could not start a Lead on ' + channel + ': ' + r.body.message);
  };
  if (!offer) { startNew(''); return; }
  const who = 'the saved Lead (' + String(offer.sessionId).slice(0, 8) + ')';
  // claude --resume ends at once when it cannot find the conversation. An exit you asked for does not count.
  const r = start(channel, { cwd: offer.cwd, resume: offer.sessionId, lead: true }, ctx, (t) => {
    if (!t.stopped && !closing && t.exitCode !== 0 && !t.typedAt && Date.now() - Date.parse(t.startedAt) < FAIL_WITHIN) startNew('Could not bring back ' + who + ': it ended at once. ');
  });
  if (r.status >= 400) { startNew('Could not bring back ' + who + ': ' + r.body.message + ' '); return; }
  ctx.log('Brought back ' + who + ' as the Lead on ' + channel + '.');
}
function sse(res, event, data) { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }

// onExit (t) runs once the session has ended. Only relay/checkouts.js and relay/sessions.js pass it,
// and own, which no request can set: own.reviewOf is the PR an automatic reviewer was started for, and
// own.kept is what relay/sessions.js saved about a session it brings back: whether it was the Lead,
// could move the board or merge, how many tasks it could start up to, and still owed the Lead's brief.
function start(channel, body, ctx, onExit, own) {
  const kept = own && own.kept;
  const terms = termsOf(channel), running = [...terms.values()].filter((t) => !t.exited);
  if (running.length >= MAX_TERMINALS) return { status: 409, body: { ok: false, error: 'full', message: 'All ' + MAX_TERMINALS + ' desks are taken. Stop a session first.' } };
  const resume = body.resume ? String(body.resume).trim() : '';
  if (resume && !UUID.test(resume)) return { status: 400, body: { ok: false, error: 'bad_session', message: 'A session id looks like b299ee24-0c4c-4507-afb7-bb2625eeb192.' } };
  if (resume && running.some((t) => t.sessionId === resume)) return { status: 409, body: { ok: false, error: 'running', message: 'That session is already running here.' } };
  const cwd = expand(body.cwd);
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error(); } catch (e) {
    return { status: 400, body: { ok: false, error: 'bad_folder', message: 'There is no folder ' + cwd + '.' } };
  }
  // A session the last relay was running is still running in the host after a restart: this relay
  // takes it back as it is, with its desk, conversation, ticket token and output.
  const back = restoring && restoring.terminal ? link.peek(restoring.terminal) : null;
  const adopted = back && back.meta && back.meta.channel === channel ? restoring : null;  // /clear may have given it a new session id since
  if (!adopted && !link.isReady()) return { status: 503, body: { ok: false, error: 'no_host', message: 'The session host is not running yet. Try again in a moment.' } };
  const cols = adopted ? back.cols : Math.min(400, Math.max(20, Number(body.cols) || 120)), rows = adopted ? back.rows : Math.min(200, Math.max(5, Number(body.rows) || 32));
  const sessionId = adopted ? adopted.sessionId : resume || crypto.randomUUID();
  const id = adopted ? adopted.terminal : crypto.randomBytes(6).toString('hex');
  // What lets this session file tickets (relay/ticket.js), and move the board if you made it the Lead.
  // The token is good for nothing else.
  const token = adopted ? back.meta.token : crypto.randomBytes(16).toString('hex');
  // Sessions started here report to this room. If the hooks are already in
  // ~/.claude/settings.json they report anyway, and adding them again would double every event.
  const global = hook.hooksInstalled();
  const saved = leads.get(channel);
  // Only Bring back asks for this. Two sessions can share an old id after /clear, and the one already
  // running stays the Lead. own.newLead is the relay's own new Lead (startLead): a plain session, made the
  // Lead as it starts so it gets the Lead's model, with every permission off.
  const fresh = !!(own && own.newLead && !resume && !body.task && !body.role && !running.some((x) => x.lead));
  const lead = fresh || (kept ? !!(kept.lead && !body.task && !body.role && !running.some((x) => x.lead))
    : !!(body.lead === true && resume && !body.task && !body.role && saved && saved.sessionId === resume && !running.some((x) => x.lead)));
  const board = !!(lead && !fresh && (kept ? kept.board : saved.board)), merge = !!(lead && !fresh && (kept ? kept.merge : saved.merge));
  const { starts, startsLeft } = lead && !fresh ? keptStarts(kept || saved) : keptStarts(null);
  if (lead && kept) offered.delete(channel);
  if (fresh) clearSavedGrants(channel);  // as for a session you make the Lead: the file's grants were for another
  if (resume) forgetFailed(channel, resume);  // tried again, here or by hand
  const talked = adopted ? !!adopted.talked : !!resume;
  const t = { id, channel, cwd, from: body.from || null, title: body.title ? String(body.title).slice(0, 80) : null, task: body.task || null, role: body.role || null, pr: body.pr || null, token, lead, board, merge, starts, startsLeft, talked, spoke: adopted ? !!(adopted.spoke || adopted.talked) : talked, state: 'idle', message: null, drafting: false, sinceKey: null, lastEnterAt: 0, lastActAt: Date.now(), lastOutAt: 0, tail: '', sessionId, startedAt: new Date().toISOString(), hooks: global ? 'global' : 'session', cols, rows,
    io: null, out: [], outSize: 0, viewers: new Set(), exited: false, exitCode: null, pendingOut: [], flush: null, reviewOf: (own && own.reviewOf) || null, round: (own && own.round) || null, posted: null, ending: null };
  if (restoring && resume && !adopted) { t.restoredAt = Date.now(); t.tries = restoring.tries || 0; }
  // A session brought back starts from the person and name it had. reseat below checks that against the rules.
  if (restoring) {
    t.seat = typeof restoring.seat === 'string' ? restoring.seat : null;
    t.who = typeof restoring.who === 'string' ? plainName(restoring.who) || null : null;
    t.customTitle = customTitleOf(restoring.customTitle);
    const h = held.get(channel), n = heldNames.get(channel);
    if (h) delete h['saved ' + restoring.sessionId];
    if (n) delete n['saved ' + restoring.sessionId];
  }
  // Where hooks last left it, since its turn went on through the restart.
  if (adopted) { t.state = ['working', 'waiting'].includes(adopted.state) ? adopted.state : 'idle'; t.message = adopted.message || null; if (t.state === 'waiting') t.waitingAt = adopted.waitingAt || Date.now(); t.hooked = !!adopted.hooked; t.heard = !!adopted.heard; t.hookAt = Number(adopted.hookAt) || 0; }
  // An automatic reviewer that had posted when the relay stopped had ended its turn or was about to,
  // so it leaves after the same wait as if its Stop had just come.
  if (kept && kept.posted && t.reviewOf) {
    t.posted = kept.posted;
    t.ending = setTimeout(() => { t.ending = null; reviewDone(channel, t); }, REVIEW_GRACE());
  }
  terms.set(id, t);
  reseat(channel);
  const emitOut = (buf) => {
    t.out.push(buf); t.outSize += buf.length;
    t.lastOutAt = Date.now(); t.tail = (t.tail + buf.toString('latin1')).slice(-TAIL);
    if (t.sinceKey !== null) t.sinceKey = (t.sinceKey + buf.toString('latin1')).slice(-TAIL);
    while (t.outSize > KEEP && t.out.length > 1) t.outSize -= t.out.shift().length;
    t.pendingOut.push(buf);
    if (!t.flush) t.flush = setTimeout(() => flushOut(t), OUT_BATCH);
  };
  const ended = (code) => {
    t.exited = true; t.exitCode = t.stopped ? null : code;
    reseat(channel);  // its person is free, so someone at the Lead's desk who is not the Lead can move
    keepReviewer(t);
    if (t.refresh) endRefresh(t, 'The Lead\'s session ended before the refresh finished.', false);
    setTimeout(() => {
      flushOut(t);  // its last output goes before the end, whatever the batch length
      for (const v of t.viewers) sse(v, 'exit', { code: t.exitCode, stopped: !!t.stopped });
      terms.delete(id);  // its desk is free again
    }, 30);
    ctx.log('Claude Code in ' + cwd + (t.stopped ? ' was stopped' : ' ended (' + code + ')'));
    // Only an exit nobody asked for: /exit, or Ctrl+C twice, ends with 0, after Enter or keys from the panel.
    if (t.restoredAt && !t.stopped && !closing && code !== 0 && !t.typedAt && Date.now() - t.restoredAt < FAIL_WITHIN) {
      markFailed(channel, Object.assign(keepOf(t), { sessionId: resume, talked: true, tries: t.tries }), 'it ended ' + Math.round((Date.now() - t.restoredAt) / 1000) + ' seconds after it was brought back, with exit code ' + code);
    }
    saveSessions();
    // Claude Code sends SessionEnd itself when it quits normally, but not when it is killed.
    // Tell the room either way, so nobody keeps working for a session that is gone.
    ctx.command(channel, { action: 'hook', source: 'terminal', event: { hook_event_name: 'SessionEnd', session_id: t.sessionId.slice(0, 12), reason: 'terminal closed' } });
    for (const fn of enders) { try { fn(channel, t, code, closing); } catch (e) { console.error('After a session ended: ' + e.message); } }
    if (onExit) onExit(t);
  };
  if (adopted) {
    const got = link.adopt(id, { out: emitOut, exit: ended });
    t.io = got.io;
    if (got.out.length) { t.out.push(got.out); t.outSize = got.out.length; t.tail = got.out.toString('latin1').slice(-TAIL); }
    t.lastOutAt = Date.now();
  } else {
    const args = resume ? ['--resume', sessionId] : ['--session-id', sessionId];
    // A new session runs on its role's model, if one is set in Settings. A resumed one keeps its own, and
    // a /model switch made by hand with it (relay/skills.js). A missing skill is said once in #office.
    const role = skills.roleOf(body, own, lead);
    if (!resume) args.push(...skills.modelArgs(role));
    if (role) skills.notice(channel);
    // Every session gets the room's status line, which shows how full its context is and tells the
    // relay (relay/status-line.js). It takes the place of a status line of the person's own here.
    const settings = { statusLine: STATUS_LINE };
    if (!global) settings.hooks = hook.hookSettings({ key: ctx.key, url: 'http://localhost:' + ctx.port, channel });
    args.push('--settings', JSON.stringify(settings));
    // What the session's environment holds, without the relay's key and settings (relay/session-env.js).
    const env = sessionEnv.build(process.env, {
      OFFICE_TERMINAL_ID: id,  // the hook sends it, so /clear keeps the session at the same desk
      // Global hooks learn the channel only from this. A hook installed for another channel sets its own.
      OFFICE_CHANNEL: channel,
      // The same value again, so office-hook.js --install run in this session can tell the panel set it,
      // and does not pin the global hooks to this page's channel (T-115).
      OFFICE_PANEL_CHANNEL: channel,
      OFFICE_TICKET_TOKEN: token,
      OFFICE_TICKET_URL: 'http://localhost:' + ctx.port + '/channels/' + encodeURIComponent(channel) + '/tickets',
      // The hook sends here first, with the token, so the session reports to this relay even when the
      // hooks in ~/.claude/settings.json name another one (relay/office-hook.js). 127.0.0.1, where the
      // relay listens, since Node 18's fetch tries only ::1 for localhost.
      OFFICE_HOOK_URL: 'http://127.0.0.1:' + ctx.port + '/channels/' + encodeURIComponent(channel) + '/commands',
      // A seat in a round of a game (relay/games.js): its hooks send none of its words (relay/office-hook.js).
      ...(own && own.round ? { OFFICE_SEAT: '1' } : {})
    });
    // meta comes back from the host after a restart, so the next relay knows whose session it is.
    t.io = link.spawn({ id, cwd, env, cmd: [CLAUDE].concat(args), cols, rows, meta: { channel, sessionId, token, cwd } }, { out: emitOut, exit: ended });
  }
  // Bring back briefs the Lead again. A Lead the relay brings back after a restart is in the same
  // conversation, which has the brief already, unless it never went in.
  if (lead && (!kept || kept.owesBrief || (!resume && !adopted))) briefLead(channel, t);
  saveSessions();
  ctx.log(adopted ? 'Took back Claude Code in ' + cwd + ' for channel ' + channel + ', still running' : 'Claude Code started in ' + cwd + ' for channel ' + channel + ' (hooks: ' + t.hooks + ')');
  return { status: 201, body: Object.assign({ ok: true }, info(t)) };
}

// The relay types into a session only once it can take one (notSafeToType). Claude Code first asks
// whether to trust a new folder, and Enter there means No, so nothing is typed while that question is
// up. The screen has settled when nothing has printed for a moment.
const PROMPT = Buffer.from('❯').toString('latin1');  // t.tail holds bytes as latin1
const { ENTER_SETTLES } = require('./stop-verdict.js');  // one grace for Enter, shared with the Lead's stop verdict
// CSI (any parameters, so DA2 replies and SGR mouse too), OSC, DCS (such as an XTVERSION reply), charset, and the rest.
// eslint-disable-next-line no-control-regex -- matching terminal escape codes is the point
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b[()][A-Za-z0-9]|\x1b./g;
// The old mouse mode: ESC [ M and three raw bytes. Only in what xterm sends, since ESC [ M in output deletes a line.
// eslint-disable-next-line no-control-regex -- matching terminal escape codes is the point
const X10_MOUSE = /\x1b\[M[\s\S]{3}/g;
// While an update is under way (relay/update.js), the relay types no saved delivery, so no turn it starts
// can be cut off by the restart: they stay in their file and reach the session when it comes back. A first
// prompt waits only for the restart itself (restarting). The update waits for the quiet moment no turn
// is in, which can take hours while Autopilot runs, and a reviewer held all that time sat with talked:
// false (T-147). Typed while the update waits, its turn is waited for like any other.
let updating = () => false, restarting = () => false;
const holdWhileUpdating = (fn, restartFn) => { updating = fn; if (restartFn) restarting = restartFn; };
// A refresh of the Lead holds the update until it ends (relay/update.js), so its steps, and the brief
// /clear brings, still go into the Lead. Held too, neither would ever finish.
// brief 'prompt' is a reviewer's, the PM's or the COO's first prompt, which only the restart holds.
const heldForUpdate = (t, brief) => (brief === 'prompt' ? restarting() : updating() && !t.refresh);

// What a reviewer's, the PM's or the COO's first prompt is, while it is not in yet (relay/delivery.js,
// promptOnce). It is saved with the session, so a session brought back after a stop, with a new
// terminal and session id, still gets it (relay/sessions.js), and the Lead's stop verdict sees it is owed.
function owePrompt(t, text) {
  t.owesPrompt = text || null;
  if (!closing) saveSessions();
}
// Claude Code can show a menu after a turn has ended, with hooks saying idle, and Enter picks from it.
const MENU = new RegExp('Entertoconfirm|Esctocancel|' + PROMPT + '\\d+\\.');
// Sends the output held for the next batch to the pages watching now. It is in t.out already, so a page
// that opens the stream gets it in its replay, and this runs first so that page does not get it twice.
function flushOut(t) {
  if (t.flush) { clearTimeout(t.flush); t.flush = null; }
  if (!t.pendingOut.length) return;
  const data = Buffer.concat(t.pendingOut).toString('base64'); t.pendingOut = [];
  for (const v of t.viewers) sse(v, 'out', data);
}
function screenOf(t) { return t.tail.replace(ANSI, '').replace(/\s+/g, ''); }
function onTrustQuestion(screen) {
  const asked = screen.toLowerCase().lastIndexOf('trust');
  return asked >= 0 && screen.length - asked < AFTER_TRUST;
}

// A question on screen that no hook reports, or null: 'trust' while Claude Code asks whether to trust
// the folder, or 'menu' while a menu is open. notSafeToType and the Lead's stop verdict both use it.
function questionOnScreen(t) {
  if (!t.heard && onTrustQuestion(screenOf(t))) return 'trust';  // heard: past that question, so the word in its output is only a word
  // Esc or Enter closes a menu and leaves its words in the output, so only what came after them counts.
  if (MENU.test(screenOf({ tail: t.sinceKey === null ? t.tail : t.sinceKey }).slice(-AFTER_TRUST))) return 'menu';
  return null;
}

// Why nothing can be typed into this session right now, or null if it can. Typed text and Enter
// answer whatever is on screen, so anything unknown counts as no. Only hooks say a turn has ended.
// Silence never does: an interrupted turn stays working, and is reported as quiet instead.
// brief: this is a first brief, such as the Lead's, which an owed brief does not hold back. 'prompt': a
// reviewer's, the PM's or the COO's first prompt, which an update holds only while it restarts (T-147).
function notSafeToType(t, brief) {
  if (!t || t.exited || t.stopped) return 'ended';
  if (heldForUpdate(t, brief)) return 'restarting';
  if (t.posted) return 'leaving';  // an automatic reviewer that has posted: a prompt now would only hold it up
  if (t.state === 'working') return 'working';
  if (t.state === 'waiting') return 'waiting';
  if (t.spoke && !t.hooked) return 'no_hooks';  // spoken to, and no hook has ever said how that went
  if (t.owesBrief && !brief) return 'briefing';  // the Lead's brief goes first, and never at the same time
  if (t.drafting) return 'typing';
  if (Date.now() - t.lastEnterAt < ENTER_SETTLES) return 'working';  // Enter was pressed, and its hook is on the way
  if (!t.lastOutAt || Date.now() - t.lastOutAt < SETTLED) return 'settling';
  const question = questionOnScreen(t);
  if (question) return question;
  return screenOf(t).includes(PROMPT) ? null : 'no_prompt';
}
// Types and presses Enter, checking again before each. done (problem): null means it went in.
// Enter after a pause, since a TUI takes text and Enter that arrive together as a paste.
// Long text goes in as one paste, so all of it arrives (relay/typed.js).
const { asTyped } = require('./typed.js');
// How long the text sits in the prompt before Enter. A press that changes a saved message in that time
// takes the text back out (relay/delivery.js). Tests make it longer, so they can press in time.
const TYPE_SETTLE = Number(process.env.RELAY_TYPE_SETTLE_MS) >= 1 ? Number(process.env.RELAY_TYPE_SETTLE_MS) : 300;
function typeIfSafe(t, text, wanted, done, brief) {
  const first = notSafeToType(t, brief);
  if (first) { done(first); return; }
  t.io.write(asTyped(text));
  // typingFirst: a first prompt is in the box and Enter is not pressed yet, so the update waits (relay/update.js).
  if (brief === 'prompt') t.typingFirst = true;
  setTimeout(() => {
    t.typingFirst = false;
    const second = t.exited || t.stopped ? 'ended' : heldForUpdate(t, brief) ? 'restarting' : t.state !== 'idle' ? t.state : t.drafting ? 'typing' : !wanted() ? 'dropped' : null;
    if (second) { if (!t.exited && !t.stopped) t.io.write('\x15'); done(second); return; }  // takes the text back out
    t.io.write('\r'); t.spoke = true; t.relayTyped = Date.now(); t.lastEnterAt = Date.now(); t.sinceKey = '';
    done(null);
  }, TYPE_SETTLE);
}

// A second try at a note the session did not take up (relay/delivery.js). If the note still shows since
// the relay's Enter, it is in the prompt, so only Enter goes in. Otherwise the prompt is cleared and the
// note typed again. Both wait for notSafeToType, like any typing. done (problem, how): how is 'enter' or 'typed'.
const NOTE_SEEN = 30;  // characters of the note, without spaces, that count as it showing
function noteShown(t, text) {
  const key = Buffer.from(String(text).replace(/\s+/g, '').slice(0, NOTE_SEEN)).toString('latin1');
  return !!key && t.sinceKey !== null && screenOf({ tail: t.sinceKey }).includes(key);
}
function nudge(t, text, wanted, done, brief) {
  const problem = notSafeToType(t, brief);
  if (problem) { done(problem); return; }
  if (noteShown(t, text)) {
    t.io.write('\r'); t.spoke = true; t.relayTyped = Date.now(); t.lastEnterAt = Date.now(); t.sinceKey = '';
    done(null, 'enter'); return;
  }
  t.io.write('\x15');
  typeIfSafe(t, text, wanted, (p) => done(p, 'typed'), brief);
}

// Whether a person has left text in this session's prompt, which a typed message would be joined to.
// Escape codes do not count: xterm sends those by itself, for focus and cursor reports.
function noteTyping(t, data) {
  const plain = data.replace(ANSI, '');
  const enter = Math.max(plain.lastIndexOf('\r'), plain.lastIndexOf('\n'));
  // A key or Enter at a question answers it, and the turn goes on with no hook until its next tool or
  // its end (relay/update.js). Esc and arrow keys alone do not.
  // eslint-disable-next-line no-control-regex -- control keys other than Enter answer nothing
  if (t.state === 'waiting' && (enter >= 0 || /[^\x00-\x1f\x7f]/.test(plain))) t.answeredAt = Date.now();
  // A key pressed while a menu is up picks from it, and goes nowhere near the prompt.
  if (MENU.test(screenOf({ tail: t.sinceKey === null ? t.tail : t.sinceKey }).slice(-AFTER_TRUST))) { t.sinceKey = ''; return; }
  if (enter >= 0) { t.drafting = false; t.lastEnterAt = Date.now(); }
  if (enter >= 0 || plain.includes('\x1b')) t.sinceKey = '';  // what is left of the codes is a bare Esc
  // eslint-disable-next-line no-control-regex -- control keys are not text in the prompt
  if (/[^\x00-\x1f\x7f]/.test(plain.slice(enter + 1))) t.drafting = true;
  // eslint-disable-next-line no-control-regex -- Ctrl+C and Ctrl+U clear it
  else if (/\x03|\x15/.test(plain)) t.drafting = false;
}

// What the relay last heard from each session's hook, so a page that reloads can seat its
// people in the right state.
function noteHook(channel, ev) {
  if (!ev || !ev.hook_event_name) return;
  const terms = [...termsOf(channel).values()];
  const name = ev.hook_event_name, sid = String(ev.session_id || '');
  if (name === 'SessionStart' && ev.terminal && ev.source && ev.source !== 'startup') {
    const moved = terms.find((t) => t.id === ev.terminal);  // /clear or /resume gave it a new id
    if (moved && sid && !((Number(ev.at) || Date.now()) < (moved.hookAt || 0))) {
      moved.hooked = true;
      const was = moved.sessionId;
      moved.sessionId = UUID.test(ev.full_session_id || '') ? ev.full_session_id : sid; moved.talked = ev.source === 'resume' || (ev.source === 'compact' && moved.sessionId === was && moved.talked); if (!moved.task && !moved.role) moved.title = null;
      if ((moved.board || moved.starts || moved.merge) && moved.sessionId !== was) { try { clearSavedGrants(channel); } catch (e) { console.error('Could not save the Lead: ' + e.message); } }
      // A new conversation is not in a turn, even if the last one was interrupted and never said it ended.
      if (moved.sessionId !== was) { moved.state = 'idle'; moved.message = null; moved.customTitle = null; }  // this event's own customTitle, below, puts back the new one's
      // The same terminal keeps its person, and ticket history keeps the name against the new id too.
      if (moved.who && namer) namer(channel, moved);
      if (moved.sessionId !== was) for (const fn of movers) { try { fn(channel, moved, was); } catch (e) { console.error('Could not follow a new session: ' + e.message); } }
      // A new conversation has never heard the brief, and a compacted one may have lost it.
      if (moved.lead && (moved.sessionId !== was || ev.source === 'compact')) briefLead(channel, moved);
    }
  }
  const t = sid && terms.find((x) => x.sessionId.startsWith(sid));
  if (!t) return;
  // An event older than the last one applied changes nothing, such as a hook queued while no relay ran
  // that arrives after a newer one (relay/hook-queue.js). at is when the hook ran. hookAt is saved with
  // the session, so this holds across a restart. Events with no time, such as the relay's own, are now.
  const at = Number(ev.at) || Date.now();
  if (at < (t.hookAt || 0)) return;
  t.hookAt = at;
  t.hooked = true; t.lastActAt = Date.now();
  if (ev.title && !t.task && !t.role) t.title = ev.title;  // a task, the PM or the COO keeps its own title
  // The title you gave it with /rename, whatever its job, shown beside its person's name. '' takes it away.
  if (typeof ev.customTitle === 'string') t.customTitle = customTitleOf(ev.customTitle);
  if (name === 'UserPromptSubmit') t.talked = t.spoke = t.heard = true;  // heard: it is past any question about trusting the folder
  // A tool or the end of a turn means a turn began, in case its prompt's hook was lost.
  if (['PreToolUse', 'PostToolUse', 'Stop'].includes(name)) t.talked = t.spoke = true;
  // movedAt: when a hook last said the session did something, not only that it started (relay/autopilot.js).
  if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(name)) t.movedAt = Date.now();
  // turnAt: when a hook last said a turn began, so relay/delivery.js can tell whether a note was taken up.
  if (name === 'UserPromptSubmit' || (name === 'PreToolUse' && !ev.agent_id)) { t.state = 'working'; t.message = null; t.turnAt = Date.now(); t.stuck = null; }
  else if (name === 'PreToolUse') { if (t.state === 'waiting') { t.state = 'working'; t.message = null; } }
  else if (name === 'Stop' || name === 'StopFailure' || name === 'SessionEnd') { t.state = 'idle'; t.message = null; }
  else if (name === 'Notification' && !/waiting for your input|idle/i.test((ev.message || '') + ' ' + (ev.notification_type || ''))) { if (t.state !== 'waiting') t.waitingAt = Date.now(); t.state = 'waiting'; t.message = ev.message || null; }
  if (t.lead) keepLeadSaved(channel, t);
  saveSessions();
  if (t.reviewOf) noteReview(channel, t, name, ev);
  if (t.refresh) advanceRefresh(t);
}

// ---------- Refresh the Lead: handoff notes, /clear, and the notes read back ----------
// The steps are in relay/lead-refresh.js. The relay runs them, since only it knows whether the
// person has text in the Lead's prompt, a menu is up, or Enter was just pressed (notSafeToType).
// Hooks drive it, so no turn is missed between two looks. One refresh at a time, per Lead.
const leadRefresh = require('./lead-refresh.js');
const refreshView = (t) => t && { lead: !!t.lead, running: !t.exited && !t.stopped, state: t.state, owesBrief: !!t.owesBrief, sessionId: t.sessionId };
let refreshRuns = 0;  // each refresh's number, so a typing loop from a stopped one never types into the next
const NOT_NOW = { typing: 'You have text typed in the Lead\'s prompt. Send it or clear it first.', menu: 'A menu is open in the Lead\'s session. Close it first.', no_hooks: 'No hooks reach this relay from the Lead, so it cannot tell when a turn ends.', settling: 'The Lead\'s screen is still changing. Try again in a few seconds.', working: 'The Lead is busy. Try again when its turn ends.' };
function startRefresh(channel) {
  const t = leadOf(channel);
  if (t && t.refresh) return [409, { ok: false, error: 'refreshing', message: 'The Lead is already being refreshed.' }];
  const unsafe = t ? notSafeToType(t) : null;
  const why = leadRefresh.canStart(refreshView(t)) || (unsafe && (NOT_NOW[unsafe] || 'The Lead cannot take a prompt right now. Try again in a moment.'));
  if (why) return [409, { ok: false, error: 'not_now', message: why }];
  t.refresh = { run: ++refreshRuns, phase: 'notes', sessionId: t.sessionId, startedAt: Date.now(), sawWork: false };
  t.refreshTimer = setTimeout(() => { if (t.refresh) endRefresh(t, 'The refresh took more than ' + leadRefresh.LIMIT_MS / 60000 + ' minutes, so it stopped. Look at the Lead.', false); }, leadRefresh.LIMIT_MS);
  typeForRefresh(t, leadRefresh.NOTES_PROMPT, () => {});
  return [200, { ok: true, refresh: 'notes' }];
}
// The person can stop a refresh at any step. What was typed stays typed.
function stopRefresh(channel) {
  const t = [...termsOf(channel).values()].find((x) => x.refresh);
  if (!t) return [409, { ok: false, error: 'no_refresh', message: 'No refresh is running.' }];
  const r = t.refresh;
  // The session id changes when /clear takes effect, so that, not the step, says whether it went in.
  const cleared = t.sessionId !== r.sessionId;
  const where = cleared ? 'after /clear, before it read its notes back. Ask it to read ' + leadRefresh.NOTES
    : r.phase === 'notes' ? 'before /clear went in, so the Lead has its old conversation' : 'before /clear went in, so the Lead has its old conversation and its notes are written';
  endRefresh(t, 'You stopped the refresh ' + where + '.', false);
  return [200, { ok: true, refresh: null }];
}
function endRefresh(t, text, ok) {
  clearTimeout(t.refreshTimer);
  t.refresh = null;
  t.refreshNote = { text, ok, at: new Date().toISOString() };
  console.log('Refresh the Lead: ' + text);
}
// Types once it is safe, as often as it takes, while the refresh lasts. A prompt the person sends
// meanwhile is answered first.
function typeForRefresh(t, text, then) {
  t.refresh.typing = true;
  const run = t.refresh.run, mine = () => !!t.refresh && t.refresh.run === run;
  const timer = setInterval(() => {
    if (!mine() || !t.lead) { clearInterval(timer); if (mine()) endRefresh(t, 'It is no longer the Lead, so the refresh stopped.', false); return; }
    if (notSafeToType(t)) return;
    clearInterval(timer);
    typeIfSafe(t, text, () => mine() && !!t.lead, (problem) => {
      if (!mine()) return;
      if (problem) { typeForRefresh(t, text, then); return; }
      t.refresh.typing = false;
      then();
    });
  }, 300);
}
function advanceRefresh(t) {
  if (t.refresh.typing) return;
  const out = leadRefresh.step(t.refresh, refreshView(t), Date.now());
  if (out.act === 'fail') { endRefresh(t, out.reason, false); return; }
  t.refresh = Object.assign(out.next, { typing: false });
  if (out.act === 'clear') typeForRefresh(t, '/clear', () => {});
  else if (out.act === 'read') typeForRefresh(t, leadRefresh.READ_PROMPT, () => endRefresh(t, 'The Lead is fresh. It is reading its notes back now.', true));
}

// ---------- an automatic reviewer gives its desk back once it has posted ----------
// Only a session relay/checkouts.js started for a PR (t.reviewOf): an automatic reviewer, or Get a
// review on a session with a PR. Get a review in a folder, Devs, the PM and every other session never end
// this way. The sign is in the hooks: a PostToolUse that says the post
// worked, for this PR, and then Stop. A failed post, a post to another PR, or no hooks at all, and it
// stays. After Stop it waits REVIEW_GRACE. Nothing the relay types goes into it once it has posted
// (notSafeToType), and a huddle does not ask it. A prompt the relay typed before that, or a task notice
// (its own background command ending), only pauses the wait until the next Stop. A key or a prompt from
// the person keeps it until they stop it, or until it posts again and that turn ends. Its verdict stays
// linked to the post either way (relay/autopilot.js).
const REVIEW_GRACE = () => config.get('reviewGraceSeconds') * 1000;
const FINISHED_KEPT = 10, RELAY_PROMPT_MS = 10 * 1000;
const finished = new Map();  // channel -> the latest reviewers that ended this way, newest first
function finishedOf(channel) { return finished.get(channel) || []; }
function postedHere(t, posted) {
  const m = String(t.reviewOf).match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
  // A post that names no repo could have gone to another one, through GH_REPO or another folder, so it does not count.
  return !!(m && posted && posted.repo && Number(posted.pr) === Number(m[2]) && String(posted.repo).toLowerCase() === m[1].toLowerCase());
}
function noteReview(channel, t, name, ev) {
  if (name === 'PostToolUse' && postedHere(t, ev.posted)) {
    const url = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#issuecomment-\d+$/.test(ev.posted.url || '') ? ev.posted.url : t.reviewOf;
    t.posted = { kind: ['comment', 'review', 'approve', 'request-changes'].includes(ev.posted.kind) ? ev.posted.kind : 'review', url };
    console.log('The review of ' + t.reviewOf + ' is posted. Its session ends ' + REVIEW_GRACE() / 1000 + ' seconds after its turn does.');
    tell(reviewPostedFns, channel, t, 'After a review was posted');
  } else if (name === 'UserPromptSubmit') {
    // The relay typed it if that was in the last RELAY_PROMPT_MS. A hook that never came does not make a later prompt the relay's.
    // A task notice is the session's own background command ending. Neither is the person.
    const relays = Date.now() - (t.relayTyped || 0) < RELAY_PROMPT_MS;
    if (ev.notice === true) { pauseReview(t); return; }
    t.relayTyped = 0;
    if (relays) pauseReview(t);
    else { if (t.posted) console.log('The review of ' + t.reviewOf + ' got a prompt that was not the relay\'s, so it stays.'); keepReviewer(t); }
  } else if (name === 'Stop' && !t.posted) tell(turnEndFns, channel, t, 'After a review\'s turn ended');
  else if (name === 'Stop' && !t.ending && !t.exited) t.ending = setTimeout(() => { t.ending = null; reviewDone(channel, t); }, REVIEW_GRACE());
}
function tell(fns, channel, t, what) { for (const fn of fns) { try { fn(channel, t); } catch (e) { console.error(what + ': ' + e.message); } } }
function pauseReview(t) { clearTimeout(t.ending); t.ending = null; }
// The person is talking to it, so it stays until they stop it, or until it posts again and its turn ends.
function keepReviewer(t) { pauseReview(t); t.posted = null; }
// relay/autopilot.js keeps each reviewer's verdict against its post. It is told of a post as the hook
// reports it (onReviewPosted), of a turn that ended with no post seen, so it can look on the PR
// (onReviewTurnEnd), and of each posted review just before its session ends (onReviewDone).
const reviewDoneFns = [], reviewPostedFns = [], turnEndFns = [];
const onReviewDone = (fn) => { reviewDoneFns.push(fn); };
const onReviewPosted = (fn) => { reviewPostedFns.push(fn); };
const onReviewTurnEnd = (fn) => { turnEndFns.push(fn); };
// The one place a posted review ends. T-4 can call it on approval, and choose what changes requested does.
function reviewDone(channel, t) {
  if (t.exited || t.stopped || !t.posted) return;
  const list = finishedOf(channel);
  list.unshift({ id: t.id, title: t.title, pr: t.reviewOf, kind: t.posted.kind, url: t.posted.url, at: new Date().toISOString() });
  finished.set(channel, list.slice(0, FINISHED_KEPT));
  console.log('The review of ' + t.reviewOf + ' was posted, so its session is ending: ' + t.posted.url);
  tell(reviewDoneFns, channel, t, 'After a posted review');
  stop(t);
}
function stop(t) {
  if (t.exited) return;
  t.stopped = true; t.io.hangup(); setTimeout(() => { if (!t.exited) t.io.kill('SIGTERM'); }, 1500);
}

// Who hears that a session ended: relay/coo.js counts the crashes.
const enders = [];
const onEnd = (fn) => { enders.push(fn); };
// Who hears the name of a session: relay/ticket-history.js keeps it against the session id.
let namer = null;
const onNamed = (fn) => { namer = fn; };
// Who hears that a terminal's session moved to a new id, by /clear or /resume: relay/ticket-history.js
// gives a reviewer a new step for it.
const movers = [];
const onSessionMoved = (fn) => { movers.push(fn); };

// Whether the global hooks run this relay's office-hook.js, and the command that fixes it when not.
// The command names the key only as a placeholder: the page must never show the key.
function hookCheckoutInfo() {
  const c = hook.hookCheckout();
  const root = path.dirname(path.dirname(c.own));
  const dir = /^[\w@%+=:,./-]+$/.test(root) ? root : "'" + root.replace(/'/g, "'\\''") + "'";
  return Object.assign(c, { fix: c.match ? null : 'cd ' + dir + ' && RELAY_KEY=<your relay key> npm run office:hooks' });
}

// Routes under /channels/{channel}/terminals. Returns true when it answered.
// Who may say no to opening or typing into a session: relay/games.js, for the seats of a round.
// fn (channel, t, verb) gives the reason, or null.
let guarded = null;
const guard = (fn) => { guarded = fn; };
async function handle(req, res, channel, rest, ctx) {
  const route = rest.match(/^\/terminals(?:\/([0-9a-f]{12})(?:\/(stream|input|resize|stop))?)?$/);
  const isLead = rest === '/terminals/lead', isFailed = rest === '/terminals/failed', isContext = rest === '/terminals/context';
  if (!route && !isLead && !isFailed && !isContext) { if (!/^\/terminals(\/|$)/.test(rest)) return false; ctx.problem(res, 404, 'not_found', 'Unknown terminal route.'); return true; }
  const deny = localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (!ENABLED) {
    if (req.method === 'GET' && rest === '/terminals') { ctx.send(res, 200, { ok: true, enabled: false, home: os.homedir(), message: 'Start the relay with npm run office (or RELAY_TERMINAL=1 npm run relay) to run Claude Code here.' }); return true; }
    ctx.problem(res, 404, 'terminal_off', 'The terminal is off. Start the relay with npm run office, or with RELAY_TERMINAL=1.'); return true;
  }
  if (isFailed) {  // { sessionId }: forget one that could not come back
    if (req.method !== 'POST') { ctx.problem(res, 404, 'not_found', 'Unknown terminal route.'); return true; }
    forgetFailed(channel, String((await ctx.readJson(req)).sessionId || '')); saveSessions();
    ctx.send(res, 200, { ok: true, failed: failedOf(channel) }); return true;
  }
  if (isContext) {
    if (req.method !== 'POST') { ctx.problem(res, 404, 'not_found', 'Unknown terminal route.'); return true; }
    const [status, out] = noteContext(ctx.agent, await ctx.readJson(req));
    ctx.send(res, status, out); return true;
  }
  if (isLead) {
    if (req.method !== 'POST') { ctx.problem(res, 404, 'not_found', 'Unknown terminal route.'); return true; }
    const [status, out] = setLead(channel, await ctx.readJson(req));
    ctx.send(res, status, out); return true;
  }
  const terms = termsOf(channel), [, id, verb] = route;
  if (!id) {
    if (req.method === 'GET') { ctx.send(res, 200, { ok: true, enabled: true, home: os.homedir(), cwd: process.cwd(), hooksInstalled: hook.hooksInstalled(), hookCheckout: hookCheckoutInfo(), terminals: [...terms.values()].map(info), lead: leads.get(channel) || null, restore: restoreOf(channel), finished: finishedOf(channel), failed: failedOf(channel), wipLimit: wipLimit() }); return true; }
    if (req.method === 'POST') { const r = start(channel, await ctx.readJson(req), ctx); ctx.send(res, r.status, r.body); return true; }
    ctx.problem(res, 404, 'not_found', 'Unknown terminal route.'); return true;
  }
  const t = terms.get(id);
  if (!t) { ctx.problem(res, 404, 'no_terminal', 'No such session on this channel.'); return true; }
  const refused = guarded ? guarded(channel, t, verb) : null;
  if (refused) { ctx.problem(res, 403, 'held', refused); return true; }
  if (req.method === 'GET' && verb === 'stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    sse(res, 'hello', info(t));
    flushOut(t);
    if (t.out.length) sse(res, 'out', Buffer.concat(t.out).toString('base64'));
    if (t.exited) sse(res, 'exit', { code: t.exitCode, stopped: !!t.stopped });
    t.viewers.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); t.viewers.delete(res); });
    return true;
  }
  if (req.method === 'POST' && verb === 'input') {
    const body = await ctx.readJson(req);
    if (t.exited) { ctx.problem(res, 409, 'ended', 'That session has ended.'); return true; }
    if (typeof body.data === 'string' && body.data) {
      t.io.write(body.data);
      // talked says whether the current session has a conversation, and depends on hooks reaching this
      // relay. spoke says whether one could ever have begun: Enter was pressed, or a hook heard a prompt.
      if (/[\r\n]/.test(body.data)) t.spoke = true;
      t.typedAt = Date.now();
      noteTyping(t, body.data);
      // Any key counts, but not the focus and cursor reports xterm sends by itself.
      // eslint-disable-next-line no-control-regex -- what is left of an escape code is a bare Esc
      if (/[^\x1b]/.test(body.data.replace(X10_MOUSE, '').replace(ANSI, ''))) {
        t.keyedAt = Date.now();  // a real key: the COO stays for a person who talks to it after its report (relay/coo.js)
        if (t.reviewOf) keepReviewer(t);
      }
    }
    ctx.send(res, 200, { ok: true }); return true;
  }
  if (req.method === 'POST' && verb === 'resize') {
    const body = await ctx.readJson(req);
    const cols = Math.min(400, Math.max(20, Number(body.cols) || 0)), rows = Math.min(200, Math.max(5, Number(body.rows) || 0));
    if (!t.exited) { t.io.resize(cols, rows); t.cols = cols; t.rows = rows; saveSessions(); }
    ctx.send(res, 200, { ok: true, cols, rows }); return true;
  }
  if (req.method === 'POST' && verb === 'stop') {
    t.stoppedBy = ctx.agent ? 'Lead' : 'you';  // the COO counts a stop by the person (relay/coo.js)
    stop(t);
    ctx.send(res, 200, { ok: true }); return true;
  }
  ctx.problem(res, 404, 'not_found', 'Unknown terminal route.');
  return true;
}

// The relay is stopping. Its sessions run on in the host, and the saved list says what they are, so the
// next relay takes them back, or brings them back with claude --resume if the host stopped too.
// A relay that never saved, such as the demo's with RELAY_RESUME=0, leaves the list for the next one.
function close() { if (savedText !== null) saveSessions(); closing = true; link.close(); }
// Connects to the session host, before the relay brings back its sessions. If the host stops while
// the relay runs, every session has ended with it, so the relay restarts, and the next one brings them
// back with claude --resume. The supervisor starts a new host first. A relay with no supervisor cannot
// restart, so it stops, and says to start it again.
async function connectHost(log) {
  const supervised = process.env.RELAY_SUPERVISED === '1';
  link.onLost(() => {
    log('The session host stopped, so every session ended with it. ' + (supervised ? 'The relay restarts and brings them back.' : 'The relay stops. Start it again and they come back.'));
    closing = true; process.exit(supervised ? require('./supervisor.js').RESTART : 1);
  });
  await link.connect();
}
// Whether a saved session is still running in the host, for relay/sessions.js to say so.
function stillRunning(channel, saved) {
  const back = saved && saved.terminal ? link.peek(saved.terminal) : null;
  return !!(back && back.meta && back.meta.channel === channel);
}
// Once the restore is done, seats and names held for sessions that did not come back are free.
const dropUnclaimed = (log) => { held.clear(); heldNames.clear(); link.dropUnclaimed(log); };

// Whether a session on any channel is running in that folder or under it, so its checkout is not
// pulled away. Either path may have come through a symlink.
function real(p) { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } }
function runningIn(dir) {
  const want = real(dir);
  for (const terms of channels.values()) for (const t of terms.values()) {
    if (!t.exited && (real(t.cwd) === want || real(t.cwd).startsWith(want + path.sep))) return true;
  }
  return false;
}

// How full a session's context is, from its status line (relay/status-line.js), with its own token.
// It is kept with the session, for the conversation it names, and only for its own conversation.
function noteContext(t, body) {
  if (!t) return [403, { ok: false, error: 'forbidden', message: 'Only a session\'s own status line says how full its context is.' }];
  const sid = String((body && body.session_id) || '');
  // A session moved by a hook with only the short id keeps that, so the full id starts with it.
  if (!sid || !t.sessionId || !(sid === t.sessionId || (t.sessionId.length >= 12 && sid.startsWith(t.sessionId)))) return [409, { ok: false, error: 'other_session', message: 'That is not the conversation this session is in now.' }];
  const reading = leadTired.readingOf({ session_id: sid, context_window: { used_percentage: Number(body.percent), context_window_size: body.size } }, Date.now());
  if (!reading) return [400, { ok: false, error: 'bad_param', message: 'Send percent, the part of the context window used, 0 to 100.' }];
  t.context = Object.assign(reading, { sessionId: t.sessionId });
  return [200, { ok: true, tired: leadTired.tiredOf(t) }];
}

// The session a ticket token belongs to, or null. relay/server.js decides what it may reach.
function agentFor(req) {
  const token = req.headers['x-office-token'];
  if (typeof token !== 'string' || !token) return null;
  for (const terms of channels.values()) for (const t of terms.values()) if (t.token === token && !t.exited) return t;
  return null;
}

const all = (channel) => [...termsOf(channel).values()].filter((t) => !t.exited);
// Every running session on every channel.
const everyone = () => [...channels.values()].flatMap((terms) => [...terms.values()].filter((t) => !t.exited));

module.exports = { DESKS: MAX_TERMINALS, guard, setRoster, rebriefLead, startLead, holdSeats, handle, noteHook, onEnd, onNamed, onSessionMoved, onReviewDone, onReviewPosted, onReviewTurnEnd, onWork, workOfTerm, questionOnScreen, stop, holdWhileUpdating, owePrompt, failedIn, close, connectHost, stillRunning, dropUnclaimed, takeLastRun, bringingBack, markFailed, start, find, all, everyone, leadOf, notSafeToType, typeIfSafe, nudge, noteShown, expand, localOnly, agentFor, runningIn, useStart, ENABLED, wipLimit };
