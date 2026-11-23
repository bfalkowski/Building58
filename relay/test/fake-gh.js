#!/usr/bin/env node
// Stands in for gh. FAKE_GH_DIR holds calls.log, which it appends each call to, and answers.json:
//   { "fail": "message" }                  every call fails with that message
//   { "failApi": { "repos/o/r/issues/7/comments": "message" } }  `gh api` on that path fails with that message
//   { "prs": { "<branch or PR link>": {...} } }  what `gh pr view` prints. Anything else has no PR.
//   { "api": { "repos/o/r/issues/7/comments": [...] } }  what `gh api --slurp` prints, as one page. Anything else is empty.
//                                          Without --slurp, such as `gh api user`, it prints the value as it is.
//   { "gateApi": { "repos/o/r/pulls/7/reviews": "/a/file" } }  `gh api` on that path waits until the file exists,
//                                          then answers from answers.json as it was when the call began
//   { "runs": [...] }                     what `gh run list` prints. Without it, `gh run list` prints [].
//   { "lists": { "<branch>": [...] } }  what `gh pr list --head <branch>` prints. Anything else is [].
// `gh pr comment <link> --body-file -` appends its link and body to posted.log, and prints a comment link.
// `gh pr merge <link> --merge` appends `<link> --merge` to merged.log.
// `gh pr edit <link> ...` appends its arguments to edited.log, and adds or removes the label on that PR in answers.json. With "labels": [...] in answers.json, adding a
// label not in the list fails as gh does, and `gh label create <name>` adds it to the list, or fails with "failLabel".
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = process.env.FAKE_GH_DIR;
fs.appendFileSync(path.join(dir, 'calls.log'), process.argv.slice(2).join(' ') + '\n');
let answers = {};
try { answers = JSON.parse(fs.readFileSync(path.join(dir, 'answers.json'), 'utf8')); } catch (e) { /* none yet */ }
if (answers.fail) { console.error(answers.fail); process.exit(1); }
const [verb, sub] = process.argv.slice(2);
if (verb === 'api') {
  const at = process.argv.slice(3).find((a) => !a.startsWith('-')).split('?')[0];
  if ((answers.failApi || {})[at]) { console.error(answers.failApi[at]); process.exit(1); }
  const gate = (answers.gateApi || {})[at];
  while (gate && !fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const value = (answers.api || {})[at];
  console.log(JSON.stringify(process.argv.includes('--slurp') ? [value || []] : value || {}));
  process.exit(0);
}
if (verb === 'run' && sub === 'list') {
  console.log(JSON.stringify(answers.runs || []));
  process.exit(0);
}
if (verb === 'pr' && sub === 'list') {  // prints answers.lists[<--head branch>]
  console.log(JSON.stringify((answers.lists || {})[process.argv[process.argv.indexOf('--head') + 1]] || []));
  process.exit(0);
}
if (verb === 'pr' && sub === 'merge') {  // appends its arguments to merged.log
  fs.appendFileSync(path.join(dir, 'merged.log'), process.argv.slice(4).join(' ') + '\n');
  process.exit(0);
}
if (verb === 'label' && sub === 'create') {
  if (answers.failLabel) { console.error(answers.failLabel); process.exit(1); }
  answers.labels = (answers.labels || []).concat(process.argv[4]);
  fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(answers));
  process.exit(0);
}
if (verb === 'pr' && sub === 'edit') {
  const add = process.argv.indexOf('--add-label');
  if (add > 0 && answers.labels && !answers.labels.includes(process.argv[add + 1])) { console.error('could not add label: \'' + process.argv[add + 1] + '\' not found'); process.exit(1); }
  const shown = (answers.prs || {})[process.argv[4]], remove = process.argv.indexOf('--remove-label');
  if (shown) {
    const names = (shown.labels || []).map((l) => l.name).filter((n) => !(remove > 0 && n === process.argv[remove + 1]));
    if (add > 0 && !names.includes(process.argv[add + 1])) names.push(process.argv[add + 1]);
    shown.labels = names.map((name) => ({ name }));
    fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(answers));
  }
  fs.appendFileSync(path.join(dir, 'edited.log'), process.argv.slice(4).join(' ') + '\n');
  process.exit(0);
}
if (verb === 'pr' && sub === 'comment') {
  const log = path.join(dir, 'posted.log');
  const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n---\n').length : 1;
  fs.appendFileSync(log, process.argv[4] + '\n' + fs.readFileSync(0, 'utf8') + '\n---\n');
  console.log(process.argv[4] + '#issuecomment-' + (9000 + n));
  process.exit(0);
}
const asked = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const pr = (answers.prs || {})[asked];
if (!pr) { console.error('no pull requests found for branch "' + asked + '"'); process.exit(1); }
console.log(JSON.stringify(pr));
