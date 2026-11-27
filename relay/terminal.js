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
//
// redraw(t) makes a session draw its whole screen again, as a resize does. It widens the terminal by one
// column, and puts the width back at the next output, or after REDRAW_BACK. t.cols and t.rows do not change.
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
const KEEP = 256 * 1024;
const MAX_TERMINALS = 9;
const SEAT_DESKS = 2;
const WORKER_DESKS = MAX_TERMINALS - SEAT_DESKS;
const seated = (t) => !!(t.lead || t.standing || t.role === 'pm');
const workersOf = (channel) => all(channel).filter((t) => !t.exited && !seated(t)).length;
const OUT_BATCH = Number(process.env.RELAY_OUT_BATCH_MS) >= 1 ? Number(process.env.RELAY_OUT_BATCH_MS) : 16;
const config = require('./config.js');
const wipLimit = () => config.get('wipLimit');
const TAIL = 16 * 1024, SETTLED = 1500, AFTER_TRUST = 400;
const { claim } = require('./lockfile.js');
const sessionEnv = require('./session-env.js');
const seatBoundary = require('./seat-boundary.js');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const channels = new Map();
function termsOf(channel) {
  if (!channels.has(channel)) channels.set(channel, new Map());
  return channels.get(channel);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const LOCAL_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function localOnly(req, port) {
  const cf = require('./cf-access.js');
  const site = req.headers['sec-fetch-site'];
  if (!LOCAL_ADDRS.has(req.socket.remoteAddress)) return 'The terminal only answers this computer.';
  if (cf.ownerHere(req)) return site && site !== 'same-origin' && site !== 'none' ? 'The terminal only answers the room page served by this relay.' : null;
  if (cf.CF_HEADERS.some((h) => req.headers[h] !== undefined)) return 'The terminal does not answer through a tunnel.';
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) return 'The terminal only answers http://localhost:' + port + ', not ' + host + '.';
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let o; try { o = new URL(origin); } catch (e) { return 'Bad Origin.'; }
    if (!LOCAL_HOSTS.has(o.hostname) || String(o.port || 80) !== String(port)) return 'The terminal only answers the room page served by this relay.';
  }
  if (site && site !== 'same-origin' && site !== 'none') return 'The terminal only answers the room page served by this relay.';
  return null;
}
function expand(dir) {
  const d = String(dir || '~').trim() || '~';
  return path.resolve(d === '~' ? os.homedir() : d.startsWith('~/') ? path.join(os.homedir(), d.slice(2)) : d);
}
function find(channel, id) { return id ? termsOf(channel).get(id) || null : null; }

