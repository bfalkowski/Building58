// The push hold: after a review's verdict says merge, the Dev's checkout refuses a push, except a
// merge of the base that GitHub needs to clear a conflict. A push for a merge verdict's findings costs
// a pipeline run and a review round, and can break what was reviewed (T-253).
// See docs/manual/roles.html#push-hold.
//
//   The relay side. sync() writes a mark, office-push-hold.json, in the git folder of a task's own
//   checkout (that worktree's folder under .git/worktrees, so git never shows or commits it). It writes
//   the mark while the latest posted verdict on the task's PR says merge, and removes it when a newer
//   verdict says fix, the PR merges or closes, or the task is Done. A newer fix verdict is a review's, or the
//   person's Fix it (the Lead's under its merge rung), which relay/autopilot.js keeps on the reviewed commit.
//   relay/autopilot.js, which keeps the verdicts, calls it when a verdict is posted or decided, when a task
//   changes state, and on each of its looks.
//   The git side. .githooks/pre-push runs this file with --pre-push when the mark is there. A push goes
//   through only when every new commit since the reviewed one is a merge whose first parent is the
//   reviewed commit or another such merge, and whose other parents are on the remote's base branch.
//   It also goes through when the remote branch has commits the verdict did not read (a push after
//   the review began), since then a follow-up review is owed anyway.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MARK = 'office-push-hold.json';
const ZERO = /^0+$/;

function markOf(task, verdict, seen) {
  if (!task || !task.pr || task.state === 'done') return null;
  if (seen && seen.open === false) return null;
  if (!verdict || !verdict.posted || verdict.kind !== 'merge' || !verdict.commit) return null;
  return { pr: task.pr, commit: verdict.commit, base: task.base || 'main' };
}

function gitDirOf(worktree) {
  const dot = path.join(worktree, '.git');
  let stat;
  try { stat = fs.statSync(dot); } catch (e) { return null; }
  if (stat.isDirectory()) return dot;
  const m = fs.readFileSync(dot, 'utf8').match(/^gitdir:\s*(.+)$/m);
  return m ? path.resolve(worktree, m[1].trim()) : null;
}

function sync(task, verdict, seen) {
  if (!task || !task.worktree) return false;
  const dir = gitDirOf(task.worktree);
  if (!dir) return false;
  const file = path.join(dir, MARK), mark = markOf(task, verdict, seen);
  let was = null;
  try { was = fs.readFileSync(file, 'utf8'); } catch (e) { was = null; }
  if (!mark) {
    if (was === null) return false;
    fs.rmSync(file, { force: true });
    return true;
  }
  const text = JSON.stringify(mark) + '\n';
  if (was === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

function refusal(mark) {
  return 'The review of ' + mark.commit.slice(0, 7) + ' says merge. Do not push. Reply on the PR, and file a ticket only for a finding that is a real bug or risk outside this PR.' +
    ' Only a merge of ' + mark.base + ' that clears a conflict may be pushed now. PR: ' + mark.pr;
}

function onlyMerges(git, tip, reviewed, base) {
  if (tip === reviewed) return true;
  let out;
  try { out = git(['rev-list', '--parents', tip, '--not', reviewed].concat(base ? [base] : [])); } catch (e) { return false; }
  const rows = out.split('\n').filter(Boolean).map((l) => l.split(' '));
  const fresh = new Set(rows.map((r) => r[0]));
  if (!rows.length) return isAncestor(git, tip, reviewed);
  return rows.every(([, first, ...others]) => others.length > 0 && (first === reviewed || fresh.has(first)));
}
function isAncestor(git, a, b) {
  try { git(['merge-base', '--is-ancestor', a, b]); return true; } catch (e) { return false; }
}

function check(git, mark, remote, lines) {
  const resolve = (ref) => { try { return git(['rev-parse', '--verify', '--quiet', ref]); } catch (e) { return null; } };
  const base = resolve('refs/remotes/' + remote + '/' + mark.base) || resolve('refs/remotes/origin/' + mark.base);
  for (const line of lines) {
    const [, local, , remoteSha] = line.trim().split(/\s+/);
    if (!local) continue;
    if (ZERO.test(local)) return { ok: false, message: refusal(mark) };
    const covered = !remoteSha || ZERO.test(remoteSha) || onlyMerges(git, remoteSha, mark.commit, base);
    if (!covered) continue;
    if (!onlyMerges(git, local, mark.commit, base)) return { ok: false, message: refusal(mark) };
  }
  return { ok: true };
}

function prePush(remote, input, cwd) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let mark;
  try { mark = JSON.parse(fs.readFileSync(path.join(git(['rev-parse', '--absolute-git-dir']), MARK), 'utf8')); } catch (e) { return { ok: true }; }
  if (!mark || !mark.commit) return { ok: true };
  return check(git, mark, remote || 'origin', String(input).split('\n'));
}

if (require.main === module && process.argv[2] === '--pre-push') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    const r = prePush(process.argv[3], input, process.cwd());
    if (!r.ok) { process.stderr.write('Push refused: ' + r.message + '\n'); process.exit(1); }
  });
}

module.exports = { markOf, sync, gitDirOf, check, prePush, refusal, MARK };
