// The Metrics page's numbers (relay/metrics-plan.js), from made-up run records, COO data, tasks and samples.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const plan = require('../metrics-plan.js');
const runs = require('../autopilot-runs.js');

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const HOUR = 3600000, DAY = 24 * HOUR;
const ago = (hours) => NOW - hours * HOUR;
const iso = (at) => new Date(at).toISOString();
const PR = (n) => 'https://github.com/o/r/pull/' + n;
const moved = (at, to, by, note) => ({ at: iso(at), type: 'moved', to, by: by || 'Autopilot', note });

function run(id, ticket, startedAgo, extra) {
  const r = runs.start({ task: id, ticket, kind: 'bug', at: ago(startedAgo) });
  return Object.assign(r, extra || {});
}
function task(id, ticket, startedAgo, history, extra) {
  return Object.assign({ id, ticket, title: 'SECRET TITLE of ' + id, brief: 'SECRET BRIEF', state: 'done', pr: PR(Number(id.slice(-1))), createdAt: iso(ago(startedAgo)), history }, extra || {});
}

const A = {
  run: run('a1', 'T-1', 6, { prAt: iso(ago(5)), mergedAt: iso(ago(1)), mergedBy: 'Autopilot', verdicts: [{ kind: 'merge', commit: 'abc', at: iso(ago(2)) }] }),
  task: task('a1', 'T-1', 6, [
    { at: iso(ago(6)), type: 'created' }, { at: iso(ago(5)), type: 'pr', pr: PR(1) }, moved(ago(5), 'in_review'),
    moved(ago(3), 'changes_requested'), moved(ago(2.5), 'in_review'), { at: iso(ago(1)), type: 'merged', pr: PR(1) }, moved(ago(1), 'done')
  ])
};
const B = {
  run: run('b2', 'T-2', 30, { prAt: iso(ago(29)), handed: { reason: 'protected-file', at: iso(ago(28)) }, mergedAt: iso(ago(20)), mergedBy: 'person' }),
  task: task('b2', 'T-2', 30, [
    { at: iso(ago(30)), type: 'created' }, { at: iso(ago(29)), type: 'pr', pr: PR(2) }, moved(ago(29), 'in_review'),
    moved(ago(28), 'waiting_on_you'), { at: iso(ago(20)), type: 'merged', pr: PR(2) }, moved(ago(20), 'done', 'you')
  ])
};
const C = { run: run('c3', 'T-3', 3, { blocked: { reason: 'reviewer-not-started', at: iso(ago(2)) } }), task: task('c3', 'T-3', 3, [{ at: iso(ago(3)), type: 'created' }], { state: 'building', pr: null }) };
const D = { run: run('d4', 'T-4', 200, { mergedAt: iso(ago(190)), mergedBy: 'Autopilot' }), task: null };
const REVIEWS = [{ pr: PR(1), round: 1, at: ago(4.5) }, { pr: PR(1), round: 2, at: ago(2.2) }];
const SAMPLE = (minutesAgo, w, i, wt, s, f, red) => [NOW - minutesAgo * 60000, w, i, wt, s, f, red || 0];
const INPUT = {
  now: NOW, range: '7d',
  runs: [A.run, B.run, C.run, D.run], tasks: [A.task, B.task, C.task],
  hands: [{ who: 'Dev', at: iso(ago(10)), endedAt: iso(ago(9.5)), how: 'answered' }],
  events: [{ kind: 'stall', who: 'Dev', at: iso(ago(8)), endedAt: iso(ago(6)), ended: 'went on' }, { kind: 'quiet', who: 'Dev', at: iso(ago(7)), endedAt: iso(ago(6.9)) }],
  reviews: REVIEWS,
  desks: [SAMPLE(180, 4, 2, 1, 0, 2), SAMPLE(175, 5, 2, 1, 1, 0, 1), SAMPLE(170, 5, 2, 1, 1, 0, 1), SAMPLE(165, 3, 3, 0, 0, 3)],
  room: [[ago(3), 50, 1048576 * 100, 1048576 * 1000], [ago(2.9), 70, 1048576 * 300, 1048576 * 1000]],
  pm: []
};

