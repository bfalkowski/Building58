// The manager's jam review: each look of the manager's watch (relay/manager-watch.js) reads the jam log
// (relay/jams.js) and asks relay/manager-jams-plan.js which kind of jam was logged three times in a day. For each
// such cause it files one ticket labelled manager, with the jams as evidence, and posts a short note on the chat
// board. The next look that sees new jams of the kind adds them to that ticket as a note, and files no second one.
// Once a day it also types the jam summary to the manager session, so the session can judge what the relay cannot.
// It starts, moves, merges and closes nothing. It keeps its causes in RELAY_MANAGER_JAMS_FILE. See
// docs/manual/roles.html#manager-jams.
'use strict';
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const tickets = require('./tickets.js');
const chat = require('./chat.js');
const jams = require('./jams.js');
const delivery = require('./delivery.js');
const { claim } = require('./lockfile.js');
const { oneLine } = require('./clean.js');
const { JAM_KINDS } = require('./metrics-plan.js');
const plan = require('./manager-jams-plan.js');

const FILE = state.file('manager-jams.json', 'RELAY_MANAGER_JAMS_FILE');
const ownsFile = claim(FILE);
let store = {};
if (ownsFile) try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { store = {}; }
function save() {
  if (!ownsFile) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Could not save the manager\'s jam review to ' + FILE + ': ' + e.message); }
}
const chOf = (channel) => { const c = store[channel] || (store[channel] = {}); return Object.assign(c, { causes: c.causes || {}, dailyAt: c.dailyAt || 0 }); };
const label = (kind) => JAM_KINDS[kind] || kind;

async function repoOf(channel, all) {
  const t = tasks.list(channel).find((x) => x.repo) || all.find((x) => x.repo);
  return t ? t.repo : null;
}

async function review(channel, now, log) {
  const c = chOf(channel), list = jams.listOf(channel);
  const found = plan.bursts(list, now);
  if (found.length) {
    const all = await tickets.listAll(channel);
    for (const burst of found) {
      const cause = c.causes[burst.kind], mine = cause && all.find((t) => t.id === cause.ticket);
      const status = cause ? (mine ? mine.status : 'done') : undefined;
      const call = plan.decide(burst, cause, status);
      if (call.act === 'file') {
        const repo = await repoOf(channel, all);
        if (!repo) continue;
        const [code, out] = await tickets.fileAsManager(channel, Object.assign({ repo }, plan.ticketOf(burst, label(burst.kind), call.earlier)));
        if (code >= 300 || !out.ticket) continue;
        c.causes[burst.kind] = { kind: burst.kind, ticket: out.ticket.id, filedAt: now, before: burst.count, seen: burst.jams.map((j) => j.at), fixedAt: null };
        chat.announce(channel, 'The manager: "' + label(burst.kind) + '" jams were logged ' + burst.count + ' times in a day. Filed ticket ' + out.ticket.id + ' to find the cause.', out.ticket.id);
        log('Filed ' + out.ticket.id + ' for the jam kind ' + burst.kind + ': ' + burst.count + ' in a day.');
      } else if (call.act === 'add') {
        const [code] = await tickets.noteAsManager(channel, cause.ticket, plan.noteOf(call.fresh, label(burst.kind)));
        if (code >= 300) continue;
        cause.seen = cause.seen.concat(call.fresh.map((j) => j.at)).slice(-200);
        log('Added ' + call.fresh.length + ' jams of the kind ' + burst.kind + ' to ' + cause.ticket + '.');
      }
    }
  }
  if (Object.keys(c.causes).length) {
    const all = await tickets.listAll(channel);
    for (const cause of Object.values(c.causes)) {
      const t = all.find((x) => x.id === cause.ticket);
      if (t && t.status === 'done' && !cause.fixedAt) cause.fixedAt = now;
    }
  }
  if (now - c.dailyAt >= plan.DAY) {
    const manager = terminal.all(channel).find((t) => t.role === 'manager');
    if (manager) {
      c.dailyAt = now;
      const kinds = Object.entries(list.filter((j) => now - Date.parse(j.at) < 7 * plan.DAY).reduce((m, j) => Object.assign(m, { [j.kind]: (m[j.kind] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const text = 'Daily jam review. Jams in the last 7 days by kind: ' + (kinds.length ? kinds.map(([k, n]) => label(k) + ' ' + n).join(', ') : 'none') + '. Causes that already have a ticket: ' + (Object.values(c.causes).map((x) => label(x.kind) + ' is ticket ' + x.ticket).join(', ') || 'none') + '. Read the jam log, the metrics and the hand-overs, and ask what keeps causing them. File one ticket for each cause with no ticket, or add evidence to the ticket it has.';
      delivery.promptOnce(channel, manager.id, oneLine(text, 1000), (problem) => { if (problem) log('The daily jam review was not told to the manager: ' + problem); });
    }
  }
  save();
}

function watching(channel, now) {
  const c = chOf(channel), list = jams.listOf(channel);
  const causes = Object.values(c.causes).sort((a, b) => b.filedAt - a.filedAt);
  const cause = causes[0];
  if (!cause) return null;
  return { kind: cause.kind, label: label(cause.kind), ticket: cause.ticket, fixed: !!cause.fixedAt, outcome: plan.outcomeOf(cause, list, now) };
}

module.exports = { review, watching };
