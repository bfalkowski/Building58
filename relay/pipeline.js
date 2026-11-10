// A PR's pipeline: what the checks on its latest commit say. Automatic reviews wait for it
// (relay/reviews.js), and the Board shows it (relay/tasks.js). See docs/manual/roles.html#pipeline.
//
// The relay asks gh pr view --json headRefOid,statusCheckRollup every pipelinePollSeconds (Settings)
// for each PR that someone here watches, and keeps the last answer in memory. 0 stops asking, and
// then nothing waits for a pipeline. A pipeline is one of:
//   green    every check passed, or was skipped or neutral
//   red      a check failed
//   pending  a check has not finished
//   none     the PR has no checks at all. Right after a push GitHub may not have started them yet,
//            so this is waited on for pipelineNoChecksSeconds, and then it means no pipeline
//   unknown  gh did not answer, or sent something unreadable
// It also keeps whether the PR is still open (open: false once it merged or closed), since a review
// that waits for a PR that is gone never starts.
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const config = require('./config.js');

const GH = process.env.GH_CMD || 'gh';
const OK = ['SUCCESS', 'SKIPPED', 'NEUTRAL'];
const NOT_DONE = ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'];

// A check run has a status and, once it is done, a conclusion. A commit status has only a state.
function stateOf(rollup) {
  const checks = Array.isArray(rollup) ? rollup : [];
  if (!checks.length) return 'none';
  const result = (c) => String(c.conclusion || c.state || '').toUpperCase();
  if (checks.some((c) => result(c) && !OK.includes(result(c)) && !NOT_DONE.includes(result(c)))) return 'red';
  if (checks.some((c) => (c.status && String(c.status).toUpperCase() !== 'COMPLETED') || !OK.includes(result(c)))) return 'pending';
  return 'green';
}

// Whether a review that waits on the pipeline can start. p is what the relay last heard about the PR,
// or null. heldAt is when the review began to wait. lastHead is the commit the PR's last review read,
// for a review after a push: until GitHub has a newer one, the push has not reached it, and what it
// says is about the old commit. grace is pipelineNoChecksSeconds in ms.
// Returns { go: true, why? } or { go: false, red?, why }.
// A PR that merged or closed gives { go: false, gone: true }, and its review stops waiting.
function gate(p, { heldAt, lastHead, now, grace }) {
  const waited = (since) => now - Math.max(since || 0, heldAt || 0) >= grace;
  if (!p) return { go: false, why: 'Asking GitHub about its checks.' };
  if (p.open === false) return { go: false, gone: true, why: 'It was ' + (p.prState === 'MERGED' ? 'merged' : 'closed') + ' before its review started.' };
  if (p.state === 'unknown') return waited(p.since) ? { go: true, why: 'gh could not read its checks (' + p.error + '), so the review starts without them.' } : { go: false, why: 'gh could not read its checks: ' + p.error };
  if (lastHead && p.head === lastHead && !waited(0)) return { go: false, why: 'Waiting for GitHub to see the push.' };
  if (p.state === 'green') return { go: true };
  if (p.state === 'red') return { go: false, red: true, why: 'A check failed.' };
  if (p.state === 'pending') return { go: false, why: 'Its checks are running.' };
  return waited(p.since) ? { go: true, why: 'It has no checks, so the review starts with no pipeline.' } : { go: false, why: 'No checks have started yet.' };
}

// ---------- asking gh ----------
const seen = new Map();  // PR link -> { state, head, since, at, error }
const sources = [];  // each returns [{ pr, cwd }]: the PRs to ask about, and a folder to ask from
const watch = (fn) => sources.push(fn);
const on = () => config.get('pipelinePollSeconds') > 0;
const of = (pr) => (pr && seen.get(pr)) || null;

function view(pr, cwd) {
  return new Promise((resolve) => {
    execFile(GH, ['pr', 'view', pr, '--json', 'state,headRefOid,statusCheckRollup'], { cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(), timeout: 20000, env: Object.assign({}, process.env, { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }) }, (err, stdout, stderr) => {
      if (err) { resolve({ state: 'unknown', error: err.code === 'ENOENT' ? 'gh is not installed' : String(stderr || err.message).trim().split('\n')[0].slice(0, 160) || 'gh failed' }); return; }
      try { const p = JSON.parse(stdout); const prState = String(p.state || 'OPEN').toUpperCase(); resolve({ state: stateOf(p.statusCheckRollup), head: String(p.headRefOid || ''), prState, open: prState === 'OPEN' }); } catch (e) { resolve({ state: 'unknown', error: 'gh sent something unreadable' }); }
    });
  });
}
// since is when this answer, for this commit, was first heard, so a wait for checks to appear has a start.
const asking = new Map();
function ask(pr, cwd) {
  if (asking.has(pr)) return asking.get(pr);
  const done = view(pr, cwd).then((now) => {
    const was = seen.get(pr), at = Date.now();
    const same = was && was.state === now.state && (now.state === 'unknown' || was.head === now.head);
    seen.set(pr, Object.assign(now, { head: now.head || (was && was.head) || null, since: same ? was.since : at, at }));
    return seen.get(pr);
  }).finally(() => asking.delete(pr));
  asking.set(pr, done);
  return done;
}
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const wanted = new Map();
    for (const fn of sources) { try { for (const w of fn()) if (w && w.pr && !wanted.has(w.pr)) wanted.set(w.pr, w.cwd); } catch (e) { console.error('Pipeline: ' + e.message); } }
    for (const pr of seen.keys()) if (!wanted.has(pr)) seen.delete(pr);  // nobody watches it now
    for (const [pr, cwd] of wanted) await ask(pr, cwd);
  } finally { polling = false; }
}
// A PR just opened or pushed is asked about now, rather than at the next poll.
const soon = (pr, cwd) => { if (on()) ask(pr, cwd).catch(() => {}); };
// What the Board shows. Only what is worth seeing: a state, and the commit it is about.
const summary = (pr) => { const p = of(pr); return p ? { state: p.state, head: p.head, open: p.open !== false, at: new Date(p.at).toISOString(), error: p.error || null } : null; };

let begun = false;
function begin() {
  if (begun) return;
  begun = true;
  config.every('pipelinePollSeconds', poll, 1000);
}

module.exports = { stateOf, gate, watch, of, soon, summary, on, begin, poll };
