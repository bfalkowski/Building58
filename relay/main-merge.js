// A push whose own changes are the same as at the last review is a merge of main, not a round. Reads the Dev's checkout
// through the git function it is given. See docs/manual/roles.html#auto-review.
'use strict';

async function ownDiff(git, head, base) {
  const mb = (await git(['merge-base', head, base])).trim();
  return git(['diff', '--no-color', '--no-ext-diff', mb + '..' + head]);
}

async function sameOwnChanges(git, reviewed, head, base) {
  if (!reviewed || !head || !base) return false;
  try {
    return (await ownDiff(git, reviewed, base)) === (await ownDiff(git, head, base));
  } catch (e) { return false; }
}

const noteMerge = (rec, head) => { rec.mainMerges = (rec.mainMerges || 0) + 1; rec.head = head; return rec; };
const roundsLine = (rounds, merges) => rounds + (rounds === 1 ? ' round' : ' rounds') + (merges ? ', plus ' + merges + (merges === 1 ? ' merge' : ' merges') + ' of main' : '');

function coveredHead(rec, commit) {
  let at = commit;
  for (let i = 0; rec && rec.covers && rec.covers[at] && i < 1000; i++) at = rec.covers[at];
  return at;
}
const coveredVerdict = (v, head) => (v && v.kind === 'merge' && head && head !== v.commit ? Object.assign({}, v, { commit: head }) : v);

module.exports = { coveredHead, coveredVerdict, sameOwnChanges, noteMerge, roundsLine };
