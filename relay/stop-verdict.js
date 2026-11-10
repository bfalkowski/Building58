// Whether the Lead may stop a session, and why. The one place that decides it: relay/floor.js shows
// it to the Lead, and asks it again before the Lead stops one. Plain, so the tests can run it on its own.
// Anything unknown counts as not safe: stopping a session that someone needs is worse than leaving
// an idle one open.
'use strict';
const config = require('./config.js');
const { jobsOf, jobWords } = require('./liveness.js');
const PM_TALK = () => config.get('pmTalkMinutes') * 60 * 1000;  // the person typed to the PM this recently. Read at each use (Settings).
const ENTER_SETTLES = 3000;  // Enter was pressed, and the hook that says a turn began may still be on its way. relay/terminal.js uses it too.
// How long after a message goes in the relay waits for a turn to begin before it tries again (relay/delivery.js).
const TOLD_CHECK = Number(process.env.RELAY_TOLD_CHECK_MS) > 0 ? Number(process.env.RELAY_TOLD_CHECK_MS) : 60 * 1000;
const minutes = (ms) => Math.max(0, Math.floor(ms / 60000));

// t is a relay terminal, task its task or null, and now the time in ms. question is what
// questionOnScreen in relay/terminal.js says: 'trust', 'menu' or null. A caller that leaves it out has
// not looked at the screen, so the answer is not safe. Returns { safe, reason }.
const QUESTIONS = { trust: 'it is asking the person whether to trust its folder', menu: 'a menu is open on its screen' };
function stopVerdict(t, task, now, question) {
  const no = (reason) => ({ safe: false, reason });
  if (!t || t.exited || t.stopped) return no('it has ended');
  if (t.lead) return no('it is the Lead');
  if (t.state === 'working') return no('it is working');
  if (t.state === 'waiting') return no('it is waiting on the person' + (t.message ? ': ' + t.message : ''));
  if ((jobsOf(t) || {}).count > 0) return no(jobWords(t) + ', and a stop would end it');  // relay/jobs.js
  if (t.drafting) return no('the person has text typed in its prompt');
  // Enter that a hooked session never answered, past the relay's check: what was typed did not go in.
  const unanswered = (t.lastEnterAt || 0) > (t.lastActAt || 0);
  if (unanswered && t.hooked && now - t.lastEnterAt >= ENTER_SETTLES + TOLD_CHECK) {
    return no('Enter was pressed ' + minutes(now - t.lastEnterAt) + ' min ago and no turn began, so ' + (t.owesBrief || t.owesPrompt || t.owesTaskBrief ? 'its first prompt' : 'the prompt') + ' did not go in');
  }
  if (t.owesBrief || t.owesPrompt || t.owesTaskBrief) return no('the relay still owes it its first prompt or brief');
  if (task && task.briefed === false) return no('its brief was never delivered, and Bring back starts it over with the brief');
  if (question === undefined) return no('its screen was not checked for a question');
  if (question) return no(QUESTIONS[question] || 'a question is on its screen');
  // A hook answers Enter when a turn begins. Until one does, a turn may be starting, however long that takes.
  if (unanswered || now - (t.lastEnterAt || 0) < ENTER_SETTLES) return no('Enter was pressed and no hook has answered yet');
  if (t.spoke && !t.hooked) return no('no hook has said what state it is in');
  if (t.role === 'pm' && t.typedAt && now - t.typedAt < PM_TALK()) return no('the PM is talking to the person: they typed to it ' + minutes(now - t.typedAt) + ' min ago');
  if (task && task.state === 'waiting_on_you') return no('its task is Waiting on you');
  const idle = t.hooked ? 'idle ' + minutes(now - t.lastActAt) + ' min' : 'idle';
  if (!t.spoke) return { safe: true, reason: 'it was never given a prompt' };
  if (t.role === 'reviewer') return { safe: true, reason: (t.posted ? 'its review is posted, ' : 'it has not posted a review, ') + idle };
  if (t.task) return { safe: true, reason: idle + ', and Bring back returns it to the same checkout' };
  return { safe: true, reason: idle };
}

// Which sessions the Lead may stop at all, when the verdict above says safe (article 3). Only the two
// its brief names: an automatic reviewer that has posted its review, and a task's Dev whose PR merged
// or whose task is Done. Every other session stays the person's to stop, however idle: one they just
// added, a reviewer whose report they may be reading, a plain session, the PM. merged says whether
// the relay has heard that the task's PR merged. relay/floor.js also checks a Dev's checkout for work
// that is not pushed, since that needs git. Returns { may: true, why } or { may: false, reason }.
function leadMayStop(t, task, merged) {
  const no = (reason) => ({ may: false, reason });
  if (t.reviewOf) return t.posted ? { may: true, why: '' } : no('its review is not posted');
  if (t.role === 'reviewer') return no('the relay did not start it to review a PR');
  if (t.task) {
    if (!task) return no('its task is not on the board');
    if (task.state === 'done') return { may: true, why: 'its task is Done, ' };
    return merged ? { may: true, why: 'its PR merged, ' } : no('its PR has not merged and its task is not Done');
  }
  if (t.role === 'pm') return no('it is the PM');
  if (t.role === 'coo') return no('it is the COO');
  return no('it is not a reviewer or a Dev');
}

module.exports = { stopVerdict, leadMayStop, PM_TALK, ENTER_SETTLES, TOLD_CHECK };
