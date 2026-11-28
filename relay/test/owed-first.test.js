'use strict';
// A Dev owed fixes comes back before a review of new work takes the free desk (ticket 553).
const test = require('node:test');
const assert = require('node:assert');
const owedFirst = require('../owed-first.js');

test('two owed tasks: the oldest comes back first, and a done or unowed task is skipped', () => {
  const list = [
    { id: 'c', state: 'building' },
    { id: 'b', state: 'building', bringBack: { at: 200 } },
    { id: 'a', state: 'building', bringBack: { at: 100 } },
    { id: 'd', state: 'done', bringBack: { at: 50 } },
  ];
  assert.deepStrictEqual(owedFirst.owedTasks(list).map((t) => t.id), ['a', 'b']);
  assert.strictEqual(owedFirst.oldest(list).id, 'a');
  assert.strictEqual(owedFirst.oldest([{ id: 'c' }]), null);
});

test('canStart skips an owed Dev that the WIP limit holds, since a review may free that slot', () => {
  const list = [
    { id: 'a', state: 'building', bringBack: { at: 100, error: 'wip_limit' } },
    { id: 'b', state: 'building', bringBack: { at: 200, error: 'full' } },
  ];
  assert.strictEqual(owedFirst.canStart(list).id, 'b');
  assert.strictEqual(owedFirst.canStart([list[0]]), null);
});

test('firstReviews holds a first review for an owed Dev while a desk is free, and starts it with none owed', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-owed-first-'));
  process.env.RELAY_REVIEWS_FILE = path.join(dir, 'reviews.json');
  process.env.RELAY_PIPELINE_POLL_SECONDS = '0';
  fs.writeFileSync(process.env.RELAY_REVIEWS_FILE, '{}');
  const reviews = require('../reviews.js');
  const pr = 'https://github.com/a/b/pull/1';
  const record = () => ({ prs: { [pr]: { count: 0, head: null, pending: null, waits: false, first: { at: 1, desk: true } } } });
  let owed = true;
  reviews.useAutopilot({ owed: () => owed, follows: () => false, ask: () => '', since: () => null, freed: () => {}, verdictOf: () => null });
  let free;
  const held = record();
  reviews.firstReviews('c', held);
  assert.ok(held.prs[pr].first && !reviews.chOf('c').prs[pr], 'held for the owed Dev');
  owed = false;
  reviews.firstReviews('c', free = record());
  assert.strictEqual(reviews.chOf('c').prs[pr].count, 1, 'started once no Dev is owed');
  fs.rmSync(dir, { recursive: true, force: true });
});
