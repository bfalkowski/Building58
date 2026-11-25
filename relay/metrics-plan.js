// The Metrics page's numbers (office/metrics.html), as plain functions of what the relay already keeps and
// what relay/metrics.js samples, so the tests can run them on made-up data. build() makes the answer of
// GET /metrics, and csv() the same numbers as rows. Only ids, times, counts, states and reason words go in:
// a ticket's title or body, a prompt and a key never reach this file's answer, because each field is picked
// here by name. The sources of each chart are in docs/manual/how-it-works.html#metrics.
'use strict';
const runsOf = require('./autopilot-runs.js');

const KEEP_DAYS = 90;
const EVERY_MS = 5 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const RANGES = { '1d': { days: 1, bucket: EVERY_MS }, '7d': { days: 7, bucket: HOUR }, '30d': { days: 30, bucket: 6 * HOUR } };
const WAIT_MINUTES = 10;
const MAX_ITEMS = 300;
const TOP_REASONS = 5;

const PARTS = { building: 'Building', waiting_review: 'Waiting for a review', in_review: 'In review', fixing: 'Fixing', waiting_you: 'Waiting on you' };
const WAIT_REASONS = { merge: 'Merge', rounds: 'Review rounds', protected: 'Protected file', question: 'Question', other: 'Other' };
const JAM_KINDS = {
  'no-first-review': 'No first review', 'desks-full': 'Desks full', 'news-untold': 'Review news untold', 'handed-over': 'Handed over',
  'waits-on-state': 'Waits on state', 'person-merge': 'Waits on a person merge', 'merged-not-done': 'Merged, not done', 'no-new-commit': 'No new commit',
  'main-red': 'Main red', 'signing-key': 'Signing key', 'workflows-push': 'Workflows push', 'dev-idle': 'Dev idle', 'tunnel-down': 'Tunnel down', 'push-refused': 'Push refused', other: 'Other'
};
const STALLS = Object.assign({}, JAM_KINDS, { 'dev-stopped': 'Dev stopped with no PR', silent: 'Session silent', 'not-started': 'Not started on its brief', 'brief-lost': 'Brief not delivered' });
const BLOCKED_KIND = { 'reviewer-not-started': 'no-first-review', 'dev-gone': 'dev-stopped', 'brief-not-delivered': 'brief-lost', 'conflict-dropped': 'other' };

