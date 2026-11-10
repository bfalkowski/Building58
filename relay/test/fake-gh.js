#!/usr/bin/env node
// Stands in for gh. FAKE_GH_DIR holds calls.log, which it appends each call to, and answers.json:
//   { "fail": "message" }                  every call fails with that message
//   { "prs": { "<branch or PR link>": {...} } }  what `gh pr view` prints. Anything else has no PR.
//   { "api": { "repos/o/r/issues/7/comments": [...] } }  what `gh api --slurp` prints, as one page. Anything else is empty.
//                                          Without --slurp, such as `gh api user`, it prints the value as it is.
// `gh pr comment <link> --body-file -` appends its link and body to posted.log, and prints a comment link.
// `gh pr merge <link> --merge` appends `<link> --merge` to merged.log.
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
  const value = (answers.api || {})[at];
  console.log(JSON.stringify(process.argv.includes('--slurp') ? [value || []] : value || {}));
  process.exit(0);
}
if (verb === 'pr' && sub === 'merge') {  // appends its arguments to merged.log
  fs.appendFileSync(path.join(dir, 'merged.log'), process.argv.slice(4).join(' ') + '\n');
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
