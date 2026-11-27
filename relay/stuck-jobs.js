// Stuck jobs. The session host (relay/jobs.js) says which of a session's jobs did nothing for 30 minutes:
// no CPU in its process tree and no new output in its output file. This module acts on that, once a look:
//   1. A Dev with a stuck job is told once, as a saved message (relay/delivery.js): the command, that it
//      has done nothing, and that a wait for a background command ends by itself, since Claude Code
//      reports it.
//   2. If that job is still stuck SECOND later (10 minutes), the relay ends that one process tree through
//      the session host, never the session, and logs a stuck-job jam signed 'room', the relay's name in
//      the jam log (relay/jams.js).
// The person ends a stuck job at any time with End it on its Needs you line, and the Lead with POST
// /floor/end-job while Let the Lead stop sessions is on, Autopilot on or off. The host ends only a
// process that is a job of that session. The relay asks only for a job it holds as stuck, and the host checks only
// that the process is a job of that session.
// See docs/manual/roles.html#stuck-jobs.
'use strict';
const delivery = require('./delivery.js');
const hostLink = require('./host-link.js');
const jams = require('./jams.js');
const chat = require('./chat.js');
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const { stuckJobsOf, stuckJobWords } = require('./liveness.js');
const { oneLine } = require('./clean.js');

const positive = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
const EVERY = () => positive('RELAY_STUCK_JOB_CHECK_MS', 10000);
const SECOND = () => positive('RELAY_STUCK_JOB_SECOND_MS', 10 * 60 * 1000);
const KEEP = 12 * 60 * 60 * 1000;
const minutes = (ms) => Math.max(0, Math.floor(ms / 60000));

const told = new Map();
const keyOf = (t, job) => t.id + ' ' + job.pid + ' ' + job.since;
const commandOf = (job) => oneLine(job.command, 120) || 'a command';

const textOf = (job) => 'Your command ' + commandOf(job) + ' has done nothing for 30 minutes. If it waits for a background command, Claude Code tells you when that ends, so end the loop.';

function stuckOf(t, now) {
  return stuckJobsOf(t).map((j) => ({ pid: j.pid, command: commandOf(j), since: j.since, minutes: minutes(now - j.since), line: stuckJobWords(j, now) }));
}

function jam(channel, t, job, task, by, now) {
  const fix = oneLine(by + ' ended the stuck job ' + commandOf(job) + ' of ' + (t.who || 'a session') + ' after ' + minutes(now - job.since) + ' min with no CPU and no new output.', 200);
  jams.record(channel, { kind: 'stuck-job', by: 'room', since: new Date(job.since).toISOString(), ticket: (task && task.ticket) || undefined, pr: (task && task.pr) || undefined, fix });
}

function endOne(channel, t, job, by, now) {
  if (!hostLink.endJob(t.id, job.pid)) return false;
  const task = t.task ? tasks.list(channel).find((x) => x.id === t.task) : null;
  jam(channel, t, job, task, by, now);
  chat.announce(channel, by + ' ended the stuck job ' + commandOf(job) + ' of ' + (t.who || 'a session') + ' after ' + minutes(now - job.since) + ' min with no CPU and no new output. The session runs on.', task && task.ticket);
  return true;
}

function look(now) {
  const seen = new Set();
  for (const t of terminal.everyone()) {
    if (!t.task || t.exited || t.stopped) continue;
    for (const job of stuckJobsOf(t)) {
      const key = keyOf(t, job);
      seen.add(key);
      const rec = told.get(key);
      if (!rec) {
        delivery.save(t.channel, { key: 'stuck-job ' + t.id + ' ' + job.pid, terminal: t.id, sessionId: t.sessionId, expiresAt: now + KEEP, text: textOf(job) });
        told.set(key, { at: now });
      } else if (now - rec.at >= SECOND() && !rec.ended) {
        rec.ended = endOne(t.channel, t, job, 'The relay', now);
      }
    }
  }
  for (const key of told.keys()) if (!seen.has(key)) told.delete(key);
}

function endByPerson(channel, t, pid, by, now) {
  const job = stuckJobsOf(t).find((j) => j.pid === pid);
  if (!job) return false;
  return endOne(channel, t, job, by, now);
}

function begin() {
  const timer = setInterval(() => look(Date.now()), EVERY());
  timer.unref();
}

module.exports = { begin, look, stuckOf, endByPerson, textOf };
