// Autopilot's run records (relay/autopilot-runs.js): each step adds its time once, the outcome follows
// the four rules article 5 names for rung evidence, and the day's counts. The relay's own use of them is
// in relay/test/autopilot.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const runs = require('../autopilot-runs.js');

const T0 = '2026-11-08T10:00:00.000Z';
const at = (min) => new Date(Date.parse(T0) + min * 60000).toISOString();
const fresh = (extra) => runs.start(Object.assign({ task: 'a1b2c3', ticket: 'T-12', kind: 'feature', at: T0 }, extra));
const PR = 'https://github.com/acme/widgets/pull/7';

test('each step adds its time once, from the task history and from Autopilot', () => {
  const r = fresh();
  const task = { history: [{ type: 'created', at: T0 }, { type: 'briefed', at: at(2) }, { type: 'pr', pr: PR, at: at(20) }] };
  assert.strictEqual(runs.fromTask(r, task, false), true);
  assert.deepStrictEqual([r.briefedAt, r.prAt, r.pr], [at(2), at(20), PR]);
  task.history.push({ type: 'briefed', at: at(30) }, { type: 'pr', pr: PR, at: at(31) });
  assert.strictEqual(runs.fromTask(r, task, false), false, 'a second brief or PR event does not move the first time');
  assert.deepStrictEqual([r.briefedAt, r.prAt], [at(2), at(20)]);
  const v = { kind: 'fix', commit: 'a'.repeat(40), at: at(25), sessionId: 's', posted: PR + '#issuecomment-1' };
  assert.strictEqual(runs.verdict(r, v), true);
  assert.strictEqual(runs.verdict(r, v), false, 'the same verdict is kept once');
  assert.deepStrictEqual(r.verdicts, [{ kind: 'fix', commit: 'a'.repeat(12), at: at(25) }]);
  assert.strictEqual(runs.merged(r, at(40), 'Autopilot'), true);
  assert.strictEqual(runs.merged(r, at(50), 'Autopilot'), false);
  assert.deepStrictEqual([r.mergedAt, r.mergedBy], [at(40), 'Autopilot']);
});

test('success: Autopilot merged it, and no review said fix', () => {
  const r = fresh();
  runs.verdict(r, { kind: 'merge', commit: 'b'.repeat(40), at: at(30) });
  assert.strictEqual(runs.outcomeOf(r), null, 'still open before the merge');
  runs.merged(r, at(41), 'Autopilot');
  assert.strictEqual(runs.outcomeOf(r), 'success');
});

test('flawed: a review round said fix, or a fix was needed after the merge', () => {
  const r = fresh();
  runs.verdict(r, { kind: 'fix', commit: 'a'.repeat(40), at: at(20) });
  runs.verdict(r, { kind: 'merge', commit: 'b'.repeat(40), at: at(30) });
  runs.merged(r, at(41), 'Autopilot');
  assert.strictEqual(runs.outcomeOf(r), 'flawed');
  const later = fresh();
  runs.merged(later, at(41), 'Autopilot');
  assert.strictEqual(runs.fixAfter(later, 'T-99', at(10)), false, 'a ticket filed before the merge is not a fix after it');
  assert.strictEqual(runs.outcomeOf(later), 'success');
  assert.strictEqual(runs.fixAfter(later, 'T-99', at(90)), true);
  assert.deepStrictEqual(later.fixAfter, { ticket: 'T-99', at: at(90) });
  assert.strictEqual(runs.outcomeOf(later), 'flawed');
});

test('blocked: stuck on a missing brief, a session at a question, or nothing moving it', () => {
  const r = fresh();
  runs.fromTask(r, { history: [{ type: 'note', note: 'The brief was not delivered: the session ended first.', at: at(5) }] }, false);
  assert.deepStrictEqual(r.blocked, { reason: 'brief-not-delivered', at: at(5) });
  runs.merged(r, at(60), 'Autopilot');
  assert.strictEqual(runs.outcomeOf(r), 'blocked', 'it merged in the end, but it was stuck on the way');
  const q = fresh();
  assert.strictEqual(runs.hand(q, 'question', at(35)), true);
  assert.strictEqual(q.handed, null, 'being stuck is not a hand-over by rule');
  assert.strictEqual(runs.outcomeOf(q), 'blocked');
});

test('manual: handed to the person by rule, such as a constitution change, or merged by a person', () => {
  const r = fresh();
  runs.verdict(r, { kind: 'fix', commit: 'a'.repeat(40), at: at(20) });
  assert.strictEqual(runs.hand(r, 'protected-file', at(30)), true);
  assert.strictEqual(runs.hand(r, 'ci-red', at(40)), false, 'the first hand-over is the one kept');
  const e = fresh();
  runs.verdict(e, { kind: 'merge', commit: 'a'.repeat(40), at: at(20) });
  assert.strictEqual(runs.hand(e, 'exhibit', at(30)), true, 'Exhibit not passing is a hand-over by rule');
  assert.strictEqual(runs.outcomeOf(e), 'manual');
  assert.deepStrictEqual(r.handed, { reason: 'protected-file', at: at(30) });
  assert.strictEqual(runs.outcomeOf(r), 'manual');
  const p = fresh();
  runs.merged(p, at(70), 'you');
  assert.strictEqual(runs.outcomeOf(p), 'manual');
  assert.strictEqual(runs.hand(fresh(), 'any words at all', at(1)), false, 'only reason words from the list are kept');
});

