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
// never went in starts over with it. A worker or reviewer in its own checkout keeps the checkout's
// clean-up for when it ends (relay/checkouts.js).
'use strict';
const fs = require('fs');
const path = require('path');
const terminal = require('./terminal.js');
const delivery = require('./delivery.js');
const tasks = require('./tasks.js');
const checkouts = require('./checkouts.js');

const GONE = 'its task is gone';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function restoreOne(channel, s, ctx) {
  const resume = s.talked && UUID.test(s.sessionId || '') ? s.sessionId : undefined;
  const size = { cols: s.cols, rows: s.rows };
  if (s.task) {
    const task = tasks.list(channel).find((x) => x.id === s.task);
    if (!task) return GONE;
    if (task.owner && resume) task.owner.sessionId = resume;  // /clear may have moved it on since the task last looked
    const [status, out] = tasks.resume(channel, task, size, ctx, 'relay', true);  // past the WIP limit: it was building before
    return status < 400 ? null : out.message;
  }
  const body = Object.assign({ cwd: s.cwd, from: s.from, title: s.title, role: s.role, pr: s.pr, resume }, size);
  const r = terminal.start(channel, body, ctx, checkouts.onExitFor(channel, s.cwd, ctx.log),
    { kept: { lead: s.lead, board: s.board, merge: s.merge, starts: s.starts, startsLeft: s.startsLeft, owesBrief: s.owesBrief, posted: s.posted || null }, reviewOf: s.reviewOf || null });
  if (r.status >= 400) return r.body.message;
  // A reviewer's, the PM's or the COO's first prompt that no turn began on yet. One that did is in the
  // conversation. Its saved delivery follows the session from its old desk (s.terminal): one that ran on
  // through a restart keeps it as it was, and one that came back after a stop gets it typed again.
  if (typeof s.owesPrompt === 'string' && s.owesPrompt) {
    delivery.promptOnce(channel, r.body.id, s.owesPrompt, (problem) => { if (problem) ctx.log((s.title || 'A session') + ' did not get its first prompt: ' + problem); }, s.terminal);
  }
  return null;
}

// What the last restoreAll did, for the supervisor's check (relay/rollback.js). A session whose task
// or folder is gone could not come back on any code, and one that already failed on an earlier start
// says nothing about this code, so neither is counted as failed. Nor is one the relay would not keep
// on its failed list.
const restored = { done: false, saved: 0, back: 0, failed: [] };

// Runs once, when the relay starts. Says what came back and what did not.
// No round of a game outlives the relay that ran it (relay/games.js). Its seats are never brought
// back: the host hangs them up with the other unclaimed sessions, and their folders go.
const SEATS = () => path.join(require('./state.js').dir(), 'seats');
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
    // The Lead first, so a second session that once shared its id cannot take the Lead's place.
    list.sort((a, b) => (b.lead ? 1 : 0) - (a.lead ? 1 : 0));
    // Each comes back as the person it was, so nobody takes a person whose session is not back yet.
    terminal.holdSeats(channel, list.filter((s) => s && typeof s === 'object'));
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      let problem;
      const still = terminal.stillRunning(channel, s);
      try { problem = terminal.bringingBack(s, () => restoreOne(channel, s, ctx)); } catch (e) { problem = e.message; }
      const who = (s.title || s.role || 'a session') + ' (' + String(s.sessionId || '').slice(0, 8) + ')';
      ctx.log(problem ? 'Could not bring back ' + who + ' on ' + channel + ': ' + problem : (still ? 'Took back ' : 'Brought back ') + who + ' on ' + channel + (still ? ', still running' : ''));
      // One with a conversation stays on the list, so the next start tries again. A task that is gone does not.
      // One already running here (two saved under one id after /clear) has come back.
      // One whose folder is gone cannot come back there, so it is not kept.
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

// Runs once, after restoreAll: the channel the room's sessions run on gets a running Lead, unless one
// came back (relay/terminal.js, startLead). A new one starts in the folder the relay runs in, which the
// panel also offers first. RELAY_RESUME=0 starts the relay with nobody, so no Lead either, and
// RELAY_LEAD=0 turns off only this.
function startLead(channel, ctx) {
  if (!terminal.ENABLED || !channel || process.env.RELAY_RESUME === '0' || process.env.RELAY_LEAD === '0') return;
  try { terminal.startLead(channel, process.cwd(), ctx); } catch (e) { ctx.log('Could not start a Lead on ' + channel + ': ' + e.message); }
}

module.exports = { restoreAll, restored, startLead };
