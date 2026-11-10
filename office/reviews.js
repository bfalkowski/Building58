// Which review starts, and with which brief: Get a review on the page, and the automatic reviews the
// relay starts (relay/reviews.js). Plain functions, so both can load them, and so can the tests.
(function () {
  'use strict';
  const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
  const NO_CHANGES = 'Do not change any code, commit, or merge anything.';
  const workBrief = 'Review the work in this folder that is not merged yet, using git status, git diff, and this branch\'s commits compared to the branch it came from. Other sessions may share this folder. Look for bugs, and flag anything a person has to check by hand. Report your findings here. ' + NO_CHANGES;
  const prBrief = (u) => 'Review ' + u + ' using gh pr view and gh pr diff. This folder is your own checkout of its latest commit. Look for bugs and for anything that does not match the description, and flag anything a person has to check by hand. Post your findings as a PR comment. ' + NO_CHANGES;

  // What Get a review starts for a session. A session with a PR gets the same review as the automatic
  // one: a checkout of the PR's latest commit, made from the session's repo, and a comment on the PR,
  // so the reviewer does not stop to ask whether to post. Its PR is the relay's record for a Dev on a
  // ticket (work.pr), or else knownPr: its task's PR, or the PR the page saw it open. A reviewer is
  // never reviewed. Anyone else gets a reviewer in their own folder, who reports in their own
  // terminal, since only there is the work that is not pushed yet.
  function manualReview(t, knownPr) {
    const reviewer = t.role === 'reviewer' || (t.work && t.work.role === 'reviewer');
    const pr = reviewer ? null : (t.work && t.work.pr) || knownPr || null;
    if (pr && PR_URL.test(pr)) return { pr, from: t.cwd, prompt: prBrief(pr) };
    return { cwd: t.cwd, prompt: workBrief };
  }

  // A follow-up review, after a Dev pushed to a PR that had a review already.
  // With since, the commit the last review read, it reviews only what changed from there, so a round
  // checks the fixes rather than the whole PR again. A merge of main is checked only for how its
  // conflicts were resolved, and that neither side's code was dropped.
  const followBrief = (u, since) => prBrief(u) + ' New commits were pushed to it. If it has an earlier review comment (gh pr view ' + u + ' --comments), say for each finding in it whether the new commits fix it.' +
    (/^[0-9a-f]{40}$/.test(String(since || '')) ? ' The last review read ' + since + ', so review only what changed since: git log and git diff ' + since + '..HEAD. A new finding blocks only if it is a bug in those commits. For a merge of main among them, check only how its conflicts were resolved (git show --remerge-diff on it), and that no code from either side was dropped.' : '');

  // The automatic reviews one PR can get, the first one included. Then it waits on the person, who
  // can still press Get a review. This is the limit on the loop that article 5 asks for. The relay
  // counts them in RELAY_REVIEWS_FILE. This is the default: the person changes it in Settings, and the
  // relay passes it to followUps as max.
  const MAX_AUTO_REVIEWS = 3;

  // Which pushed PRs get their follow-up review now. pending maps a PR to { from, dev, session }: the
  // folder to make the checkout from, the Dev's desk, and its session id. A relay restart can bring the
  // Dev back at a new desk, so the session id finds it too. A PR waits while the Dev is still in its turn,
  // since it may push again, and while a review of it runs, since that review read an older commit.
  // counts maps a PR to the automatic reviews it has had. A PR whose last try failed waits until its
  // notBefore. Returns { start, full }: the reviews to start, and the PRs that are at the limit, max.
  function followUps(pending, terms, counts, now, max) {
    const limit = max || MAX_AUTO_REVIEWS;
    const start = [], full = [];
    for (const [pr, p] of pending) {
      if (p.notBefore && p.notBefore > (now || 0)) continue;
      const dev = terms.find((t) => t.running && (t.id === p.dev || (p.session && t.sessionId === p.session)));
      if (dev && (dev.state === 'working' || dev.state === 'waiting')) continue;  // waiting on the person is still the same turn
      if (terms.some((t) => t.running && t.role === 'reviewer' && t.pr === pr)) continue;
      if ((counts[pr] || 0) >= limit) full.push(pr);
      else start.push({ pr, from: p.from });
    }
    return { start, full };
  }

  // Whether a reviewed PR owes a follow-up review, from what the relay knows now, so a lost push hook
  // costs nothing. rec is the PR's record in relay/reviews.js: head, the commit its last review read,
  // and reviewedAt, when that review began. seen is what relay/pipeline.js last heard: { head, open, at }.
  // follows: Review again after each push, or Autopilot. reviewing: a review of the PR runs or starts.
  // A PR the relay never reviewed, or whose first review still waits, owes none: that is the first review's
  // job. An answer heard before the last review began may not know the commit it read, so it waits for the
  // next one. queued is the head the relay last queued from here, so a head that could not start, or that
  // a checkout found unchanged, is not queued again. A red pipeline still owes one: it waits in the
  // pipeline gate, which tells the Dev once and starts no review until it is green.
  // Returns 'review' when one is owed, 'person' when only the limit, max, stops it and nobody was told yet,
  // and '' otherwise. The relay queues an owed one as if the push had been heard, and followUps decides
  // when it starts.
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