const { seatAll, nameAll, plainName } = require('./seats.js');
let roster = [], pool = {};
const NAME = /^[A-Za-z][A-Za-z'-]{0,23}$/;
function setRoster(r) {
  const people = r && r.lead ? [Object.assign({}, r.lead, { lead: true })].concat((r.workers || []).slice(0, MAX_TERMINALS - 1)) : [];
  roster = people.filter((p) => p && typeof p.id === 'string').map((p, i) => ({ id: p.id, name: plainName(p.name) || plainName(p.id) || 'Desk ' + (i + 1), lead: !!p.lead, kind: typeof p.kind === 'string' ? p.kind : null }));
  const seen = new Set(roster.map((p) => p.name.toLowerCase()).concat('lead'));
  pool = {};
  for (const [kind, list] of Object.entries((r && r.names) || {})) {
    pool[kind] = (Array.isArray(list) ? list : []).filter((n) => typeof n === 'string' && NAME.test(n) && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
  }
}
const NAMES_FILE = state.file('names.json', 'RELAY_NAMES_FILE');
const NAME_SEED = state.dir();
let used = null;
const inUse = new Map();
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
const held = new Map();
const heldNames = new Map();
function holdSeats(channel, list) {
  const m = {}, n = {};
  for (const s of list) {
    if (s && s.seat && s.sessionId) m['saved ' + s.sessionId] = s.seat;
    if (s && typeof s.who === 'string' && s.sessionId) n['saved ' + s.sessionId] = s.who;
  }
  held.set(channel, m); heldNames.set(channel, n);
}
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
  for (const n of inUse.get(channel) || []) if (!names.has(n) && isPooled(n)) { record[n] = now; stamped = true; }
  inUse.set(channel, names);
  if (stamped) saveNames();
  if (moved) saveSessions();
}
const isPooled = (n) => Object.values(pool).some((list) => list.includes(n));
let describeWork = null;
const onWork = (fn) => { describeWork = fn; };
const workOfTerm = (t) => (describeWork ? describeWork(t.channel, t) : null);
const customTitleOf = (v) => (typeof v === 'string' && v.replace(/\s+/g, ' ').trim().slice(0, 60)) || null;
function info(t) {
  return { id: t.id, who: t.who || null, seat: t.seat || null, cwd: t.cwd, from: t.from, project: hook.projectOf(t.cwd), sessionId: t.sessionId, title: t.title, customTitle: t.customTitle || null, task: t.task, role: t.role, pr: t.pr, work: describeWork ? describeWork(t.channel, t) : null, talked: t.talked, lead: !!t.lead, standing: !!t.standing, owesBrief: !!t.owesBrief, briefHeld: !!(t.owesBrief && briefHeld(t)), hooksSilent: !!(t.spoke && !t.hooked), board: !!t.board, merge: !!t.merge, starts: t.starts || 0, startsLeft: t.startsLeft || 0, lastStart: t.lastStart || null, startedAt: t.startedAt, running: !t.exited, exitCode: t.exitCode, hooks: t.hooks, state: t.state, message: t.message, lastActAt: t.lastActAt, replay: t.outSize, refresh: t.refresh ? t.refresh.phase : null, refreshNote: t.refreshNote || null, tired: leadTired.tiredOf(t), round: t.round || null };
}

const LEAD_FILE = state.file('lead.json', 'RELAY_LEAD_FILE');
let leads = new Map();
try { leads = new Map(Object.entries(JSON.parse(fs.readFileSync(LEAD_FILE, 'utf8')))); } catch (e) { leads = new Map(); }
const offered = new Map(leads);
const ownsLeadFile = claim(LEAD_FILE);
function saveLeads() {
  if (!ownsLeadFile) return;
  fs.mkdirSync(path.dirname(LEAD_FILE), { recursive: true });
  const tmp = LEAD_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(leads), null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, LEAD_FILE);
}
const LEAD_STOP_SAYS = 'That session is the Lead, so it was not stopped. A stop loses its turn in progress, and it comes back as the Lead only with Bring back. To make a slow Lead fresh, use Refresh the Lead. To stop it anyway, send lead: true.';
const ENDED_SAYS = { stopped: 'The Lead\'s session was stopped.', ended: 'The Lead\'s session ended.', crashed: 'The Lead\'s session ended with an error.' };
function offerBack(channel, t, code) {
  const saved = leads.get(channel);
  if (closing || !saved || saved.sessionId !== t.sessionId) return;
  offered.set(channel, Object.assign({}, saved, { ended: t.stopped ? 'stopped' : code ? 'crashed' : 'ended', exitCode: t.stopped ? null : code, endedAt: new Date().toISOString() }));
}
function leadEndedOf(channel) {
  const offer = !leadOf(channel) && restoreOf(channel);
  if (!offer || !offer.ended) return null;
  return { ended: offer.ended, sessionId: offer.sessionId, title: offer.title || null, endedAt: offer.endedAt, says: ENDED_SAYS[offer.ended] + ' No session is the Lead now. Its handoff notes are kept. Bring back as the Lead, on the page, returns it.' };
}
function leadIn(dir) {
  const want = real(dir), inside = (cwd) => !!cwd && (real(cwd) === want || real(cwd).startsWith(want + path.sep));
  for (const saved of leads.values()) if (inside(saved.cwd)) return true;
  for (const terms of channels.values()) for (const t of terms.values()) if (t.lead && inside(t.cwd)) return true;
  return false;
}
function restoreOf(channel) {
  const lead = offered.get(channel);
  return lead && !leadOf(channel) && ![...termsOf(channel).values()].some((t) => t.sessionId === lead.sessionId) ? lead : null;
}
function leadOf(channel) {
  return [...termsOf(channel).values()].find((t) => !t.exited && t.lead) || null;
}
function clearSavedGrants(channel) {
  const saved = leads.get(channel);
  if (saved && (saved.board || saved.starts || saved.merge)) { saved.board = false; saved.merge = false; saved.starts = 0; saved.startsLeft = 0; saveLeads(); }
}
const MAX_TOTAL = 20;
function startsProblem(n) {
  if (wipLimit() < 2) return 'The WIP limit is ' + wipLimit() + ', so there is no room under it for the Lead to start tickets. Raise the WIP limit in Settings first.';
  if (!Number.isInteger(n) || n < 1 || n >= wipLimit()) return 'Let the Lead start while fewer than 1' + (wipLimit() > 2 ? ' to ' + (wipLimit() - 1) : '') + ' tasks are building. It has to stay under the WIP limit of ' + wipLimit() + '.';
  return null;
}
function totalProblem(n) {
  return Number.isInteger(n) && n >= 1 && n <= MAX_TOTAL ? null : 'Give the Lead a total of 1 to ' + MAX_TOTAL + ' starts. The permission turns off when it has used them.';
}
const keptStarts = (g) => (g && !startsProblem(Number(g.starts)) && !totalProblem(Number(g.startsLeft)) ? { starts: Number(g.starts), startsLeft: Number(g.startsLeft) } : { starts: 0, startsLeft: 0 });
function useStart(channel, t, ticket) {
  t.startsLeft = Math.max(0, (t.startsLeft || 0) - 1);
  if (!t.startsLeft) t.starts = 0;
  t.lastStart = { ticket: ticket.id, title: ticket.title, at: new Date().toISOString(), left: t.startsLeft };
  if (t.lead && t.talked && UUID.test(t.sessionId)) { try { saveLead(channel, t); } catch (e) { console.error('Could not save the Lead: ' + e.message); } }
  saveSessions();
}
const { leadBrief } = require('./lead-brief.js');
const skills = require('./skills.js');
const delivery = () => require('./delivery.js');
const BRIEF_KEY = 'lead-brief', NOT_LEAD_KEY = (t) => 'no-longer-lead ' + t.id;
const NO_LONGER_LEAD = 'You are no longer the Lead of this room. Never merge a pull request: merging stays with the person.';
function tellNoLongerLead(channel, t) {
  delivery().save(channel, { key: NOT_LEAD_KEY(t), terminal: t.id, sessionId: t.sessionId, text: NO_LONGER_LEAD,
    on: (what, why) => { if (what !== 'delivered') console.log('A replaced Lead was not told it may no longer merge: ' + why); } });
}
const briefHeld = (t) => t.state !== 'idle' || (t.spoke && !t.hooked);
const autopilotOn = (channel) => require('./autopilot.js').isOn(channel);
function briefLead(channel, t) {
  t.owesBrief = true;
  delivery().save(channel, { key: BRIEF_KEY, to: 'lead', terminal: t.id, sessionId: t.sessionId, first: true, text: (leadBrief(__dirname, { merge: !!t.merge, autopilot: autopilotOn(channel), order: !!config.get('leadOrder'), unstick: !!config.get('leadUnstick') }) + skills.brief('lead') + require('./rules.js').brief()).trim(), on: (what, why) => {
    t.owesBrief = false; saveSessions();
    if (what !== 'delivered') { console.error('The Lead was not briefed: ' + why); return; }
    if (t.lead && UUID.test(t.sessionId)) { try { saveLead(channel, t); } catch (e) { console.error('Could not save the Lead: ' + e.message); } }
  } });
}
function rebriefLead(channel) {
  const t = leadOf(channel);
  if (t && !t.exited) briefLead(channel, t);
}
config.onChange((names) => { if (names.includes('leadOrder') || names.includes('leadUnstick')) for (const channel of channels.keys()) rebriefLead(channel); });
const SESSIONS_FILE = state.file('sessions.json', 'RELAY_SESSIONS_FILE');
let lastRun = {};
try { lastRun = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch (e) { lastRun = {}; }
const ownsSessionsFile = claim(SESSIONS_FILE);
let closing = false, savedText = null;
function keepOf(t) {
  return { sessionId: t.sessionId, seat: t.seat || undefined, who: t.who || undefined, talked: !!t.talked, cwd: t.cwd, from: t.from, title: t.title, customTitle: t.customTitle || undefined, task: t.task, role: t.role, pr: t.pr,
    lead: !!t.lead, standing: t.standing || undefined, board: !!t.board, merge: !!t.merge, starts: t.starts || 0, startsLeft: t.startsLeft || 0, owesBrief: !!t.owesBrief, owesPrompt: t.owesPrompt || undefined, reviewOf: t.reviewOf || undefined, round: t.round || undefined, posted: t.posted || undefined, cols: t.cols, rows: t.rows,
    terminal: t.id, state: t.state, message: t.message || undefined, waitingAt: t.state === 'waiting' ? t.waitingAt : undefined, hooked: !!t.hooked, heard: !!t.heard, spoke: !!t.spoke, hookAt: t.hookAt || undefined, actAt: t.lastActAt || undefined };
}
const FAIL_WITHIN = 10 * 1000, MAX_TRIES = 3;
const failed = new Map();
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
function failedIn(dir) {
  const want = real(dir);
  for (const list of failed.values()) for (const f of list) if (f.cwd && (real(f.cwd) === want || real(f.cwd).startsWith(want + path.sep))) return true;
  return false;
}
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
function takeLastRun() { const out = ownsSessionsFile ? lastRun : {}; lastRun = {}; return out; }

function saveLead(channel, t) {
  leads.set(channel, { sessionId: t.sessionId, cwd: t.cwd, title: t.title || null, board: !!t.board, merge: !!t.merge, starts: t.starts || 0, startsLeft: t.startsLeft || 0, savedAt: new Date().toISOString() });
  saveLeads();
}
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
  delivery().drop(channel, NOT_LEAD_KEY(t));
  for (const other of termsOf(channel).values()) { if (other !== t) other.owesBrief = false; other.lead = other === t; other.board = other === t && board; other.merge = other === t && merge; other.starts = other === t ? starts : 0; other.startsLeft = other === t ? startsLeft : 0; }
  reseat(channel);
  if (t.talked) saveLead(channel, t); else clearSavedGrants(channel);
  if (isNew || mergeChanged) briefLead(channel, t);
  saveSessions();
  return [200, { ok: true, lead: true, board, merge, starts, startsLeft }];
}
function startLead(channel, cwd, ctx) {
  if (leadOf(channel)) return;
  if (updating()) { ctx.log('No Lead started on ' + channel + ': an update is under way.'); return; }
  const offer = restoreOf(channel);
  offered.delete(channel);
  const startNew = (why) => {
    if (leadOf(channel) || closing) return;
    offered.delete(channel);
    const r = start(channel, { cwd }, ctx, null, { newLead: true });
    ctx.log(r.status < 400 ? why + 'Started a new Lead in ' + cwd + ' on ' + channel + '.' : why + 'Could not start a Lead on ' + channel + ': ' + r.body.message);
  };
  if (!offer) { startNew(''); return; }
  const who = 'the saved Lead (' + String(offer.sessionId).slice(0, 8) + ')';
  const r = start(channel, { cwd: offer.cwd, resume: offer.sessionId, lead: true }, ctx, (t) => {
    if (!t.stopped && !closing && t.exitCode !== 0 && !t.typedAt && Date.now() - Date.parse(t.startedAt) < FAIL_WITHIN) startNew('Could not bring back ' + who + ': it ended at once. ');
  });
  if (r.status >= 400) { startNew('Could not bring back ' + who + ': ' + r.body.message + ' '); return; }
  ctx.log('Brought back ' + who + ' as the Lead on ' + channel + '.');
}
function sse(res, event, data) { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }

