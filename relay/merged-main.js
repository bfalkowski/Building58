// Did a push add a merge of origin/main? Reads the Dev's checkout through the git function it is given.
// Used by relay/autopilot.js to tell a Dev that merged main from one that did not. See docs/manual/roles.html#autopilot-conflict-count.
'use strict';

async function mergedMain(git, from, head) {
  if (!from) return false;
  try {
    const lines = (await git(['rev-list', '--merges', '--parents', from + '..' + head])).split('\n').filter(Boolean);
    for (const line of lines) {
      for (const parent of line.split(' ').slice(2)) {
        if (await git(['merge-base', '--is-ancestor', parent, 'origin/main']).then(() => true, () => false)) return true;
      }
    }
  } catch (e) { return false; }
  return false;
}

async function holdsAll(git, commits, head) {
  if (!commits.length) return false;
  for (const c of commits) {
    if (!c || !(await git(['merge-base', '--is-ancestor', c, head]).then(() => true, () => false))) return false;
  }
  return true;
}

module.exports = { mergedMain, holdsAll };
