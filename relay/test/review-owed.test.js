'use strict';
// While a follow-up review is owed or queued, the room says it waits for that review, and Autopilot does not hand
// the PR to the person as stalled (PR 439). reviews.owes() is what Autopilot's stall check asks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'office', 'front.js'), 'utf8'), sandbox);
const front = sandbox.window.OfficeFront;
const { listOf } = require('../needs-you-plan.js');

test('an owed follow-up review is owed to Autopilot, the card and Needs you say so, and nothing waits on the person', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-owed-'));
  process.env.RELAY_REVIEWS_FILE = path.join(dir, 'reviews.json');
  const pr = 'https://github.com/a/b/pull/1', first = 'https://github.com/a/b/pull/2';
  fs.writeFileSync(process.env.RELAY_REVIEWS_FILE, JSON.stringify({ c: { prs: {
    [pr]: { count: 1, head: 'abc', pending: { from: '/w', at: 1, watch: true, same: true }, waits: false },
    [first]: { count: 0, head: null, first: { at: 1 }, waits: false },
  } } }));
  const reviews = require('../reviews.js');
  assert.strictEqual(reviews.owes('c', pr), true, 'Autopilot sees a review owed, so it does not hand the PR over as stalled');
  assert.strictEqual(reviews.deskOf('c', pr).followUp, true);
  assert.strictEqual(reviews.deskOf('c', first).followUp, false, 'a first review is not a follow-up');

  const task = { id: 't1', ticket: 'T-1', title: 'x', state: 'waiting_on_you', pr, prOpen: true, owner: null, reviewRuns: false, reviewOwed: true };
  const items = listOf({ tasks: [task] });
  assert.ok(!items.some((i) => i.kind === 'waiting' || /waits on you/i.test(i.line)), JSON.stringify(items));
  assert.ok(listOf({ tasks: [Object.assign({}, task, { reviewOwed: false })] }).some((i) => i.kind === 'waiting'), 'it does, once no review is owed');

  const dev = { terminal: 'd1', name: 'Bea', role: 'Dev', ticket: 'T-1', title: 'x', desk: { column: { id: 'changes_requested' }, status: { key: 'fix' }, pr, prNumber: 1, review: { followUp: true } } };
  const needs = [{ kind: 'waiting', terminal: 'd1', line: 'Look at it' }];
  const card = front.cardsOf([dev], needs).cards[0];
  assert.strictEqual(card.stage, 'waiting for a follow-up review');
  assert.strictEqual(card.reason, null, 'the card does not say Waits on you');
  fs.rmSync(dir, { recursive: true, force: true });
});
