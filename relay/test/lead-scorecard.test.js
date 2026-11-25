// The Metrics page's Lead section (relay/metrics-plan.js): time to act, what the Lead fixed, what it passed to
// the person, what it saw and never acted on, and the shared failure channels, all from the jam log.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const plan = require('../metrics-plan.js');

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const MIN = 60000, HOUR = 60 * MIN;
const iso = (at) => new Date(at).toISOString();
const jam = (extra) => Object.assign({ at: iso(NOW - HOUR), kind: 'no-first-review', ticket: null, pr: null, since: null, fix: 'x', by: 'Lead' }, extra);
const build = (jams, range) => plan.build({ now: NOW, range: range || '7d', jams });

test('time to act is the median and the slowest few, from when the Lead first saw each jam', () => {
  const jams = [
    jam({ pr: 'https://github.com/o/r/pull/1', since: iso(NOW - HOUR - 10 * MIN) }),
    jam({ pr: 'https://github.com/o/r/pull/2', since: iso(NOW - HOUR - 30 * MIN) }),
    jam({ ticket: 'T-3', since: iso(NOW - HOUR - 20 * MIN), kind: 'merged-not-done' }),
    jam({ ticket: 'T-4', since: iso(NOW - HOUR - 120 * MIN), kind: 'dev-idle' }),
    jam({ ticket: 'T-5', kind: 'dev-idle' })
  ];
  const t = build(jams).lead.timeToAct;
  assert.strictEqual(t.count, 4, 'a jam with no since has no time to act');
  assert.strictEqual(t.medianMinutes, 25);
  assert.deepStrictEqual(t.slowest.map((x) => [x.ticket || x.pr, x.minutes]), [['T-4', 120], ['https://github.com/o/r/pull/2', 30], ['T-3', 20]]);
});

test('jams the Lead fixed, passed to the person and never acted on are counted by kind', () => {
  const jams = [
    jam({ kind: 'no-first-review' }), jam({ kind: 'no-first-review' }), jam({ kind: 'merged-not-done' }),
    jam({ kind: 'main-red', outcome: 'passed' }), jam({ kind: 'dev-idle', outcome: 'passed' }),
    jam({ kind: 'dev-idle', outcome: 'seen' })
  ];
  const l = build(jams).lead;
  assert.deepStrictEqual([l.fixed.total, l.passed.total, l.neverActed.total], [3, 2, 1]);
  assert.deepStrictEqual(l.fixed.kinds.map((k) => [k.kind, k.count]), [['no-first-review', 2], ['merged-not-done', 1]]);
  assert.deepStrictEqual(l.passed.kinds.map((k) => k.kind).sort(), ['dev-idle', 'main-red']);
  assert.deepStrictEqual(l.neverActed.kinds.map((k) => [k.kind, k.count]), [['dev-idle', 1]]);
});

test('jams the Lead fixed do not count as fixed by hand, and the range holds', () => {
  const jams = [jam({}), jam({ by: 'you' }), jam({ by: 'autopilot' }), jam({ at: iso(NOW - 3 * 24 * HOUR) })];
  assert.strictEqual(build(jams).numbers.jamsFixedByHand, 1);
  assert.strictEqual(build(jams, '1d').lead.fixed.total, 1);
  assert.strictEqual(build(jams, '7d').lead.fixed.total, 2);
  assert.strictEqual(build([jam({ by: 'you' })]).lead.available, false);
});

test('each shared failure channel is one jam by the room, with how many PRs it blocked and the time to the fix', () => {
  const jams = [
    jam({ by: 'room', kind: 'main-red', blocked: 5, since: iso(NOW - 5 * HOUR), at: iso(NOW - HOUR) }),
    jam({ by: 'room', kind: 'other', blocked: 2, since: iso(NOW - 3 * HOUR), at: iso(NOW - HOUR) })
  ];
  const d = build(jams);
  assert.deepStrictEqual(d.lead.failures, { channels: 2, prsBlocked: 7, medianHours: 3 });
  assert.strictEqual(d.numbers.jamsFixedByHand, 0);
  const red = d.stalls.kinds.find((k) => k.kind === 'main-red');
  assert.deepStrictEqual([red.detected.count, red.hand.count], [1, 0], 'the room found it, nobody fixed it by hand');
});

test('the scorecard carries ids, kinds and counts, and the csv has its rows', () => {
  const d = build([jam({ ticket: 'T-9', since: iso(NOW - 2 * HOUR), fix: 'SECRET FIX TEXT' })]);
  assert.ok(!JSON.stringify(d.lead).includes('SECRET'));
  assert.match(plan.csv(d), /lead_fixed,,no-first-review,jams,1/);
});