test('the day: counts by outcome and by kind, and the median minutes from start to merge', () => {
  const day = '2026-11-08';
  const make = (kind, mins, how) => {
    const r = fresh({ kind, task: 't' + mins });
    if (how === 'fix') runs.verdict(r, { kind: 'fix', commit: 'a'.repeat(40), at: at(5) });
    if (how === 'hand') runs.hand(r, 'protected-file', at(mins));
    else if (mins) runs.merged(r, at(mins), 'Autopilot');
    return r;
  };
  const yesterday = Object.assign(make('feature', 10), { startedAt: '2026-11-07T23:00:00.000Z' });
  const all = [make('feature', 32), make('feature', 84, 'fix'), make('docs', 40), make(null, 0), make('docs', 50, 'hand'), yesterday];
  assert.deepStrictEqual(runs.dayOf(all, day), {
    day, runs: 5,
    byOutcome: { success: 2, flawed: 1, blocked: 0, manual: 1, open: 1 },
    byKind: {
      feature: { success: 1, flawed: 1, blocked: 0, manual: 0, open: 0 },
      docs: { success: 1, flawed: 0, blocked: 0, manual: 1, open: 0 },
      none: { success: 0, flawed: 0, blocked: 0, manual: 0, open: 1 }
    },
    medianStartToMergeMinutes: 40
  });
  assert.strictEqual(runs.dayOf([], day).medianStartToMergeMinutes, null);
});

test('a record holds only ids, times, verdicts and reason words, and is kept for 90 days', () => {
  const r = runs.start({ task: 'a1b2c3', ticket: 'T-12', kind: 'Write "hello" $(rm -rf ~)', at: T0 });
  assert.strictEqual(r.kind, null, 'a value that is not an id is not kept');
  runs.fromTask(r, { history: [{ type: 'briefed', at: at(1), text: 'the whole brief' }, { type: 'pr', pr: PR, at: at(2), body: 'secret body' }] }, false);
  runs.verdict(r, { kind: 'merge', commit: 'c'.repeat(40), at: at(3), sessionId: 'session-id', posted: PR + '#issuecomment-1', token: 'k' });
  runs.hand(r, 'merge-failed', at(4));
  assert.deepStrictEqual(Object.keys(r).sort(), runs.FIELDS.slice().sort());
  assert.deepStrictEqual(Object.keys(r.verdicts[0]).sort(), ['at', 'commit', 'kind']);
  assert.deepStrictEqual(Object.keys(r.handed).sort(), ['at', 'reason']);
  assert.doesNotMatch(JSON.stringify(r), /whole brief|secret body|session-id|token|issuecomment/);
  const store = { old: Object.assign(fresh(), { startedAt: '2026-08-01T00:00:00.000Z' }), now: fresh() };
  assert.strictEqual(runs.prune(store, Date.parse('2026-11-08T12:00:00.000Z')), true);
  assert.deepStrictEqual(Object.keys(store), ['now']);
});

test('a ticket names a run by its ticket id or its whole PR link, not a longer one', () => {
  const r = Object.assign(fresh({ ticket: 'T-4' }), { pr: 'https://github.com/acme/widgets/pull/4' });
  assert.strictEqual(runs.names('Broken since https://github.com/acme/widgets/pull/44 merged', r), false, 'PR 44 is not PR 4');
  assert.strictEqual(runs.names('See T-40.', r), false, 'T-40 is not T-4');
  assert.strictEqual(runs.names('Broken since https://github.com/acme/widgets/pull/4 merged', r), true);
  assert.strictEqual(runs.names('After https://github.com/acme/widgets/pull/44 and https://github.com/acme/widgets/pull/4.', r), true);
  assert.strictEqual(runs.names('T-4 broke it', r), true);
});

test('a merge that Autopilot did not make is a person\'s, also when the task reached Done another way', () => {
  const r = fresh();
  runs.fromTask(r, { history: [{ type: 'merged', at: at(50) }] }, false);
  assert.deepStrictEqual([r.mergedAt, r.mergedBy, runs.outcomeOf(r)], [at(50), 'person', 'manual']);
  const mine = fresh();
  runs.fromTask(mine, { history: [{ type: 'merged', at: at(50) }] }, true);
  assert.deepStrictEqual([mine.mergedBy, runs.outcomeOf(mine)], ['Autopilot', 'success']);
});
