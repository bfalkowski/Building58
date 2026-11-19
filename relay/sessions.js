// Brings back every session that was running when the last relay stopped, with the same title, task,
// role, PR, person (relay/seats.js), and Lead, board and merge state. relay/terminal.js keeps the list in
// sessions.json in the state folder. After a restart a session is still running in the session host
// (relay/session-host.js), so it is taken back as it is: the same process, desk and output, and a turn
// in progress goes on. After a stop it starts again with `claude --resume` in the same folder. A
// session nobody spoke to has no conversation to resume, so it starts a new one in the same place.
// A session still running in the host that nothing takes back ends.
//
// One that cannot come back (start refuses it, or it ends within seconds) stays on the list marked
// failed, and the next start tries again (relay/terminal.js), unless its folder is gone. Its checkout
// stays while it is on that list. The panel lists it with its id for Resume.
//
// A reviewer's, the PM's or the COO's first prompt that no turn began on before the restart goes in after it
// (relay/delivery.js, promptOnce).
//
// Then the room's channel gets a Lead, if none came back (startLead).
//
// A task's worker comes back the way Bring back brings it (relay/tasks.js), so a task whose brief
// never went in starts over with it. A worker brought back with claude --resume that was in a turn when
// the relay stopped, on a task in Building or Changes requested with no PR, had that turn cut short and
// comes back idle (T-348). So the relay saves one continue prompt for it (relay/delivery.js), typed once
// it shows its prompt mark, and dropped if a turn begins first. One taken back still running goes on in
// its turn and gets none. While the prompt waits, Needs you does not list the Dev as idle (owesContinue). A worker or reviewer in its own checkout keeps the checkout's
// clean-up for when it ends (relay/checkouts.js).
'use strict';
const fs = require('fs');
const terminal = require('./terminal.js');
const delivery = require('./delivery.js');
const tasks = require('./tasks.js');
const checkouts = require('./checkouts.js');

const GONE = 'its task is gone';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CUT = ['working', 'waiting'];
const BUILDING = ['building', 'changes_requested'];
const CONTINUE = 'The relay restarted while you were in a turn, so that turn was cut short. Go on with your task from where you stopped.';
const CONTINUE_KEY = (sessionId) => 'continue after restart ' + sessionId;
function continueCutTurn(channel, s, task, ctx) {
  if (!CUT.includes(s.state) || s.pr || task.pr || task.briefed === false || !BUILDING.includes(task.state)) return;
  const t = terminal.find(channel, task.owner && task.owner.terminal);
  if (!t || t.sessionId !== s.sessionId) return;
  const who = (s.title || 'A Dev') + ' (' + String(s.sessionId).slice(0, 8) + ')';
  ctx.log(who + ' was in a turn when the relay stopped, so it gets a continue prompt once it shows its prompt mark.');
  delivery.save(channel, { key: CONTINUE_KEY(t.sessionId), terminal: t.id, sessionId: t.sessionId, text: CONTINUE, beforeTurn: true, untilTurn: true, on: (what, why) => {
    ctx.log(who + (what === 'delivered' ? ' took up its continue prompt.' : ' did not get its continue prompt: ' + why));
  } });
}
function owesContinue(channel, t) {
  return !!t && delivery.pending(channel).some((d) => d.target === t.id && d.key === CONTINUE_KEY(t.sessionId));
}

function restoreOne(channel, s, ctx, still) {
  const resume = s.talked && UUID.test(s.sessionId || '') ? s.sessionId : undefined;
  const size = { cols: s.cols, rows: s.rows };
  if (s.task) {
    const task = tasks.list(channel).find((x) => x.id === s.task);
    if (!task) return GONE;
    if (task.owner && resume) task.owner.sessionId = resume;
    const [status, out] = tasks.resume(channel, task, size, ctx, 'relay', true);
    if (status >= 400) return out.message;
    if (resume && !still) continueCutTurn(channel, s, task, ctx);
    return null;
  }
  const body = Object.assign({ cwd: s.cwd, from: s.from, title: s.title, role: s.role, pr: s.pr, resume }, size);
  const r = terminal.start(channel, body, ctx, checkouts.onExitFor(channel, s.cwd, ctx.log),
    { kept: { lead: s.lead, board: s.board, merge: s.merge, starts: s.starts, startsLeft: s.startsLeft, owesBrief: s.owesBrief, posted: s.posted || null }, reviewOf: s.reviewOf || null });
  if (r.status >= 400) return r.body.message;
  if (typeof s.owesPrompt === 'string' && s.owesPrompt) {
    delivery.promptOnce(channel, r.body.id, s.owesPrompt, (problem) => { if (problem) ctx.log((s.title || 'A session') + ' did not get its first prompt: ' + problem); }, s.terminal);
  }
  return null;
}

const restored = { done: false, saved: 0, back: 0, failed: [] };

const SEATS = () => require('./round-seats.js').dir();
function dropSeats(channel, list, ctx) {
  const seats = list.filter((s) => s && typeof s === 'object' && s.round);
  for (const s of seats) ctx.log('Did not bring back ' + (s.title || 'a seat') + ' on ' + channel + ': a round of a game ends with the relay that ran it.');
  return list.filter((s) => !seats.includes(s));
}
function restoreAll(ctx) {
  try { fs.rmSync(SEATS(), { recursive: true, force: true }); } catch (e) { ctx.log('Could not remove the old seat folders: ' + e.message); }
  if (!terminal.ENABLED || process.env.RELAY_RESUME === '0') { terminal.takeLastRun(); if (terminal.ENABLED) terminal.dropUnclaimed(ctx.log); restored.done = true; return; }
  const last = terminal.takeLastRun();
  for (const channel of Object.keys(last)) {
    const list = dropSeats(channel, Array.isArray(last[channel]) ? last[channel] : [], ctx);
    list.sort((a, b) => (b.lead ? 1 : 0) - (a.lead ? 1 : 0));
    terminal.holdSeats(channel, list.filter((s) => s && typeof s === 'object'));
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      let problem;
      const still = terminal.stillRunning(channel, s);
      try { problem = terminal.bringingBack(s, () => restoreOne(channel, s, ctx, still)); } catch (e) { problem = e.message; }
      const who = (s.title || s.role || 'a session') + ' (' + String(s.sessionId || '').slice(0, 8) + ')';
      ctx.log(problem ? 'Could not bring back ' + who + ' on ' + channel + ': ' + problem : (still ? 'Took back ' : 'Brought back ') + who + ' on ' + channel + (still ? ', still running' : ''));
      const running = terminal.everyone().some((t) => t.sessionId === s.sessionId);
      const kept = problem && s.talked && UUID.test(s.sessionId || '') && problem !== GONE && !running && s.cwd && fs.existsSync(s.cwd);
      if (kept) terminal.markFailed(channel, s, problem);
      restored.saved++;
      if (!problem || running) restored.back++;
      else if (kept && !s.failed) restored.failed.push({ who, why: problem });
    }
  }
  terminal.dropUnclaimed(ctx.log);
  restored.done = true;
}

function startLead(channel, ctx) {
  if (!terminal.ENABLED || !channel || process.env.RELAY_RESUME === '0' || process.env.RELAY_LEAD === '0') return;
  try { terminal.startLead(channel, process.cwd(), ctx); } catch (e) { ctx.log('Could not start a Lead on ' + channel + ': ' + e.message); }
}

module.exports = { restoreAll, restored, startLead, owesContinue };
