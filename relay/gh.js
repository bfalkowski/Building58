// The one door to GitHub for the relay (T-264). GitHub gives an account 5000 core API calls an hour, shared by
// every room on it, and the relay's timers used it up. Everything that runs gh goes through here, so that:
//   - each call is counted by kind and by PR, and a line saying so is logged every few minutes;
//   - one PR lookup is shared: the checks that want a PR's state ask pr(), which asks gh once for every field
//     any of them wants, and keeps the answer for a few seconds, or for minutes while the PR waits on the person;
//   - the relay backs off as the hour's calls run out: it reads gh api rate_limit (which costs no call) every
//     minute, for core and GraphQL (gh pr view spends GraphQL), whichever is lower, polls less often below half, a quarter and a tenth left, and stops polling below 100 until the reset.
// A call a person or a session asked for (a merge, a comment, a label) always goes through. See
// docs/manual/how-it-works.html#github-polling.
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');

const GH = process.env.GH_CMD || 'gh';
const FIELDS = 'state,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,mergedAt';
const FRESH_MS = process.env.RELAY_GH_FRESH_MS ? Math.max(0, Number(process.env.RELAY_GH_FRESH_MS) || 0) : 8000;
const QUIET_MS = FRESH_MS ? 5 * 60 * 1000 : 0;
const FILES_MS = QUIET_MS;
const LIMIT_EVERY_MS = 60 * 1000;
const REPORT_EVERY_MS = 5 * 60 * 1000;
const KEEP_MS = 10 * 60 * 1000;

const calls = [];
let made = 0;
const prOf = (args) => (args.join(' ').match(/(?:\/pull\/|\bpulls?\/|\bpr \w+ )(\d+)/) || [])[1] || null;
const kindOf = (args) => (args[0] === 'api' ? 'api ' + String(args.find((a, i) => i > 0 && !a.startsWith('-')) || '').replace(/^repos\/[^/]+\/[^/]+\//, '').replace(/\d+/g, 'N').split('?')[0] : args.slice(0, 2).join(' '));
function count(args) {
  const at = Date.now();
  made++;
  calls.push({ at, kind: kindOf(args), pr: prOf(args) });
  while (calls.length && calls[0].at < at - KEEP_MS) calls.shift();
}
function usage(minutes) {
  const since = Date.now() - (minutes || 5) * 60 * 1000, kinds = {}, prs = {};
  let total = 0;
  for (const c of calls) {
    if (c.at < since) continue;
    total++;
    kinds[c.kind] = (kinds[c.kind] || 0) + 1;
    if (c.pr) prs['#' + c.pr] = (prs['#' + c.pr] || 0) + 1;
  }
  return { total, kinds, prs };
}
const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => k + ' ' + n).join(', ');

function exec(args, { cwd, timeout = 30000, maxBuffer = 16 * 1024 * 1024, input, quiet } = {}) {
  if (!quiet) count(args);
  return new Promise((resolve) => {
    const child = execFile(GH, args, { cwd: cwd && fs.existsSync(cwd) ? cwd : undefined, timeout, maxBuffer, env: Object.assign({}, process.env, { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }) }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input || ''); }
  });
}
const said = (r) => (r.err.code === 'ENOENT' ? 'gh is not installed' : r.err.killed ? 'gh did not answer in time' : String(r.stderr || r.err.message).trim().split('\n')[0].slice(0, 200) || 'gh failed');
const WRITES = ['merge', 'close', 'reopen', 'comment', 'edit', 'ready', 'review'];
async function run(args, opts) {
  const r = await exec(args, opts);
  if (args[0] === 'pr' && WRITES.includes(args[1]) && args[2]) views.delete(args[2]);
  if (r.err) throw new Error(said(r));
  return r.stdout;
}

