// A ticket's history: who filed it, who approved it, who started it, its Dev, each reviewer, and each
// move, with when, and the session of each one that was a session. It is kept in its own file, not on
// the task, so it stays through a relay restart and through Clean up, which removes the task.
// See docs/manual/roles.html#ticket-history.
//
// Names. The relay picks the person each session is (relay/seats.js, through relay/terminal.js). This
// file keeps each name against its session id the moment the relay gives it, so a restart shows the
// same name, and a session that has ended keeps its name. No page can change it.
//
// Tickets from before this was kept show what their ticket and task still say, with no names or
// sessions guessed.
'use strict';
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const terminal = require('./terminal.js');
const { claim } = require('./lockfile.js');

const FILE = state.file('ticket-history.json', 'RELAY_TICKET_HISTORY_FILE');
const MAX_ENTRIES = 100, MAX_NAMES = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- the store: { channel: { tickets: { 'T-1 createdAt': [entry] }, names: { sessionId: name } } } ----------
// An entry: { at, stage, by, role, sessionId, cwd, task, pr, from, to, what }. stage is filed, approved,
// started, dev, reviewer, moved or edited. what is the fields an edit changed: title, body, priority. role is the role of the session in it: dev, reviewer, pm, lead or coo.
const ownsFile = claim(FILE);
let store = {};
if (ownsFile) try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') {  // keep a file we cannot read, rather than writing over it
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
  } catch (e) { console.error('Could not save ticket histories to ' + FILE + ': ' + e.message); }
}
const chOf = (channel) => store[channel] || (store[channel] = { tickets: {}, names: {} });
// A ticket id can come back after its store is reset, so its creation time is part of the key.
const keyOf = (id, at) => id + ' ' + (at || '');
const entriesOf = (channel, id, at) => chOf(channel).tickets[keyOf(id, at)] || [];

// The role a session has in the room, from what the relay knows of it.
function roleOf(t) {
  if (!t) return null;
  if (t.lead) return 'lead';
  if (t.role === 'pm' || t.role === 'coo') return t.role;
  if (t.role === 'reviewer' || t.reviewOf) return 'reviewer';
  return t.task ? 'dev' : null;
}
const liveOf = (channel, sessionId) => (sessionId ? terminal.all(channel).find((t) => t.sessionId === sessionId) || null : null);

function nameSession(channel, sessionId, name) {
  if (!UUID.test(String(sessionId || '')) || !name) return;
  const names = chOf(channel).names;
  if (names[sessionId] === name) return;
  delete names[sessionId];  // the newest goes last, so the oldest go first
  names[sessionId] = name;
  const ids = Object.keys(names);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_NAMES))) delete names[id];
  save();
}
// The relay names its sessions as it seats them (relay/terminal.js).
if (terminal.onNamed) terminal.onNamed((channel, t) => nameSession(channel, t.sessionId, t.who));  // a test's stand-in may have none

// ticket is { id, createdAt } or a task's { ticket, ticketAt }. session is the session that did it, if any.
function add(channel, ticket, entry, session) {
  const id = ticket && (ticket.ticket || ticket.id), at = ticket && (ticket.ticketAt || ticket.createdAt);
  if (!id || !/^[\w-]{1,64}$/.test(String(id))) return;
  const e = Object.assign({ at: new Date().toISOString() }, entry);
  if (session) {
    e.sessionId = session.sessionId;
    if (!e.role) e.role = roleOf(session);
    if (!e.cwd) e.cwd = session.cwd;
    if (session.who) nameSession(channel, session.sessionId, session.who);
  }
  for (const k of Object.keys(e)) if (e[k] == null) delete e[k];
  const c = chOf(channel), key = keyOf(id, at), list = c.tickets[key] || (c.tickets[key] = []);
  // A worker brought back in the same conversation is the same Dev, not a new one.
  if (e.sessionId && (e.stage === 'dev' || e.stage === 'reviewer') && list.some((x) => x.stage === e.stage && x.sessionId === e.sessionId)) return;
  list.push(e);
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
  save();
}

// The ticket a PR is on, from the saved history: the newest step with that PR. It is there after Clean
// up, which removes the task. Null when no step has it.
function ticketOfPr(channel, pr) {
  let found = null;
  for (const [key, list] of Object.entries(chOf(channel).tickets)) {
    for (const e of list) if (e.pr === pr && (!found || e.at > found.e.at)) found = { key, e };
  }
  if (!found) return null;
  const space = found.key.indexOf(' ');
  return { id: found.key.slice(0, space), createdAt: found.key.slice(space + 1) || null, task: found.e.task || null };
}
// A reviewer after /clear or /resume is a new session in the same terminal. It gets a new step, as a Dev
// does (relay/tasks.js), on the ticket of its last one.
function followReviewer(channel, t, was) {
  if (!was || roleOf(t) !== 'reviewer') return;
  for (const [key, list] of Object.entries(chOf(channel).tickets)) {
    const last = list.filter((e) => e.stage === 'reviewer' && e.sessionId === was).at(-1);
    if (!last) continue;
    const space = key.indexOf(' ');
    add(channel, { id: key.slice(0, space), createdAt: key.slice(space + 1) || null }, { stage: 'reviewer', role: 'reviewer', by: last.by, task: last.task, pr: last.pr }, t);
  }
}
if (terminal.onSessionMoved) terminal.onSessionMoved(followReviewer);  // a test's stand-in may have none

