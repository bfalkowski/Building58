// Saved delivery: a message for a session, kept on disk until it can be typed safely. It is typed only
// when relay/terminal.js says nothing is going on in that session, and the check runs right before
// typing, because typed text can answer a permission prompt. It survives a relay restart, and finds a
// session brought back with the same id. This is the only module that types a message into a session
// for the relay, a first brief and a first prompt included. Refresh the Lead types its own steps.
//
//   save(channel, { key, terminal, sessionId, text, expiresAt, on, first, untilTurn })  a new save with the same key replaces the old one
//   save(channel, { key, to: 'lead', text, ... })                     for whichever session is the Lead when it is typed
//   save(channel, { key, to: 'lead', terminal, sessionId, ... })      for that session, only while it is the Lead
//   drop(channel, key)                                                takes one back, even mid-typing
//   dropWhere(test)                                                   drops every one whose key passes
//   pending(channel)                                                  what is still waiting, and why
//   promptOnce(channel, terminal, text, done, was)                    a reviewer's, the PM's or the COO's first prompt (below)
//
// `on` runs once: on ('delivered') or on ('expired', why). It is not saved, so after a restart a
// delivery still goes in and nobody is told, unless its caller saves it again: a save that changes
// neither its text nor its session keeps where it was, and only takes the new `on`.
// Treat text as data: callers keep it to one plain line.
//
// A first brief (first: true) goes before anything else for that session, and nothing else is typed
// into it while the brief is saved. untilTurn: it lands, and is 'delivered', only when a hook says a
// turn began after it went in. Until then it stays saved: if the session ends first, the session
// brought back with the same id gets it again, and a relay restart keeps it. A relay that comes back
// to a session it was typed into watches it again, from when it was typed. A task's brief is both.
// The Lead's brief is first only: a Lead with no hooks reaching the relay is still briefed.
//
// An update holds a first brief saved until a turn begins (a task's brief, and every first prompt) only
// while it restarts, not while it waits for a quiet moment, which can take hours (T-147, T-299).
// A first prompt (promptOnce) for a reviewer, the PM or the COO is a first brief saved until a turn
// begins, with two differences. It gives up if it was not typed within RELAY_READY_LIMIT
// (Settings), counted again from when a relay comes back, or if its session ends while the relay runs. And it is tried PROMPT_TRIES times before
// the session is stuck, not twice: Claude Code can drop the Enter that follows a long paste, and a
// reviewer stuck on that sat for 12 minutes before anyone saw (T-209). Its text is also saved with
// the session (t.owesPrompt). A session nobody spoke to comes back after a stop with a new terminal
// and session id, so relay/sessions.js calls promptOnce again with was, the old terminal id, and the
// saved prompt moves to the new session.
//
// After a note goes in, the relay checks that the session took it up: that a hook said a turn began
// within TOLD_CHECK. If not, it tries once more, or PROMPT_TRIES more for a first prompt (relay/terminal.js
// nudge: Enter if the note still shows, or the note typed again), and checks again after each. If it still has not started, the session is stuck
// (t.stuck: when it was told, and why where the relay can tell), the Floor says so, and the relay
// stops trying and leaves it to the person. Nothing else is typed into a session while it is stuck. The note is saved again for that session id, so Bring back gets it, but a
// turn that begins in the stuck session itself drops it: that session has it already.
//   onStuck(fn)  fn (channel, t) runs when a session becomes stuck
'use strict';
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const terminal = require('./terminal.js');
const config = require('./config.js');
const { claim } = require('./lockfile.js');
const { TOLD_CHECK } = require('./stop-verdict.js');

const FILE = state.file('deliveries.json', 'RELAY_DELIVERIES_FILE');
const EVERY = 500;
const NEVER = 24 * 60 * 60 * 1000;

const ownsFile = claim(FILE);
let store = {};
if (ownsFile) try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') {
    const aside = FILE + '.unreadable-' + Date.now();
    try { fs.renameSync(FILE, aside); console.error('Could not read ' + FILE + '. Kept it as ' + aside); } catch (e2) { /* nothing to keep */ }
  }
}
function persist() {
  if (!ownsFile) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Could not save deliveries to ' + FILE + ': ' + e.message); }
}
const listOf = (channel) => store[channel] || (store[channel] = []);
const callbacks = new Map();

