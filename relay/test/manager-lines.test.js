// The manager's lines, from office/manager-lines.js. Nothing here runs a browser.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LINES } = require('../../office/manager-lines.js');

test('the manager has 100 different lines', () => {
  assert.strictEqual(LINES.length, 100);
  assert.strictEqual(new Set(LINES).size, LINES.length, 'a line is there twice');
});

test('each line is one short sentence a bubble can show in full', () => {
  for (const line of LINES) {
    assert.ok(line.length <= 48, 'too long for three lines of a bubble: ' + line);
    assert.match(line, /[.?!]$/, 'ends without a stop: ' + line);
    assert.ok(!line.includes('—'), 'em dash: ' + line);
  }
});