function start(channel, body, ctx, onExit, own) {
  const kept = own && own.kept;
  const terms = termsOf(channel), running = [...terms.values()].filter((t) => !t.exited);
  const seat = !!(own && (own.standing || own.newLead || (kept && (kept.lead || kept.standing)))) || (body.lead === true && !!body.resume) || body.role === 'pm';
  if (running.length >= MAX_TERMINALS) return { status: 409, body: { ok: false, error: 'full', message: 'All ' + MAX_TERMINALS + ' desks are taken. Stop a session first.' } };
  if (!seat && running.filter((t) => !seated(t)).length >= WORKER_DESKS) return { status: 409, body: { ok: false, error: 'full', message: 'All ' + WORKER_DESKS + ' worker desks are taken. The other ' + SEAT_DESKS + ' are kept for the Lead and the PM. Stop a session first.' } };
  const resume = body.resume ? String(body.resume).trim() : '';
  if (resume && !UUID.test(resume)) return { status: 400, body: { ok: false, error: 'bad_session', message: 'A session id looks like b299ee24-0c4c-4507-afb7-bb2625eeb192.' } };
  if (resume && running.some((t) => t.sessionId === resume)) return { status: 409, body: { ok: false, error: 'running', message: 'That session is already running here.' } };
  const cwd = expand(body.cwd);
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error(); } catch (e) {
    return { status: 400, body: { ok: false, error: 'bad_folder', message: 'There is no folder ' + cwd + '.' } };
  }
  const back = restoring && restoring.terminal ? link.peek(restoring.terminal) : null;
  const adopted = back && back.meta && back.meta.channel === channel ? restoring : null;
  if (!adopted && !link.isReady()) return { status: 503, body: { ok: false, error: 'no_host', message: 'The session host is not running yet. Try again in a moment.' } };
  const cols = adopted ? back.cols : Math.min(400, Math.max(20, Number(body.cols) || 120)), rows = adopted ? back.rows : Math.min(200, Math.max(5, Number(body.rows) || 32));
  const sessionId = adopted ? adopted.sessionId : resume || crypto.randomUUID();
  const id = adopted ? adopted.terminal : crypto.randomBytes(6).toString('hex');
  const token = adopted ? back.meta.token : crypto.randomBytes(16).toString('hex');
  const global = hook.hooksInstalled();
  const saved = leads.get(channel);
  const fresh = !!(own && own.newLead && !resume && !body.task && !body.role && !running.some((x) => x.lead));
  const lead = fresh || (kept ? !!(kept.lead && !body.task && !body.role && !running.some((x) => x.lead))
    : !!(body.lead === true && resume && !body.task && !body.role && saved && saved.sessionId === resume && !running.some((x) => x.lead)));
  const board = !!(lead && !fresh && (kept ? kept.board : saved.board)), merge = !!(lead && !fresh && (kept ? kept.merge : saved.merge));
  const { starts, startsLeft } = lead && !fresh ? keptStarts(kept || saved) : keptStarts(null);
  if (lead && kept) offered.delete(channel);
  if (fresh) clearSavedGrants(channel);
  if (resume) forgetFailed(channel, resume);
  const talked = adopted ? !!adopted.talked : !!resume;
  const t = { id, channel, cwd, from: body.from || null, title: body.title ? String(body.title).slice(0, 80) : null, task: body.task || null, role: body.role || null, pr: body.pr || null, token, lead, standing: !!(own && own.standing) || !!(kept && kept.standing), board, merge, starts, startsLeft, talked, spoke: adopted ? !!(adopted.spoke || adopted.talked) : talked, state: 'idle', message: null, drafting: false, sinceKey: null, lastEnterAt: 0, lastActAt: Date.now(), lastOutAt: 0, tail: '', sessionId, startedAt: new Date().toISOString(), hooks: global ? 'global' : 'session', cols, rows,
    io: null, out: [], outSize: 0, viewers: new Set(), exited: false, exitCode: null, pendingOut: [], flush: null, reviewOf: (own && own.reviewOf) || null, round: (own && own.round) || null, posted: null, ending: null };
  if (restoring && resume && !adopted) { t.restoredAt = Date.now(); t.tries = restoring.tries || 0; }
  if (restoring) {
    t.seat = typeof restoring.seat === 'string' ? restoring.seat : null;
    t.who = typeof restoring.who === 'string' ? plainName(restoring.who) || null : null;
    t.customTitle = customTitleOf(restoring.customTitle);
    const h = held.get(channel), n = heldNames.get(channel);
    if (h) delete h['saved ' + restoring.sessionId];
    if (n) delete n['saved ' + restoring.sessionId];
  }
  if (adopted) { t.state = ['working', 'waiting'].includes(adopted.state) ? adopted.state : 'idle'; t.message = adopted.message || null; if (t.state === 'waiting') t.waitingAt = adopted.waitingAt || Date.now(); t.hooked = !!adopted.hooked; t.heard = !!adopted.heard; t.hookAt = Number(adopted.hookAt) || 0; t.lastActAt = Number(adopted.actAt) || t.hookAt || t.lastActAt; }
  if (kept && kept.posted && t.reviewOf) {
    t.posted = kept.posted;
    t.ending = setTimeout(() => { t.ending = null; reviewDone(channel, t); }, REVIEW_GRACE());
  }
  terms.set(id, t);
  if (adopted && t.reviewOf && !t.posted) tell(reviewBackFns, channel, t, 'After a reviewer was taken back');
  reseat(channel);
  const emitOut = (buf) => {
    t.out.push(buf); t.outSize += buf.length;
    t.lastOutAt = Date.now(); t.tail = (t.tail + buf.toString('latin1')).slice(-TAIL);
    if (t.redrawing) widthBack(t);
    if (t.sinceKey !== null) t.sinceKey = (t.sinceKey + buf.toString('latin1')).slice(-TAIL);
    while (t.outSize > KEEP && t.out.length > 1) t.outSize -= t.out.shift().length;
    t.pendingOut.push(buf);
    if (!t.flush) t.flush = setTimeout(() => flushOut(t), OUT_BATCH);
  };
  const ended = (code) => {
    t.exited = true; t.exitCode = t.stopped ? null : code;
    reseat(channel);
    keepReviewer(t);
    if (t.refresh) endRefresh(t, 'The Lead\'s session ended before the refresh finished.', false);
    if (t.lead) offerBack(channel, t, code);
    setTimeout(() => {
      flushOut(t);
      for (const v of t.viewers) sse(v, 'exit', { code: t.exitCode, stopped: !!t.stopped });
      terms.delete(id);
    }, 30);
    ctx.log('Claude Code in ' + cwd + (t.stopped ? ' was stopped' : ' ended (' + code + ')'));
    if (t.restoredAt && !t.stopped && !closing && code !== 0 && !t.typedAt && Date.now() - t.restoredAt < FAIL_WITHIN) {
      markFailed(channel, Object.assign(keepOf(t), { sessionId: resume, talked: true, tries: t.tries }), 'it ended ' + Math.round((Date.now() - t.restoredAt) / 1000) + ' seconds after it was brought back, with exit code ' + code);
    }
    saveSessions();
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
    const role = skills.roleOf(body, own, lead);
    if (!resume) args.push(...skills.modelArgs(role));
    if (role) skills.notice(channel);
    const settings = { statusLine: STATUS_LINE };
    if (!global) settings.hooks = hook.hookSettings({ key: ctx.key, url: 'http://localhost:' + ctx.port, channel });
    args.push('--settings', JSON.stringify(settings));
    const env = sessionEnv.build(process.env, {
      ...sessionEnv.slotGate(process.env, state.dir()),
      OFFICE_TERMINAL_ID: id,
      OFFICE_CHANNEL: channel,
      OFFICE_PANEL_CHANNEL: channel,
      OFFICE_TICKET_TOKEN: token,
      OFFICE_TICKET_URL: 'http://localhost:' + ctx.port + '/channels/' + encodeURIComponent(channel) + '/tickets',
      // 127.0.0.1, not localhost: Node 18's fetch tries only ::1 for localhost.
      OFFICE_HOOK_URL: 'http://127.0.0.1:' + ctx.port + '/channels/' + encodeURIComponent(channel) + '/commands',
      ...(own && own.round ? { OFFICE_SEAT: '1', OFFICE_PLAY: path.join(__dirname, 'play.js') } : {})
    });
    if (own && own.round) { delete env.GAMES_REPO; delete env.GAMES_HOME; }
    const cmd = own && own.round ? seatBoundary.wrap([CLAUDE].concat(args), { seatDir: cwd, sessionId, stateDir: require('./state.js').dir() }) : [CLAUDE].concat(args);
    t.io = link.spawn({ id, cwd, env, cmd, cols, rows, meta: { channel, sessionId, token, cwd } }, { out: emitOut, exit: ended });
  }
  if (lead && (!kept || kept.owesBrief || (!resume && !adopted))) briefLead(channel, t);
  saveSessions();
  ctx.log(adopted ? 'Took back Claude Code in ' + cwd + ' for channel ' + channel + ', still running' : 'Claude Code started in ' + cwd + ' for channel ' + channel + ' (hooks: ' + t.hooks + ')');
  return { status: 201, body: Object.assign({ ok: true }, info(t)) };
}

