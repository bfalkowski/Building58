// RELAY_TYPE_SETTLE_MS: a value from 1 to 60000 is kept; anything else means 300.
const test = require('node:test');
const assert = require('node:assert');
const { typeSettle } = require('../terminal.js');

test('the settle time keeps 1 to 60000 and falls back to 300', () => {
  assert.strictEqual(typeSettle('1500'), 1500);
  assert.strictEqual(typeSettle('60000'), 60000);
  assert.strictEqual(typeSettle('60001'), 300);
  assert.strictEqual(typeSettle('3000000000'), 300);
  assert.strictEqual(typeSettle('0'), 300);
  assert.strictEqual(typeSettle('soon'), 300);
  assert.strictEqual(typeSettle(undefined), 300);
});
