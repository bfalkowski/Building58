// The manager's brake: while Let the manager lower the trust level is on, a stall that work cannot get past (the
// manager's watch, relay/manager-watch.js: the same check failing on commit after commit, Autopilot handing task
// after task to the person) lowers the trust level by one. It never raises it, lowers at most twice in 24 hours, and
// does what pressing Set level does on the page: it changes switches and nothing else. Work under way stays where it
// is, and it reverts no PR, reopens or rejects no ticket and stops no session. See docs/manual/roles.html#manager-brake.
'use strict';
const config = require('./config.js');
const terminal = require('./terminal.js');
const reviews = require('./reviews.js');
const autopilot = require('./autopilot.js');
const { oneLine } = require('./clean.js');
const plan = require('./trust-brake-plan.js');

const STALLS = new Set(['check', 'handoffs']);
const DAY = 24 * 3600 * 1000;
const PER_DAY = 2;
const KEPT = 10;
const LEAD_STARTS = { starts: 1, total: 3 };
const SAYS = { auto: 'Review PRs automatically', again: 'Review again after each push', board: 'Let the Lead move the board', stops: 'Let the Lead stop sessions', merge: 'Let the Lead merge', starts: 'Let the Lead start tickets', autopilot: 'Autopilot', exhibit: 'Merge only when Exhibit passes' };

function switchesOf(channel) {
  const lead = terminal.leadOf(channel), r = reviews.switchesOf(channel);
  return { lead, switches: { auto: r.auto, again: r.again, board: !!(lead && lead.board), stops: !!config.get('leadStops'), merge: !!(lead && lead.merge), starts: !!(lead && lead.starts), autopilot: autopilot.isOn(channel), exhibit: !!config.get('autopilotExhibit') } };
}
const levelNow = (channel) => { const s = switchesOf(channel); return plan.levelOf(s.switches, !!s.lead); };

function turn(channel, k, on, lead) {
  if (k === 'stops' || k === 'exhibit') return config.set({ values: { [k === 'stops' ? 'leadStops' : 'autopilotExhibit']: on } })[0];
  if (k === 'auto' || k === 'again') { reviews.setSwitch(channel, k, on); return 200; }
  if (k === 'autopilot') { autopilot.turnOff(channel, 'the manager'); return 200; }
  if (!on) return terminal.setLead(channel, k === 'board' ? { board: false } : k === 'merge' ? { merge: false } : { starts: 0 })[0];
  if (!lead) return 409;
  return terminal.setLead(channel, Object.assign({ terminal: lead.id, lead: true }, k === 'merge' ? { merge: true } : LEAD_STARTS))[0];
}

function lowered(list, now) { return list.filter((x) => now - Date.parse(x.at) < DAY); }

function lower(channel, finding, list, now) {
  if (!config.get('managerLowersTrust') || !(STALLS.has(finding.kind) || finding.kind === 'judged')) return null;
  if (lowered(list, now).length >= PER_DAY) return { limit: true };
  const { switches, lead } = switchesOf(channel), step = plan.step(switches, !!lead);
  if (!step) return null;
  const done = [], missed = [];
  for (const k of step.offs) { if (turn(channel, k, false, lead) < 300) done.push('turned off ' + SAYS[k]); else missed.push(SAYS[k]); }
  for (const k of step.ons) { if (turn(channel, k, true, lead) < 300) done.push('turned on ' + SAYS[k]); else missed.push(SAYS[k]); }
  const got = levelNow(channel), at = new Date(now).toISOString();
  const where = got === null ? 'The switches now match no level' : 'The room is at level ' + got + ', ' + plan.NAMES[got];
  const entry = {
    at, key: finding.key, from: step.from, to: got, saw: oneLine(finding.reason, 300),
    said: oneLine('The manager saw: ' + finding.reason + ' He lowered the trust level from ' + step.from + ', ' + plan.NAMES[step.from] + ': ' + done.join(', ') + '. ' + where + '.' + (missed.length ? ' He could not change ' + missed.join(', ') + '.' : '') + ' Raising it again is yours.', 600),
    say: oneLine((got === null ? 'Lowered the trust level a step.' : 'Lowered the trust level to ' + got + ', ' + plan.NAMES[got] + '.') + ' ' + finding.say, 140)
  };
  list.push(entry);
  list.splice(0, list.length - KEPT);
  return { entry };
}

module.exports = { lower, lowered, levelNow, STALLS, PER_DAY };
