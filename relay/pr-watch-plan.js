// Who owes the next move on one open task PR, and what the PR watch does about it (relay/pr-watch.js).
// Plain functions with no side effects, so the tests can run them without a relay. See
// docs/manual/roles.html#pr-watch.
'use strict';
const { ciOf, PROTECTED } = require('./autopilot-plan.js');

const CLEAN = ['CLEAN', 'BEHIND', 'HAS_HOOKS'];
const short = (sha) => String(sha || '').slice(0, 7);

function nextMove(s) {
  const pr = s.pr, head = pr.headRefOid;
  const at = (owner, cause, act, why) => ({ owner, cause, act, why });
  const dev = s.dev || { state: 'gone' };
  if (s.task.state === 'waiting_on_you') return at('you', 'waiting', null, 'Its task is in Waiting on you.');
  if (s.task.autopilot) return at('Autopilot', 'autopilot', null, 'Autopilot moves it.');
  if (s.unpushed) {
    const n = s.unpushed + ' commit' + (s.unpushed === 1 ? '' : 's');
    if (dev.state === 'idle') return at('Dev', 'push', 'tell-dev', 'Its Dev is idle with ' + n + ' in its checkout that the PR does not have.');
    if (dev.state === 'gone') return at('you', 'push', null, 'Its Dev\'s session has ended with ' + n + ' in its checkout that the PR does not have.');
  }
  if (dev.state === 'working' || dev.state === 'quiet' || dev.state === 'job') return at('Dev', 'working', null, 'Its Dev is at work.');
  if (dev.state === 'waiting') return at('you', 'question', null, 'Its Dev is at a question for you.');
  if (dev.state === 'stuck') return at('you', 'stuck', null, dev.cause === 'told' ? 'Its Dev was told something and did not start on it.' : 'Its Dev is in a turn with no hook and no output.');
  const forDev = (cause, why) => (dev.state === 'gone' ? at('you', cause, null, why + ' Its Dev\'s session has ended, so nobody was told.') : at('Dev', cause, 'tell-dev', why));
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return forDev('conflict', 'It conflicts with main.');
  const ci = ciOf(pr.statusCheckRollup);
  if (ci === 'red') return forDev('red', 'A check failed on ' + short(head) + '.');
  if (ci === 'pending') return at('CI', 'ci', null, 'Its checks run on ' + short(head) + '.');
  const r = s.review;
  if (r && r.running) return at('reviewer', 'reviewing', null, 'A review of it runs.');
  const v = s.verdict && s.verdict.commit === head ? s.verdict : null;
  if (!(r && r.head === head) && !(v && v.posted)) {
    if (r && r.off) return at('you', 'review', null, 'It has no review of ' + short(head) + ', and Review PRs automatically is off.');
    if (r && r.waits) return at('you', 'review', null, 'It has no review of ' + short(head) + ', and its automatic reviews are used up. Press Get a review.');
    if (r && r.failed) return at('you', 'review', null, 'Its automatic review could not start. Press Get a review.');
    if (r && r.held) return at('reviewer', 'review', null, 'Its review of ' + short(head) + ' waits to start.');
    return at('reviewer', 'review', 'review', 'No review has read ' + short(head) + ' yet.');
  }
  if (!v) return at('you', 'verdict', null, 'Its review of ' + short(head) + ' gave no verdict. Read it, and decide.');
  if (!v.posted) return at('reviewer', 'verdict', null, 'Its reviewer gave a verdict on ' + short(head) + ' but has not posted the review.');
  if (v.kind === 'fix') return forDev('fix', 'The review of ' + short(head) + ' has blocking or fix-now findings.');
  const locked = s.files ? [...new Set(s.files.filter((f) => PROTECTED.includes(f)))] : [];
  if (locked.length) return at('you', 'protected', null, 'Reviewed at its head, green and clean, and it changes ' + locked.join(' and ') + ', which only you merge.');
  if (!CLEAN.includes(pr.mergeStateStatus)) return at('CI', 'mergeable', null, 'GitHub says it is ' + String(pr.mergeStateStatus || 'not ready').toLowerCase() + '.');
  return at(s.leadMerges ? 'Lead' : 'you', 'ready', 'tell-lead', 'Reviewed at its head ' + short(head) + ' with no blocking findings, green, and it merges cleanly.');
}

const WAITS_ON_OTHERS = ['Dev', 'reviewer', 'CI', 'Lead'];
function lateness(move, since, now, late) {
  if (!WAITS_ON_OTHERS.includes(move.owner) || now - since < late) return null;
  return { owner: 'you', why: (move.owner === 'CI' ? 'CI has' : 'the ' + move.owner + ' has') + ' owed the next move for ' + Math.round((now - since) / 60000) + ' min. ' + move.why };
}

function lineOf(rec, now) {
  if (!rec || !rec.owner) return null;
  const mins = Math.max(0, Math.floor((now - rec.since) / 60000));
  return { owner: rec.owner, minutes: mins, why: rec.why, late: !!rec.late, words: 'waits on ' + (['you', 'CI', 'Autopilot'].includes(rec.owner) ? rec.owner : 'the ' + rec.owner) + ' for ' + mins + ' min: ' + rec.why };
}

module.exports = { nextMove, lateness, lineOf, CLEAN };