test('merged per day: Autopilot and the person apart, and a merge older than the range stays out', () => {
  const d = plan.build(INPUT);
  assert.strictEqual(d.merged.days.length, 8, 'the 7 days back from now touch 8 calendar days');
  const today = d.merged.days[7], yesterday = d.merged.days[6];
  assert.deepStrictEqual([today.autopilot, today.person], [1, 0]);
  assert.deepStrictEqual([yesterday.autopilot, yesterday.person], [0, 1]);
  assert.strictEqual(d.numbers.merged, 2, 'the run that merged 190 hours ago is outside 7 days');
  const wide = plan.build({ ...INPUT, range: '30d' });
  assert.strictEqual(wide.numbers.merged, 3);
  assert.strictEqual(wide.merged.days.length, 31);
  const day = plan.build({ ...INPUT, range: '1d' });
  assert.strictEqual(day.numbers.merged, 2, 'the person\'s merge 20 hours ago is inside 1 day');
  assert.strictEqual(day.merged.days.length, 2);
});

test('time per ticket splits building, waiting for a review, in review, fixing and waiting on you', () => {
  const d = plan.build(INPUT);
  const one = d.perTicket.tickets.find((t) => t.ticket === 'T-1'), two = d.perTicket.tickets.find((t) => t.ticket === 'T-2');
  assert.strictEqual(one.minutes, 300);
  assert.deepStrictEqual(one.parts, { building: 60, waiting_review: 48, in_review: 162, fixing: 30, waiting_you: 0 });
  assert.strictEqual(one.parts.fixing, 30, 'changes requested 3 hours ago until 2.5');
  assert.strictEqual(Object.values(one.parts).reduce((a, b) => a + b, 0), 300);
  assert.strictEqual(two.parts.waiting_you, 480);
  assert.strictEqual(d.perTicket.medianMinutes, 450);
  assert.strictEqual(d.where.minutes.waiting_you, 480);
  assert.strictEqual(d.where.minutes.building, 60 + 60);
});

test('a run with no task keeps its building and review time from the record', () => {
  const d = plan.build({ ...INPUT, range: '30d' });
  const four = d.perTicket.tickets.find((t) => t.ticket === 'T-4');
  assert.strictEqual(four.minutes, 600);
  assert.strictEqual(four.parts.building, 600);
});

test('outcomes count each result, with the top reasons', () => {
  const d = plan.build({ ...INPUT, range: '30d' });
  assert.deepStrictEqual(d.outcomes.counts, { success: 2, flawed: 0, blocked: 1, manual: 1, open: 0 });
  assert.deepStrictEqual(d.outcomes.reasons.blocked, [{ reason: 'reviewer-not-started', label: runs.REASONS['reviewer-not-started'], count: 1 }]);
  assert.deepStrictEqual(d.outcomes.reasons.manual.map((r) => r.reason), ['protected-file']);
});

test('stalls by kind, with the hours each cost', () => {
  const d = plan.build(INPUT), by = Object.fromEntries(d.stalls.kinds.map((k) => [k.kind, k]));
  assert.deepStrictEqual([by.silent.detected.count, by.silent.detected.hours], [1, 2], 'a quiet spell is not a stall');
  assert.deepStrictEqual([by['no-first-review'].detected.count, by['no-first-review'].detected.hours], [2, 2.5], 'a reviewer that did not start for 2 hours, and a first review that waited 30 minutes');
  assert.strictEqual(by['desks-full'].detected.count, 1);
  assert.strictEqual(by['desks-full'].detected.hours, round(10 / 60), 'two samples in a row with no free desk are one spell of 10 minutes');
  assert.strictEqual(by['main-red'].detected.count, 1);
  assert.strictEqual(by['main-red'].detected.hours, round(10 / 60));
  assert.strictEqual(d.numbers.stalledHours, round(d.stalls.kinds.reduce((a, k) => a + k.detected.hours, 0)));
  const cost = d.stalls.kinds.map((k) => k.detected.hours + k.hand.hours);
  assert.deepStrictEqual(cost, [...cost].sort((a, b) => b - a), 'the biggest cost first');
});
const round = (n) => Math.round(n * 10) / 10;

