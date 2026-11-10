// What one desk on the Floor says: its ticket and the ticket's column, its PR with the CI and review
// state, a Dev's status icon, what it is doing now, the next step and who owns it, and whether it is safe to stop.
// relay/floor.js gathers what the relay already knows (tasks, the pipeline it polls, reviews,
// Autopilot) and hands it here, so drawing a desk asks GitHub nothing. Plain, so the tests can run
// it on its own. See docs/manual/how-it-works.html#desks.
'use strict';
const { COLUMNS, columnOf } = require('../office/board-model.js');
const { livenessOf, jobWords } = require('./liveness.js');

const minutes = (ms) => Math.max(0, Math.floor(ms / 60000));
const numberOf = (pr) => (pr ? '#' + String(pr).split('/').pop() : null);
const CI_WORDS = { green: 'CI green', red: 'CI failed', pending: 'CI running', none: 'no CI', unknown: 'CI unknown' };

// The column a task's card is in on the Board (office/board-model.js), or null with no task.
function columnOfTask(task) {
  if (!task || !task.state) return null;
  const id = columnOf({ status: 'started', task: { state: task.state, pipeline: task.pipeline || null } });
  const col = COLUMNS.find((c) => c.id === id);
  return col ? { id: col.id, label: col.label } : null;
}

// Why a task is Waiting on you: Autopilot's reason, or the note on the move that put it there.
function waitingWhy(task, autopilot) {
  if (autopilot && autopilot.handedOver) return autopilot.handedOver;
  const moved = (task.history || []).filter((h) => h.type === 'moved' && h.to === 'waiting_on_you').slice(-1)[0];
  const note = moved && moved.note ? String(moved.note).replace(/^Autopilot: /, '') : '';
  return note || 'its task is in Waiting on you';
}

// What it is doing, from relay/liveness.js: working, quiet, stuck, waiting, job, idle, or gone while it ends.
function doingOf(t, now, lv) {
  if (lv.state === 'gone') return { state: 'gone', words: 'gone' };
  if (lv.state === 'working') return { state: 'working', words: 'working' };
  if (lv.state === 'waiting') return { state: 'waiting', words: 'waiting on you' + (t.message ? ': ' + t.message : '') };
  if (lv.state === 'job') return { state: 'job', words: 'running a job: ' + jobWords(t) };
  if (lv.state === 'quiet') return { state: 'quiet', words: 'quiet: no hook for ' + minutes(now - lv.since) + ' min, output still moving' };
  if (lv.state === 'stuck' && lv.cause === 'silent') return { state: 'stuck', words: 'stuck: no hook or output for ' + minutes(now - lv.since) + ' min' };
  // Told something, and no turn began after it, nor after the relay's second try (relay/delivery.js).
  if (lv.state === 'stuck') return { state: 'stuck', words: 'stuck: told ' + minutes(now - lv.since) + ' min ago, did not start' };
  return { state: 'idle', words: t.hooked && t.lastActAt ? 'idle ' + minutes(now - t.lastActAt) + ' min' : 'idle' };
}

function reviewWords(review, autopilot, reviewing) {
  if (reviewing) return 'review running';
  if (review && review.waits) return 'automatic reviews used up';
  if (review && review.failed) return 'automatic review could not start';
  if (autopilot && autopilot.verdict === 'merge') return 'review says merge';
  if (autopilot && autopilot.verdict === 'fix') return 'review asks for fixes';
  if (review && review.held) return 'review waits on CI';
  if (review && review.desk) return 'review waits for a desk';
  if (review && review.count) return 'reviewed ' + review.count + (review.count === 1 ? ' time' : ' times');
  return 'no review yet';
}