// ---------- what the Board shows ----------
// A session in a history: its full id for Resume, the folder it ran in (Claude Code finds a session
// by its folder), and whether it is running now. A running one opens in the panel (terminal is its id
// there). One that has ended can come back with Resume in that folder, unless the folder is gone.
function sessionView(channel, sessionId, cwd) {
  const live = liveOf(channel, sessionId);
  const folder = cwd || (live && live.cwd) || null;
  return { sessionId, cwd: folder, running: !!live, terminal: live ? live.id : null, folderGone: !live && !!folder && !fs.existsSync(folder) };
}
const ROLE_BY_NAME = { PM: 'pm', Lead: 'lead', COO: 'coo' };
// What a ticket and its task say about the time before histories were kept. Nothing here is guessed:
// a step with no time recorded has none, and only a session the task recorded is shown.
function recorded(ticket, task) {
  const out = [{ stage: 'filed', at: ticket.createdAt || null, by: ticket.createdBy || null, role: ROLE_BY_NAME[ticket.createdBy] || (/^Worker on /.test(ticket.createdBy || '') ? 'dev' : null) }];
  if (ticket.approvedBy === 'you' || ticket.approvedBy === 'Lead') out.push({ stage: 'approved', at: null, by: ticket.approvedBy, role: ticket.approvedBy === 'Lead' ? 'lead' : null });
  if (task) {
    const by = task.by || ((task.history || []).find((h) => h.type === 'created') || {}).by || null;
    out.push({ stage: 'started', at: task.createdAt, by, role: by === 'Lead' ? 'lead' : null, task: task.id });
    if (task.owner && task.owner.sessionId) out.push({ stage: 'dev', at: task.createdAt, role: 'dev', sessionId: task.owner.sessionId, cwd: task.worktree, task: task.id });
    for (const h of task.history || []) if (h.type === 'moved') out.push({ stage: 'moved', at: h.at, by: h.by, from: h.from, to: h.to, role: h.by === 'Lead' ? 'lead' : null, task: task.id });
  }
  return out.map((e) => Object.assign(e, { old: true }));
}
// The saved history, and before it what was there already. A ticket filed since histories were kept has
// its filing saved, so nothing from before is needed about it. A task's start and each Dev session are
// either saved or not. A task's moves from before are the ones older than its first saved move.
function merged(saved, old) {
  const savedMove = (task) => saved.filter((s) => s.stage === 'moved' && s.task === task).map((s) => s.at).sort()[0] || null;
  const keep = old.filter((o) => {
    if (o.stage === 'filed' || o.stage === 'approved') return !saved.some((s) => s.stage === 'filed');
    if (o.stage === 'started') return !saved.some((s) => s.stage === 'started' && s.task === o.task);
    if (o.stage === 'dev') return !saved.some((s) => s.sessionId === o.sessionId);
    const first = savedMove(o.task);
    return !first || o.at < first;
  });
  const all = keep.concat(saved), dated = all.filter((e) => e.at).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const filed = dated.findIndex((e) => e.stage === 'filed');
  dated.splice(filed + 1, 0, ...all.filter((e) => !e.at));  // an approval with no time comes after the filing
  return dated;
}
function entryView(channel, e) {
  const names = chOf(channel).names, live = liveOf(channel, e.sessionId);
  const name = (e.sessionId && (names[e.sessionId] || (live && live.who))) || null;
  const out = { at: e.at || null, stage: e.stage, by: e.by || null, role: e.role || null, name, task: e.task || null, pr: e.pr || null, from: e.from || null, to: e.to || null, what: Array.isArray(e.what) ? e.what : null, old: !!e.old };
  out.session = e.sessionId ? sessionView(channel, e.sessionId, e.cwd) : null;
  return out;
}
// Who has the ticket now: its Dev while it is being built, a reviewer while it is in review, you while it
// waits on you. Nobody before it starts or once it is done, which the Board shows as Unassigned.
function holderOf(entries, ticket, task) {
  if (!task || ticket.status !== 'started' || task.state === 'done') return null;
  if (task.state === 'waiting_on_you') return { role: 'you', name: 'You', session: null };
  const mine = (stage) => entries.filter((e) => e.stage === stage && e.session && (!e.task || e.task === task.id));
  const dev = mine('dev').at(-1) || null, reviewers = mine('reviewer');
  const reviewer = reviewers.filter((e) => e.session.running).at(-1) || reviewers.at(-1) || null;
  const who = task.state === 'in_review' && reviewer ? reviewer : dev;
  return who ? { role: who.role || who.stage, name: who.name, session: who.session } : null;
}
function view(channel, ticket, task) {
  const entries = merged(entriesOf(channel, ticket.id, ticket.createdAt), recorded(ticket, task)).map((e) => entryView(channel, e));
  return { assignee: holderOf(entries, ticket, task), history: entries };
}

module.exports = { add, view, roleOf, ticketOfPr, FILE };