function save(channel, { key, to, terminal: id, sessionId, text, expiresAt, on, first, untilTurn, prompt }) {
  const same = listOf(channel).find((x) => x.key === key);
  if (same && same.text === text && same.terminal === (id || null) && same.sessionId === (sessionId || null) && (same.to || null) === (to || null) && !!same.first === !!first && !!same.untilTurn === !!untilTurn && !!same.prompt === !!prompt) {
    if (on) callbacks.set(channel + '/' + key, on);
    return;
  }
  drop(channel, key);
  listOf(channel).push(Object.assign({ key, to: to || null, terminal: id || null, sessionId: sessionId || null, text, expiresAt: expiresAt || Date.now() + NEVER, savedAt: Date.now() },
    first ? { first: true } : {}, untilTurn ? { untilTurn: true, typedAt: null, typedTo: null } : {}, prompt ? { prompt: true, readyBy: Date.now() + READY_LIMIT() } : {}));
  if (on) callbacks.set(channel + '/' + key, on);
  persist();
}
function remove(channel, d) {
  store[channel] = listOf(channel).filter((x) => x !== d);
  persist();
}
function tell(channel, key, ...args) {
  const on = callbacks.get(channel + '/' + key);
  callbacks.delete(channel + '/' + key);
  if (on) on(...args);
}
function dropWhere(test) {
  for (const channel of Object.keys(store)) for (const d of listOf(channel).filter((x) => test(x.key))) drop(channel, d.key);
}
function drop(channel, key) {
  const d = listOf(channel).find((x) => x.key === key);
  if (d) remove(channel, d);
  callbacks.delete(channel + '/' + key);
}
const how = (d) => (d.prompt || (d.first && d.untilTurn) ? 'prompt' : !!d.first);
const isTarget = (t, d) => t.id === d.terminal || (!!d.sessionId && t.sessionId === d.sessionId);
function targetOf(channel, d) {
  if (d.to !== 'lead') return terminal.all(channel).find((t) => isTarget(t, d)) || null;
  const lead = terminal.leadOf(channel);
  return lead && (!d.terminal || isTarget(lead, d)) ? lead : null;
}
function pending(channel) {
  return listOf(channel).map((d) => { const t = targetOf(channel, d); return { key: d.key, terminal: d.terminal, expiresAt: d.expiresAt, first: !!d.first, typed: !!(d.untilTurn && d.typedAt), blocked: heldBy(channel, t, d) || terminal.notSafeToType(t, how(d)) }; });
}

const PROMPT_TRIES = 3;
const READY_LIMIT = () => config.get('readyMinutes') * 60 * 1000;
const watching = new Map();
const stuckFns = [];
const onStuck = (fn) => { stuckFns.push(fn); };
const tookUp = (t, at) => (t.turnAt || 0) >= at || t.state === 'working' || t.state === 'waiting';
const WHY = {
  menu: 'a menu is open on its screen', trust: 'it is asking whether to trust its folder', typing: 'someone has text in its prompt',
  no_prompt: 'its screen shows no prompt', no_hooks: 'no hook reaches the relay from it', settling: 'its screen keeps changing',
};
function whyStuck(t, text, problem) {
  if (problem && WHY[problem]) return WHY[problem];
  const q = terminal.questionOnScreen(t);
  if (q) return WHY[q];
  if (terminal.noteShown(t, text)) return 'the note is still in its prompt, not sent';
  return 'the relay cannot tell why from its screen';
}
function watch(channel, d, t, at) {
  unwatch(t.id);
  const w = { channel, d, at, tries: 0, until: at + 4 * TOLD_CHECK, timer: null };
  watching.set(t.id, w);
  w.timer = setTimeout(() => check(t, w), TOLD_CHECK);
  w.timer.unref();
}
function unwatch(id) { const w = watching.get(id); if (w) clearTimeout(w.timer); watching.delete(id); }
function later(t, w) { if (watching.get(t.id) === w) { w.timer = setTimeout(() => check(t, w), TOLD_CHECK); w.timer.unref(); } }
const PASSING = new Set(['restarting', 'settling', 'briefing', 'working']);
function check(t, w) {
  if (watching.get(t.id) !== w) return;
  if (t.exited || t.stopped || tookUp(t, w.at)) { unwatch(t.id); return; }
  const problem = terminal.notSafeToType(t, how(w.d));
  if (problem === 'ended' || problem === 'leaving') { unwatch(t.id); return; }
  if (PASSING.has(problem) && Date.now() < w.until) { later(t, w); return; }
  if (w.tries >= (w.d.prompt ? PROMPT_TRIES : 1) || problem) { becameStuck(t, w, problem); return; }
  w.tries++; w.until = Date.now() + 4 * TOLD_CHECK;
  terminal.nudge(t, w.d.text, () => watching.get(t.id) === w && !tookUp(t, w.at), (p) => {
    if (watching.get(t.id) !== w) return;
    if (p && !tookUp(t, w.at) && !PASSING.has(p)) { becameStuck(t, w, p); return; }
    if (p && !tookUp(t, w.at)) w.tries--;
    later(t, w);
  }, how(w.d));
}
function becameStuck(t, w, problem) {
  unwatch(t.id);
  t.stuck = { at: w.at, why: whyStuck(t, w.d.text, problem), key: w.d.key };
  if (!listOf(w.channel).some((x) => x.key === w.d.key) && Date.now() < w.d.expiresAt) {
    listOf(w.channel).push(Object.assign({}, w.d, { heldFor: t.id }));
    persist();
  }
  console.log('A session did not start on what the relay told it, so it is stuck: ' + t.stuck.why + '.');
  for (const fn of stuckFns) { try { fn(w.channel, t); } catch (e) { console.error('After a stuck session: ' + e.message); } }
}
function heldBy(channel, t, d) {
  if (!t) return null;
  if (t.stuck) return 'stuck';
  if (!d.first && listOf(channel).some((x) => x.first && x !== d && targetOf(channel, x) === t)) return 'briefing';
  return null;
}
function landing(channel, d, t) {
  if (!d.typedAt) return false;
  if (t && t.id === d.typedTo && tookUp(t, d.typedAt)) { unwatch(t.id); remove(channel, d); tell(channel, d.key, 'delivered'); return true; }
  if (t && t.id === d.typedTo) {
    if (!watching.has(t.id) && !t.stuck) watch(channel, d, t, d.typedAt);
    return true;
  }
  if (!t) return true;
  d.typedAt = null; d.typedTo = null; persist();
  return false;
}