// The next step on a Dev's PR once it is built, and who owns it.
function prStep(d, pr) {
  const n = numberOf(pr);
  if (d.ci === 'red') return ['The Dev fixes the failed CI on PR ' + n, 'Dev'];
  if (d.review && d.review.waits) return ['Waiting on you: review PR ' + n + ', its automatic reviews are used up', 'you'];
  if (d.review && d.review.failed) return ['Waiting on you: review PR ' + n + ', its automatic review could not start', 'you'];
  if (d.reviewing) return ['The reviewer reviews PR ' + n, 'reviewer'];
  if (d.autopilot && d.autopilot.on && d.autopilot.mine) {
    const a = d.autopilot;
    if (a.act === 'merge') return ['Autopilot merges PR ' + n + ' now', 'Autopilot'];
    if (a.why === 'Waiting for CI.' || (a.verdict === 'merge' && d.ci === 'pending')) return ['Autopilot merges when CI is green', 'Autopilot'];
    if (a.act === 'conflict') return ['The Dev merges main into PR ' + n, 'Dev'];
    return ['Autopilot: ' + String(a.why || 'waits for the review').replace(/\.$/, ''), 'Autopilot'];
  }
  if (d.ci === 'pending' || (d.review && d.review.held)) return ['CI runs on PR ' + n + ', then the review', 'CI'];
  if (d.review && d.review.desk) return ['The review of PR ' + n + ' starts when a desk is free', 'reviewer'];
  if (d.leadMerges) return ['The Lead merges PR ' + n + ' when it is reviewed and green', 'Lead'];
  return ['Waiting on you: review and merge PR ' + n, 'you'];
}

// The status icon on a Dev's desk: where its PR stands, as an icon with a short label, so it reads
// without knowing the icons. The first that holds wins. A verdict counts only for the commit CI is on:
// after a push, the PR waits for its next review.
const STATUS = {
  merged: '\u2705', done: '\u2705', waiting_on_you: '\u270b', building: '\ud83d\udd28', reviewing: '\ud83d\udd0d',
  ci_failed: '\u274c', ci_running: '\u23f3', fix: '\ud83d\udd27', merge: '\ud83d\udc4d', review_waits: '\ud83d\udd52',
};
function statusOf(d, task, pr, ci, p) {
  const s = (key, label) => ({ key, icon: STATUS[key], label });
  const a = d.autopilot || {};
  const current = !a.verdictAt || !p || !p.head || a.verdictAt === p.head;
  if (d.merged) return s('merged', 'merged');
  if (task.state === 'done') return s('done', 'done');
  if (task.state === 'waiting_on_you') return s('waiting_on_you', 'waiting on you');
  if (!pr) return s('building', 'building');
  if (d.reviewing) return s('reviewing', d.reviewer ? 'being reviewed by ' + d.reviewer : 'being reviewed');
  if (ci === 'red') return s('ci_failed', 'CI failed');
  if (ci === 'pending') return s('ci_running', 'CI running');
  if (task.state === 'changes_requested' || (a.verdict === 'fix' && current)) return s('fix', 'fix requested');
  if (a.verdict === 'merge' && current) return s('merge', 'review says merge');
  return s('review_waits', 'waiting for a review');
}

