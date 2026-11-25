'use strict';
// The manager's six signs (relay/manager-watch-plan.js), each read from a fake board, and what each one does not catch.
const test = require('node:test');
const assert = require('node:assert');
const { findings } = require('../manager-watch-plan.js');

const MIN = 60000, NOW = 1e12;
const LIMITS = { buildingMs: 60 * MIN, checkFails: 3, briefMs: 10 * MIN, slotMs: 10 * MIN, handoffs: 3, skipMs: 30 * MIN };
const task = (o) => Object.assign({ id: 't1', ticket: 'T-1', title: 'Make it', repo: '/r', state: 'building', slot: true, terminal: 'a1', dev: 'live', movedAt: NOW - MIN, since: NOW - MIN, checks: [] }, o);
const board = (o) => Object.assign({ now: NOW, limits: LIMITS, tasks: [], seats: [], runs: [], ready: [] }, o);
const kinds = (b) => findings(b).map((f) => f.kind);

test('a task in Building with nothing moving it for the limit is one finding, with its desk and the reason', () => {
  assert.deepStrictEqual(kinds(board({ tasks: [task()] })), []);
  const [f] = findings(board({ tasks: [task({ movedAt: NOW - 70 * MIN })] }));
  assert.strictEqual(f.kind, 'quiet');
  assert.strictEqual(f.key, 'quiet t1');
  assert.strictEqual(f.ticket, 'T-1');
  assert.strictEqual(f.terminal, 'a1');
  assert.match(f.reason, /T-1 is in Building, and no hook, push or PR change came for 70 minutes/);
  assert.match(f.say, /T-1 has not moved in 70 minutes/);
});

test('a Dev at a question is not quiet, and a task past Building is not either', () => {
  assert.deepStrictEqual(kinds(board({ tasks: [task({ movedAt: NOW - 90 * MIN, dev: 'waiting' })] })), []);
  assert.deepStrictEqual(kinds(board({ tasks: [task({ movedAt: NOW - 90 * MIN, state: 'in_review' })] })), []);
});

test('the same check failing on enough commits is a finding, and fewer is not', () => {
  assert.deepStrictEqual(kinds(board({ tasks: [task({ checks: [{ name: 'pipeline', heads: 2 }] })] })), []);
  const [f] = findings(board({ tasks: [task({ checks: [{ name: 'pipeline', heads: 3 }] })] }));
  assert.strictEqual(f.kind, 'check');
  assert.strictEqual(f.key, 'check t1 pipeline');
  assert.match(f.reason, /pipeline failed on 3 commits of the PR of T-1/);
});

test('a Dev with no brief and a reviewer with no first prompt are told apart, and a seat that got its words is not caught', () => {
  const seat = (o) => Object.assign({ terminal: 'a1', role: 'Dev', task: 't1', ticket: 'T-1', repo: '/r', who: 'Mia', startedAt: NOW - 11 * MIN, briefed: false }, o);
  const [dev, rev] = findings(board({ seats: [seat(), seat({ terminal: 'b2', role: 'reviewer', who: 'Ravi' })] }));
  assert.strictEqual(dev.kind, 'brief');
  assert.match(dev.reason, /The Dev Mia of T-1 never got its brief, 11 minutes after it started/);
  assert.strictEqual(rev.kind, 'prompt');
  assert.match(rev.reason, /The reviewer Ravi of T-1 never got its first prompt/);
  assert.strictEqual(rev.terminal, 'b2');
  assert.deepStrictEqual(kinds(board({ seats: [seat({ briefed: true }), seat({ startedAt: NOW - 2 * MIN })] })), []);
});

test('a building slot with no Dev, whether its session is gone or was never there', () => {
  assert.deepStrictEqual(kinds(board({ tasks: [task({ dev: 'gone', terminal: null, since: NOW - 11 * MIN }), task({ id: 't2', dev: null, terminal: null, since: NOW - 11 * MIN })] })), ['slot', 'slot']);
  assert.deepStrictEqual(kinds(board({ tasks: [task({ dev: 'gone', terminal: null, since: NOW - 2 * MIN })] })), [], 'not yet');
  assert.deepStrictEqual(kinds(board({ tasks: [task({ dev: 'gone', terminal: null, since: NOW - 11 * MIN, slot: false })] })), [], 'a task that holds no slot');
});

test('a task that is quiet and holds a slot with no Dev is one finding, the slot', () => {
  const both = task({ dev: 'gone', terminal: null, movedAt: NOW - 90 * MIN, since: NOW - 90 * MIN });
  assert.deepStrictEqual(kinds(board({ tasks: [both] })), ['slot']);
  assert.deepStrictEqual(kinds(board({ tasks: [both, task({ id: 't2', movedAt: NOW - 90 * MIN })] })), ['quiet', 'slot'], 'another task is still its own finding');
});

test('Autopilot handing several tasks in a row to you is one finding, and a merge between them ends the row', () => {
  const run = (n, outcome) => ({ task: 't' + n, ticket: 'T-' + n, repo: '/r', outcome });
  const [f] = findings(board({ runs: [run(1, 'handed'), run(2, 'handed'), run(3, 'handed')] }));
  assert.strictEqual(f.kind, 'handoffs');
  assert.strictEqual(f.key, 'handoffs');
  assert.match(f.reason, /Autopilot handed 3 tasks in a row to Waiting on you: T-1, T-2, T-3/);
  assert.deepStrictEqual(kinds(board({ runs: [run(1, 'handed'), run(2, 'handed')] })), []);
  assert.deepStrictEqual(kinds(board({ runs: [run(1, 'handed'), run(2, 'handed'), run(3, 'merged'), run(4, 'handed')] })), []);
  assert.strictEqual(findings(board({ runs: [run(0, 'merged'), run(1, 'handed'), run(2, 'handed'), run(3, 'handed'), run(4, 'handed')] }))[0].reason.match(/handed (\d+)/)[1], '4');
});

test('a Ready ticket Autopilot skips for a rejected blocker, after the limit', () => {
  const ready = (o) => Object.assign({ id: 'T-9', title: 'Later', repo: '/r', rejected: ['T-4'], since: NOW - 31 * MIN }, o);
  const [f] = findings(board({ ready: [ready()] }));
  assert.strictEqual(f.kind, 'skip');
  assert.strictEqual(f.ticket, 'T-9');
  assert.match(f.reason, /T-9 is in Ready, and Autopilot skips it because T-4 was rejected/);
  assert.deepStrictEqual(kinds(board({ ready: [ready({ since: NOW - 5 * MIN })] })), []);
  assert.match(findings(board({ ready: [ready({ rejected: ['T-4', 'T-5'] })] }))[0].reason, /T-4, T-5 were rejected/);
});

test('a quiet room has no findings, and a finding has the same key on the next look', () => {
  assert.deepStrictEqual(findings(board()), []);
  const b = board({ tasks: [task({ movedAt: NOW - 70 * MIN })] });
  assert.deepStrictEqual(findings(b).map((f) => f.key), findings(Object.assign({}, b, { now: NOW + 5 * MIN })).map((f) => f.key));
});
