// Keeps the Mac awake while the room has work, and wakes sessions a sleep cut off. Claude Code keeps the
// Mac awake only while it is in a turn, so the room slept between turns, and a turn that sleep cut short
// stopped with "Your computer went to sleep mid-response" and sat idle until someone nudged it.
//
// The hold is one `caffeinate -i -w <relay pid>` (macOS's own tool, no install) that the relay runs while
// the switch Keep the computer awake (Settings, keepAwake) is on and the room has work: a task that is
// building, has changes requested or is in review, or Autopilot on for any channel. It ends when the work
// ends or the switch goes off. -w ties it to the relay's process, so it ends with the relay even when the
// relay crashes and never runs its own clean-up. RELAY_CAFFEINATE names another tool that takes the same
// arguments, for the tests, and makes the hold work on a system that is not a Mac. With neither, nothing is held.
//
// Wake: a timer that runs every RELAY_AWAKE_EVERY_MS (5 seconds) sees the clock jump by more than
// RELAY_WAKE_GAP_MS (30 seconds) when the computer slept. For WAKE_WATCH after that, each look finds the
// sessions whose last output is the sleep message and whose hooks do not say they wait on the person, and
// saves one carry-on note for each (relay/delivery.js). The message can come seconds after the wake, so the
// relay looks again and again for a while. Each look before a wake counts the sleep messages on each
// session's screen, and only a message beyond that count is new, so one from an earlier sleep does not
// count, whatever else the session prints. A session is noted once for each wake, and not while it is in a turn.
'use strict';
const { spawn } = require('child_process');
const config = require('./config.js');
const tasks = require('./tasks.js');
const autopilot = require('./autopilot.js');
const terminal = require('./terminal.js');
const delivery = require('./delivery.js');

const EVERY = Number(process.env.RELAY_AWAKE_EVERY_MS) >= 1 ? Number(process.env.RELAY_AWAKE_EVERY_MS) : 5000;
const WAKE_GAP = Number(process.env.RELAY_WAKE_GAP_MS) >= 1 ? Number(process.env.RELAY_WAKE_GAP_MS) : 30000;
const WAKE_WATCH = Number(process.env.RELAY_WAKE_WATCH_MS) >= 1 ? Number(process.env.RELAY_WAKE_WATCH_MS) : 2 * 60 * 1000;
const WORKING = ['building', 'changes_requested', 'in_review'];
const SLEPT = 'wenttosleepmid-response';
const LAST = 1500;
const CARRY_ON = 'The computer went to sleep during your turn, so that turn was cut short. Go on from where you stopped.';
const KEY = (sessionId) => 'carry on after sleep ' + sessionId;

const tool = () => process.env.RELAY_CAFFEINATE || (process.platform === 'darwin' ? 'caffeinate' : null);
const hasWork = () => autopilot.anyOn() || tasks.channels().some((c) => tasks.list(c).some((t) => WORKING.includes(t.state)));

let log = () => {}, hold = null, broken = false, lastLook = Date.now(), watchUntil = 0;
const noted = new Set(), before = new Map();

function release() {
  if (!hold) return;
  const child = hold;
  hold = null;
  try { child.kill(); } catch (e) { log('Could not end the keep-awake process: ' + e.message); }
}
function acquire() {
  const cmd = tool();
  if (hold || broken || !cmd) return;
  const child = spawn(cmd, ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  hold = child;
  child.on('error', (e) => { if (hold === child) hold = null; broken = true; log('The room could not keep the computer awake: ' + e.message); });
  child.on('exit', () => { if (hold === child) hold = null; });
  log('The room keeps the computer awake while it has work.');
}
function settle() {
  if (config.get('keepAwake') && hasWork()) acquire();
  else if (hold) { release(); log('The room no longer keeps the computer awake.'); }
}

const countOf = (screen) => screen.split(SLEPT).length - 1;
function cutBySleep(t) {
  if (!t || t.exited || t.stopped || t.state === 'waiting' || t.state === 'working' || t.round) return false;
  const screen = terminal.screenOf(t);
  return countOf(screen) > (before.get(t.sessionId) || 0) && screen.slice(-LAST).includes(SLEPT);
}
function carryOn() {
  for (const t of terminal.everyone()) {
    if (noted.has(t.sessionId) || !cutBySleep(t)) continue;
    noted.add(t.sessionId);
    const who = (t.title || 'A session') + ' (' + String(t.sessionId).slice(0, 8) + ')';
    log(who + ' was cut off by the computer\'s sleep, so it gets a carry-on note once it shows its prompt mark.');
    delivery.save(t.channel, { key: KEY(t.sessionId), terminal: t.id, sessionId: t.sessionId, text: CARRY_ON, beforeTurn: true, untilTurn: true, on: (what, why) => {
      log(who + (what === 'delivered' ? ' took up its carry-on note.' : ' did not get its carry-on note: ' + why));
    } });
  }
}

function look() {
  const now = Date.now();
  if (now - lastLook > WAKE_GAP) { watchUntil = now + WAKE_WATCH; noted.clear(); log('The computer woke after ' + Math.round((now - lastLook) / 1000) + ' seconds, so the relay looks for sessions its sleep cut off.'); }
  lastLook = now;
  settle();
  if (now < watchUntil) carryOn();
  else for (const t of terminal.everyone()) before.set(t.sessionId, countOf(terminal.screenOf(t)));
}

function begin(ctx) {
  log = ctx.log;
  config.onChange((names) => { if (names.includes('keepAwake')) settle(); });
  setInterval(look, EVERY).unref();
  settle();
}

module.exports = { begin, release, hasWork, CARRY_ON };
