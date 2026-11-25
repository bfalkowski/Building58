// The push hold: after a review's verdict says merge, the Dev's checkout refuses a push, except a
// merge of the base that GitHub needs to clear a conflict, with the small fixes that merge forces. A push
// for a merge verdict's findings costs a pipeline run and a review round, and can break what was reviewed (T-253).
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
//   reviewed commit or another such merge, and whose other parents are on the remote's base branch, or a
//   commit after such a merge that changes only files a merge in the push changed (the version bump or
//   test fix the merge forces). A follow-up review of the merge and the fixes is owed as for any push.
//   While the PR's latest pipeline run is red, there is no mark: a merge verdict on a red PR cannot merge, and
//   the hold would block the push that fixes it. sync() keeps office-push-hold-lifted.json for the verdict's
//   commit, so the hold stays off until a newer verdict (the follow-up review's) says merge. A run that is
//   only pending or cancelled lifts nothing. relay/autopilot.js tells the Dev and logs the jam once.
//   A refused push is written to office-refused-pushes.jsonl beside the mark, and a later push that goes
//   through is noted after it: the relay reads it for the jam log and for Needs you (relay/autopilot.js,
//   relay/needs-you.js), and clears it with the mark.
//   It also goes through when the remote branch has commits the verdict did not read (a push after
//   the review began), since then a follow-up review is owed anyway.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MARK = 'office-push-hold.json';
const REFUSED = 'office-refused-pushes.jsonl';
const SEEN = 'office-refused-pushes.seen';
const LIFTED = 'office-push-hold-lifted.json';
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
  const file = path.join(dir, MARK), lifted = path.join(dir, LIFTED);
  let mark = markOf(task, verdict, seen);
  let was = null;
  try { was = fs.readFileSync(file, 'utf8'); } catch (e) { was = null; }
  let lift = null;
  try { lift = JSON.parse(fs.readFileSync(lifted, 'utf8')); } catch (e) { lift = null; }
  if (mark && lift && lift.commit === mark.commit) mark = null;
  else if (mark && seen && seen.state === 'red') {
    fs.writeFileSync(lifted, JSON.stringify({ pr: mark.pr, commit: mark.commit, at: new Date().toISOString(), told: false }) + '\n');
    mark = null;
  } else if (lift) fs.rmSync(lifted, { force: true });
  if (!mark) {
    for (const name of [REFUSED, SEEN]) fs.rmSync(path.join(dir, name), { force: true });
    if (was === null) return !!lift !== !!readLift(dir);
    fs.rmSync(file, { force: true });
    return true;
  }
  const text = JSON.stringify(mark) + '\n';
  if (was === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

function readLift(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, LIFTED), 'utf8')); } catch (e) { return null; }
}
function untoldLift(task) {
  const dir = task && task.worktree ? gitDirOf(task.worktree) : null;
  const lift = dir && readLift(dir);
  return lift && !lift.told ? lift : null;
}
function markLiftTold(task) {
  const dir = task && task.worktree ? gitDirOf(task.worktree) : null;
  const lift = dir && readLift(dir);
  if (lift) fs.writeFileSync(path.join(dir, LIFTED), JSON.stringify(Object.assign(lift, { told: true })) + '\n');
}
const RED_CI_TEXT = 'CI is red on your PR. Fix the failure in this PR, run the tests, and push. A follow-up review checks the fix.';

function refusal(mark, why) {
  return 'The review of ' + mark.commit.slice(0, 7) + ' says merge. Do not push. Reply on the PR, and file a ticket only for a finding that is a real bug or risk outside this PR.' +
    ' Only a merge of ' + mark.base + ' that clears a conflict may be pushed now, and after it only commits that change files the merge changed.' +
    (why ? ' Refused: ' + why : '') + ' PR: ' + mark.pr;
}

const splitZ = (git, args) => git(args).split('\0').filter(Boolean);
function listOf(files) {
  const shown = files.slice(0, 3).join(', ');
  return files.length > 3 ? shown + ' and ' + (files.length - 3) + ' more' : shown;
}