const PROMPT = Buffer.from('❯').toString('latin1');
const { ENTER_SETTLES } = require('./stop-verdict.js');
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/, OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/, DCS = /\x1bP[^\x1b]*\x1b\\/;
const CHARSET = /\x1b[()][A-Za-z0-9]/, ANY_OTHER_ESCAPE = /\x1b./;
const ANSI = new RegExp([CSI, OSC, DCS, CHARSET, ANY_OTHER_ESCAPE].map((r) => r.source).join('|'), 'g');
const X10_MOUSE = /\x1b\[M[\s\S]{3}/g;
let updating = () => false, restarting = () => false, holding = () => false;
const holdWhileUpdating = (fns) => { ({ updating, restarting, holding } = fns); };
const heldForUpdate = (t, brief) => (brief === 'prompt' ? restarting() : holding() && !t.refresh);

function owePrompt(t, text) {
  t.owesPrompt = text || null;
  if (!closing) saveSessions();
}
const MENU = new RegExp('Entertoconfirm|Esctocancel|' + PROMPT + '\\d+\\.');
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

function questionOnScreen(t) {
  if (!t.heard && onTrustQuestion(screenOf(t))) return 'trust';
  if (MENU.test(screenOf({ tail: t.sinceKey === null ? t.tail : t.sinceKey }).slice(-AFTER_TRUST))) return 'menu';
  return null;
}

function notSafeToType(t, brief) {
  if (!t || t.exited || t.stopped) return 'ended';
  if (heldForUpdate(t, brief)) return 'restarting';
  if (t.posted) return 'leaving';
  if (t.state === 'working') return 'working';
  if (t.state === 'waiting') return 'waiting';
  if (t.spoke && !t.hooked) return 'no_hooks';
  if (t.owesBrief && !brief) return 'briefing';
  if (t.drafting) return 'typing';
  if (Date.now() - t.lastEnterAt < ENTER_SETTLES) return 'working';
  if (!t.lastOutAt || Date.now() - t.lastOutAt < SETTLED) return 'settling';
  const question = questionOnScreen(t);
  if (question) return question;
  return screenOf(t).includes(PROMPT) ? null : 'no_prompt';
}
const { asTyped } = require('./typed.js');
const CLEAR_PROMPT = '\x15';
// Enter after a pause, since a TUI takes text and Enter that arrive together as a paste.
const TYPE_SETTLE_DEFAULT = 300, TYPE_SETTLE_MAX = 60000;
function typeSettle(value) {
  const n = Number(value);
  return n >= 1 && n <= TYPE_SETTLE_MAX ? n : TYPE_SETTLE_DEFAULT;
}
const TYPE_SETTLE = typeSettle(process.env.RELAY_TYPE_SETTLE_MS);
function typeIfSafe(t, text, wanted, done, brief) {
  const first = notSafeToType(t, brief);
  if (first) { done(first); return; }
  t.io.write(asTyped(text));
  if (brief === 'prompt') t.typingFirst = true;
  setTimeout(() => {
    t.typingFirst = false;
    const second = t.exited || t.stopped ? 'ended' : heldForUpdate(t, brief) ? 'restarting' : t.state !== 'idle' ? t.state : t.drafting ? 'typing' : !wanted() ? 'dropped' : null;
    if (second) { if (!t.exited && !t.stopped) t.io.write(CLEAR_PROMPT); done(second); return; }
    t.io.write('\r'); t.spoke = true; t.relayTyped = Date.now(); t.lastEnterAt = Date.now(); t.sinceKey = '';
    done(null);
  }, TYPE_SETTLE);
}

const REDRAW_BACK = 1000;
function widthBack(t) {
  clearTimeout(t.redrawing); t.redrawing = null;
  if (!t.exited && !t.stopped) t.io.resize(t.cols, t.rows);
}
function redraw(t) {
  if (!t || t.exited || t.stopped || t.redrawing) return;
  t.redrawing = setTimeout(() => widthBack(t), REDRAW_BACK);
  t.io.resize(t.cols + 1, t.rows);
}

const NOTE_SEEN = 30;
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
  t.io.write(CLEAR_PROMPT);
  typeIfSafe(t, text, wanted, (p) => done(p, 'typed'), brief);
}

