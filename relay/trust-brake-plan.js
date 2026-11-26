// The manager's brake (relay/trust-brake.js): which level the room is at, and what one step down changes.
// Plain functions with no side effects, so the tests can give each level its switches. See
// docs/manual/roles.html#manager-brake.
//
//   levelOf(switches, hasLead) -> 0..6, or null when the switches match no level
//   step(switches, hasLead)    -> { from, to, offs: [switch], ons: [switch] } or null when there is no level to lower from
//
// switches: { auto, again, board, stops, merge, starts, autopilot, exhibit }, the same eight the page's Set level
// button sets (office/terminal.js). relay/test/trust-brake-plan.test.js checks that this table and the page's agree.
// A step only ever goes down one level. It turns off what the lower level has off, then turns on what the lower
// level needs and the Lead can take: that is only the Lead's merge and starts, going from 5 to 4.
'use strict';

const KEYS = ['auto', 'again', 'board', 'stops', 'merge', 'starts', 'autopilot', 'exhibit'];
const row = (...on) => Object.fromEntries(KEYS.map((k) => [k, on.includes(k)]));
const LEVELS = [
  row('auto'),
  row('auto', 'again'),
  row('auto', 'again', 'board', 'stops'),
  row('auto', 'again', 'board', 'stops', 'starts'),
  row('auto', 'again', 'board', 'stops', 'merge', 'starts'),
  row('auto', 'again', 'board', 'stops', 'autopilot'),
  row('auto', 'again', 'board', 'stops', 'autopilot', 'exhibit')
];
const NAMES = ['You drive', 'Review loop', 'The Lead keeps work moving', 'The Lead starts tickets', 'The Lead merges', 'Autopilot', 'Autopilot with evidence'];

const wanted = (n, hasLead) => (n >= 5 && !hasLead ? Object.assign({}, LEVELS[n], { board: false }) : LEVELS[n]);
function levelOf(switches, hasLead) {
  const at = LEVELS.findIndex((_, n) => KEYS.every((k) => wanted(n, hasLead)[k] === !!switches[k]));
  return at < 0 ? null : at;
}
function step(switches, hasLead) {
  const from = levelOf(switches, hasLead);
  if (from === null || from === 0) return null;
  const to = from - 1, want = wanted(to, hasLead);
  return { from, to, offs: KEYS.filter((k) => switches[k] && !want[k]), ons: KEYS.filter((k) => !switches[k] && want[k]) };
}

module.exports = { KEYS, LEVELS, NAMES, levelOf, step };
