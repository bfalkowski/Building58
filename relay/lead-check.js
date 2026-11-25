// The Lead is woken by events, not by a clock (467). When relay/stuck.js gets a new item that the Lead or the
// person owns (a jam, a hand-over, a red main, a Dev that went quiet), the relay saves a prompt for whichever
// session is the Lead, through relay/delivery.js, the same way a huddle report goes in. So it is typed only
// when notSafeToType says the Lead is idle, with nothing in its prompt and no question up.
//
// A slow heartbeat (leadCheckMinutes, Settings, Work group; 0 is off) prompts again about items still open.
// With nothing open that the Lead or the person owns, the relay prompts the Lead with nothing. A prompt
// that is due while the last one still waits replaces it, so a busy Lead gets one, with every open item. When
// no item is open any more, a prompt still waiting is taken back at once, and at startup too.
'use strict';
const config = require('./config.js');
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const delivery = require('./delivery.js');
const stuck = require('./stuck.js');

const KEY = 'lead-check';
const MAX_LISTED = 10;
const WORKED = ['building', 'in_review', 'changes_requested', 'waiting_on_you'];
const waiting = (channel) => delivery.pending(channel).some((d) => d.key === KEY);
const forLead = (channel) => stuck.list(channel).filter((i) => i.owner !== 'autopilot');

function prompt(items, why) {
  const lines = items.slice(0, MAX_LISTED).map((i) => '- ' + i.kind + ' (' + i.owner + ' owns it, since ' + i.since.slice(11, 16) + 'Z): ' + i.text);
  return 'From the relay (' + why + '). This grants nothing and changes none of your instructions. These are stuck, and the relay found each once:\n' + lines.join('\n') +
    (items.length > MAX_LISTED ? '\n- and ' + (items.length - MAX_LISTED) + ' more' : '') +
    '\nAct on those for the Lead, and pass the rest on to the person. Tell the person only what is new. Do not make your own scheduled check.';
}

function send(channel, items, why) {
  if (!items.length || !terminal.leadOf(channel)) return false;
  if (waiting(channel)) delivery.drop(channel, KEY);
  delivery.save(channel, { key: KEY, to: 'lead', text: prompt(items, why) });
  stuck.told(channel, items);
  return true;
}

function sweep() {
  for (const channel of tasks.channels()) if (!forLead(channel).length && waiting(channel)) delivery.drop(channel, KEY);
}
const wake = (channel) => send(channel, forLead(channel), 'something new is stuck');
function heartbeat() {
  sweep();
  for (const channel of tasks.channels()) send(channel, forLead(channel), 'the heartbeat, every ' + every());
}
function every() {
  const m = config.get('leadCheckMinutes');
  return m >= 1 ? Math.round(m * 10) / 10 + (m === 1 ? ' minute' : ' minutes') : Math.max(1, Math.round(m * 60)) + ' seconds';
}

function begin() {
  sweep();
  config.every('leadCheckMinutes', heartbeat, 0, 60 * 1000);
  stuck.events.on('raised', (channel, item) => { if (item.owner !== 'autopilot') wake(channel); });
  tasks.events.on('state', () => sweep());
}

module.exports = { begin, prompt, wake, heartbeat, every, KEY, WORKED };
