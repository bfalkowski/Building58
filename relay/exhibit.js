// What Exhibit says about a PR, for Autopilot's level 6 check (relay/autopilot-plan.js, docs/manual/roles.html#autopilot-exhibit).
// The nightly Exhibit workflow posts no comment. It stores each exhibit on the exhibit-data branch at prs/N/<head commit>.json
// (.github/workflows/exhibit.yml). The relay reads the file for the PR's current head through the GitHub API.
// verdictOf(stored, want) -> { verdict, commit } when the stored exhibit is for the PR, head and repo asked for, or null.
// MARK starts the summary comment that Exhibit's own Action posts. Level 6 does not read it, but relay/pr-comments.js
// keeps such a comment from waking the Dev.
// read(link, cwd, head) -> the same, or null with no stored exhibit for that head, or { failed } when gh could not say.
'use strict';
const gh = require('./gh.js');

const MARK = '<!-- exhibit:pr-summary -->';
const BRANCH = 'exhibit-data';
const VERDICTS = ['meets_policy', 'needs_person', 'error'];
const LINK = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;
const HEAD = /^[0-9a-f]{40}$/;

function verdictOf(stored, want) {
  const e = stored && typeof stored === 'object' ? stored : {};
  const here = e.pr === Number(want.pr) && e.head === want.head && String(e.repo).toLowerCase() === want.repo.toLowerCase();
  return here && VERDICTS.includes(e.verdict) ? { verdict: e.verdict, commit: e.head } : null;
}

async function read(link, cwd, head) {
  const m = String(link).match(LINK);
  if (!m) return { failed: 'the PR link is not a GitHub pull request' };
  if (!HEAD.test(String(head))) return { failed: 'the PR\'s head commit is not known' };
  let out;
  try {
    out = await gh.run(['api', '-H', 'Accept: application/vnd.github.raw+json', 'repos/' + m[1] + '/contents/prs/' + m[2] + '/' + head + '.json?ref=' + BRANCH], { cwd });
  } catch (e) {
    return /\b404\b|Not Found/i.test(e.message) ? null : { failed: 'gh could not read the stored exhibit' };
  }
  try { return verdictOf(JSON.parse(out), { repo: m[1], pr: m[2], head }); } catch (e) { return { failed: 'the stored exhibit is not JSON' }; }
}

module.exports = { MARK, BRANCH, verdictOf, read };
