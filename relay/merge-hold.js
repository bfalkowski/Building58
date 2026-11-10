// Whether a task's PR holds all of its Dev's work yet, asked before a merge (T-203). A merge that leaves
// the Dev's last fixes behind needs another ticket and PR to land them, as T-139, T-144, T-145 and T-186
// did. So before Autopilot merges (relay/autopilot.js), and on the Floor the Lead reads before its own
// merge (relay/floor.js), the relay asks:
//   - Has the Dev been told the latest review? News it was not told yet is still to answer.
//   - Is the Dev at work, at a question, or told something it has not started on? It may still be
//     answering the latest review, and its fixes would land after the merge.
//   - Does its checkout hold uncommitted changes, or commits that are on no remote? Then the PR does
//     not hold them.
// holdOf(task, dev, now) -> null, or { act, why }. act is 'wait' while the Dev may still push, and
// 'person' when nothing will: the Dev is idle or gone with work its PR does not hold.
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const { livenessOf } = require('./liveness.js');

// Work in a checkout that a stop or a merge would leave behind: uncommitted changes, or commits that are
// on no remote. Returns the reason, or null. Anything git cannot answer counts as unsaved.
function unsavedWork(dir) {
  const git = (...args) => execFileSync('git', ['-C', dir].concat(args), { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    if (git('status', '--porcelain')) return 'its checkout has uncommitted changes';
    const n = Number(git('rev-list', '--count', 'HEAD', '--not', '--remotes'));
    return n ? 'its checkout has ' + n + ' commit' + (n === 1 ? '' : 's') + ' that ' + (n === 1 ? 'is' : 'are') + ' not pushed' : null;
  } catch (e) { return 'git could not say whether its checkout has work that is not pushed'; }
}

const busy = (lv) => ({ working: 'is working', quiet: 'is in a turn', waiting: 'is at a question',
  stuck: lv.cause === 'told' ? 'has not started on what it was told' : 'is in a turn with no hook' })[lv.state] || null;

// dev is the task's Dev session, or null when it has none. unsaved is for the tests.
function holdOf(task, dev, now, unsaved = unsavedWork) {
  const lv = livenessOf(dev, now);
  const gone = lv.state === 'gone';
  const news = task.reviews && task.reviews.pending;
  if (news && !gone) return { act: 'wait', why: 'Its Dev has not been told of the latest review yet.' };
  if (busy(lv)) return { act: 'wait', why: 'Its Dev ' + busy(lv) + ', maybe still answering the latest review, so the PR may not hold every fix yet.' };
  // A checkout that is gone holds nothing. Its Dev's own folder counts only when the task has none.
  const dir = task.worktree || (dev && dev.cwd);
  const left = dir && fs.existsSync(dir) ? unsaved(dir) : null;
  if (left) return { act: 'person', why: 'Its Dev ' + (gone ? 'has ended' : 'stopped') + ', but ' + left + ', so the PR does not hold all its work.' };
  if (news) return { act: 'person', why: 'There is review news its Dev was never told, and its session has ended.' };
  return null;
}

module.exports = { holdOf, unsavedWork };
