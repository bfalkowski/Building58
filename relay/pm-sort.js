// The PM's scheduled sort of the Board (docs/manual/roles.html#pm-trust). Every pmSortHours (Settings; 0 is
// off) the relay saves the sort brief for the newest running PM through relay/delivery.js, so it is typed only
// when the PM is idle. It never runs while a start is in progress: a ticket starting, Autopilot starting one,
// or a PM check that Autopilot waits on. A sort that is due then waits, and is tried again every
// RETRY_MS. What the PM may do is the PM trust rung, which the brief names: at Off and Advise it only writes advice.
'use strict';
const config = require('./config.js');
const terminal = require('./terminal.js');
const delivery = require('./delivery.js');
const trust = require('./pm-trust.js');
const pmCheck = require('./pm-check.js');
const { sortBrief } = require('./pm-check-brief.js');
const CLI = require('path').join(__dirname, 'ticket.js');

const UNIT_MS = Number(process.env.RELAY_PM_SORT_UNIT_MS) >= 1 ? Number(process.env.RELAY_PM_SORT_UNIT_MS) : 60 * 60 * 1000;
const RETRY_MS = Number(process.env.RELAY_PM_SORT_RETRY_MS) >= 1 ? Number(process.env.RELAY_PM_SORT_RETRY_MS) : 5000;
const KEY = 'pm-sort';
const due = new Set();
let timer = null;

const startInProgress = (channel) => require('./tickets.js').startingNow(channel) || require('./autopilot.js').starting() || pmCheck.waiting(channel);

async function ask(channel) {
  const pm = pmCheck.seat(channel);
  if (!pm) return { done: true, why: 'No PM is running.' };
  if (startInProgress(channel)) return { done: false, why: 'A start is in progress.' };
  const all = await require('./tickets.js').listAll(channel);
  if (!all.some((t) => ['triage', 'ready'].includes(t.status))) return { done: true, why: 'No ticket is in Triage or Ready.' };
  if (startInProgress(channel)) return { done: false, why: 'A start is in progress.' };
  delivery.save(channel, { key: KEY, terminal: pm.id, sessionId: pm.sessionId, text: sortBrief({ all, rung: trust.level(), cli: CLI }), expiresAt: Date.now() + 60 * 60 * 1000 });
  return { done: true, sent: true };
}

async function flush() {
  for (const channel of [...due]) {
    let r;
    try { r = await ask(channel); } catch (e) { r = { done: true, why: e.message }; }
    if (r.done) due.delete(channel);
  }
  if (!due.size && timer) { clearInterval(timer); timer = null; }
}

function tick() {
  if (!(config.get('pmSortHours') > 0)) return;
  for (const t of terminal.everyone()) if (t.role === 'pm') due.add(t.channel);
  if (!due.size) return;
  if (!timer) { timer = setInterval(flush, RETRY_MS); timer.unref(); }
  flush();
}

function begin() { config.every('pmSortHours', tick, 0, UNIT_MS); }

module.exports = { begin, ask, KEY };