const AUTOPILOT = 'autopilot';
const idOf = (x) => (typeof x === 'string' && /^[\w.:/#-]{1,200}$/.test(x) ? x : null);
const ms = (iso) => Date.parse(iso);
const iso = (at) => new Date(at).toISOString();
const dayOf = (at) => iso(at).slice(0, 10);
const round1 = (n) => Math.round(n * 10) / 10;
const hours = (millis) => round1(Math.max(0, millis) / HOUR);
function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : round1((s[m - 1] + s[m]) / 2);
}
const rangeOf = (text) => (Object.hasOwn(RANGES, text) ? text : null);

function blank() { return { desks: {}, room: [], reviews: [], pm: [], at: 0 }; }
function shape(store) {
  const s = store && typeof store === 'object' ? store : {};
  const out = blank();
  out.desks = s.desks && typeof s.desks === 'object' ? s.desks : {};
  for (const k of ['room', 'reviews', 'pm']) if (Array.isArray(s[k])) out[k] = s[k];
  out.at = Number(s.at) || 0;
  return out;
}
function prune(store, now) {
  const from = now - KEEP_DAYS * DAY;
  let changed = false;
  const keep = (list, at) => { const kept = list.filter((x) => at(x) >= from); if (kept.length !== list.length) changed = true; return kept; };
  for (const [channel, list] of Object.entries(store.desks)) {
    const kept = keep(list, (x) => x[0]);
    if (kept.length) store.desks[channel] = kept; else { delete store.desks[channel]; changed = true; }
  }
  store.room = keep(store.room, (x) => x[0]);
  store.reviews = keep(store.reviews, (x) => x.at);
  store.pm = keep(store.pm, (x) => x.at);
  return changed;
}
function take(store, now, desks, room) {
  if (now - store.at < EVERY_MS) return false;
  store.at = now;
  for (const [channel, row] of Object.entries(desks)) (store.desks[channel] || (store.desks[channel] = [])).push([now, ...row]);
  if (room) store.room.push([now, room.cpu, room.memory, room.limit]);
  prune(store, now);
  return true;
}
function noteReview(store, pr, round, at) {
  const id = idOf(pr);
  if (!id || store.reviews.some((x) => x.pr === id && x.round === (round || 0))) return false;
  store.reviews.push({ pr: id, round: round || 0, at });
  return true;
}

function bucketed(rows, from, size, fields) {
  const groups = new Map();
  for (const row of rows) {
    if (row[0] < from) continue;
    const at = Math.floor(row[0] / size) * size, g = groups.get(at) || { n: 0, sum: fields.map(() => 0) };
    g.n++; fields.forEach((_, i) => { g.sum[i] += Number(row[i + 1]) || 0; });
    groups.set(at, g);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([at, g]) => Object.assign({ at: iso(at) }, ...fields.map((f, i) => ({ [f]: round1(g.sum[i] / g.n) }))));
}

function mergedAtOf(task) {
  const m = (task.history || []).find((x) => x.type === 'merged');
  if (m) return m.at;
  const d = (task.history || []).find((x) => x.type === 'moved' && x.to === 'done');
  return task.pr && task.state === 'done' && d ? d.at : null;
}
function startsOf(reviews, pr) {
  return reviews.filter((x) => x.pr === pr).map((x) => x.at).sort((a, b) => a - b);
}
function addTo(parts, name, millis) { parts[name] = (parts[name] || 0) + Math.max(0, millis); }
function partsOf(task, run, reviews, start, end) {
  const parts = {}, starts = task && task.pr ? startsOf(reviews, task.pr) : [];
  if (!task) {
    const pr = run && run.prAt ? ms(run.prAt) : null;
    if (pr && pr > start && pr < end) { addTo(parts, 'building', pr - start); addTo(parts, 'in_review', end - pr); } else addTo(parts, 'building', end - start);
    return parts;
  }
  const close = (state, a, b) => {
    a = Math.max(a, start); b = Math.min(b, end);
    if (b <= a) return;
    if (state === 'building') addTo(parts, 'building', b - a);
    else if (state === 'changes_requested') addTo(parts, 'fixing', b - a);
    else if (state === 'waiting_on_you') addTo(parts, 'waiting_you', b - a);
    else if (state === 'in_review') {
      const s = starts.find((x) => x >= a && x <= b);
      if (s) { addTo(parts, 'waiting_review', s - a); addTo(parts, 'in_review', b - s); } else addTo(parts, 'in_review', b - a);
    }
  };
  let state = 'building', since = start;
  for (const h of (task.history || []).filter((x) => x.type === 'moved').sort((a, b) => (a.at < b.at ? -1 : 1))) {
    if (ms(h.at) < start) { state = h.to; continue; }
    close(state, since, ms(h.at)); state = h.to; since = ms(h.at);
    if (state === 'done') return parts;
  }
  close(state, since, end);
  return parts;
}

function shipped(input, from) {
  const tasks = input.tasks || [], runs = input.runs || [], reviews = input.reviews || [];
  const seen = new Set(), out = [];
  const add = (task, run) => {
    const mergedIso = (run && run.mergedAt) || (task && mergedAtOf(task));
    if (!mergedIso || ms(mergedIso) < from) return;
    const start = ms(run ? run.startedAt : task.createdAt), end = ms(mergedIso);
    const parts = partsOf(task, run, reviews, start, end);
    const changes = task ? (task.history || []).filter((x) => x.type === 'moved' && x.to === 'changes_requested').length : (run.verdicts || []).filter((v) => v.kind === 'fix').length;
    out.push({ ticket: idOf((run && run.ticket) || (task && task.ticket)), at: end, by: run ? (run.mergedBy === 'Autopilot' ? 'autopilot' : 'person') : 'person', run, parts, minutes: round1((end - start) / 60000), rounds: changes + 1, hasPr: !!(task ? task.pr : run.pr) });
  };
  for (const r of runs) { const t = tasks.find((x) => x.id === r.task) || null; seen.add(r.task); add(t, r); }
  for (const t of tasks) if (!seen.has(t.id)) add(t, null);
  return out.sort((a, b) => a.at - b.at);
}

function waitsOf(input, from, now) {
  const out = [], byTask = new Map((input.runs || []).filter((r) => r.task).map((r) => [r.task, r]));
  for (const h of input.hands || []) {
    const at = ms(h.at);
    if (at >= from) out.push({ at, millis: (h.endedAt ? ms(h.endedAt) : now) - at, reason: 'question' });
  }
  for (const task of input.tasks || []) {
    const hist = task.history || [], run = byTask.get(task.id);
    hist.forEach((x, i) => {
      if (x.type !== 'moved' || x.to !== 'waiting_on_you' || ms(x.at) < from) return;
      const next = hist.slice(i + 1).find((y) => y.type === 'moved' || y.type === 'merged');
      if (x.by === 'Autopilot' && next && next.type === 'moved' && next.by === 'Autopilot' && /, so the task is back\.$/.test(next.note || '')) return;
      const why = run && run.handed ? run.handed.reason : null;
      const reason = why === 'protected-file' ? 'protected' : why === 'rounds' ? 'rounds' : run && run.blocked && run.blocked.reason === 'question' ? 'question' : task.pr ? 'merge' : 'other';
      out.push({ at: ms(x.at), millis: (next ? ms(next.at) : now) - ms(x.at), reason });
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

function spells(rows, from, test) {
  const out = [];
  let open = null;
  for (const row of rows.filter((x) => x[0] >= from)) {
    if (test(row)) { if (open) open.n++; else { open = { at: row[0], n: 1 }; out.push(open); } } else open = null;
  }
  return out.map((s) => ({ at: s.at, millis: s.n * EVERY_MS }));
}
function stallsOf(input, from, now) {
  const out = [], runs = input.runs || [], reviews = input.reviews || [];
  const add = (kind, at, millis) => { if (at >= from) out.push({ kind, at, millis: Math.max(0, millis) }); };
  for (const e of input.events || []) {
    const at = ms(e.at), end = e.endedAt ? ms(e.endedAt) : now;
    if (e.kind === 'stall') add('silent', at, end - at);
    else if (e.kind === 'not_started') add('not-started', at, end - at);
    else if (e.kind === 'crash') add('other', at, 0);
  }
  for (const run of runs) {
    const end = ms(run.mergedAt || (run.handed && run.handed.at) || iso(now));
    if (run.blocked && BLOCKED_KIND[run.blocked.reason]) add(BLOCKED_KIND[run.blocked.reason], ms(run.blocked.at), end - ms(run.blocked.at));
    else if (run.blocked && ['stalled'].includes(run.blocked.reason)) add('other', ms(run.blocked.at), end - ms(run.blocked.at));
    if (run.handed && run.handed.reason === 'news-untold') {
      const last = (run.verdicts || []).map((v) => ms(v.at)).sort((a, b) => b - a)[0] || ms(run.handed.at);
      add('news-untold', ms(run.handed.at), ms(run.handed.at) - last);
    }
  }
  const lost = new Set(runs.filter((r) => r.blocked && r.blocked.reason === 'reviewer-not-started').map((r) => r.task));
  for (const task of input.tasks || []) {
    if (lost.has(task.id) || !task.pr) continue;
    const entry = (task.history || []).find((x) => x.type === 'moved' && x.to === 'in_review');
    if (!entry) continue;
    const first = startsOf(reviews, task.pr).find((x) => x >= ms(entry.at));
    if (first && first - ms(entry.at) > WAIT_MINUTES * 60000) add('no-first-review', ms(entry.at), first - ms(entry.at));
  }
  for (const s of spells(input.desks || [], from, (r) => r[5] === 0)) add('desks-full', s.at, s.millis);
  for (const s of spells(input.desks || [], from, (r) => r[6] > 0)) add('main-red', s.at, s.millis);
  const kinds = {};
  const row = (kind) => kinds[kind] || (kinds[kind] = { kind, label: STALLS[kind], detected: { count: 0, millis: 0 }, hand: { count: 0, millis: 0 } });
  for (const s of out) { const r = row(s.kind).detected; r.count++; r.millis += s.millis; }
  for (const j of input.jams || []) {
    const at = ms(j.at);
    if (at < from || !Object.hasOwn(JAM_KINDS, j.kind) || j.by === AUTOPILOT) continue;
    const r = row(j.kind).hand;
    r.count++; r.millis += j.since ? Math.max(0, at - ms(j.since)) : 0;
  }
  const side = (x) => ({ count: x.count, hours: hours(x.millis) });
  return Object.values(kinds).map((k) => ({ kind: k.kind, label: k.label, detected: side(k.detected), hand: side(k.hand), count: k.detected.count, hours: hours(k.detected.millis) }))
    .sort((a, b) => (b.detected.hours + b.hand.hours) - (a.detected.hours + a.hand.hours) || (b.detected.count + b.hand.count) - (a.detected.count + a.hand.count) || (a.kind < b.kind ? -1 : 1));
}

function outcomesOf(runs, from) {
  const counts = { success: 0, flawed: 0, blocked: 0, manual: 0, open: 0 }, reasons = { flawed: {}, blocked: {}, manual: {} };
  for (const run of runs.filter((r) => ms(r.startedAt) >= from)) {
    const o = runsOf.outcomeOf(run) || 'open';
    counts[o]++;
    const why = o === 'blocked' ? run.blocked.reason : o === 'manual' ? (run.handed ? run.handed.reason : 'merged-by-person') : o === 'flawed' ? ((run.verdicts || []).some((v) => v.kind === 'fix') ? 'review-sent-back' : 'fix-after-merge') : null;
    if (why) reasons[o][why] = (reasons[o][why] || 0) + 1;
  }
  const top = (o) => Object.entries(reasons[o]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TOP_REASONS).map(([reason, count]) => ({ reason, label: runsOf.REASONS[reason] || (reason === 'review-sent-back' ? 'a review asked for a fix' : reason === 'fix-after-merge' ? 'a bug ticket named it after it merged' : reason), count }));
  return { counts, reasons: { flawed: top('flawed'), blocked: top('blocked'), manual: top('manual') } };
}

function perDay(from, now, make) {
  const out = [];
  for (let at = Date.parse(dayOf(from)); at <= now; at += DAY) out.push(make(dayOf(at)));
  return out;
}

function build(input) {
  const now = input.now, key = rangeOf(input.range) || '7d', size = RANGES[key], from = now - size.days * DAY;
  const items = shipped(input, from), desks = input.desks || [];
  const waits = waitsOf(input, from, now), stalls = stallsOf(input, from, now);
  const mergedDays = perDay(from, now, (day) => ({ day, autopilot: items.filter((x) => x.by === 'autopilot' && dayOf(x.at) === day).length, person: items.filter((x) => x.by === 'person' && dayOf(x.at) === day).length }));
  const tickets = items.map((x) => ({ ticket: x.ticket, mergedAt: iso(x.at), minutes: x.minutes, parts: Object.fromEntries(Object.keys(PARTS).map((p) => [p, round1((x.parts[p] || 0) / 60000)])) }));
  const totals = Object.fromEntries(Object.keys(PARTS).map((p) => [p, round1(tickets.reduce((a, t) => a + t.parts[p], 0))]));
  const withRun = items.filter((x) => x.run);
  const waitDays = perDay(from, now, (day) => {
    const mine = waits.filter((w) => dayOf(w.at) === day), row = { day, count: mine.length, minutes: round1(mine.reduce((a, w) => a + w.millis, 0) / 60000) };
    for (const r of Object.keys(WAIT_REASONS)) row[r] = mine.filter((w) => w.reason === r).length;
    return row;
  });
  const rounds = { 1: 0, 2: 0, 3: 0 };
  for (const x of items.filter((y) => y.hasPr)) rounds[Math.min(3, x.rounds)]++;
  const pmDays = perDay(from, now, (day) => {
    const mine = (input.pm || []).filter((x) => dayOf(x.at) === day), sum = (k) => mine.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    return { day, checked: sum('checked'), held: sum('held'), closed: sum('closed'), merged: sum('merged'), moved: sum('moved'), hoursSaved: round1(sum('hoursSaved')) };
  });
  return {
    ok: true, at: iso(now), range: key, days: size.days, since: iso(from), keptDays: KEEP_DAYS, bucketMinutes: size.bucket / 60000,
    numbers: {
      merged: items.length, medianMinutes: median(items.map((x) => x.minutes)), waitingOnYouHours: hours(waits.reduce((a, w) => a + w.millis, 0)),
      stalledHours: round1(stalls.reduce((a, s) => a + s.hours, 0)),
      jamsFixedByHand: (input.jams || []).filter((j) => ms(j.at) >= from && Object.hasOwn(JAM_KINDS, j.kind) && j.by !== AUTOPILOT).length,
      noHelpShare: withRun.length ? round1((withRun.filter((x) => runsOf.outcomeOf(x.run) === 'success').length / withRun.length) * 100) : null
    },
    merged: { days: mergedDays },
    perTicket: { parts: PARTS, medianMinutes: median(items.map((x) => x.minutes)), tickets: tickets.slice(-MAX_ITEMS) },
    where: { parts: PARTS, minutes: totals },
    outcomes: outcomesOf(input.runs || [], from),
    stalls: { kinds: stalls },
    waits: { reasons: WAIT_REASONS, days: waitDays, items: waits.slice(-MAX_ITEMS).map((w) => ({ at: iso(w.at), minutes: round1(Math.max(0, w.millis) / 60000), reason: w.reason })) },
    rounds: { prs: [{ rounds: '1', count: rounds[1] }, { rounds: '2', count: rounds[2] }, { rounds: '3 or more', count: rounds[3] }] },
    desks: { points: bucketed(desks, from, size.bucket, ['working', 'idle', 'waiting', 'stuck', 'free']) },
    load: { points: bucketed((input.room || []).map((r) => [r[0], r[1], r[2] / 1048576, r[3] / 1048576]), from, size.bucket, ['cpu', 'memoryMb', 'limitMb']) },
    pm: { available: pmDays.some((d) => d.checked || d.held || d.closed || d.merged || d.moved), days: pmDays }
  };
}

const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function csv(data) {
  const rows = [['chart', 'when', 'label', 'series', 'value']];
  const add = (chart, when, label, series, value) => rows.push([chart, when, label, series, value]);
  for (const [k, v] of Object.entries(data.numbers)) add('numbers', '', '', k, v);
  for (const d of data.merged.days) { add('merged', d.day, '', 'autopilot', d.autopilot); add('merged', d.day, '', 'person', d.person); }
  for (const t of data.perTicket.tickets) for (const p of Object.keys(data.perTicket.parts)) add('time_per_ticket', t.mergedAt, t.ticket, p, t.parts[p]);
  for (const p of Object.keys(data.where.parts)) add('where_the_time_went', '', '', p, data.where.minutes[p]);
  for (const [o, n] of Object.entries(data.outcomes.counts)) add('outcomes', '', '', o, n);
  for (const [o, list] of Object.entries(data.outcomes.reasons)) for (const r of list) add('outcome_reasons', '', r.reason, o, r.count);
  for (const s of data.stalls.kinds) for (const side of ['detected', 'hand']) { add('stalls', '', s.kind, side + '_count', s[side].count); add('stalls', '', s.kind, side + '_hours', s[side].hours); }
  for (const d of data.waits.days) for (const r of Object.keys(data.waits.reasons)) add('waits_on_you', d.day, '', r, d[r]);
  for (const w of data.waits.items) add('wait_minutes', w.at, w.reason, 'minutes', w.minutes);
  for (const r of data.rounds.prs) add('review_rounds', '', r.rounds, 'prs', r.count);
  for (const p of data.desks.points) for (const s of ['working', 'idle', 'waiting', 'stuck', 'free']) add('desks', p.at, '', s, p[s]);
  for (const p of data.load.points) { add('room_load', p.at, '', 'cpu_percent_of_one_core', p.cpu); add('room_load', p.at, '', 'memory_mb', p.memoryMb); }
  for (const d of data.pm.days) for (const s of ['checked', 'held', 'closed', 'merged', 'moved', 'hoursSaved']) add('pm', d.day, '', s, d[s]);
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

module.exports = { JAM_KINDS, build, csv, take, prune, noteReview, shape, blank, rangeOf, KEEP_DAYS, EVERY_MS, RANGES, PARTS, STALLS, WAIT_REASONS, WAIT_MINUTES };
