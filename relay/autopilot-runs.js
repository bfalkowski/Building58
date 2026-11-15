// Autopilot's run records (relay/autopilot.js keeps them in RELAY_AUTOPILOT_FILE). One record for each
// ticket Autopilot starts: when it started, when its Dev got the brief, when its PR opened, each posted
// verdict, when it merged or went to the person, and its outcome. A record holds only ids, times,
// verdicts and reason words from REASONS, never a key, a prompt or a ticket's words. Plain functions with
// no side effects, so the tests load them without a relay. See docs/manual/roles.html#autopilot-runs.
'use strict';

const KEEP_DAYS = 90;
const OUTCOMES = ['success', 'flawed', 'blocked', 'manual'];
const BLOCKED = {
  question: 'a session was at a question',
  silent: 'a session sent no hook and printed nothing',
  'reviewer-not-started': 'a reviewer did not start on its brief',
  stalled: 'nothing moved it',
  'brief-not-delivered': 'its Dev did not get the brief'
};
const MANUAL = {
  'protected-file': 'it changes a file only a person merges',
  'pr-closed': 'the PR was closed without merging',
  rounds: 'review rounds still asked for fixes at the limit',
  'ci-red': 'CI failed on the reviewed commit',
  'merge-failed': 'gh pr merge failed',
  'work-left-out': 'its Dev left work out of the PR',
  'news-untold': 'its Dev never heard the latest review',
  'dev-says-bug': 'its Dev said a non-blocking finding is a bug',
  'merged-by-person': 'a person merged it'
};
const REASONS = Object.assign({}, BLOCKED, MANUAL);
const FIELDS = ['task', 'ticket', 'kind', 'pr', 'startedAt', 'briefedAt', 'prAt', 'verdicts', 'mergedAt', 'mergedBy', 'handed', 'blocked', 'fixAfter'];

const iso = (at) => new Date(at).toISOString();
const id = (x) => (typeof x === 'string' && /^[\w.:/#-]{1,200}$/.test(x) ? x : null);

function start({ task, ticket, kind, at }) {
  return { task: id(task), ticket: id(ticket), kind: id(kind), pr: null, startedAt: iso(at), briefedAt: null, prAt: null, verdicts: [], mergedAt: null, mergedBy: null, handed: null, blocked: null, fixAfter: null };
}
function once(run, field, value) {
  if (run[field] !== null && run[field] !== undefined) return false;
  run[field] = value;
  return true;
}
function fromTask(run, task, byAutopilot) {
  const h = (task && task.history) || [];
  const first = (test) => h.find(test);
  let changed = false;
  const briefed = first((x) => x.type === 'briefed');
  if (briefed) changed = once(run, 'briefedAt', iso(briefed.at)) || changed;
  const pr = first((x) => x.type === 'pr');
  if (pr) { changed = once(run, 'prAt', iso(pr.at)) || changed; changed = once(run, 'pr', id(pr.pr)) || changed; }
  const merged = first((x) => x.type === 'merged');
  if (merged) changed = (byAutopilot === undefined ? once(run, 'mergedAt', iso(merged.at)) : mergedBy(run, merged.at, byAutopilot ? 'Autopilot' : 'person')) || changed;
  const lost = first((x) => x.type === 'note' && /was not delivered/.test(x.note || ''));
  if (lost) changed = block(run, 'brief-not-delivered', lost.at) || changed;
  return changed;
}
function verdict(run, v) {
  if (!v || !['merge', 'fix'].includes(v.kind) || !v.at) return false;
  const commit = String(v.commit || '').slice(0, 12), at = iso(v.at);
  if (run.verdicts.some((x) => x.at === at && x.commit === commit)) return false;
  run.verdicts.push({ kind: v.kind, commit, at });
  return true;
}
function mergedBy(run, at, by) {
  const a = once(run, 'mergedAt', iso(at));
  return once(run, 'mergedBy', by === 'Autopilot' ? 'Autopilot' : 'person') || a;
}
function block(run, reason, at) {
  return BLOCKED[reason] ? once(run, 'blocked', { reason, at: iso(at) }) : false;
}
function hand(run, reason, at) {
  if (BLOCKED[reason]) return block(run, reason, at);
  return MANUAL[reason] ? once(run, 'handed', { reason, at: iso(at) }) : false;
}
function fixAfter(run, ticket, at) {
  if (!run.mergedAt || Date.parse(at) < Date.parse(run.mergedAt)) return false;
  return once(run, 'fixAfter', { ticket: id(ticket), at: iso(at) });
}
function names(text, run) {
  if (run.ticket && new RegExp('\\b' + run.ticket + '\\b').test(text)) return true;
  return !!run.pr && String(text).split(run.pr).slice(1).some((after) => !/^\d/.test(after));
}

function outcomeOf(run) {
  if (run.handed || (run.mergedAt && run.mergedBy === 'person')) return 'manual';
  if (run.blocked) return 'blocked';
  if (run.verdicts.some((v) => v.kind === 'fix') || run.fixAfter) return 'flawed';
  if (run.mergedBy === 'Autopilot') return 'success';
  return null;
}

const minutes = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
const emptyCounts = () => ({ success: 0, flawed: 0, blocked: 0, manual: 0, open: 0 });
function dayOf(runs, day) {
  const mine = runs.filter((r) => String(r.startedAt).slice(0, 10) === day);
  const byOutcome = emptyCounts(), byKind = {};
  for (const r of mine) {
    const o = outcomeOf(r) || 'open', k = r.kind || 'none';
    byOutcome[o]++;
    (byKind[k] || (byKind[k] = emptyCounts()))[o]++;
  }
  const merges = mine.filter((r) => r.mergedAt).map((r) => minutes(r.startedAt, r.mergedAt));
  return { day, runs: mine.length, byOutcome, byKind, medianStartToMergeMinutes: median(merges) };
}

function prune(store, now) {
  const from = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const [k, r] of Object.entries(store)) if (!(Date.parse(r.startedAt) >= from)) { delete store[k]; changed = true; }
  return changed;
}

const viewOf = (run) => Object.assign({}, run, { outcome: outcomeOf(run) });

module.exports = { start, fromTask, verdict, merged: mergedBy, names, hand, block, fixAfter, outcomeOf, dayOf, prune, viewOf, minutes, KEEP_DAYS, OUTCOMES, REASONS, BLOCKED, MANUAL, FIELDS };
