// Each desk on the Floor says its ticket, the ticket's column, its PR with CI and review, what it is
// doing, the next step and who owns it, and whether it is safe to stop (relay/desk.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { deskOf } = require('../desk.js');

const now = Date.now(), min = 60 * 1000;
const PR = 'https://github.com/o/r/pull/31';
const idle = (over) => Object.assign({ id: 'a', state: 'idle', spoke: true, hooked: true, lastActAt: now - 12 * min }, over);
const task = (over) => Object.assign({ id: 'abc123', ticket: 'T-7', ticketAt: '2026-11-01T00:00:00.000Z', title: 'Make the desk talk', state: 'building', pr: null, history: [] }, over);
const work = (t) => ({ role: 'dev', ticket: t.ticket, ticketAt: t.ticketAt, pr: t.pr, label: t.ticket + ' · ' + t.title });
const safe = (reason) => ({ safe: true, canStop: true, reason });
const notSafe = (reason) => ({ safe: false, canStop: false, reason });

test('a Done Dev: Done, safe to stop, with the reason', () => {
  const k = task({ state: 'done', pr: PR });
  const d = deskOf({ t: idle({ task: k.id }), role: 'Dev', work: work(k), task: k, pipeline: null, verdict: safe('its task is Done, idle 12 min, and Bring back returns it to the same checkout'), now });
  assert.deepStrictEqual([d.ticket, d.title, d.column.label, d.prNumber], ['T-7', 'Make the desk talk', 'Done', '#31']);
  assert.deepStrictEqual(d.doing, { state: 'idle', words: 'idle 12 min' });
  assert.deepStrictEqual(d.next, { text: 'Done, safe to stop', owner: 'you' });
  assert.deepStrictEqual(d.stop, { safe: true, reason: 'its task is Done, idle 12 min, and Bring back returns it to the same checkout' });
});

test('a Done Dev with work not pushed is not safe to stop, and says why', () => {
  const k = task({ state: 'done', pr: PR });
  const d = deskOf({ t: idle({ task: k.id }), role: 'Dev', work: work(k), task: k, verdict: { safe: true, canStop: false, reason: 'not one the Lead may stop: its checkout has uncommitted changes' }, now });
  assert.deepStrictEqual(d.next, { text: 'Done, but its checkout has uncommitted changes', owner: 'you' });
  assert.strictEqual(d.stop.safe, false);
});

test('a Done Dev still working is not safe to stop yet', () => {
  const k = task({ state: 'done', pr: PR });
  const d = deskOf({ t: idle({ task: k.id, state: 'working' }), role: 'Dev', work: work(k), task: k, verdict: notSafe('it is working'), now });
  assert.deepStrictEqual(d.next, { text: 'Done, not safe to stop yet: it is working', owner: 'you' });
});

