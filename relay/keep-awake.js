// Keeps the Mac awake while the room has work, and wakes sessions the sleep cut short. On 2026-11-19 and
// 2026-11-20 the Mac slept between turns, and each session in a turn stopped with "Your computer went to
// sleep mid-response" and sat idle. Claude Code holds the Mac awake only while it works.
//
// The hold is one `caffeinate -i -w <the relay's pid>` (macOS's own tool, no install). It is held while the
// Keep the computer awake switch is on and a task is building or in review, or Autopilot is on. -w ends it
// when the relay ends, also when the relay crashes. Elsewhere the switch does nothing.
//
// A timer ticks every few seconds. A tick that comes much later than it should means the computer slept.
// After that, a session whose screen ends with the sleep message, and that is not waiting on the person, gets
// one carry-on note, through relay/delivery.js, dropped if a turn begins first. A session carried on once
// gets another only after it took a turn since.
'use strict';
const { spawn } = require('child_process');
const config = require('./config.js');
const tasks = require('./tasks.js');
const terminal = require('./terminal.js');
const delivery = require('./delivery.js');
const autopilot = require('./autopilot.js');
const { livenessOf } = require('./liveness.js');

const WORK = ['building', 'in_review'];
const SLEPT = /wenttosleepmid-?response/i;
const TEXT = 'The computer went to sleep while you were in a turn, so that turn was cut short. Go on with your task from where you stopped.';
const num = (name, def) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : def);
const TICK = () => num('RELAY_KEEP_AWAKE_TICK_MS', 5000);
const GAP = () => num('RELAY_WAKE_GAP_MS', 30000);
const platform = () => process.env.RELAY_KEEP_AWAKE_PLATFORM || process.platform;
const command = () => process.env.RELAY_KEEP_AWAKE_CMD || 'caffeinate';

const supported = () => platform() === 'darwin';
function hasWork() {
  return tasks.channels().some((c) => autopilot.isOn(c) || tasks.list(c).some((t) => WORK.includes(t.state)));
}
const wanted = (on, work, mac) => !!(on && work && mac);

let hold = null, broken = false, log = console.log;
function sync() {
  const want = wanted(config.get('keepAwake'), hasWork(), supported());
  if (want && !hold && !broken) {
    const child = spawn(command(), ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    hold = child;
    child.on('error', (e) => { log('Could not keep the computer awake with ' + command() + ': ' + e.message); broken = true; if (hold === child) hold = null; });
    child.on('exit', () => { if (hold === child) hold = null; });
    log('Keeping the computer awake while the room has work.');
  } else if (!want && hold) {
    const child = hold;
    hold = null;
    child.kill();
    log('No longer keeping the computer awake.');
  }
}
const holding = () => !!hold;

const carried = new Map();
function cut(t) {
  if (!t || !t.tail) return false;
  const state = livenessOf(t, Date.now()).state;
  if (state === 'gone' || state === 'waiting') return false;
  if (!SLEPT.test(terminal.screenOf(t).slice(-300))) return false;
  const was = carried.get(t.sessionId);
  return !was || (t.turnAt || 0) > was;
}
function carryOn() {
  for (const t of terminal.everyone()) {
    if (!cut(t)) continue;
    carried.set(t.sessionId, Date.now());
    log((t.title || 'A session') + ' was cut short by the computer sleeping, so it gets a carry-on note.');
    delivery.save(t.channel, { key: 'wake carry-on ' + t.sessionId, terminal: t.id, sessionId: t.sessionId, text: TEXT, beforeTurn: true, untilTurn: true, expiresAt: Date.now() + 10 * 60 * 1000 });
  }
}

function begin(opts) {
  if (opts && opts.log) log = opts.log;
  let last = Date.now();
  const tick = () => {
    const now = Date.now();
    const woke = now - last > GAP();
    last = now;
    sync();
    if (woke) { log('The computer woke from sleep.'); carryOn(); }
  };
  setInterval(tick, TICK()).unref();
  config.onChange((names) => { if (names.includes('keepAwake')) sync(); });
  tasks.events.on('state', sync);
  sync();
}

module.exports = { begin, sync, holding, wanted, cut, carryOn, TEXT };
