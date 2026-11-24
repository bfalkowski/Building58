// What Autopilot does next (relay/autopilot.js). Plain functions with no side effects, so the tests
// can load them without starting a relay. See docs/manual/roles.html#autopilot.
'use strict';

const PROTECTED = ['CLAUDE.md', 'docs/constitution.md', 'eslint.config.js', 'eslint-local.js'];
const WORDING_TICKET = 'CLAUDE.md and constitution updates';
const { stateOf } = require('./pipeline.js');
const { boardOrder } = require('./ticket-order.js');

function ciOf(rollup) {
  const state = stateOf(rollup);
  return state === 'none' ? 'pending' : state;
}

function forPr(pr, files, verdict, rounds, maxRounds, devGone) {
  if (!pr) return { act: 'wait', why: 'GitHub has not answered about the PR yet.' };
  if (pr.state === 'MERGED') return { act: 'done', why: 'The PR merged.' };
  if (pr.state === 'CLOSED') return { act: 'person', reason: 'pr-closed', why: 'The PR was closed without merging.' };
  if (!files) return { act: 'wait', why: 'Waiting for the list of files the PR changes.' };
  const locked = lockedOf(files);
  if (locked.length) return { act: 'person', reason: 'protected-file', why: onlyAPerson(locked) };
  return forReviewed(pr, verdict, rounds, maxRounds, devGone);
}
const lockedOf = (files) => [...new Set((files || []).filter((f) => PROTECTED.includes(f)))];
const onlyAPerson = (locked) => 'It changes ' + locked.join(' and ') + ', which only a person merges.';
const WAITS_FOR_REVIEW = 'Waiting for the review.';
function forReviewed(pr, verdict, rounds, maxRounds, devGone) {
  if (!verdict) return { act: 'wait', why: WAITS_FOR_REVIEW };
  if (!verdict.posted) return { act: 'wait', why: 'Waiting for the reviewer to post the review.' };
  if (verdict.kind === 'fix') {
    if (rounds >= maxRounds) return { act: 'person', reason: 'rounds', why: 'Review ' + rounds + ' still asks for fixes, and Autopilot stops at ' + maxRounds + ' rounds.' };
    if (devGone && verdict.commit !== pr.headRefOid) return { act: 'wait', why: 'There are commits after the review asked for fixes, so a follow-up review checks them.' };
    if (devGone) return { act: 'bring-back', for: 'fix', why: 'The last review asks for fixes, but its Dev is not running, so Autopilot brings it back to fix them.' };
    return { act: 'wait', why: 'The Dev is fixing what the last review found. A follow-up review checks the fixes after the push.' };
  }
  if (verdict.commit !== pr.headRefOid) return { act: 'wait', why: 'There are commits after the review said merge, so a follow-up review checks them first.' };
  if (pr.mergeStateStatus === 'DIRTY') return devGone ? { act: 'bring-back', for: 'conflict', why: 'It conflicts with main, but its Dev is not running, so Autopilot brings it back to merge main.' } : { act: 'conflict', why: 'It conflicts with main.' };
  const ci = ciOf(pr.statusCheckRollup);
  if (ci === 'red') return { act: 'person', reason: 'ci-red', why: 'CI failed on the reviewed commit.' };
  if (ci === 'pending') return { act: 'wait', why: 'Waiting for CI.' };
  if (!['CLEAN', 'BEHIND', 'HAS_HOOKS'].includes(pr.mergeStateStatus)) return { act: 'wait', why: 'GitHub says the PR is ' + String(pr.mergeStateStatus || 'not ready').toLowerCase() + '.' };
  return { act: 'merge', why: 'Reviewed with no blocking findings, CI is green, and GitHub can merge it.' };
}

