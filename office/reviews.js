// Which review starts, and with which brief: Get a review on the page, and the automatic reviews the
// relay starts (relay/reviews.js). Plain functions, so both can load them, and so can the tests.
(function () {
  'use strict';
  const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
  const NO_CHANGES = 'Do not change any code, commit, or merge anything.';
  const workBrief = 'Review the work in this folder that is not merged yet, using git status, git diff, and this branch\'s commits compared to the branch it came from. Other sessions may share this folder. Look for bugs, and flag anything a person has to check by hand. Report your findings here. ' + NO_CHANGES;
  const prBrief = (u) => 'Review ' + u + ' using gh pr view and gh pr diff. This folder is your own checkout of its latest commit. Look for bugs and for anything that does not match the description, and flag anything a person has to check by hand. Post your findings as a PR comment. ' + NO_CHANGES;

  function manualReview(t, knownPr) {
    const reviewer = t.role === 'reviewer' || (t.work && t.work.role === 'reviewer');
    const pr = reviewer ? null : (t.work && t.work.pr) || knownPr || null;
    if (pr && PR_URL.test(pr)) return { pr, from: t.cwd, prompt: prBrief(pr) };
    return { cwd: t.cwd, prompt: workBrief };
  }

  const followBrief = (u, since) => prBrief(u) + ' New commits were pushed to it. If it has an earlier review comment (gh pr view ' + u + ' --comments), say for each finding in it whether the new commits fix it. A blocking or fix-now finding they do not fix keeps its kind. Do not reverse a finding from an earlier round unless you say why.' +
    (/^[0-9a-f]{40}$/.test(String(since || '')) ? ' The last review read ' + since + ', so review only what changed since: git log and git diff ' + since + '..HEAD. A new finding is blocking only if it is a bug in those commits, and fix now only if it is in those commits. For a merge of main among them, check only how its conflicts were resolved (git show --remerge-diff on it), and that no code from either side was dropped.' : '');

  const MAX_AUTO_REVIEWS = 3;

  function followUps(pending, terms, counts, now, max) {
    const limit = max || MAX_AUTO_REVIEWS;
    const start = [], full = [];
    for (const [pr, p] of pending) {
      if (p.notBefore && p.notBefore > (now || 0)) continue;
      const dev = terms.find((t) => t.running && (t.id === p.dev || (p.session && t.sessionId === p.session)));
      if (dev && (dev.state === 'working' || dev.state === 'waiting')) continue;
      if (terms.some((t) => t.running && t.role === 'reviewer' && t.pr === pr)) continue;
      if ((counts[pr] || 0) >= limit && !p.again) full.push(pr);
      else start.push({ pr, from: p.from });
    }
    return { start, full };
  }

  function followUpOwed(rec, seen, o) {
    if (!o.follows || !rec || !rec.head || rec.first || rec.pending || o.reviewing) return '';
    if (!seen || !seen.head || seen.open === false || (seen.at || 0) <= (rec.reviewedAt || 0)) return '';
    if (seen.head === rec.head || seen.head === rec.queued) return '';
    if ((rec.count || 0) >= (o.max || MAX_AUTO_REVIEWS)) return rec.waits ? '' : 'person';
    return 'review';
  }

  const api = { PR_URL, prBrief, followBrief, manualReview, followUps, followUpOwed, MAX_AUTO_REVIEWS };
  if (typeof module !== 'undefined') module.exports = api; else window.OfficeReviews = api;
})();