const budget = { remaining: null, limit: null, reset: null };
async function readLimit() {
  const r = await exec(['api', 'rate_limit'], { timeout: 10000, quiet: true });
  if (r.err) return;
  try {
    const res = JSON.parse(r.stdout).resources;
    const tight = ['core', 'graphql'].map((k) => res[k]).filter((x) => x && Number.isFinite(x.remaining) && x.limit > 0).sort((a, b) => a.remaining / a.limit - b.remaining / b.limit)[0];
    if (tight) Object.assign(budget, { remaining: tight.remaining, limit: tight.limit, reset: tight.reset * 1000 });
  } catch (e) { return; }
}
function spacing() {
  if (budget.remaining === null) return 1;
  if (budget.reset && Date.now() > budget.reset) return 1;
  const share = budget.remaining / budget.limit;
  return share >= 0.5 ? 1 : share >= 0.25 ? 2 : share >= 0.1 ? 4 : 8;
}
function paused() {
  return budget.remaining !== null && budget.remaining < 100 && !!budget.reset && Date.now() < budget.reset;
}
const budgetNote = () => (budget.remaining === null ? '' : ' ' + budget.remaining + ' of ' + budget.limit + ' calls left' + (spacing() > 1 ? ', polling ' + spacing() + ' times slower' : '') + (paused() ? ', paused until ' + new Date(budget.reset).toISOString().slice(11, 16) + 'Z' : '') + '.');

const waiters = [];
const waiting = (fn) => waiters.push(fn);
const onPerson = (pr) => waiters.some((fn) => { try { return !!fn(pr); } catch (e) { return false; } });
const freshMs = (pr) => Math.round((onPerson(pr) ? QUIET_MS : FRESH_MS) * spacing());

const views = new Map(), flights = new Map(), listings = new Map();
function pr(link, cwd, opts) {
  const o = opts || {};
  const now = Date.now(), have = views.get(link);
  const age = have ? now - have.at : Infinity;
  if (have && !o.fresh && (age < freshMs(link) || (have.until && now < have.until) || paused())) return Promise.resolve(have.value);
  if (paused()) return Promise.reject(new Error('GitHub\'s hourly limit is nearly used up, so the relay waits until ' + new Date(budget.reset).toISOString().slice(11, 16) + 'Z'));
  if (flights.has(link) && !o.fresh) return flights.get(link);
  const p = run(['pr', 'view', link, '--json', FIELDS], { cwd, timeout: 30000 }).then((out) => {
    const value = JSON.parse(out);
    views.set(link, { at: Date.now(), value });
    return value;
  }).finally(() => { if (flights.get(link) === p) flights.delete(link); });
  flights.set(link, p);
  return p;
}
const SLOWER = 4;
const due = (lastAt, everyMs, link) => Date.now() - (lastAt || 0) >= everyMs * (spacing() * (onPerson(link) ? SLOWER : 1) - 0.5);
function forget(link) { views.delete(link); }
function seed(link, value, ttlMs) { views.set(link, { at: Date.now(), value, until: Date.now() + ttlMs }); }

async function files(link, head, cwd) {
  const m = link.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
  const have = listings.get(link);
  if (have && head && have.head === head && Date.now() - have.at < FILES_MS) return have.files;
  const out = await run(['api', '--paginate', '--slurp', 'repos/' + m[1] + '/pulls/' + m[2] + '/files?per_page=100'], { cwd });
  const list = JSON.parse(out).flat().flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean);
  if (head) listings.set(link, { head, files: list, at: Date.now() });
  return list;
}

function report() {
  const u = usage(5);
  if (u.total) console.log(new Date().toISOString().slice(11, 19), 'GitHub calls in the last 5 minutes: ' + u.total + ' (' + top(u.kinds) + '; by PR ' + (top(u.prs) || 'none') + ').' + budgetNote());
}
if (process.env.RELAY_GH_BUDGET !== 'off') {
  setInterval(() => { readLimit().catch(() => {}); }, LIMIT_EVERY_MS).unref();
  setInterval(report, REPORT_EVERY_MS).unref();
}

module.exports = { made: () => made, seed, due, count, exec, run, said, pr, forget, files, usage, spacing, paused, waiting, onPerson, readLimit, budget, FIELDS };
