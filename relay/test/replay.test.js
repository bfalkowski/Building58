// What a page gets when it opens a session: output from the last full-screen clear, at most REPLAY bytes.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { replayOf, REPLAY } = require('../replay.js');

const buf = (s) => Buffer.from(s);

test('output with no clear and under the cap is replayed whole', () => {
  assert.strictEqual(replayOf(buf('one\r\ntwo\r\n')).toString(), 'one\r\ntwo\r\n');
});

test('the replay starts at the last clear-screen, with the cursor move before it', () => {
  const out = buf('old\r\n\x1b[H\x1b[2Jfirst\r\n\x1b[H\x1b[2Jsecond\r\nmore');
  assert.strictEqual(replayOf(out).toString(), '\x1b[H\x1b[2Jsecond\r\nmore');
});

test('a bare clear and a full reset both start a replay', () => {
  assert.strictEqual(replayOf(buf('a\x1b[2Jb\x1b[3Jc')).toString(), '\x1b[3Jc');
  assert.strictEqual(replayOf(buf('a\x1bcb')).toString(), '\x1bcb');
});

test('with no clear, a replay over the cap is cut to the cap at a line start', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => 'line ' + i + '\r\n').join('');
  const got = replayOf(buf(lines)).toString();
  assert.ok(got.length <= REPLAY, String(got.length));
  assert.ok(got.length > REPLAY - 100, 'it keeps nearly the cap');
  assert.match(got, /^line \d+\r\n/);
  assert.ok(got.endsWith('line 4999\r\n'));
});

test('a cut never splits a multi-byte letter', () => {
  const got = replayOf(buf('é'.repeat(REPLAY))).toString();
  assert.ok(!got.includes('�'));
});
