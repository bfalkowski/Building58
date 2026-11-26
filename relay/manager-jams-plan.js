// The manager's reading of the jam log (relay/manager-jams.js), as plain functions the tests can give made-up
// jams. A cause is a kind of jam logged BURST times or more in one day. Each cause has one ticket: the first look
// files it with the jams as evidence, and a later look that sees new jams of the kind adds them to that ticket. When
// the ticket is done, three or more new jams of the kind make a new ticket. A rejected ticket is the person's answer,
// so nothing is filed again for it. See docs/manual/roles.html#manager-jams.
'use strict';
const { oneLine, keepLines } = require('./clean.js');

const DAY = 24 * 60 * 60 * 1000;
const BURST = 3;
const SHOWN = 8;

function bursts(jams, now) {
  const by = new Map();
  for (const j of jams || []) {
    const at = Date.parse(j && j.at);
    if (!j || !j.kind || j.by === 'autopilot' || !Number.isFinite(at) || at > now || now - at >= DAY) continue;
    if (!by.has(j.kind)) by.set(j.kind, []);
    by.get(j.kind).push(j);
  }
  return [...by].filter(([, list]) => list.length >= BURST).map(([kind, list]) => ({ kind, count: list.length, jams: list.sort((a, b) => (a.at < b.at ? -1 : 1)) }));
}

const jamLine = (j) => '- ' + String(j.at).slice(0, 16).replace('T', ' ') + ' UTC' + (j.ticket ? ', ticket ' + oneLine(j.ticket, 40) : '') + (j.pr ? ', ' + oneLine(j.pr, 120) : '') + ', by ' + oneLine(j.by, 40) + ': ' + oneLine(j.fix, 200);
const evidenceOf = (jams) => jams.slice(-SHOWN).map(jamLine).join('\n') + (jams.length > SHOWN ? '\n(' + (jams.length - SHOWN) + ' earlier ones are in GET /jams.)' : '');

function ticketOf(burst, label, earlier) {
  const title = oneLine('Find why "' + label + '" jams keep happening', 80);
  const body = keepLines([
    'The jam log has ' + burst.count + ' jams of the kind "' + label + '" in the last day. A jam is a stall the room did not see, fixed by hand.',
    earlier ? 'Ticket ' + earlier + ' was meant to stop this kind of jam and is done, and it came back.' : '',
    '', 'Evidence from the jam log:', evidenceOf(burst.jams), '',
    'What to do: find what keeps causing this kind of jam (a missing check, a rule that makes sessions wait, a test that flakes, a step no one owns) and fix the cause, not the symptom. Do not add a retry or a sleep.',
    'Filed by the manager (relay/manager-jams.js). It files one ticket for each cause and adds new jams of the kind to it as notes.'
  ].filter((l, i, a) => l || (a[i - 1] && a[i - 1] !== '')).join('\n'));
  return { title, body };
}

function decide(burst, cause, status) {
  const seen = new Set((cause && cause.seen) || []);
  const fresh = burst.jams.filter((j) => !seen.has(j.at));
  if (!cause || status === 'done' || status === undefined) {
    if (cause && status === 'done' && fresh.length < BURST) return { act: 'none' };
    return { act: 'file', earlier: cause && status === 'done' ? cause.ticket : null };
  }
  if (status === 'rejected') return { act: 'none' };
  return fresh.length ? { act: 'add', fresh } : { act: 'none' };
}

function noteOf(fresh, label) {
  return oneLine('The manager saw ' + fresh.length + ' more "' + label + '" jam' + (fresh.length === 1 ? '' : 's') + ' since the last look at this ticket.', 200) + '\n' + evidenceOf(fresh);
}

function outcomeOf(cause, jams, now) {
  if (!cause || !cause.fixedAt) return null;
  const days = Math.max(1, (now - cause.fixedAt) / DAY);
  const after = (jams || []).filter((j) => j.kind === cause.kind && j.by !== 'autopilot' && Date.parse(j.at) >= cause.fixedAt).length;
  const rate = Math.round((after / days) * 10) / 10;
  return { before: cause.before, after: rate, down: rate < cause.before, words: 'The ticket is done. Jams of this kind: ' + cause.before + ' a day before, ' + rate + ' a day since' + (rate < cause.before ? ', so it went down.' : ', so it did not go down.') };
}

module.exports = { DAY, BURST, bursts, ticketOf, decide, noteOf, outcomeOf, evidenceOf };
