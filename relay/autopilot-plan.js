// What Autopilot does next (relay/autopilot.js). Plain functions with no side effects, so the tests
// can load them without starting a relay. See docs/manual/roles.html#autopilot.
'use strict';

// A PR may not change these: only a person merges a change to them (CLAUDE.md, the constitution).
const PROTECTED = ['CLAUDE.md', 'docs/constitution.md'];
// So a code PR stays free of them and Autopilot can merge it, wording changes to them gather in one open
// ticket with this title, which the person merges (T-239). The Dev's and the PM's briefs name it.
const WORDING_TICKET = 'CLAUDE.md and constitution updates';
const { stateOf } = require('./pipeline.js');
const { boardOrder } = require('./ticket-order.js');

// The checks on a PR's head, from gh pr view --json statusCheckRollup: 'green', 'pending' or 'red'.
// No checks at all is pending: CI has not reported yet, and Autopilot merges nothing without it.
function ciOf(rollup) {
  const state = stateOf(rollup);
  return state === 'none' ? 'pending' : state;
}

// What to do with one PR. pr is what gh pr view printed: state, headRefOid, mergeStateStatus,
// statusCheckRollup. files is every path the PR touches, old names of renamed files too, or null
// once it is not open. verdict is the latest one a reviewer gave on it, or null:
// { kind: 'merge' | 'fix', commit, posted }. rounds is how many verdicts the PR has had.
// Returns { act, why }. act is one of:
//   done     the PR merged, so its task is done
//   merge    merge it now
//   wait     nothing to do yet; why says what it waits for
//   conflict the Dev merges main into it, since GitHub cannot
//   person   it needs the person; why says why, and Autopilot leaves it alone
function forPr(pr, files, verdict, rounds, maxRounds) {
  if (!pr) return { act: 'wait', why: 'GitHub has not answered about the PR yet.' };
  if (pr.state === 'MERGED') return { act: 'done', why: 'The PR merged.' };
  if (pr.state === 'CLOSED') return { act: 'person', why: 'The PR was closed without merging.' };
  if (!files) return { act: 'wait', why: 'Waiting for the list of files the PR changes.' };
  const locked = [...new Set(files.filter((f) => PROTECTED.includes(f)))];
  if (locked.length) return { act: 'person', why: 'It changes ' + locked.join(' and ') + ', which only a person merges.' };
  if (!verdict) return { act: 'wait', why: 'Waiting for the review.' };
  if (!verdict.posted) return { act: 'wait', why: 'Waiting for the reviewer to post the review.' };
  if (verdict.kind === 'fix') {
    if (rounds >= maxRounds) return { act: 'person', why: 'Review ' + rounds + ' still asks for fixes, and Autopilot stops at ' + maxRounds + ' rounds.' };
    return { act: 'wait', why: 'The Dev is fixing what the last review found. A follow-up review checks the fixes after the push.' };
  }
  if (verdict.commit !== pr.headRefOid) return { act: 'wait', why: 'There are commits after the review said merge, so a follow-up review checks them first.' };
  if (pr.mergeStateStatus === 'DIRTY') return { act: 'conflict', why: 'It conflicts with main.' };
  const ci = ciOf(pr.statusCheckRollup);
  if (ci === 'red') return { act: 'person', why: 'CI failed on the reviewed commit.' };
  if (ci === 'pending') return { act: 'wait', why: 'Waiting for CI.' };
  // BEHIND is fine: main does not require a branch to be up to date, so GitHub merges it as it is.
  if (!['CLEAN', 'BEHIND', 'HAS_HOOKS'].includes(pr.mergeStateStatus)) return { act: 'wait', why: 'GitHub says the PR is ' + String(pr.mergeStateStatus || 'not ready').toLowerCase() + '.' };
  return { act: 'merge', why: 'Reviewed with no blocking findings, CI is green, and GitHub can merge it.' };
}

// The next ticket to start: Ready, approved by a person, every blocker done, no task yet, in the
// Board's order (relay/ticket-order.js). only, when set, is the ticket ids Autopilot may start.
function nextTicket(all, hasTask, only) {
  const approved = (t) => ('approvedBy' in t ? t.approvedBy === 'you' : t.createdBy === 'you');
  const settled = (t) => (t.blockedBy || []).every((id) => { const b = all.find((x) => x.id === id); return b && b.status === 'done'; });
  return boardOrder(all.filter((t) => t.status === 'ready' && t.repo && approved(t) && settled(t) && !hasTask(t) && (!only || only.includes(t.id))))[0] || null;
}

// A reviewer's posted review on the PR, for when its hook never said it posted (relay/autopilot.js). comments
// are the PR's issue comments from GitHub's API. It is the newest one by the room's account (login) posted
// at or after since (ms), whose first line is a heading that names commit: "## Review of <hash>", or a range
// "## Review of <from>..<hash>" that ends in it. A hash counts from 7 characters, as git shortens them.
// Returns the comment's link, or null.
const HEADING = /^#{1,6}[ \t]+review of[ \t]+`?(?:[0-9a-f]{7,40}\.\.\.?)?([0-9a-f]{7,40})\b/i;
const COMMENT_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#issuecomment-\d+$/;
function reviewPostFor(comments, { login, since, commit }) {
  let found = null, foundAt = -Infinity;
  for (const c of comments || []) {
    if (!c || !c.user || !login || String(c.user.login).toLowerCase() !== String(login).toLowerCase()) continue;
    const at = Date.parse(c.created_at);
    if (!(at >= since) || at < foundAt || !COMMENT_URL.test(String(c.html_url))) continue;
    const named = String(c.body || '').trimStart().match(HEADING);
    if (named && String(commit).toLowerCase().startsWith(named[1].toLowerCase())) { found = c.html_url; foundAt = at; }
  }
  return found;
}

module.exports = { forPr, ciOf, nextTicket, reviewPostFor, PROTECTED, WORDING_TICKET };
