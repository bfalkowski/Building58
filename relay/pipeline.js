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
const config = require('./config.js');
const gh = require('./gh.js');

const CALM_MS = 10 * 60 * 1000;
const OK = ['SUCCESS', 'SKIPPED', 'NEUTRAL'];
const NOT_DONE = ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'];

function stateOf(rollup) {
  const checks = Array.isArray(rollup) ? rollup : [];
  if (!checks.length) return 'none';
  const result = (c) => String(c.conclusion || c.state || '').toUpperCase();
  if (checks.some((c) => result(c) && !OK.includes(result(c)) && !NOT_DONE.includes(result(c)))) return 'red';
  if (checks.some((c) => (c.status && String(c.status).toUpperCase() !== 'COMPLETED') || !OK.includes(result(c)))) return 'pending';
  return 'green';
}

function gate(p, { heldAt, lastHead, now, grace }) {
  const waited = (since) => now - Math.max(since || 0, heldAt || 0) >= grace;
  if (!p) return { go: false, why: 'Asking GitHub about its checks.' };
  if (p.open === false) return { go: false, gone: true, why: 'It was ' + (p.prState === 'MERGED' ? 'merged' : 'closed') + ' before its review started.' };
  if (p.conflict) return { go: false, conflict: true, why: 'It conflicts with main.' };
  if (p.state === 'unknown') return waited(p.since) ? { go: true, why: 'gh could not read its checks (' + p.error + '), so the review starts without them.' } : { go: false, why: 'gh could not read its checks: ' + p.error };
  if (lastHead && p.head === lastHead && !waited(0)) return { go: false, why: 'Waiting for GitHub to see the push.' };
  if (p.state === 'green') return { go: true };
  if (p.state === 'red') return { go: false, red: true, why: 'A check failed.' };
  if (p.state === 'pending') return { go: false, why: 'Its checks are running.' };
  return waited(p.since) ? { go: true, why: 'It has no checks, so the review starts with no pipeline.' } : { go: false, why: 'No checks have started yet.' };
}

const seen = new Map();
const sources = [];
const watch = (fn) => sources.push(fn);
const on = () => config.get('pipelinePollSeconds') > 0;
const of = (pr) => (pr && seen.get(pr)) || null;
gh.waiting((pr) => { const p = seen.get(pr); return !!p && p.state !== 'pending' && p.state !== 'unknown' && p.open !== false && Date.now() - p.since > CALM_MS; });

async function view(pr, cwd, fresh) {
  try {
    const p = await gh.pr(pr, cwd, { fresh });
    const prState = String(p.state || 'OPEN').toUpperCase();
    return { state: stateOf(p.statusCheckRollup), conflict: p.mergeStateStatus === 'DIRTY' || p.mergeable === 'CONFLICTING', head: String(p.headRefOid || ''), prState, open: prState === 'OPEN' };
  } catch (e) {
    return { state: 'unknown', error: e instanceof SyntaxError ? 'gh sent something unreadable' : e.message.slice(0, 160) };
  }
}
const asking = new Map();
function ask(pr, cwd, fresh) {
  if (asking.has(pr)) return asking.get(pr);
  const done = view(pr, cwd, fresh).then((now) => {
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
  if (polling || gh.paused()) return;
  polling = true;
  try {
    const wanted = new Map();
    for (const fn of sources) { try { for (const w of fn()) if (w && w.pr && !wanted.has(w.pr)) wanted.set(w.pr, w.cwd); } catch (e) { console.error('Pipeline: ' + e.message); } }
    for (const pr of seen.keys()) if (!wanted.has(pr)) seen.delete(pr);
    for (const [pr, cwd] of wanted) await ask(pr, cwd);
  } finally { polling = false; }
}
const soon = (pr, cwd) => { if (on()) ask(pr, cwd, true).catch(() => {}); };
const summary = (pr) => { const p = of(pr); return p ? { state: p.state, head: p.head, open: p.open !== false, at: new Date(p.at).toISOString(), error: p.error || null } : null; };

let begun = false;
function begin() {
  if (begun) return;
  begun = true;
  config.every('pipelinePollSeconds', poll, 1000);
}

module.exports = { stateOf, gate, watch, of, soon, summary, on, begin, poll };