function forPersonMerge(pr, locked, verdict, d) {
  const short = verdict && verdict.commit ? String(verdict.commit).slice(0, 7) : '';
  if (d.act === 'merge') return { ready: pr.headRefOid, why: 'Ready for your merge: the review of ' + short + ' says merge, CI is green, and GitHub can merge it.' };
  let now;
  if (!verdict || !verdict.posted) now = 'Waiting for its review.';
  else if (verdict.commit !== pr.headRefOid) now = 'Waiting for a review of the new commits.';
  else if (verdict.kind === 'fix') now = 'The review of ' + short + ' says fix, so its Dev fixes it first.';
  else if (d.act === 'conflict' || (d.act === 'bring-back' && d.for === 'conflict')) now = 'The review of ' + short + ' says merge, but it conflicts with main.';
  else now = d.why;
  return { ready: null, why: onlyAPerson(locked) + ' ' + now };
}

const MARKS = ['hold', 'replaced'];
const OPEN = ['triage', 'ready', 'started'];
function proposalWords(p, id) {
  const ids = (p.ids || []).join(', ');
  if (p.action === 'replace') return 'replace ' + id + ' with ' + ids;
  if (p.action === 'merge') return 'merge ' + id + ' into ' + ids;
  if (p.action === 'close') return 'close ' + id;
  return 'set the blockers of ' + id + ' to ' + (ids || 'none');
}
function heldBack(t, all) {
  if (t.proposal) return 'A proposal to ' + proposalWords(t.proposal, t.id) + ' waits on you. Nothing starts it by itself until you approve or decline it.';
  const after = ' Nothing starts it by itself until you clear the mark.';
  if (t.mark === 'hold') return 'On hold.' + after;
  if (t.mark === 'replaced') return 'Replaced' + (t.replacedBy ? ' by ' + t.replacedBy : '') + '.' + after;
  const designs = all.filter((d) => d.id !== t.id && OPEN.includes(d.status) && Array.isArray(d.shapes) && d.shapes.includes(t.id)).map((d) => d.id);
  if (!designs.length) return null;
  const them = designs.join(', ');
  return 'Waiting on design ticket ' + them + ', which shapes it. Nothing starts it by itself until ' + them + (designs.length > 1 ? ' are' : ' is') + ' done or rejected.';
}

const allowed = (t, only) => !only || only.includes(t.id) || (Array.isArray(t.labels) && t.labels.some((l) => only.includes(l)));
const approved = (t) => ('approvedBy' in t ? t.approvedBy === 'you' : t.createdBy === 'you');
const unsettled = (t, all) => (t.blockedBy || []).filter((id) => { const b = all.find((x) => x.id === id); return !b || b.status !== 'done'; });
function nextTicket(all, hasTask, only, prefer) {
  const startable = boardOrder(all.filter((t) => t.status === 'ready' && t.repo && approved(t) && !unsettled(t, all).length && !heldBack(t, all) && !hasTask(t) && allowed(t, only)));
  return (prefer && startable.find((t) => t.id === prefer)) || startable[0] || null;
}
function waitsWhy(t, all) {
  if (t.status === 'rejected') return 'Rejected';
  if (t.status === 'triage') return 'In Triage';
  if (!approved(t)) return 'Not approved by you';
  const blockers = unsettled(t, all);
  if (blockers.length) return 'Waiting for ' + blockers.join(', ');
  const held = heldBack(t, all);
  if (held) return held.split('. ')[0].replace(/\.$/, '');
  return t.repo ? null : 'No repo';
}
function whyNoneAllowed(all, hasTask, only) {
  const mine = boardOrder(all.filter((t) => allowed(t, only)));
  if (!mine.length) return 'No ticket on the Board has an id or label you allowed.';
  const waiting = mine.filter((t) => ['triage', 'ready', 'rejected'].includes(t.status) && !hasTask(t)).map((t) => [t.id, waitsWhy(t, all)]).filter(([, why]) => why);
  if (!waiting.length) return 'Every ticket you allowed is started or done.';
  return 'No ticket you allowed can start. ' + waiting.map(([id, why]) => id + ': ' + why + '.').join(' ');
}

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

module.exports = { WAITS_FOR_REVIEW, forPr, forReviewed, forPersonMerge, lockedOf, ciOf, nextTicket, whyNoneAllowed, heldBack, proposalWords, MARKS, reviewPostFor, PROTECTED, WORDING_TICKET };
