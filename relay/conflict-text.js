// What the relay tells a Dev whose PR conflicts with main: the exact steps, and, after a push that did
// not clear it, the files that still conflict. See docs/manual/roles.html#conflict-note.
'use strict';
const { execFile } = require('child_process');

const git = (cwd, args) => new Promise((resolve, reject) => execFile('git', ['-C', cwd].concat(args), { timeout: 20000 }, (e, out) => (e ? reject(e) : resolve(String(out)))));

const STEPS = 'Do these steps and push nothing else: 1. git fetch origin 2. git merge origin/main 3. fix the files GitHub names as conflicting, keeping both sides of each conflict 4. run the suite in the foreground, not in the background 5. push the merge with a plain git push. Not fixes for the review\'s follow-up findings.';

const first = (pr) => 'Your PR ' + pr + ' conflicts with main, so it gets no review until the conflict is gone. ' + STEPS;
const again = (pr, head, files) => 'Your PR ' + pr + ' still conflicts with main at ' + head.slice(0, 7) + ' after your push.' + (files.length ? ' The conflicting files are: ' + files.join(', ') + '.' : '') + ' ' + STEPS;

async function conflictFiles(cwd) {
  if (!cwd) return [];
  try {
    await git(cwd, ['fetch', '-q', 'origin']);
    const out = await git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', 'origin/main']).catch((e) => (e && e.stdout ? String(e.stdout) : ''));
    return [...new Set(out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean))].slice(0, 20);
  } catch (e) { return []; }
}

module.exports = { STEPS, first, again, conflictFiles };
