// What a follow-up reviewer is given about the PR's earlier rounds (T-297): each earlier review (a comment
// or review headed "Review of <commit>"), its verdict, its findings, and how the Dev answered each one
// (the comments that start with the Dev mark, until the next round). A round that does not fit is cut to
// its findings, and the text says so. A closed earlier PR of the same ticket is named, with why it closed
// when the room knows. See docs/manual/roles.html#auto-review.
'use strict';
const { keepLines } = require('./clean.js');

const HEADING = /^#{1,6}[ \t]+review of[ \t]+`?(?:[0-9a-f]{7,40}\.\.\.?)?([0-9a-f]{7,40})\b/i;
const DEV_MARK = '<!-- office:dev -->';
const FINDING = /^\s*(?:[-*]|\d+[.)])\s|blocking|fix now|follow-up/i;
const BUDGET = 5500, FLOOR = 240, ANSWER = 300;

function verdictOf(item) {
  const said = String(item.body).match(/verdict\W+(merge|fix)\b/i);
  if (said) return said[1].toLowerCase();
  return item.kind === 'r' && item.state === 'CHANGES_REQUESTED' ? 'fix' : 'not stated';
}
function roundsOf(items) {
  const rounds = [];
  for (const item of items.slice().sort((a, b) => (a.at || 0) - (b.at || 0))) {
    const body = String(item.body || '');
    const named = body.trimStart().match(HEADING);
    if (named) rounds.push({ commit: named[1], verdict: verdictOf(item), body, answers: [] });
    else if (body.startsWith(DEV_MARK) && rounds.length) rounds[rounds.length - 1].answers.push(body.slice(DEV_MARK.length));
  }
  return rounds;
}
const findings = (body) => String(body).split('\n').filter((l) => FINDING.test(l)).join('\n') || String(body);
const fit = (text, max) => (text.length > max ? text.slice(0, Math.max(0, max - 6)).trimEnd() + ' [cut]' : text);
const one = (text, max) => fit(keepLines(text, 100000).trim(), max);

function part(round, i, max) {
  const head = 'Round ' + (i + 1) + ', commit ' + round.commit.slice(0, 12) + ', verdict ' + round.verdict + ':\n';
  const answers = round.answers.map((a) => 'Dev answered: ' + one(a, ANSWER)).join('\n');
  const cutBody = max !== null;
  const body = cutBody ? one(findings(round.body), Math.max(FLOOR, max)) : keepLines(round.body, 100000).trim();
  return head + body + (answers ? '\n' + answers : '');
}
function text(items, o) {
  const rounds = roundsOf(items || []), earlier = (o && o.earlier) || null;
  const closed = earlier ? ' An earlier PR of this ticket, ' + earlier.pr + ', was closed without a merge' + (earlier.why ? ': ' + earlier.why : ', and the room does not know why') + '.' : '';
  if (!rounds.length) return closed;
  const limit = (o && o.budget) || BUDGET;
  const lead = ' Earlier reviews of this PR, oldest first. Check that no finding marked fixed in an earlier round has come back in the new commits, and that a finding the Dev disputed was settled.' + closed + '\n';
  let parts = rounds.map((r, i) => part(r, i, null));
  let cut = false;
  if (lead.length + parts.join('\n\n').length > limit) {
    cut = true;
    const share = Math.floor((limit - lead.length - 80) / rounds.length) - 120 - ANSWER;
    parts = rounds.map((r, i) => part(r, i, share));
  }
  let out = lead + (cut ? 'Long rounds are cut to their findings.\n' : '') + parts.join('\n\n');
  if (out.length > limit) out = out.slice(0, limit - 40).trimEnd() + '\n[the rest of the history is cut]';
  return out;
}

module.exports = { text, roundsOf, HEADING };
