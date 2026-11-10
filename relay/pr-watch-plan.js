// Who owes the next move on one open task PR, and what the PR watch does about it (relay/pr-watch.js).
// Plain functions with no side effects, so the tests can run them without a relay. See
// docs/manual/roles.html#pr-watch.
'use strict';
const { ciOf, PROTECTED } = require('./autopilot-plan.js');

// The merge states that let GitHub merge a PR. BEHIND is fine: main does not ask for branches to be up to date.
const CLEAN = ['CLEAN', 'BEHIND', 'HAS_HOOKS'];
const short = (sha) => String(sha || '').slice(0, 7);

// s: what the relay knows about one PR at this look.
//   pr        what gh pr view printed: { state, headRefOid, mergeable, mergeStateStatus, statusCheckRollup }
//   task      { state, autopilot }: its task's column, and whether Autopilot moves it (Autopilot is on and started it)
//   dev       { state, cause } from relay/liveness.js for its Dev's session, or null when it has none
//   unpushed  commits in the Dev's checkout that are not on the PR (a number), or null when none or not known
//   review    what relay/reviews.js keeps for the PR: { head, running, waits, failed, held, off }, or null for no record
//   verdict   the latest verdict a reviewer gave on the PR: { kind, commit, posted }, or null
//   files     every path the PR changes, or null when not read
//   leadMerges whether a Lead runs that may merge
// Returns { owner, cause, act, why }. owner is who the PR waits on: Dev, reviewer, CI, Lead, Autopilot or you.
// cause names the reason, so an action is done once per PR, head and cause. act is what the watch does:
//   review     ask relay/reviews.js for a review of the head
//   tell-dev   tell the Dev, once for this head and cause
//   tell-lead  tell the Lead, once for this head
//   null       nothing: the owner moves it, or it is the person's
function nextMove(s) {
  const pr = s.pr, head = pr.headRefOid;
  const at = (owner, cause, act, why) => ({ owner, cause, act, why });
  const dev = s.dev || { state: 'gone' };
  if (s.task.state === 'waiting_on_you') return at('you', 'waiting', null, 'Its task is in Waiting on you.');
  if (s.task.autopilot) return at('Autopilot', 'autopilot', null, 'Autopilot moves it.');
  // Work the PR does not hold comes first: a review of the old head would be spent on code that is about to change.
  if (s.unpushed) {
    const n = s.unpushed + ' commit' + (s.unpushed === 1 ? '' : 's');
    if (dev.state === 'idle') return at('Dev', 'push', 'tell-dev', 'Its Dev is idle with ' + n + ' in its checkout that the PR does not have.');
    if (dev.state === 'gone') return at('you', 'push', null, 'Its Dev\'s session has ended with ' + n + ' in its checkout that the PR does not have.');
  }
  if (dev.state === 'working' || dev.state === 'quiet' || dev.state === 'job') return at('Dev', 'working', null, 'Its Dev is at work.');
  if (dev.state === 'waiting') return at('you', 'question', null, 'Its Dev is at a question for you.');
  if (dev.state === 'stuck') return at('you', 'stuck', null, dev.cause === 'told' ? 'Its Dev was told something and did not start on it.' : 'Its Dev is in a turn with no hook and no output.');
  // The Dev's to fix. Told once for each head and cause, and only while its session runs.
  const forDev = (cause, why) => (dev.state === 'gone' ? at('you', cause, null, why + ' Its Dev\'s session has ended, so nobody was told.') : at('Dev', cause, 'tell-dev', why));
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return forDev('conflict', 'It conflicts with main.');
  const ci = ciOf(pr.statusCheckRollup);
  if (ci === 'red') return forDev('red', 'A check failed on ' + short(head) + '.');
  if (ci === 'pending') return at('CI', 'ci', null, 'Its checks run on ' + short(head) + '.');
  const r = s.review;
  if (r && r.running) return at('reviewer', 'reviewing', null, 'A review of it runs.');
  const v = s.verdict && s.verdict.commit === head ? s.verdict : null;
  // No review read this head yet. A PR the relay has no record of gets its first one, as if its hook had been heard.
  if (!(r && r.head === head) && !(v && v.posted)) {
    if (r && r.off) return at('you', 'review', null, 'It has no review of ' + short(head) + ', and Review PRs automatically is off.');
    if (r && r.waits) return at('you', 'review', null, 'It has no review of ' + short(head) + ', and its automatic reviews are used up. Press Get a review.');
    if (r && r.failed) return at('you', 'review', null, 'Its automatic review could not start. Press Get a review.');
    if (r && r.held) return at('reviewer', 'review', null, 'Its review of ' + short(head) + ' waits to start.');
    return at('reviewer', 'review', 'review', 'No review has read ' + short(head) + ' yet.');
  }
  if (!v) return at('you', 'verdict', null, 'Its review of ' + short(head) + ' gave no verdict. Read it, and decide.');
  if (!v.posted) return at('reviewer', 'verdict', null, 'Its reviewer gave a verdict on ' + short(head) + ' but has not posted the review.');
  if (v.kind === 'fix') return forDev('fix', 'The review of ' + short(head) + ' has blocking findings.');
  const locked = s.files ? [...new Set(s.files.filter((f) => PROTECTED.includes(f)))] : [];
  if (locked.length) return at('you', 'protected', null, 'Reviewed at its head, green and clean, and it changes ' + locked.join(' and ') + ', which only you merge.');
  if (!CLEAN.includes(pr.mergeStateStatus)) return at('CI', 'mergeable', null, 'GitHub says it is ' + String(pr.mergeStateStatus || 'not ready').toLowerCase() + '.');
  return at(s.leadMerges ? 'Lead' : 'you', 'ready', 'tell-lead', 'Reviewed at its head ' + short(head) + ' with no blocking findings, green, and it merges cleanly.');
}

// Waits on someone other than the person for longer than late (ms): it goes to the person.
const WAITS_ON_OTHERS = ['Dev', 'reviewer', 'CI', 'Lead'];
function lateness(move, since, now, late) {
  if (!WAITS_ON_OTHERS.includes(move.owner) || now - since < late) return null;
  return { owner: 'you', why: (move.owner === 'CI' ? 'CI has' : 'the ' + move.owner + ' has') + ' owed the next move for ' + Math.round((now - since) / 60000) + ' min. ' + move.why };
}

// One line for the Floor, the Board and ticket.js floor.
function lineOf(rec, now) {
  if (!rec || !rec.owner) return null;
  const mins = Math.max(0, Math.floor((now - rec.since) / 60000));
  return { owner: rec.owner, minutes: mins, why: rec.why, late: !!rec.late, words: 'waits on ' + (['you', 'CI', 'Autopilot'].includes(rec.owner) ? rec.owner : 'the ' + rec.owner) + ' for ' + mins + ' min: ' + rec.why };
}

module.exports = { nextMove, lateness, lineOf, CLEAN };
