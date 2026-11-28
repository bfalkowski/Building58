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