function noteTyping(t, data) {
  const plain = data.replace(ANSI, '');
  const enter = Math.max(plain.lastIndexOf('\r'), plain.lastIndexOf('\n'));
  if (t.state === 'waiting' && (enter >= 0 || /[^\x00-\x1f\x7f]/.test(plain))) t.answeredAt = Date.now();
  if (MENU.test(screenOf({ tail: t.sinceKey === null ? t.tail : t.sinceKey }).slice(-AFTER_TRUST))) { t.sinceKey = ''; return; }
  if (enter >= 0) { t.drafting = false; t.lastEnterAt = Date.now(); }
  if (enter >= 0 || plain.includes('\x1b')) t.sinceKey = '';
  if (/[^\x00-\x1f\x7f]/.test(plain.slice(enter + 1))) t.drafting = true;
  else if (/\x03|\x15/.test(plain)) t.drafting = false;
}

const QUESTION_KINDS = ['permission_prompt', 'elicitation_dialog'];
const asksQuestion = (ev) => ev.notification_type ? QUESTION_KINDS.includes(ev.notification_type) : !/waiting for your input|idle/i.test(ev.message || '');

function noteHook(channel, ev) {
  if (!ev || !ev.hook_event_name) return;
  const terms = [...termsOf(channel).values()];
  const name = ev.hook_event_name, sid = String(ev.session_id || '');
  if (name === 'SessionStart' && ev.terminal && ev.source && ev.source !== 'startup') {
    const moved = terms.find((t) => t.id === ev.terminal);
    if (moved && sid && !((Number(ev.at) || Date.now()) < (moved.hookAt || 0))) {
      moved.hooked = true;
      const was = moved.sessionId;
      moved.sessionId = UUID.test(ev.full_session_id || '') ? ev.full_session_id : sid; moved.talked = ev.source === 'resume' || (ev.source === 'compact' && moved.sessionId === was && moved.talked); if (!moved.task && !moved.role && !(ev.source === 'compact' && moved.sessionId === was)) moved.title = null;
      if ((moved.board || moved.starts || moved.merge) && moved.sessionId !== was) { try { clearSavedGrants(channel); } catch (e) { console.error('Could not save the Lead: ' + e.message); } }
      if (moved.sessionId !== was) { moved.state = 'idle'; moved.message = null; moved.customTitle = null; }
      if (moved.who && namer) namer(channel, moved);
      if (moved.sessionId !== was) for (const fn of movers) { try { fn(channel, moved, was); } catch (e) { console.error('Could not follow a new session: ' + e.message); } }
      if (moved.lead && (moved.sessionId !== was || ev.source === 'compact')) briefLead(channel, moved);
    }
  }
  const t = sid && terms.find((x) => x.sessionId.startsWith(sid));
  if (!t) return;
  const at = Number(ev.at) || Date.now();
  if (at < (t.hookAt || 0)) return;
  t.hookAt = at;
  t.hooked = true; t.lastActAt = Date.now();
  if (ev.title && !t.task && !t.role) t.title = ev.title;
  if (typeof ev.customTitle === 'string') t.customTitle = customTitleOf(ev.customTitle);
  if (name === 'UserPromptSubmit') t.talked = t.spoke = t.heard = true;
  if (['PreToolUse', 'PostToolUse', 'Stop'].includes(name)) t.talked = t.spoke = true;
  if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(name)) t.movedAt = Date.now();
  if (name === 'UserPromptSubmit' || (name === 'PreToolUse' && !ev.agent_id)) { t.state = 'working'; t.message = null; t.turnAt = Date.now(); t.stuck = null; }
  else if (name === 'PreToolUse') { if (t.state === 'waiting') { t.state = 'working'; t.message = null; } }
  else if (name === 'Stop' || name === 'StopFailure' || name === 'SessionEnd') { t.state = 'idle'; t.message = null; }
  else if (name === 'Notification' && asksQuestion(ev)) { if (t.state !== 'waiting') t.waitingAt = Date.now(); t.answeredAt = null; t.state = 'waiting'; t.message = ev.message || null; }
  if (name === 'PreToolUse' && !ev.agent_id) t.toolAt = Date.now();
  else if (['PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'].includes(name) && !(name === 'PostToolUse' && ev.agent_id)) t.toolAt = null;
  if (t.lead) keepLeadSaved(channel, t);
  saveSessions();
  if (t.reviewOf) noteReview(channel, t, name, ev);
  if (t.refresh) advanceRefresh(t);
}

