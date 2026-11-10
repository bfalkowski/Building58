// Is this session alive? One answer, from all the relay sees of it together: what its hooks last said
// (t.state, t.lastActAt), when it last printed (t.lastOutAt, which comes from the session host through
// relay/host-link.js), whether its process ended (t.exited, t.stopped), and whether relay/delivery.js
// found that it did not start on what it was told (t.stuck). The Floor (relay/floor.js, relay/desk.js),
// Autopilot's stall check (relay/autopilot.js) and the COO's stall count (relay/coo.js) ask this, and
// none of them reads hooks for it. Plain, so the tests can run it on its own.
//
//   livenessOf(t, now, stallMs) -> { state, since, cause }
//
//   gone     its process ended, or it was stopped and is ending
//   waiting  hooks say it waits on the person. Not stuck however long: the question is theirs.
//   idle     hooks say its turn ended
//   job      hooks say its turn ended, but a command it started still runs, such as npm test in the
//            background (relay/jobs.js, which the session host runs). Busy, not idle: Autopilot does not
//            count it as stalled, Update waits for it, and it is not safe to stop.
//   working  in a turn, and a hook came within the stall time
//   quiet    in a turn, no hook for the stall time, but it printed within it
//   stuck    in a turn, with no hook and no output for the stall time (cause 'silent'), or out of a turn,
//            told something by the relay and no turn began after it (cause 'told', relay/delivery.js)
//
// Only a hook is progress. Claude Code's spinner and its timer keep printing while it thinks, and while a
// long command runs, so output says only that the process is alive and drawing. Output never makes a
// session working: it only keeps a session whose hooks went silent from being called stuck. That session
// is quiet: it may be thinking, running a long command, or sending hooks that no longer reach the relay,
// and the relay cannot tell which. Nothing acts on quiet by itself. The Floor shows it, and the COO lists it.
//
// since: when the state began, as far as the relay can tell. For quiet and job, the last hook. For stuck, when the
// last hook or output came, whichever was later, or when it was told. null for gone.
// delivery's stuck stays decided in relay/delivery.js, which watches a note it typed and tries once more.
// This module only reports it, so there is one place to ask.
'use strict';
const config = require('./config.js');
const STALL = () => config.get('stallMinutes') * 60 * 1000;  // read at each use (Settings)

// A session's jobs: { count, since } or null. t.jobs where a test sets it, otherwise what the session host
// last said for that session, which relay/host-link.js keeps and hands here with useJobs.
let jobsSource = () => null;
const useJobs = (fn) => { jobsSource = fn; };
const jobsOf = (t) => (!t ? null : t.jobs !== undefined ? t.jobs : jobsSource(t.id));

function livenessOf(t, now, stallMs) {
  const at = (state, since, cause) => ({ state, since: since == null ? null : since, cause: cause || null });
  if (!t || t.exited || t.stopped) return at('gone', null);
  const stall = stallMs === undefined ? STALL() : stallMs;
  const hookAt = t.lastActAt || 0, outAt = t.lastOutAt || 0;
  if (t.state === 'waiting') return at('waiting', t.waitingAt || hookAt);
  if (t.state !== 'working') {
    if (t.stuck) return at('stuck', t.stuck.at, 'told');
    const jobs = jobsOf(t);
    return jobs && jobs.count > 0 ? at('job', hookAt) : at('idle', hookAt);
  }
  if (now - hookAt < stall) return at('working', hookAt);
  if (now - outAt < stall) return at('quiet', hookAt);
  return at('stuck', Math.max(hookAt, outAt), 'silent');
}

// The jobs of a session, in words for the Floor.
function jobWords(t) {
  const n = (jobsOf(t) || {}).count || 0;
  return n > 1 ? n + ' commands it started still run' : 'a command it started still runs';
}

module.exports = { livenessOf, jobsOf, jobWords, useJobs, STALL };