const typing = new Set();
function pump() {
  for (const channel of Object.keys(store)) {
    for (const d of listOf(channel).slice()) {
      const t = targetOf(channel, d);
      if (Date.now() >= d.expiresAt) { remove(channel, d); tell(channel, d.key, 'expired', terminal.notSafeToType(t)); continue; }
      if (d.readyBy && !d.typedAt && Date.now() >= d.readyBy) {
        remove(channel, d); tell(channel, d.key, 'expired', 'the session was not ready after ' + Math.round(READY_LIMIT() / 60000) + ' minutes'); continue;
      }
      if (t && d.heldFor === t.id && !t.stuck) { remove(channel, d); continue; }
      if (d.untilTurn && landing(channel, d, t)) continue;
      if (!t || typing.has(t.id) || heldBy(channel, t, d) || terminal.notSafeToType(t, how(d))) continue;
      typing.add(t.id);
      const at = Date.now();
      terminal.typeIfSafe(t, d.text, () => listOf(channel).includes(d) && targetOf(channel, d) === t, (problem) => {
        typing.delete(t.id);
        if (problem || !listOf(channel).includes(d)) return;
        watch(channel, d, t, at);
        if (d.untilTurn) { d.typedAt = at; d.typedTo = t.id; persist(); return; }
        remove(channel, d);
        if (!d.heldFor) tell(channel, d.key, 'delivered');
      }, how(d));
    }
  }
}
setInterval(pump, EVERY).unref();

const PROMPT_KEY = (id) => 'first-prompt ' + id;
function promptOnce(channel, id, text, done, was) {
  const t = terminal.find(channel, id);
  if (!t || t.exited || t.stopped) { done('the session ended first'); return; }
  if (was && was !== id) drop(channel, PROMPT_KEY(was));
  const kept = listOf(channel).find((x) => x.key === PROMPT_KEY(id));
  if (kept && kept.readyBy && !kept.typedAt) { kept.readyBy = Date.now() + READY_LIMIT(); persist(); }
  terminal.owePrompt(t, text);
  save(channel, { key: PROMPT_KEY(id), terminal: id, sessionId: t.sessionId, text, first: true, untilTurn: true, prompt: true, on: (what, why) => {
    terminal.owePrompt(t, null);
    done(what === 'delivered' ? null : why || 'it was not delivered in a day');
  } });
}
terminal.onEnd((channel, t, code, closing) => {
  if (closing) return;
  const d = listOf(channel).find((x) => x.key === PROMPT_KEY(t.id));
  if (!d) return;
  unwatch(t.id); remove(channel, d);
  tell(channel, d.key, 'expired', d.typedAt ? 'the session ended after its prompt was typed, before a hook said a turn began' : 'the session ended first');
});

module.exports = { save, drop, dropWhere, pending, onStuck, promptOnce, TOLD_CHECK, PROMPT_TRIES };
