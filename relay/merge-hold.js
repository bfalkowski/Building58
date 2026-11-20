// Whether a task's PR holds all of its Dev's work yet, asked before a merge (T-203). A merge that leaves
// the Dev's last fixes behind needs another ticket and PR to land them, as T-139, T-144, T-145 and T-186
// did. So before Autopilot merges (relay/autopilot.js), and on the Floor the Lead reads before its own
// merge (relay/floor.js), the relay asks:
//   - Has the comment check (relay/pr-comments.js) looked at the PR since the room's latest review of it
//     was posted? Until then that review is not news yet, though its verdict may already say merge
//     (T-229). The poll runs about once a minute and Autopilot looks every 20 s, so without this a merge
//     verdict could merge before its Dev was told. With the check off, the Dev is never told of reviews.
//   - Has the Dev been told the latest review? News it was not told yet is still to answer.
//   - Is the Dev at work, running a job (such as npm test in the background), at a question, or told
//     something it has not started on? It may still be answering the latest review, and its fixes would
//     land after the merge.
//   - Was the Dev told something (t.toldAt, set by relay/delivery.js when it types a note) after its
//     last turn began (t.turnAt)? Then the review news is delivered, so task.reviews.pending is empty,
//     but its hooks still say idle until its UserPromptSubmit hook comes, about a second later, and it is
//     not stuck until RELAY_TOLD_CHECK_MS has passed (T-238). It is about to start, so wait, but only for
//     RELAY_TOLD_HOLD_MS, the time delivery itself gives a note to start a turn before it types another.
//   - Does its checkout hold uncommitted changes, or commits that are on no remote? Then the PR does
//     not hold them.
// holdOf(task, dev, now) -> null, or { act, why }, with a reason word when act is 'person'. act is 'wait'
// while the Dev may still push, and 'person' when nothing will: the Dev is idle or gone with work its PR
// does not hold.
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const { livenessOf, jobWords } = require('./liveness.js');
const config = require('./config.js');
const { TOLD_HOLD } = require('./stop-verdict.js');

function unsavedWork(dir) {
  const git = (...args) => execFileSync('git', ['-C', dir].concat(args), { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    if (git('status', '--porcelain')) return 'its checkout has uncommitted changes';
    const n = Number(git('rev-list', '--count', 'HEAD', '--not', '--remotes'));
    return n ? 'its checkout has ' + n + ' commit' + (n === 1 ? '' : 's') + ' that ' + (n === 1 ? 'is' : 'are') + ' not pushed' : null;
  } catch (e) { return 'git could not say whether its checkout has work that is not pushed'; }
}

const UNSEEN = 'No comment check has listed the latest posted review on the PR yet, so its Dev was not told of it.';
const unseen = (r) => !!r.posted && !r.posted.seen && config.get('reviewPollSeconds') > 0;

const busy = (lv, dev) => ({ working: 'is working', quiet: 'is in a turn', waiting: 'is at a question', job: 'is running a job (' + jobWords(dev) + ')',
  stuck: lv.cause === 'told' ? 'has not started on what it was told' : 'is in a turn with no hook' })[lv.state] || null;

const toldSinceTurn = (dev, now) => (dev.toldAt || 0) > (dev.turnAt || 0) && now - dev.toldAt < TOLD_HOLD;

function holdOf(task, dev, now, unsaved = unsavedWork) {
  const lv = livenessOf(dev, now);
  const gone = lv.state === 'gone';
  const r = task.reviews || {};
  if (unseen(r)) return { act: 'wait', why: UNSEEN };
  const news = r.pending;
  if (news && !gone) return { act: 'wait', why: 'Its Dev has not been told of the latest review yet.' };
  if (busy(lv, dev)) return { act: 'wait', why: 'Its Dev ' + busy(lv, dev) + ', maybe still answering the latest review, so the PR may not hold every fix yet.' };
  if (!gone && toldSinceTurn(dev, now)) return { act: 'wait', why: 'Its Dev was told something and has not started on it yet, so the PR may not hold every fix yet.' };
  const dir = task.worktree || (dev && dev.cwd);
  const left = dir && fs.existsSync(dir) ? unsaved(dir) : null;
  if (left) return { act: 'person', reason: 'work-left-out', why: 'Its Dev ' + (gone ? 'has ended' : 'stopped') + ', but ' + left + ', so the PR does not hold all its work.' };
  if (news) return { act: 'person', reason: 'news-untold', why: 'There is review news its Dev was never told, and its session has ended.' };
  return null;
}

module.exports = { holdOf, unsavedWork };
