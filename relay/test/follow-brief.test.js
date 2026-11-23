'use strict';
// The follow-up reviewer's brief says not to reverse an earlier round's finding without saying why (T-297).
const test = require('node:test');
const assert = require('node:assert');
const { followBrief, prBrief } = require('../../office/reviews.js');

const PR = 'https://github.com/acme/widgets/pull/51';

test('the follow-up brief carries the no-silent-reversal rule, and the first brief does not', () => {
  const rule = 'Do not reverse a finding from an earlier round unless you say why.';
  assert.ok(followBrief(PR).includes(rule));
  assert.ok(followBrief(PR, 'a'.repeat(40)).includes(rule));
  assert.ok(!prBrief(PR).includes(rule));
});