const leadRefresh = require('./lead-refresh.js');
const refreshView = (t) => t && { lead: !!t.lead, running: !t.exited && !t.stopped, state: t.state, owesBrief: !!t.owesBrief, sessionId: t.sessionId };
let refreshRuns = 0;
const NOT_NOW = { typing: 'You have text typed in the Lead\'s prompt. Send it or clear it first.', menu: 'A menu is open in the Lead\'s session. Close it first.', no_hooks: 'No hooks reach this relay from the Lead, so it cannot tell when a turn ends.', settling: 'The Lead\'s screen is still changing. Try again in a few seconds.', working: 'The Lead is busy. Try again when its turn ends.' };
function startRefresh(channel) {
  const t = leadOf(channel);
  if (t && t.refresh) return [409, { ok: false, error: 'refreshing', message: 'The Lead is already being refreshed.' }];
  if (t && !t.exited && !t.stopped && t.owesBrief) return briefNow(channel, t);
  const unsafe = t ? notSafeToType(t) : null;
  const why = leadRefresh.canStart(refreshView(t)) || (unsafe && (NOT_NOW[unsafe] || 'The Lead cannot take a prompt right now. Try again in a moment.'));
  if (why) return [409, { ok: false, error: 'not_now', message: why }];
  t.refresh = { run: ++refreshRuns, phase: 'notes', sessionId: t.sessionId, startedAt: Date.now(), sawWork: false };
  t.refreshTimer = setTimeout(() => { if (t.refresh) endRefresh(t, 'The refresh took more than ' + leadRefresh.LIMIT_MS / 60000 + ' minutes, so it stopped. Look at the Lead.', false); }, leadRefresh.LIMIT_MS);
  typeForRefresh(t, leadRefresh.NOTES_PROMPT, () => {});
  return [200, { ok: true, refresh: 'notes' }];
}
const BRIEF_NOT_NOW = {
  working: 'it is busy, and it gets the brief when its turn ends', waiting: 'it is waiting on you. Answer it first',
  restarting: 'the relay is restarting for an update', stuck: 'it did not start on what the relay last typed. Look at its screen',
  ended: 'its session has ended', busy_typing: 'the relay is typing into it right now. Try again in a moment',
  typed: 'the brief is typed and waits for its turn to begin',
};
const whyNoBrief = (problem) => delivery().WHY[problem] || BRIEF_NOT_NOW[problem] || 'the relay cannot type into it right now';
function briefNow(channel, t) {
  const done = (problem) => { if (problem && t.owesBrief) endRefresh(t, 'The relay did not finish typing the Lead\'s brief: ' + whyNoBrief(problem) + '. It types it once that is safe.', false); };
  let problem = delivery().sendNow(channel, BRIEF_KEY, done);
  if (problem === 'gone') { briefLead(channel, t); problem = delivery().sendNow(channel, BRIEF_KEY, done); }
  if (problem) return [409, { ok: false, error: 'brief_not_now', reason: problem, message: 'The Lead has not had its brief, and the relay cannot type it now: ' + whyNoBrief(problem) + '.' }];
  return [200, { ok: true, refresh: null, brief: true, message: 'The Lead had not had its brief, so the relay is typing it now. The refresh stops there. Press Refresh the Lead again later if the Lead still needs it.' }];
}
function stopRefresh(channel) {
  const t = [...termsOf(channel).values()].find((x) => x.refresh);
  if (!t) return [409, { ok: false, error: 'no_refresh', message: 'No refresh is running.' }];
  const r = t.refresh;
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

const REVIEW_GRACE = () => config.get('reviewGraceSeconds') * 1000;
const FINISHED_KEPT = 10, RELAY_PROMPT_MS = 10 * 1000;
const finished = new Map();
function finishedOf(channel) { return finished.get(channel) || []; }
function postedHere(t, posted) {
  const m = String(t.reviewOf).match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
  return !!(m && posted && posted.repo && Number(posted.pr) === Number(m[2]) && String(posted.repo).toLowerCase() === m[1].toLowerCase());
}
function noteReview(channel, t, name, ev) {
  if (name === 'PostToolUse' && postedHere(t, ev.posted)) {
    const url = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#issuecomment-\d+$/.test(ev.posted.url || '') ? ev.posted.url : t.reviewOf;
    t.posted = { kind: ['comment', 'review', 'approve', 'request-changes'].includes(ev.posted.kind) ? ev.posted.kind : 'review', url };
    saveSessions();
    console.log('The review of ' + t.reviewOf + ' is posted. Its session ends ' + REVIEW_GRACE() / 1000 + ' seconds after its turn does.');
    tell(reviewPostedFns, channel, t, 'After a review was posted');
  } else if (name === 'UserPromptSubmit') {
    const relays = Date.now() - (t.relayTyped || 0) < RELAY_PROMPT_MS;
    if (ev.notice === true) { pauseReview(t); return; }
    t.relayTyped = 0;
    if (relays) pauseReview(t);
    else { if (t.posted) console.log('The review of ' + t.reviewOf + ' got a prompt that was not the relay\'s, so it stays.'); keepReviewer(t); }
  } else if (name === 'Stop' && !t.posted) tell(turnEndFns, channel, t, 'After a review\'s turn ended');
  else if (name === 'Stop' && !t.ending && !t.exited) t.ending = setTimeout(() => { t.ending = null; reviewDone(channel, t); }, REVIEW_GRACE());
}
function reviewFound(channel, t, url) {
  if (t.exited || t.stopped || t.posted || !t.reviewOf) return;
  t.posted = { kind: 'comment', url };
  saveSessions();
  console.log('The review of ' + t.reviewOf + ' is on the PR. Its session ends ' + REVIEW_GRACE() / 1000 + ' seconds after its turn does.');
  if (t.state !== 'working' && !t.ending) t.ending = setTimeout(() => { t.ending = null; reviewDone(channel, t); }, REVIEW_GRACE());
}
function tell(fns, channel, t, what) { for (const fn of fns) { try { fn(channel, t); } catch (e) { console.error(what + ': ' + e.message); } } }
function pauseReview(t) { clearTimeout(t.ending); t.ending = null; }
function keepReviewer(t) { pauseReview(t); t.posted = null; saveSessions(); }
const reviewDoneFns = [], reviewPostedFns = [], turnEndFns = [], reviewBackFns = [];
const onReviewBack = (fn) => { reviewBackFns.push(fn); };
const onReviewDone = (fn) => { reviewDoneFns.push(fn); };
const onReviewPosted = (fn) => { reviewPostedFns.push(fn); };
const onReviewTurnEnd = (fn) => { turnEndFns.push(fn); };
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

const enders = [];
const onEnd = (fn) => { enders.push(fn); };
let namer = null;
const onNamed = (fn) => { namer = fn; };
const movers = [];
const onSessionMoved = (fn) => { movers.push(fn); };

function hookCheckoutInfo() {
  const c = hook.hookCheckout();
  const root = path.dirname(path.dirname(c.own));
  const dir = /^[\w@%+=:,./-]+$/.test(root) ? root : "'" + root.replace(/'/g, "'\\''") + "'";
  return Object.assign(c, { fix: c.match ? null : 'cd ' + dir + ' && RELAY_KEY=<your relay key> npm run office:hooks' });
}

const MAX_PROMPT = 8000;
function startPrompted(channel, body, ctx) {
  const prompt = body.prompt ? String(body.prompt) : '';
  if (prompt.length > MAX_PROMPT) return { status: 400, body: { ok: false, error: 'bad_prompt', message: 'Keep the prompt to ' + MAX_PROMPT + ' characters.' } };
  const r = start(channel, body, ctx);
  if (prompt && r.status < 400) {
    const who = body.title ? String(body.title).slice(0, 80) : 'A session';
    delivery().promptOnce(channel, r.body.id, prompt, (problem) => { if (problem) ctx.log(who + ' in ' + r.body.cwd + ' did not get its first prompt: ' + problem); });
  }
  return r;
}

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
  if (isFailed) {
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
    if (req.method === 'POST') { const r = startPrompted(channel, await ctx.readJson(req), ctx); ctx.send(res, r.status, r.body); return true; }
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
      if (/[\r\n]/.test(body.data)) t.spoke = true;
      t.typedAt = Date.now();
      noteTyping(t, body.data);
      if (/[^\x1b]/.test(body.data.replace(X10_MOUSE, '').replace(ANSI, ''))) {
        t.keyedAt = Date.now();
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
    const body = await ctx.readJson(req);
    if (t.lead && !t.exited && body.lead !== true) { ctx.problem(res, 409, 'lead', LEAD_STOP_SAYS); return true; }
    t.stoppedBy = ctx.agent ? 'Lead' : 'you';
    stop(t);
    ctx.send(res, 200, { ok: true }); return true;
  }
  ctx.problem(res, 404, 'not_found', 'Unknown terminal route.');
  return true;
}

function close() { if (savedText !== null) saveSessions(); closing = true; link.close(); }
async function connectHost(log) {
  const supervised = process.env.RELAY_SUPERVISED === '1';
  link.onLost(() => {
    log('The session host stopped, so every session ended with it. ' + (supervised ? 'The relay restarts and brings them back.' : 'The relay stops. Start it again and they come back.'));
    closing = true; process.exit(supervised ? require('./supervisor.js').RESTART : 1);
  });
  await link.connect(log);
}
function stillRunning(channel, saved) {
  const back = saved && saved.terminal ? link.peek(saved.terminal) : null;
  return !!(back && back.meta && back.meta.channel === channel);
}
const dropUnclaimed = (log) => { held.clear(); heldNames.clear(); link.dropUnclaimed(log); };

function real(p) { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } }
function runningIn(dir) {
  const want = real(dir);
  for (const terms of channels.values()) for (const t of terms.values()) {
    if (!t.exited && (real(t.cwd) === want || real(t.cwd).startsWith(want + path.sep))) return true;
  }
  return false;
}

function noteContext(t, body) {
  if (!t) return [403, { ok: false, error: 'forbidden', message: 'Only a session\'s own status line says how full its context is.' }];
  const sid = String((body && body.session_id) || '');
  if (!sid || !t.sessionId || !(sid === t.sessionId || (t.sessionId.length >= 12 && sid.startsWith(t.sessionId)))) return [409, { ok: false, error: 'other_session', message: 'That is not the conversation this session is in now.' }];
  const reading = leadTired.readingOf({ session_id: sid, context_window: { used_percentage: Number(body.percent), context_window_size: body.size } }, Date.now());
  if (!reading) return [400, { ok: false, error: 'bad_param', message: 'Send percent, the part of the context window used, 0 to 100.' }];
  t.context = Object.assign(reading, { sessionId: t.sessionId });
  return [200, { ok: true, tired: leadTired.tiredOf(t) }];
}

function agentFor(req) {
  const token = req.headers['x-office-token'];
  if (typeof token !== 'string' || !token) return null;
  for (const terms of channels.values()) for (const t of terms.values()) if (t.token === token && !t.exited) return t;
  return null;
}

const all = (channel) => [...termsOf(channel).values()].filter((t) => !t.exited);
const everyone = () => [...channels.values()].flatMap((terms) => [...terms.values()].filter((t) => !t.exited));

module.exports = { setLead, screenOf, isClosing: () => closing, isUpdating: () => updating(), DESKS: MAX_TERMINALS, WORKER_DESKS, workersOf, seated, guard, setRoster, rebriefLead, startLead, holdSeats, handle, noteHook, onEnd, onNamed, onSessionMoved, onReviewDone, onReviewPosted, onReviewTurnEnd, onReviewBack, reviewFound, onWork, workOfTerm, questionOnScreen, stop, holdWhileUpdating, owePrompt, failedIn, close, connectHost, stillRunning, dropUnclaimed, takeLastRun, bringingBack, markFailed, start, find, all, everyone, leadOf, notSafeToType, typeSettle, typeIfSafe, nudge, noteShown, redraw, expand, localOnly, agentFor, runningIn, leadIn, leadEndedOf, useStart, ENABLED, wipLimit, MAX_PROMPT };