test('a Dev in review: its column, CI and review, and who moves it next', async (t) => {
  const k = task({ state: 'in_review', pr: PR });
  const base = { t: idle({ task: k.id }), role: 'Dev', work: work(k), task: k, review: { count: 1, waits: false, held: false }, verdict: notSafe('not one the Lead may stop: its PR has not merged and its task is not Done'), now };
  await t.test('Autopilot waits for CI', () => {
    const d = deskOf(Object.assign({}, base, { pipeline: { state: 'pending' }, autopilot: { on: true, mine: true, act: 'wait', why: 'Waiting for CI.', verdict: 'merge' } }));
    assert.deepStrictEqual([d.column.label, d.ciWords, d.review], ['In review', 'CI running', 'review says merge']);
    assert.deepStrictEqual(d.next, { text: 'Autopilot merges when CI is green', owner: 'Autopilot' });
    assert.deepStrictEqual(d.stop, { safe: false, reason: null });
  });
  await t.test('a reviewer is on it', () => {
    const d = deskOf(Object.assign({}, base, { pipeline: { state: 'green' }, reviewing: true }));
    assert.deepStrictEqual([d.ciWords, d.review], ['CI green', 'review running']);
    assert.deepStrictEqual(d.next, { text: 'The reviewer reviews PR #31', owner: 'reviewer' });
  });
  await t.test('no Autopilot and no Lead that merges: the person', () => {
    const d = deskOf(Object.assign({}, base, { pipeline: { state: 'green' } }));
    assert.deepStrictEqual([d.review, d.next], ['reviewed 1 time', { text: 'Waiting on you: review and merge PR #31', owner: 'you' }]);
  });
  await t.test('a Lead that merges', () => {
    const d = deskOf(Object.assign({}, base, { pipeline: { state: 'green' }, leadMerges: true }));
    assert.deepStrictEqual(d.next, { text: 'The Lead merges PR #31 when it is reviewed and green', owner: 'Lead' });
  });
  await t.test('a failed check goes back to the Dev', () => {
    const d = deskOf(Object.assign({}, base, { pipeline: { state: 'red' } }));
    assert.deepStrictEqual(d.next, { text: 'The Dev fixes the failed CI on PR #31', owner: 'Dev' });
  });
  await t.test('automatic reviews used up', () => {
    const d = deskOf(Object.assign({}, base, { pipeline: { state: 'green' }, review: { count: 3, waits: true } }));
    assert.deepStrictEqual(d.next, { text: 'Waiting on you: review PR #31, its automatic reviews are used up', owner: 'you' });
  });
  await t.test('a follow-up review waits on CI', () => {
    const d = deskOf(Object.assign({}, base, { pipeline: { state: 'pending' }, review: { count: 1, waits: false, held: true } }));
    assert.deepStrictEqual([d.review, d.next], ['review waits on CI', { text: 'CI runs on PR #31, then the review', owner: 'CI' }]);
  });
  await t.test('a first review waits for a desk', () => {
    const d = deskOf(Object.assign({}, base, { pipeline: { state: 'green' }, review: { count: 0, waits: false, held: false, desk: true } }));
    assert.deepStrictEqual([d.review, d.next], ['review waits for a desk', { text: 'The review of PR #31 starts when a desk is free', owner: 'reviewer' }]);
  });
  await t.test('a first review that could not start waits on the person', () => {
    const d = deskOf(Object.assign({}, base, { pipeline: { state: 'green' }, review: { count: 0, waits: false, held: false, failed: true } }));
    assert.deepStrictEqual([d.review, d.next], ['automatic review could not start', { text: 'Waiting on you: review PR #31, its automatic review could not start', owner: 'you' }]);
  });
  await t.test('working now', () => {
    const d = deskOf(Object.assign({}, base, { t: idle({ task: k.id, state: 'working' }) }));
    assert.deepStrictEqual(d.doing, { state: 'working', words: 'working' });
  });
});

test('a task Waiting on you says why', async (t) => {
  await t.test('Autopilot handed it over', () => {
    const k = task({ state: 'waiting_on_you', pr: PR });
    const d = deskOf({ t: idle({ task: k.id }), role: 'Dev', work: work(k), task: k, autopilot: { on: true, mine: true, act: 'person', handedOver: 'It changes docs/constitution.md, which only a person merges.' }, verdict: notSafe('its task is Waiting on you'), now });
    assert.strictEqual(d.column.label, 'Waiting on you');
    assert.deepStrictEqual(d.next, { text: 'Waiting on you: It changes docs/constitution.md, which only a person merges.', owner: 'you' });
    assert.strictEqual(d.stop.safe, false);
  });
  await t.test('the note on the move', () => {
    const k = task({ state: 'waiting_on_you', history: [{ type: 'moved', from: 'in_review', to: 'waiting_on_you', by: 'Lead', note: 'constitution change' }] });
    const d = deskOf({ t: idle({ task: k.id }), role: 'Dev', work: work(k), task: k, verdict: notSafe('its task is Waiting on you'), now });
    assert.deepStrictEqual(d.next, { text: 'Waiting on you: constitution change', owner: 'you' });
  });
  await t.test('a permission prompt on its screen comes first', () => {
    const k = task({ state: 'building' });
    const d = deskOf({ t: idle({ task: k.id, state: 'waiting', message: 'Claude needs your permission to use Bash' }), role: 'Dev', work: work(k), task: k, verdict: notSafe('it is waiting on the person'), now });
    assert.deepStrictEqual(d.doing, { state: 'waiting', words: 'waiting on you: Claude needs your permission to use Bash' });
    assert.deepStrictEqual(d.next, { text: 'Waiting on you: Claude needs your permission to use Bash', owner: 'you' });
  });
});

test('a posted reviewer: its ticket and column are those of the PR it reviewed', () => {
  const k = task({ state: 'in_review', pr: PR });
  const t = idle({ role: 'reviewer', reviewOf: PR, pr: PR, posted: { kind: 'review', url: PR + '#r1' } });
  const d = deskOf({ t, role: 'reviewer', work: { role: 'reviewer', ticket: 'T-7', ticketAt: k.ticketAt, pr: PR, label: 'reviewing T-7 · Make the desk talk' }, task: k, verdict: safe('its review is posted, idle 12 min'), now });
  assert.deepStrictEqual([d.ticket, d.column.label, d.prNumber, d.review], ['T-7', 'In review', '#31', 'review posted']);
  assert.deepStrictEqual(d.next, { text: 'Done, safe to stop', owner: 'you' });
  assert.deepStrictEqual(d.stop, { safe: true, reason: 'its review is posted, idle 12 min' });
});