test('Stalls by kind counts the jams fixed by hand next to the detected ones, per kind, with hours from since to when it was logged', () => {
  const jams = [
    { at: iso(ago(1)), kind: 'no-first-review', since: iso(ago(3)), fix: 'x', by: 'you' },
    { at: iso(ago(2)), kind: 'no-first-review', since: null, fix: 'x', by: 'you' },
    { at: iso(ago(4)), kind: 'tunnel-down', since: iso(ago(5)), fix: 'x', by: 'you' },
    { at: iso(ago(200)), kind: 'tunnel-down', since: iso(ago(201)), fix: 'x', by: 'you' },
    { at: iso(ago(1)), kind: 'not-a-kind', since: null, fix: 'x', by: 'you' }
  ];
  const by = (range) => Object.fromEntries(plan.build({ ...INPUT, jams, range }).stalls.kinds.map((k) => [k.kind, k]));
  const week = by('7d');
  assert.deepStrictEqual(week['no-first-review'].hand, { count: 2, hours: 2 });
  assert.deepStrictEqual(week['no-first-review'].detected, { count: 2, hours: 2.5 });
  assert.deepStrictEqual(week['tunnel-down'].hand, { count: 1, hours: 1 }, 'the jam from 200 hours ago is outside 7 days');
  assert.strictEqual(week['not-a-kind'], undefined);
  assert.strictEqual(plan.build({ ...INPUT, jams }).numbers.jamsFixedByHand, 3, 'the number counts the kinds the log knows, the old one excluded');
  assert.deepStrictEqual(by('30d')['tunnel-down'].hand, { count: 2, hours: 2 });
  assert.deepStrictEqual(by('1d')['no-first-review'].hand, { count: 2, hours: 2 });
});

test('waits on you: how many each day, how long, and why', () => {
  const d = plan.build(INPUT);
  const reasons = Object.fromEntries(d.waits.items.map((w) => [w.reason, w.minutes]));
  assert.deepStrictEqual(reasons, { question: 30, protected: 480 });
  assert.strictEqual(d.numbers.waitingOnYouHours, 8.5);
  assert.strictEqual(d.waits.days.reduce((a, x) => a + x.count, 0), 2);
  assert.strictEqual(d.waits.days.filter((x) => x.protected === 1).length, 1);
});

test('review rounds per PR: 1, 2, and 3 or more', () => {
  const d = plan.build(INPUT);
  assert.deepStrictEqual(d.rounds.prs, [{ rounds: '1', count: 1 }, { rounds: '2', count: 1 }, { rounds: '3 or more', count: 0 }]);
});

test('the share of tickets that merged with no help from the person', () => {
  assert.strictEqual(plan.build(INPUT).numbers.noHelpShare, 50);
  assert.strictEqual(plan.build({ ...INPUT, runs: [], tasks: [] }).numbers.noHelpShare, null);
});

test('desks and room load come in buckets of 5 minutes for a day, an hour for 7 days and 6 hours for 30', () => {
  const day = plan.build({ ...INPUT, range: '1d' }), week = plan.build(INPUT), month = plan.build({ ...INPUT, range: '30d' });
  assert.strictEqual(day.desks.points.length, 4);
  assert.deepStrictEqual(day.desks.points[0], { at: iso(ago(3)), working: 4, idle: 2, waiting: 1, stuck: 0, free: 2 });
  assert.strictEqual(week.desks.points.length, 1, 'the four samples are in one hour');
  assert.strictEqual(week.desks.points[0].working, 4.3);
  assert.ok(month.desks.points.length >= 1);
  assert.deepStrictEqual([day.bucketMinutes, week.bucketMinutes, month.bucketMinutes], [5, 60, 360]);
  assert.deepStrictEqual(week.load.points.map((p) => [p.cpu, p.memoryMb, p.limitMb]), [[60, 200, 1000]]);
});

