// The Lead's unstick commands (T-479, the rest of T-466). While the person has turned on Let the Lead unstick the
// board, the Lead may tell a session something, bring a stopped Dev back, hand a task back to Autopilot and end
// a stuck command, each through its own route here, and rerun a known flaky job (relay/failures.js). They work
// while Autopilot is on too: leadRefusal in relay/autopilot.js lets them through only with the rung on, and
// answers 403 with the reason when it is off. Each one that acts writes a jam by: Lead (relay/jams.js).
// Autopilot still starts and merges. See docs/manual/roles.html#unstick.
'use strict';
const terminal = require('./terminal.js');
const delivery = require('./delivery.js');
const jams = require('./jams.js');
const tasks = require('./tasks.js');
const floor = require('./floor.js');
const crypto = require('crypto');
const { oneLine } = require('./clean.js');

const MAY_HAND_BACK = ['stalled', 'dev-gone', 'conflict-dropped', 'main-kept-moving', 'merge-failed'];
const COMMANDS = ['tell', 'bring-back', 'hand-back', 'stop-command'];
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const bad = (message) => [400, { ok: false, error: 'bad_param', message }];

function log(channel, kind, fix, task) {
  jams.record(channel, { kind, fix: oneLine(fix, 200), by: 'Lead', ticket: task && task.ticket || undefined, pr: task && task.pr || undefined });
}

function tell(channel, body) {
  const text = oneLine(body.text, 500);
  if (!text) return bad('"text" is what to tell the session, in one line.');
  const [t, status, error, message] = floor.pick(channel, body.who);
  if (!t) return [status, { ok: false, error, message }];
  if (terminal.leadOf(channel) === t) return [409, { ok: false, error: 'is_lead', message: 'That is you. Tell the person instead.' }];
  const name = floor.nameOf(t);
  delivery.save(channel, { key: 'lead-tell ' + t.id + ' ' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 12), terminal: t.id, sessionId: t.sessionId, expiresAt: Date.now() + TWELVE_HOURS, text: 'From the Lead: ' + text });
  log(channel, 'other', 'Told ' + name + ': ' + text);
  return [200, { ok: true, told: { name, terminal: t.id }, message: 'Saved for ' + name + '. It is typed when the session is idle.' }];
}

function taskOf(channel, id) {
  return tasks.list(channel).find((x) => x.id === String(id || '')) || null;
}

function bringBack(channel, body, ctx) {
  const task = taskOf(channel, body.task);
  if (!task) return [404, { ok: false, error: 'no_task', message: 'No such task on this channel. ticket.js tasks lists them.' }];
  const [status, out] = tasks.resume(channel, task, {}, ctx, 'Lead');
  if (status < 400) log(channel, 'dev-idle', 'Brought back the Dev of ' + (task.ticket || 'task ' + task.id), task);
  return [status, out];
}

function handBack(channel, body) {
  const task = taskOf(channel, body.task);
  const autopilot = require('./autopilot.js');
  if (!task) return [404, { ok: false, error: 'no_task', message: 'No such task on this channel. ticket.js tasks lists them.' }];
  if (!autopilot.isOn(channel)) return [409, { ok: false, error: 'autopilot_off', message: 'Autopilot is off, so there is nothing to hand this back to.' }];
  if (task.state !== 'waiting_on_you') return [409, { ok: false, error: 'not_handed', message: 'That task is in ' + task.state + ', not Waiting on you, so Autopilot did not hand it over.' }];
  const reason = autopilot.handedReasonFor(channel, task);
  if (!reason) return [409, { ok: false, error: 'not_handed', message: 'Autopilot did not hand this task over, so the person put it in Waiting on you. Leave it to them.' }];
  if (!MAY_HAND_BACK.includes(reason)) return [403, { ok: false, error: 'persons_decision', message: 'Autopilot handed this task over for a decision that is the person\'s (' + reason + '). Tell the person instead.' }];
  tasks.setState(channel, task, 'in_review', 'Lead', autopilot.HAND_BACK);
  log(channel, 'handed-over', 'Handed ' + (task.ticket || 'task ' + task.id) + ' back to Autopilot', task);
  return [200, { ok: true, task: { id: task.id, state: task.state, pr: task.pr }, message: 'Handed back. Autopilot takes it from its next pass.' }];
}

function stopCommand(channel, body, ctx) {
  const out = floor.endJob(channel, body, ctx, Date.now(), true);
  if (out[0] === 200) log(channel, 'stuck-job', 'Ended the stuck command ' + out[1].ended.pid + ' of ' + out[1].ended.name);
  return out;
}

async function handle(req, res, channel, rest, ctx) {
  const route = rest.match(/^\/lead\/(tell|bring-back|hand-back|stop-command)$/);
  if (!route) return false;
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (req.method !== 'POST') { ctx.problem(res, 404, 'not_found', 'The Lead commands answer POST only.'); return true; }
  if (!ctx.agent || !ctx.agent.lead) { ctx.problem(res, 403, 'forbidden', 'Only the Lead uses this route.'); return true; }
  const refused = require('./autopilot.js').leadRefusal(channel, '', false, route[1]);
  if (refused) { ctx.send(res, refused[0], refused[1]); return true; }
  const raw = await ctx.readJson(req), body = raw && typeof raw === 'object' ? raw : {};
  const out = route[1] === 'tell' ? tell(channel, body) : route[1] === 'bring-back' ? bringBack(channel, body, ctx) : route[1] === 'hand-back' ? handBack(channel, body) : stopCommand(channel, body, ctx);
  ctx.send(res, out[0], out[1]);
  return true;
}

module.exports = { handle, handBack, COMMANDS };
