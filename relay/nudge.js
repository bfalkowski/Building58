// Autopilot's nudge (relay/autopilot.js, stalled). Before it hands you a task whose Dev stopped with no
// PR, it tells the Dev once, through the saved delivery queue (relay/delivery.js). On 2026-11-08 three
// Devs ended their turn to wait for npm test in the background. A relay restart ended two of those runs,
// those Devs never acted again, and Autopilot parked all three. One message would have started them.
//
// One nudge per task per stall: the nudge is kept in Autopilot's store (c.nudged), so a relay restart
// does not send a second one, and it is forgotten once the task is parked. After it, the task waits
// another stall time. If the Dev is still idle with no PR then, whether or not it took a turn, the task
// is parked, and the reason says it was nudged.
'use strict';
const delivery = require('./delivery.js');
const { livenessOf } = require('./liveness.js');

const TEXT = 'Your task has no PR yet. If a test run was lost, run it again in the foreground and open the PR. If you are blocked, say why.';
const keyOf = (task) => 'autopilot-nudge ' + task.id;
const minutes = (ms) => Math.max(0, Math.round(ms / 60000));

// c is Autopilot's store for the channel, and save writes it. Nudges the Dev of a task with no PR when it
// is idle (not running a job, not in a turn, not stuck) and was not nudged in this stall. Returns true when
// it nudged now, so the caller waits another stall time before it parks the task.
function first(channel, c, task, dev, stallMs, save) {
  if (task.pr || !dev || (c.nudged && c.nudged[task.id])) return false;
  if (livenessOf(dev, Date.now()).state !== 'idle') return false;
  (c.nudged || (c.nudged = {}))[task.id] = { at: Date.now(), sessionId: dev.sessionId };
  save();
  delivery.save(channel, { key: keyOf(task), terminal: dev.id, sessionId: dev.sessionId, text: TEXT, expiresAt: Date.now() + stallMs });
  return true;
}

// Why a task with no PR goes to Waiting on you, from what is true now: its Dev's session ended, or its
// Dev is idle, for as long as since its last hook, or since its session started if it sent none. It
// forgets the nudge, and drops it if it was never typed, since the task is parked now.
function noPrWhy(channel, c, task, dev, now) {
  const n = c.nudged && c.nudged[task.id];
  if (n) { delete c.nudged[task.id]; delivery.drop(channel, keyOf(task)); }
  const lv = livenessOf(dev, now);
  if (lv.state === 'gone') return 'its Dev\'s session ended, and there is no PR';
  const idle = 'its Dev has been idle for ' + minutes(now - (lv.since || Date.parse(dev.startedAt) || now)) + ' minutes with no PR';
  if (!n) return idle;
  const ago = minutes(now - n.at);
  return idle + ((dev.turnAt || 0) >= n.at ? ', and took a turn after Autopilot nudged it ' + ago + ' minutes ago'
    : ', and did not start a turn after Autopilot nudged it ' + ago + ' minutes ago');
}

module.exports = { first, noPrWhy, TEXT };
