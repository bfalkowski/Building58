// The two ways the relay cleans text, from relay/clean.js. Nothing here starts a relay.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { oneLine, keepLines } = require('../clean.js');
const { plainName } = require('../seats.js');

const messy = 'a\tb\r\n\nc\x00d\x07e\x1bf\x7fg\x85h\x9fi   j';

test('oneLine turns control characters and runs of space into one space, trims, and cuts to n', () => {
  assert.strictEqual(oneLine(messy), 'a b c d e f g h i j');
  assert.strictEqual(oneLine('  hi\n\nthere  '), 'hi there');
  assert.strictEqual(oneLine('abcdef', 3), 'abc');
  assert.strictEqual(oneLine(' \x00 abc', 2), 'ab', 'it trims before it cuts');
  assert.strictEqual(oneLine(' x '), 'x', 'other spaces count as space');
});

test('keepLines takes control characters out, keeps line breaks and tabs, and does not trim', () => {
  assert.strictEqual(keepLines(messy), 'a\tb\n\ncdefghi   j');
  assert.strictEqual(keepLines('  x \n'), '  x \n');
  assert.strictEqual(keepLines('a\x00bcdef', 3), 'abc', 'it cuts after it cleans');
});

test('both read null and undefined as empty, and anything else as its string', () => {
  for (const f of [oneLine, keepLines]) {
    assert.strictEqual(f(null), '');
    assert.strictEqual(f(undefined), '');
    assert.strictEqual(f(42), '42');
    assert.strictEqual(f(false), 'false');
  }
});

test('a seat name still loses hidden marks and control characters, and keeps 40 code points', () => {
  assert.strictEqual(plainName('Ada​ \x00 ‮Love'), 'Ada Love');
  assert.strictEqual(plainName('😀'.repeat(41)), '😀'.repeat(40));
  assert.strictEqual(plainName(null), '');
});
