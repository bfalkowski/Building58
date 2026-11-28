// The gate from round 3 on: who decides each finding, and what a PR owes once they have. Nothing calls it yet (ticket 615).
'use strict';

const GATE_FROM = 3, GATE_MINUTES = 10;
const FIX = 'fix', FOLLOW = 'follow-up';

const deciderOf = (finding) => (finding.tag === 'functional' ? 'pm' : 'lead');
const gated = (round) => round >= GATE_FROM;

function answerOf(finding, answers, askedAt, now) {
  const given = (answers || {})[finding.id];
  if (given === FIX || given === FOLLOW) return { answer: given, by: deciderOf(finding) };
  if (now - askedAt >= GATE_MINUTES * 60000 && !finding.blocking) return { answer: FOLLOW, by: 'timeout' };
  return null;
}

function gateOf({ round, findings, answers, askedAt, now }) {
  if (!gated(round)) return { gated: false, open: [], fix: [], followUp: [], mergeReady: false };
  const open = [], fix = [], followUp = [];
  for (const f of findings || []) {
    const a = answerOf(f, answers, askedAt, now);
    if (!a) open.push({ id: f.id, to: deciderOf(f) });
    else if (a.answer === FIX) fix.push(f.id);
    else followUp.push(f.id);
  }
  return { gated: true, open, fix, followUp, mergeReady: !open.length && !fix.length };
}

module.exports = { gateOf, deciderOf, gated, GATE_FROM, GATE_MINUTES, FIX, FOLLOW };