test('PM verdicts show once they exist', () => {
  assert.strictEqual(plan.build(INPUT).pm.available, false);
  const d = plan.build({ ...INPUT, pm: [{ at: ago(1), checked: 3, held: 1, closed: 1, merged: 0, moved: 1, hoursSaved: 5 }] });
  assert.strictEqual(d.pm.available, true);
  assert.deepStrictEqual(d.pm.days[7], { day: iso(NOW).slice(0, 10), checked: 3, held: 1, closed: 1, merged: 0, moved: 1, hoursSaved: 5 });
});

test('an empty room answers zeros and no data, not an error', () => {
  const d = plan.build({ now: NOW, range: '7d' });
  assert.strictEqual(d.numbers.merged, 0);
  assert.strictEqual(d.numbers.medianMinutes, null);
  assert.deepStrictEqual(d.desks.points, []);
  assert.deepStrictEqual(d.stalls.kinds, []);
});

test('samples are taken every 5 minutes, and nothing older than 90 days is kept', () => {
  const store = plan.blank(), at = Date.parse('2026-01-01T00:00:00.000Z');
  const row = [1, 0, 0, 0, 8, 0], room = { cpu: 10, memory: 1, limit: 2 };
  assert.strictEqual(plan.take(store, at, { c: row }, room), true);
  assert.strictEqual(plan.take(store, at + 4 * 60000, { c: row }, room), false, 'four minutes later is too soon');
  assert.strictEqual(plan.take(store, at + 5 * 60000, { c: row }, room), true);
  assert.strictEqual(store.desks.c.length, 2);
  assert.strictEqual(store.room.length, 2);
  plan.noteReview(store, PR(1), 1, at);
  plan.noteReview(store, PR(1), 1, at + 1000);
  assert.strictEqual(store.reviews.length, 1, 'a review is noted once');
  const later = at + 91 * DAY;
  assert.strictEqual(plan.take(store, later, { c: row }, room), true);
  assert.deepStrictEqual(store.desks.c.map((r) => r[0]), [later], 'the samples from 91 days ago are gone');
  assert.deepStrictEqual(store.room.map((r) => r[0]), [later]);
  assert.deepStrictEqual(store.reviews, []);
  const edge = plan.blank();
  plan.take(edge, at, { c: row }, null);
  plan.take(edge, at + 90 * DAY, { c: row }, null);
  assert.strictEqual(edge.desks.c.length, 2, 'a sample exactly 90 days old stays');
  assert.strictEqual(edge.room.length, 0, 'no room sample when the files cannot be read');
});

test('no title, body, prompt or key is in the answer or the CSV', () => {
  const secret = { ...INPUT, tasks: INPUT.tasks.map((t) => ({ ...t, title: 'SECRET TITLE', brief: 'SECRET BRIEF', body: 'SECRET BODY', prompt: 'SECRET PROMPT', key: 'sk-ant-SECRET' })), hands: [{ who: 'SECRET NAME', at: iso(ago(10)), endedAt: iso(ago(9)), task: 'a1' }], events: [...INPUT.events, { kind: 'stall', who: 'SECRET NAME', detail: 'SECRET DETAIL', at: iso(ago(5)), endedAt: iso(ago(4)) }] };
  for (const range of Object.keys(plan.RANGES)) {
    const d = plan.build({ ...secret, range }), text = JSON.stringify(d) + plan.csv(d);
    assert.ok(!/SECRET|sk-ant/.test(text), range + ' leaks: ' + (text.match(/.{20}(SECRET|sk-ant).{20}/) || [])[0]);
  }
});

test('the CSV has one row for each number, with a header, and quotes what needs it', () => {
  const d = plan.build(INPUT), lines = plan.csv(d).trim().split('\n');
  assert.strictEqual(lines[0], 'chart,when,label,series,value');
  assert.ok(lines.includes('numbers,,,merged,2'));
  assert.ok(lines.some((l) => l.startsWith('time_per_ticket,') && l.includes(',T-1,')));
  assert.ok(lines.includes('review_rounds,,2,prs,1'));
  assert.ok(lines.includes('stalls,,silent,detected_hours,2'));
});

test('a range that is not 1d, 7d or 30d is not one', () => {
  assert.strictEqual(plan.rangeOf('7d'), '7d');
  assert.strictEqual(plan.rangeOf('2d'), null);
  assert.strictEqual(plan.rangeOf('__proto__'), null);
});
