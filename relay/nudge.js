// Autopilot's nudge (relay/autopilot.js, stalled). Before it hands you a task whose Dev stopped with no
// PR, it tells the Dev once, through the saved delivery queue (relay/delivery.js). On 2026-11-08 three
// Devs ended their turn to wait for npm test in the background. A relay restart ended two of those runs,
// those Devs never acted again, and Autopilot parked all three. One message would have started them.
//
// One nudge per task per stall: the nudge is kept in Autopilot's store (c.nudged), so a relay restart
// does not send a second one. forget() drops it each time Autopilot parks or hands over the task, for
// any reason, so after the person moves the card back the next stall gets a new nudge. After it, the task
// waits another stall time. If the Dev is still idle with no PR then, whether or not it took a turn, the
// task is parked, and the reason says what became of the nudge: typed in, then a turn or none, or never
// typed in. The delivery queue says when it was typed (typedAt). Its word is not saved, so after a relay
// restart watch() asks for it again while the nudge still waits to go in.
'use strict';
const delivery = require('./delivery.js');
const { livenessOf } = require('./liveness.js');

const TEXT = 'Your task has no PR yet. If a test run was lost, run it again in the foreground and open the PR. If you are blocked, say why.';
const keyOf = (task) => 'autopilot-nudge ' + task.id;
const minutes = (ms) => Math.max(0, Math.round(ms / 60000));

function send(channel, c, id, n, save) {
  delivery.save(channel, { key: keyOf({ id }), terminal: n.terminal, sessionId: n.sessionId, text: TEXT, expiresAt: n.expiresAt, on: (what) => {
    if (what === 'delivered' && c.nudged && c.nudged[id] === n) { n.typedAt = Date.now(); save(); }
  } });
}

function first(channel, c, task, dev, stallMs, save) {
  if (task.pr || !dev || (c.nudged && c.nudged[task.id])) return false;
  if (livenessOf(dev, Date.now()).state !== 'idle') return false;
  const n = { at: Date.now(), terminal: dev.id, sessionId: dev.sessionId, expiresAt: Date.now() + stallMs, typedAt: null };
  (c.nudged || (c.nudged = {}))[task.id] = n;
  save();
  send(channel, c, task.id, n, save);
  return true;
}

function watch(channel, c, save) {
  if (!Object.values(c.nudged || {}).some((n) => !n.typedAt)) return;
  const waiting = new Set(delivery.pending(channel).map((d) => d.key));
  for (const [id, n] of Object.entries(c.nudged || {})) if (!n.typedAt && n.terminal && waiting.has(keyOf({ id }))) send(channel, c, id, n, save);
}

function forget(channel, c, task) {
  if (c.nudged) delete c.nudged[task.id];
  delivery.drop(channel, keyOf(task));
}

function noPrWhy(channel, c, task, dev, now) {
  const n = c.nudged && c.nudged[task.id];
  const lv = livenessOf(dev, now);
  if (lv.state === 'gone') return 'its Dev\'s session ended, and there is no PR';
  const idle = 'its Dev has been idle for ' + minutes(now - (lv.since || Date.parse(dev.startedAt) || now)) + ' minutes with no PR';
  if (!n) return idle;
  const typedAt = n.typedAt === undefined ? n.at : n.typedAt;
  if (!typedAt) return idle + ', and the nudge Autopilot saved for it ' + minutes(now - n.at) + ' minutes ago was never typed in';
  const ago = minutes(now - typedAt);
  return idle + ((dev.turnAt || 0) >= typedAt ? ', and took a turn after Autopilot nudged it ' + ago + ' minutes ago'
    : ', and did not start a turn after Autopilot nudged it ' + ago + ' minutes ago');
}

module.exports = { first, watch, forget, noPrWhy, TEXT };