// d: { t, role, work, task, pipeline, review, reviewing, reviewer, autopilot, leadMerges, merged, verdict, now }.
//   t is the relay terminal, role what relay/floor.js calls it (Lead, Dev, reviewer, PM, COO, Security, session),
//   work what workOf says, task the task it works on or reviews (or null), pipeline pipeline.summary
//   of its PR, review what relay/reviews.js keeps for that PR ({ count, waits, held, desk, failed }),
//   reviewing whether a reviewer is on that PR now, reviewer that reviewer's name if it has one,
//   autopilot what Autopilot keeps for it ({ on, mine, act, why, verdict, verdictAt, handedOver }),
//   leadMerges whether a Lead may merge, merged whether its PR merged, and verdict the Floor's
//   { safe, canStop, reason }.
function deskOf(d) {
  const { t, role, task, now } = d, work = d.work || {};
  const pr = work.pr || (task && task.pr) || t.pr || t.reviewOf || null;
  const p = pr && d.pipeline ? d.pipeline : null;
  const ci = p ? p.state : null;
  const verdict = d.verdict || { safe: false, canStop: false, reason: 'unknown' };
  const safe = !!(verdict.safe && verdict.canStop);
  const isReviewer = role === 'reviewer';
  const lv = livenessOf(t, now);
  const desk = {
    ticket: work.ticket || (task && task.ticket) || null,
    ticketAt: work.ticketAt || (task && task.ticketAt) || null,
    title: (task && task.title) || null,
    column: columnOfTask(task),
    pr, prNumber: numberOf(pr),
    ci, ciWords: ci ? CI_WORDS[ci] || ci : null,
    review: pr ? (isReviewer ? (t.posted ? 'review posted' : 'review running') : reviewWords(d.review, d.autopilot, d.reviewing)) : null,
    doing: doingOf(t, now, lv),
    status: role === 'Dev' && task ? statusOf(d, task, pr, ci, p) : null,
    next: null,
    stop: { safe, reason: safe ? verdict.reason : null },
  };
  const step = (text, owner) => { desk.next = { text, owner }; return desk; };
  if (t.state === 'waiting') return step('Waiting on you: ' + (t.message || 'it asked you something'), 'you');
  if (lv.state === 'stuck' && lv.cause === 'silent') return step('Waiting on you: it has sent no hook and printed nothing for ' + minutes(now - lv.since) + ' min. Open its session, or stop it and Bring it back', 'you');
  // A first prompt (relay/delivery.js, promptOnce) has no task to Bring back, and stopping its session drops it.
  if (lv.state === 'stuck' && /^first-prompt /.test(t.stuck.key || '')) return step('Waiting on you: it did not start on its first prompt, ' + t.stuck.why + '. Open its session and press Enter if the prompt is still in its box, or answer what is on its screen. Stopping it drops the prompt', 'you');
  if (lv.state === 'stuck') return step('Waiting on you: it did not start on what it was told, ' + t.stuck.why + '. Open its session, or stop it and Bring it back', 'you');
  if (role === 'Lead') return step('The Lead keeps tickets moving', 'Lead');
  if (role === 'PM') return step('Waiting on you: talk tickets through with the PM', 'you');
  if (role === 'COO') return t.state === 'working' ? step('The COO writes its report on the room', 'COO') : step('Waiting on you: read the COO report', 'you');
  if (role === 'Security') return t.state === 'working' ? step('The security officer writes its report on access', 'Security') : step('Waiting on you: read the Security report', 'you');
  if (isReviewer) {
    if (t.posted) return safe ? step('Done, safe to stop', 'you') : step('Review posted', 'you');
    if (t.state === 'working') return step('The reviewer posts its review of PR ' + numberOf(pr), 'reviewer');
    return step('Waiting on you: read its review', 'you');
  }
  if (role === 'Dev' && task) {
    if (task.state === 'done' || d.merged) {
      if (safe) return step('Done, safe to stop', 'you');
      // Not one of the kinds that may be stopped, such as work not pushed, or not safe at this moment, such as still working.
      return verdict.safe ? step('Done, but ' + verdict.reason.replace(/^not one the Lead may stop: /, ''), 'you') : step('Done, not safe to stop yet: ' + verdict.reason, 'you');
    }
    if (task.state === 'waiting_on_you') return step('Waiting on you: ' + waitingWhy(task, d.autopilot), 'you');
    if (task.state === 'changes_requested') return step('The Dev fixes what the review found', 'Dev');
    if (!pr) return t.state === 'working' ? step('The Dev builds it, then opens a PR', 'Dev') : step('Waiting on you: read what the Dev wrote, it has no PR yet', 'you');
    return step(...prStep(Object.assign({}, d, { ci }), pr));
  }
  if (role === 'Dev') return step('Its task is not on the Board', 'you');
  return t.state === 'working' ? step('Works on your prompt', 'session') : step('Waiting on you: give it a prompt, or stop it', 'you');
}

// Who reviews whom, so the page can draw each reviewer right under the Dev whose PR it reviews. rows
// are the Floor's rows ({ terminal, name, role, desk }). A reviewer's desk gets reviewing: { pr,
// prNumber, dev }, with dev { terminal, name } or null when no Dev on the Floor has that PR. A Dev's
// desk with a PR gets reviewedBy: the reviewers on its PR, as { terminal, name }.
function pairReviewers(rows) {
  const devs = rows.filter((r) => r.role === 'Dev' && r.desk && r.desk.pr);
  for (const d of devs) d.desk.reviewedBy = [];
  for (const r of rows) {
    if (r.role !== 'reviewer' || !r.desk) continue;
    const dev = r.desk.pr ? devs.find((d) => d.desk.pr === r.desk.pr) : null;
    r.desk.reviewing = r.desk.pr ? { pr: r.desk.pr, prNumber: r.desk.prNumber, dev: dev ? { terminal: dev.terminal, name: dev.name } : null } : null;
    if (dev) dev.desk.reviewedBy.push({ terminal: r.terminal, name: r.name });
  }
  return rows;
}

module.exports = { deskOf, columnOfTask, pairReviewers };