test('a reviewer still at work', () => {
  const t = idle({ role: 'reviewer', reviewOf: PR, pr: PR, state: 'working' });
  const d = deskOf({ t, role: 'reviewer', work: { role: 'reviewer', pr: PR }, task: null, verdict: notSafe('it is working'), now });
  assert.deepStrictEqual([d.ticket, d.column, d.review], [null, null, 'review running']);
  assert.deepStrictEqual(d.next, { text: 'The reviewer posts its review of PR #31', owner: 'reviewer' });
});

test('the Lead is never safe to stop', () => {
  const d = deskOf({ t: idle({ lead: true }), role: 'Lead', work: { role: 'lead', label: 'The Lead' }, task: null, verdict: notSafe('it is the Lead'), now });
  assert.deepStrictEqual([d.ticket, d.column, d.pr], [null, null, null]);
  assert.deepStrictEqual(d.next, { text: 'The Lead keeps tickets moving', owner: 'Lead' });
  assert.deepStrictEqual(d.stop, { safe: false, reason: null });
});

test('a session the Floor calls safe, but not one of the two kinds, has no Safe to stop', () => {
  const d = deskOf({ t: idle(), role: 'session', work: null, task: null, verdict: { safe: true, canStop: false, reason: 'not one the Lead may stop: it is not a reviewer or a Dev' }, now });
  assert.strictEqual(d.stop.safe, false);
  assert.deepStrictEqual(d.next, { text: 'Waiting on you: give it a prompt, or stop it', owner: 'you' });
});

test('a Dev told something that did not start: stuck, how long ago, and why, as a step that waits on you', () => {
  const k = task({ state: 'changes_requested', pr: PR });
  const t = idle({ task: k.id, stuck: { at: now - 27 * min, why: 'a menu is open on its screen' } });
  const d = deskOf({ t, role: 'Dev', work: work(k), task: k, verdict: notSafe('Enter was pressed and no hook has answered yet'), now });
  assert.deepStrictEqual(d.doing, { state: 'stuck', words: 'stuck: told 27 min ago, did not start' });
  assert.deepStrictEqual(d.next, { text: 'Waiting on you: it did not start on what it was told, a menu is open on its screen. Open its session, or stop it and Bring it back', owner: 'you' });
  const working = deskOf({ t: Object.assign({}, t, { state: 'working' }), role: 'Dev', work: work(k), task: k, verdict: notSafe('it is working'), now });
  assert.strictEqual(working.doing.state, 'working', 'a turn that has begun is not stuck');
});

test('a Dev\'s status icon says where its PR stands, with a label to read it by (T-141)', async (t) => {
  const HEAD = 'b'.repeat(40), OLD = 'a'.repeat(40);
  const status = (over, taskOver) => {
    const k = task(Object.assign({ state: 'in_review', pr: PR }, taskOver));
    return deskOf(Object.assign({ t: idle({ task: k.id }), role: 'Dev', work: work(k), task: k, review: { count: 1 }, verdict: notSafe('working'), now }, over)).status;
  };
  const label = (over, taskOver) => { const s = status(over, taskOver); return [s.key, s.label]; };
  await t.test('each step, in the order the relay learns of them', () => {
    assert.deepStrictEqual(label({}, { state: 'building', pr: null }), ['building', 'building']);
    assert.deepStrictEqual(label({ pipeline: { state: 'pending', head: HEAD } }), ['ci_running', 'CI running']);
    assert.deepStrictEqual(label({ pipeline: { state: 'red', head: HEAD } }), ['ci_failed', 'CI failed']);
    assert.deepStrictEqual(label({ pipeline: { state: 'green', head: HEAD }, review: { count: 0, held: false } }), ['review_waits', 'waiting for a review']);
    assert.deepStrictEqual(label({ pipeline: { state: 'green', head: HEAD }, reviewing: true, reviewer: 'Ada' }), ['reviewing', 'being reviewed by Ada']);
    assert.deepStrictEqual(label({ pipeline: { state: 'green', head: HEAD }, reviewing: true }), ['reviewing', 'being reviewed']);
    assert.deepStrictEqual(label({ pipeline: { state: 'green', head: HEAD } }, { state: 'changes_requested' }), ['fix', 'fix requested']);
    assert.deepStrictEqual(label({ pipeline: { state: 'green', head: HEAD }, autopilot: { verdict: 'fix', verdictAt: HEAD } }), ['fix', 'fix requested']);
    assert.deepStrictEqual(label({ pipeline: { state: 'green', head: HEAD }, autopilot: { verdict: 'merge', verdictAt: HEAD } }), ['merge', 'review says merge']);
    assert.deepStrictEqual(label({ merged: true }), ['merged', 'merged']);
  });
  await t.test('every status has an icon', () => {
    for (const over of [{}, { pipeline: { state: 'red' } }, { merged: true }, { reviewing: true }]) assert.ok(status(over).icon, JSON.stringify(over));
  });
  await t.test('a verdict on an older commit no longer speaks: the push waits for its review', () => {
    assert.deepStrictEqual(label({ pipeline: { state: 'green', head: HEAD }, autopilot: { verdict: 'merge', verdictAt: OLD } }), ['review_waits', 'waiting for a review']);
  });
  await t.test('a review running wins over CI, and a failed CI over an old verdict', () => {
    assert.strictEqual(status({ pipeline: { state: 'pending' }, reviewing: true, reviewer: 'Ada' }).key, 'reviewing');
    assert.strictEqual(status({ pipeline: { state: 'red' }, autopilot: { verdict: 'merge', verdictAt: HEAD } }).key, 'ci_failed');
  });
  await t.test('Done and Waiting on you come from the task', () => {
    assert.deepStrictEqual(label({}, { state: 'done' }), ['done', 'done']);
    assert.deepStrictEqual(label({}, { state: 'waiting_on_you' }), ['waiting_on_you', 'waiting on you']);
  });
  await t.test('only a Dev with a task has one', () => {
    assert.strictEqual(deskOf({ t: idle({ role: 'reviewer', reviewOf: PR, pr: PR }), role: 'reviewer', work: { pr: PR }, task: null, verdict: notSafe('x'), now }).status, null);
    assert.strictEqual(deskOf({ t: idle({ lead: true }), role: 'Lead', work: {}, task: null, verdict: notSafe('x'), now }).status, null);
  });
});

