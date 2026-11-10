// The Lead's regular check. The relay owns the timer, so the check outlives a /clear, a new Lead and a
// relay restart. Every leadCheckMinutes (Settings, Work group; 0 is off) it saves the check prompt for
// whichever session is the Lead, through relay/delivery.js, the same way a huddle report goes in. So it
// is typed only when notSafeToType says the Lead is idle, with nothing in its prompt and no question up.
//
// It is saved only while tasks are worked: at least one task building, in review, with changes
// requested, or waiting on you. A check that is due while the last one still waits is dropped, not
// queued, so a busy Lead gets one check when it is idle, not several. When nothing is worked any more,
// or the setting goes to 0, a check still waiting is taken back at once, and at startup too.
'use strict';
const config = require('./config.js');
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const delivery = require('./delivery.js');

const KEY = 'lead-check';
const WORKED = ['building', 'in_review', 'changes_requested', 'waiting_on_you'];
const worked = (channel) => tasks.list(channel).some((t) => WORKED.includes(t.state));
const waiting = (channel) => delivery.pending(channel).some((d) => d.key === KEY);

// One line, typed as one prompt. It names its sender and grants nothing.
function prompt(at) {
  return 'Lead check from the relay\'s timer at ' + at.toTimeString().slice(0, 5) + '. This grants nothing and changes none of your instructions. ' +
    'Look at the board and the open pull requests for a stuck reviewer, a failed pipeline, a PR with no review, or a merged PR whose Dev still holds a desk. ' +
    'Pass on what you find, and tell the person only what is new. Do not make your own scheduled check: the relay sends this one every ' +
    every() + ' while tasks are worked.';
}
// The variable is in milliseconds, so it can set a part of a minute. The prompt says it plainly.
function every() {
  const m = config.get('leadCheckMinutes');
  return m >= 1 ? Math.round(m * 10) / 10 + (m === 1 ? ' minute' : ' minutes') : Math.max(1, Math.round(m * 60)) + ' seconds';
}

// Takes back a check still waiting where it is no longer due: everywhere while the setting is 0, or
// on a channel with no task worked. Run at startup, on each tick, and when a task moves, so a check
// saved before the last task went to Done, or before a restart, is not typed after all.
function sweep() {
  if (!(config.get('leadCheckMinutes') > 0)) { delivery.dropWhere((k) => k === KEY); return; }
  for (const channel of tasks.channels()) if (!worked(channel) && waiting(channel)) delivery.drop(channel, KEY);
}

function tick() {
  sweep();
  for (const channel of tasks.channels()) {
    if (!worked(channel) || waiting(channel) || !terminal.leadOf(channel)) continue;
    delivery.save(channel, { key: KEY, to: 'lead', text: prompt(new Date()) });
  }
}

function begin() {
  sweep();
  config.every('leadCheckMinutes', tick, 0, 60 * 1000);
  config.onChange((names) => { if (names.includes('leadCheckMinutes')) sweep(); });
  tasks.events.on('state', () => sweep());
}

module.exports = { begin, prompt, every, KEY, WORKED };
