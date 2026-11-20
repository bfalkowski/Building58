// What the Lead's Ready to merge note says, and why the relay refuses to post one (relay/ready.js, T-107).
// Plain functions with no side effects, so the tests can load them without starting a relay.
// See docs/manual/roles.html#ready.
'use strict';
const path = require('path');
const { stateOf } = require('./pipeline.js');
const { PROTECTED } = require('./autopilot-plan.js');

const LABEL = 'ready to merge';
const LABEL_COLOR = '0E8A16';
const LABEL_ABOUT = 'The Lead checked it: reviewed, findings settled, pipeline green, merges cleanly into main';
const MARK = '<!-- office:ready -->';
const PARTS = [['Reviews:', 'each review of this head, with its link and verdict'],
  ['Findings:', 'how each finding was settled: fixed and checked in the code, disputed, or filed as a ticket'],
  ['Hand checks still open:', 'what nobody has checked by hand yet, or none']];

function guide(relayDir) {
  return 'Mark a PR ready to merge only when a review of its current head is posted, every blocking and fix-now finding is fixed and you checked each fix in the code, and no decision is left to the person. ' +
    'The relay checks the rest and refuses if any fails: the PR is open with base main, its head is the commit you name, its pipeline is green there, it merges cleanly, and its Dev has no merge hold. Then run:\n' +
    '  node ' + JSON.stringify(path.join(relayDir, 'ticket.js')) + ' ready <PR link> <head commit> --body - <<\'EOF\'\n' +
    PARTS.map(([k, v]) => '  ' + k + ' ' + v + '.\n').join('') +
    '  EOF\n' +
    'The relay posts it as one comment headed Ready to merge, with the head and who merges it, and adds the "' + LABEL + '" label. ' +
    'A new commit takes the label off and the note stays. Mark it again once you have checked the new commits.';
}

function missingParts(text) {
  const lines = String(text).split('\n').map((l) => l.trim().toLowerCase());
  const missing = PARTS.filter(([k]) => !lines.some((l) => l.startsWith(k.toLowerCase()))).map(([k]) => k);
  return missing.length ? missing : null;
}

function refusal(p, head, hold) {
  const state = String(p.state || '').toUpperCase();
  if (state !== 'OPEN') return 'It is ' + (state ? state.toLowerCase() : 'not open') + ', not open.';
  if (p.baseRefName !== 'main') return 'Its base is ' + p.baseRefName + ', not main. A PR with another base goes to the person.';
  if (!String(p.headRefOid || '').startsWith(head)) return 'Its head is now ' + String(p.headRefOid || '').slice(0, 7) + ', not ' + head.slice(0, 7) + '. Check the new commits first.';
  const pipe = stateOf(p.statusCheckRollup);
  if (pipe !== 'green') return 'Its pipeline is ' + (pipe === 'none' ? 'not reporting any checks' : pipe) + ' on this head, not green.';
  if (p.mergeable !== 'MERGEABLE') return 'GitHub says it ' + (p.mergeable === 'CONFLICTING' ? 'conflicts with main' : 'has not worked out yet whether it merges cleanly; try again in a minute') + '.';
  if (hold) return 'Its Dev has a merge hold: ' + hold;
  return null;
}

function whoMerges(files, { leadMerges = false, autopilot = false } = {}) {
  const locked = [...new Set(files.filter((f) => PROTECTED.includes(f)))];
  if (locked.length) return 'the person, since it changes ' + locked.join(' and ') + ', which only a person merges.';
  if (autopilot) return 'Autopilot, unless the person merges it first.';
  return leadMerges ? 'the Lead, under the merge rung, unless the person merges it first.' : 'the person.';
}

function noteOf({ head, who, text }) {
  return MARK + '\n## Ready to merge\n\n' +
    '**Head:** `' + head + '`\n\n**Who merges:** ' + who + '\n\n' + String(text).trim() + '\n\n' +
    '_From the Lead. The relay checked that this head is open on main, green and merges cleanly. The `' + LABEL + '` label comes off when a new commit lands. This note stays as history._\n';
}

module.exports = { guide, missingParts, refusal, whoMerges, noteOf, PARTS, LABEL, LABEL_COLOR, LABEL_ABOUT, MARK };
