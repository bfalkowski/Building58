// What a follow-up reviewer is given about the PR's earlier rounds (T-297): each earlier review (a comment
// or review headed "Review of <commit>"), its verdict, its findings, and how the Dev answered each one
// (the comments that start with the Dev mark, until the next round). A round that does not fit is cut to
// its findings, and the text says so. A closed earlier PR of the same ticket is named, with why it closed
// when the room knows. See docs/manual/roles.html#auto-review.
'use strict';
const { keepLines, oneLine } = require('./clean.js');
const { DEV_MARK } = require('./pr-comments.js');

const HEADING = /^#{1,6}[ \t]+review of[ \t]+`?(?:[0-9a-f]{7,40}\.\.\.?)?([0-9a-f]{7,40})\b/i;
const FINDING = /^\s*(?:[-*]|\d+[.)])\s|blocking|fix now|follow-up/i;
const BUDGET = 5500, FLOOR = 240, ANSWER = 300, DROPPED = 60;

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

function part(round, i, max, ans) {
  const head = 'Round ' + (i + 1) + ', commit ' + round.commit.slice(0, 12) + ', verdict ' + round.verdict + ':\n';
  const answers = round.answers.map((a) => 'Dev answered: ' + one(a, ans)).join('\n');
  const body = max !== null ? one(findings(round.body), max) : keepLines(round.body, 100000).trim();
  return head + body + (answers ? '\n' + answers : '');
}
const NOTICE = 'Long rounds are cut to their findings.\n';
function text(items, o) {
  const rounds = roundsOf(items || []), earlier = (o && o.earlier) || null;
  const closed = earlier ? ' An earlier PR of this ticket, ' + earlier.pr + ', was closed without a merge' + (earlier.why ? ': ' + earlier.why : ', and the room does not know why') + '.' : '';
  const limit = o && o.budget != null ? o.budget : BUDGET;
  if (!rounds.length) return closed.length <= limit ? closed : '';
  const lead = ' Earlier reviews of this PR, oldest first. Check that no finding marked fixed in an earlier round has come back in the new commits, and that a finding the Dev disputed was settled.' + closed + '\n';
  const full = rounds.map((r, i) => part(r, i, null, ANSWER));
  if (lead.length + full.join('\n\n').length <= limit) return lead + full.join('\n\n');
  let room = limit - lead.length - NOTICE.length - DROPPED;
  if (room < FLOOR) return '';
  const kept = [];
  for (let i = rounds.length - 1; i >= 0; i--) {
    const tries = [part(rounds[i], i, 1200, ANSWER), part(rounds[i], i, FLOOR, 100)];
    const fits = tries.find((p) => p.length + 2 <= room);
    if (fits) { kept.unshift(fits); room -= fits.length + 2; continue; }
    if (!kept.length) { kept.unshift(tries[1].slice(0, room - 8).trimEnd() + ' [cut]'); room = 0; i--; }
    break;
  }
  const left = rounds.length - kept.length;
  const dropped = left ? 'Rounds 1 to ' + left + ' are left out for size.\n' : '';
  return lead + NOTICE + dropped + kept.join('\n\n');
}

async function earlierOf(task, pr, look) {
  const old = task && task.history.filter((h) => h.type === 'pr' && h.pr && h.pr !== pr).map((h) => h.pr).pop();
  if (!old) return null;
  try {
    const seen = await look(old);
    if (seen.state !== 'CLOSED' || seen.mergedAt) return null;
  } catch (e) { return null; }
  const why = task.history.filter((h) => h.type === 'note' && h.note && h.note.includes(old) && /closed/i.test(h.note)).map((h) => h.note).pop();
  return { pr: old, why: why ? oneLine(why, 200) : '' };
}

module.exports = { text, roundsOf, earlierOf, HEADING };
