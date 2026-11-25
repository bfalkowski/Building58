// What Exhibit says about a PR, for Autopilot's level 6 check (relay/autopilot-plan.js, docs/manual/roles.html#autopilot).
// The Exhibit GitHub Action posts one summary comment on each PR and updates it on each push. It starts with
// MARK, and its second line is: Verdict: **meets_policy** at head commit `abc1234`. The relay reads it only when it
// came from github-actions[bot], since every session posts as the person's own account and could write the mark.
// verdictOf(comments) -> { verdict, commit } of the latest such comment, or null.
// read(link, cwd) -> the same, or null with no comment, or { failed } when gh could not say.
'use strict';
const gh = require('./gh.js');

const MARK = '<!-- exhibit:pr-summary -->';
const BOT = 'github-actions[bot]';
const LINE = /^Verdict: \*\*(meets_policy|needs_person|error)\*\* at head commit `([0-9a-f]{7,40})`/m;
const LINK = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;

function verdictOf(comments) {
  const mine = (comments || []).filter((c) => c && c.user && c.user.login === BOT && c.user.type === 'Bot' && typeof c.body === 'string' && c.body.startsWith(MARK));
  mine.sort((a, b) => String(a.updated_at || a.created_at).localeCompare(String(b.updated_at || b.created_at)));
  const last = mine[mine.length - 1];
  const m = last && last.body.match(LINE);
  return m ? { verdict: m[1], commit: m[2] } : null;
}

async function read(link, cwd) {
  const m = String(link).match(LINK);
  if (!m) return { failed: 'the PR link is not a GitHub pull request' };
  try {
    const out = await gh.run(['api', '--paginate', '--slurp', 'repos/' + m[1] + '/issues/' + m[2] + '/comments?per_page=100'], { cwd });
    return verdictOf(JSON.parse(out).flat());
  } catch (e) { return { failed: 'gh could not list the PR\'s comments' }; }
}

module.exports = { MARK, verdictOf, read };