function judge(git, tip, reviewed, base) {
  if (tip === reviewed) return null;
  let out;
  try { out = git(['rev-list', '--parents', tip, '--not', reviewed].concat(base ? [base] : [])); } catch (e) { return 'git could not list the new commits.'; }
  const rows = out.split('\n').filter(Boolean).map((l) => l.split(' '));
  if (!rows.length) return isAncestor(git, tip, reviewed) ? null : 'the push does not build on the reviewed commit.';
  const fresh = new Map(rows.map((r) => [r[0], r]));
  const merges = rows.filter((r) => r.length > 2);
  const allowed = new Set();
  const bad = (sha, text) => 'commit ' + sha.slice(0, 7) + ' ' + text;
  for (const [sha, first] of merges) {
    if (first !== reviewed && !fresh.has(first)) return bad(sha, 'is a merge that does not continue from the reviewed commit.');
    try { for (const f of splitZ(git, ['diff', '--name-only', '-z', first, sha])) allowed.add(f); } catch (e) { return bad(sha, 'is a merge git could not read.'); }
  }
  for (const [sha, first, ...others] of rows) {
    if (others.length) continue;
    if (!first || !fresh.has(first)) return bad(sha, 'is new work, not a merge of the base or a fix after one.');
    let files;
    try { files = splitZ(git, ['diff', '--name-only', '-z', first, sha]); } catch (e) { return bad(sha, 'is a commit git could not read.'); }
    const extra = files.filter((f) => !allowed.has(f));
    if (extra.length) return bad(sha, 'changes ' + listOf(extra) + ', which the merge did not change.');
  }
  return null;
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
    if (ZERO.test(local)) return { ok: false, why: 'it deletes the branch.', message: refusal(mark, 'it deletes the branch.') };
    const covered = !remoteSha || ZERO.test(remoteSha) || judge(git, remoteSha, mark.commit, base) === null;
    if (!covered) continue;
    const why = judge(git, local, mark.commit, base);
    if (why) return { ok: false, why, message: refusal(mark, why), tip: local };
  }
  return { ok: true };
}

function note(dir, line, onlyIfThere) {
  const file = path.join(dir, REFUSED);
  try {
    if (onlyIfThere && !fs.existsSync(file)) return;
    fs.appendFileSync(file, JSON.stringify(Object.assign({ at: new Date().toISOString() }, line)) + '\n');
  } catch (e) { return; }
}

function refusalsOf(task) {
  const dir = task && task.worktree ? gitDirOf(task.worktree) : null;
  if (!dir) return { list: [], seen: 0 };
  let list = [];
  try { list = fs.readFileSync(path.join(dir, REFUSED), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { list = []; }
  let seen = 0;
  try { seen = Number(fs.readFileSync(path.join(dir, SEEN), 'utf8')) || 0; } catch (e) { seen = 0; }
  return { list, seen };
}
function markSeen(task, count) {
  const dir = task && task.worktree ? gitDirOf(task.worktree) : null;
  if (dir) fs.writeFileSync(path.join(dir, SEEN), String(count) + '\n');
}

function prePush(remote, input, cwd) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let mark;
  try { mark = JSON.parse(fs.readFileSync(path.join(git(['rev-parse', '--absolute-git-dir']), MARK), 'utf8')); } catch (e) { return { ok: true }; }
  if (!mark || !mark.commit) return { ok: true };
  const r = check(git, mark, remote || 'origin', String(input).split('\n'));
  try {
    const dir = git(['rev-parse', '--absolute-git-dir']);
    if (r.ok) note(dir, { allowed: true }, true); else note(dir, { pr: mark.pr, commit: mark.commit, tip: r.tip || null, why: r.why });
  } catch (e) { return r; }
  return r;
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

module.exports = { untoldLift, markLiftTold, RED_CI_TEXT, LIFTED, markOf, sync, gitDirOf, check, prePush, refusal, refusalsOf, markSeen, MARK, REFUSED, SEEN };
