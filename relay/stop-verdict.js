// Whether the Lead may stop a session, and why. The one place that decides it: relay/floor.js shows
// it to the Lead, and asks it again before the Lead stops one. Plain, so the tests can run it on its own.
// Anything unknown counts as not safe: stopping a session that someone needs is worse than leaving
// an idle one open. forReview picks the one session a review that waits for a desk stops (relay/reviews.js).
'use strict';
const config = require('./config.js');
const { jobsOf, jobWords } = require('./liveness.js');
const PM_TALK = () => config.get('pmTalkMinutes') * 60 * 1000;
const ENTER_SETTLES = 3000;
const TOLD_CHECK = Number(process.env.RELAY_TOLD_CHECK_MS) > 0 ? Number(process.env.RELAY_TOLD_CHECK_MS) : 60 * 1000;
const TOLD_HOLD = Number(process.env.RELAY_TOLD_HOLD_MS) > 0 ? Number(process.env.RELAY_TOLD_HOLD_MS) : 15 * 1000;
const minutes = (ms) => Math.max(0, Math.floor(ms / 60000));

const QUESTIONS = { trust: 'it is asking the person whether to trust its folder', menu: 'a menu is open on its screen' };
function stopVerdict(t, task, now, question) {
  const no = (reason) => ({ safe: false, reason });
  if (!t || t.exited || t.stopped) return no('it has ended');
  if (t.lead) return no('it is the Lead');
  if (t.state === 'working') return no('it is working');
  if (t.state === 'waiting') return no('it is waiting on the person' + (t.message ? ': ' + t.message : ''));
  if ((jobsOf(t) || {}).count > 0) return no(jobWords(t) + ', and a stop would end it');
  if (t.drafting) return no('the person has text typed in its prompt');
  const unanswered = (t.lastEnterAt || 0) > (t.lastActAt || 0);
  if (unanswered && t.hooked && now - t.lastEnterAt >= ENTER_SETTLES + TOLD_CHECK) {
    return no('Enter was pressed ' + minutes(now - t.lastEnterAt) + ' min ago and no turn began, so ' + (t.owesBrief || t.owesPrompt || t.owesTaskBrief ? 'its first prompt' : 'the prompt') + ' did not go in');
  }
  if (t.owesBrief || t.owesPrompt || t.owesTaskBrief) return no('the relay still owes it its first prompt or brief');
  if (task && task.briefed === false) return no('its brief was never delivered, and Bring back starts it over with the brief');
  if (question === undefined) return no('its screen was not checked for a question');
  if (question) return no(QUESTIONS[question] || 'a question is on its screen');
  if (unanswered || now - (t.lastEnterAt || 0) < ENTER_SETTLES) return no('Enter was pressed and no hook has answered yet');
  if (t.spoke && !t.hooked) return no('no hook has said what state it is in');
  if (t.role === 'pm' && t.typedAt && now - t.typedAt < PM_TALK()) return no('the PM is talking to the person: they typed to it ' + minutes(now - t.typedAt) + ' min ago');
  const idle = t.hooked ? 'idle ' + minutes(now - t.lastActAt) + ' min' : 'idle';
  if (!t.spoke) return { safe: true, reason: 'it was never given a prompt' };
  if (t.role === 'reviewer') return { safe: true, reason: (t.posted ? 'its review is posted, ' : 'it has not posted a review, ') + idle };
  if (t.task) return { safe: true, reason: idle + ', and Bring back returns it to the same checkout' };
  return { safe: true, reason: idle };
}

function leadMayStop(t, task, merged) {
  const no = (reason) => ({ may: false, reason });
  if (t.reviewOf) return t.posted ? { may: true, why: '' } : no('its review is not posted');
  if (t.role === 'reviewer') return no('the relay did not start it to review a PR');
  if (t.task) {
    if (!task) return no('its task is not on the board');
    if (task.state === 'done') return { may: true, why: 'its task is Done, ' };
    if (task.state === 'waiting_on_you') return { may: true, why: 'its task waits on the person, ', keeps: true };
    return merged ? { may: true, why: 'its PR merged, ' } : no('its PR has not merged and its task is not Done');
  }
  if (t.role === 'pm') return no('it is the PM');
  if (t.role === 'coo') return no('it is the COO');
  return no('it is not a reviewer or a Dev');
}

function reviewRank(c) {
  const { t, task } = c;
  if (t.lead || !c.verdict.safe) return null;
  if (t.reviewOf) return t.posted ? { rank: 1, why: '' } : null;
  if (!t.task || !task) return null;
  const kind = leadMayStop(t, task, c.merged);
  if (kind.may) return c.unsaved && !kind.keeps ? null : { rank: 2, why: kind.why };
  return task.pr && c.waits ? { rank: 3, why: 'its PR waits on a review, ' } : null;
}
function forReview(candidates) {
  const ranked = candidates.map((c) => Object.assign({}, c, { by: reviewRank(c) })).filter((c) => c.by)
    .sort((a, b) => a.by.rank - b.by.rank || (a.t.lastActAt || 0) - (b.t.lastActAt || 0));
  const pick = ranked[0];
  return pick ? { t: pick.t, task: pick.task, why: pick.by.why + pick.verdict.reason } : null;
}

module.exports = { stopVerdict, leadMayStop, forReview, PM_TALK, ENTER_SETTLES, TOLD_CHECK, TOLD_HOLD };