test('the security officer writes its report, then waits for you to read it (review of PR 185)', () => {
  const work = { role: 'security', label: 'Security · report on access' };
  const writing = deskOf({ t: idle({ role: 'security', state: 'working' }), role: 'Security', work, task: null, verdict: notSafe('it is working'), now });
  assert.deepStrictEqual(writing.next, { text: 'The security officer writes its report on access', owner: 'Security' });
  const done = deskOf({ t: idle({ role: 'security' }), role: 'Security', work, task: null, verdict: notSafe('it is idle'), now });
  assert.deepStrictEqual(done.next, { text: 'Waiting on you: read the Security report', owner: 'you' });
});

// T-126: the Floor pairs each reviewer with the Dev whose PR it reviews, so the page draws it under that Dev.
test('a reviewer is paired with the Dev whose PR it reviews', async (t) => {
  const { pairReviewers } = require('../desk.js');
  const OTHER = 'https://github.com/o/r/pull/40';
  const row = (terminal, name, role, pr) => ({ terminal, name, role, desk: { pr, prNumber: pr ? '#' + pr.split('/').pop() : null } });
  await t.test('the reviewer names the Dev, and the Dev names its reviewers', () => {
    const rows = [row('d1', 'Ada', 'Dev', PR), row('r1', 'Theo', 'reviewer', PR), row('r2', 'Mia', 'reviewer', PR), row('d2', 'Bo', 'Dev', OTHER)];
    pairReviewers(rows);
    assert.deepStrictEqual(rows[1].desk.reviewing, { pr: PR, prNumber: '#31', dev: { terminal: 'd1', name: 'Ada' } });
    assert.deepStrictEqual(rows[0].desk.reviewedBy, [{ terminal: 'r1', name: 'Theo' }, { terminal: 'r2', name: 'Mia' }]);
    assert.deepStrictEqual(rows[3].desk.reviewedBy, []);
    assert.strictEqual(rows[0].desk.reviewing, undefined, 'a Dev reviews nothing');
  });
  await t.test('a reviewer whose PR has no Dev on the Floor names only the PR', () => {
    const rows = [row('r1', 'Theo', 'reviewer', OTHER), row('d1', 'Ada', 'Dev', PR)];
    pairReviewers(rows);
    assert.deepStrictEqual(rows[0].desk.reviewing, { pr: OTHER, prNumber: '#40', dev: null });
  });
  await t.test('a row with no desk, or a reviewer with no PR, is left alone', () => {
    const rows = [{ terminal: 'x', name: 'X', role: 'reviewer', desk: null }, row('r1', 'Theo', 'reviewer', null)];
    pairReviewers(rows);
    assert.strictEqual(rows[1].desk.reviewing, null);
  });
});
