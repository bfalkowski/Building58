// Speech bubbles (office/bubbles.js): the manager's deck never repeats a line across a refill, a long
// bubble stays up long enough to read, and a tall bubble moves the tags above it out of its way.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../office/bubbles.js'), 'utf8'), sandbox);
const { GAP, showSecs, deck, stackTags } = sandbox.window.OfficeBubbles;

const lines = ['a', 'b', 'c', 'd', 'e'];
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('a refill never starts with the line just said, and holds every line once', () => {
  for (let seed = 1; seed <= 300; seed++) {
    for (const last of lines) {
      const cards = deck(lines, last, seeded(seed));
      assert.deepStrictEqual([...cards].sort(), lines);
      assert.notStrictEqual(cards[cards.length - 1], last, 'the next line out is not the last one said');
    }
  }
  assert.deepStrictEqual([...deck(['only'], 'only', Math.random)], ['only']);
});

test('the shuffle reaches every order, not only some', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 2000; seed++) seen.add(deck(['a', 'b', 'c'], '', seeded(seed)).join(''));
  assert.strictEqual(seen.size, 6);
});

test('a long bubble stays up for 2 seconds plus 1 for each 15 characters, with no cap, and a short one as asked', () => {
  const sixty = 'x'.repeat(60);
  assert.strictEqual(showSecs(sixty, 3, true), 6);
  assert.strictEqual(showSecs('x'.repeat(48), undefined, true), 2 + 48 / 15);
  assert.strictEqual(showSecs('Done', 2, false), 2);
  assert.strictEqual(showSecs('Hm.', undefined, false), 2.5);
});

test('a tag behind a desk with a tall bubble is moved above the bubble, and not under it', () => {
  const tall = { x: 100, y: 300, w: 80, h: GAP + 60 };
  const above = { x: 100, y: 290, w: 80, h: 25 };
  stackTags([tall, above]);
  assert.ok(above.y <= tall.y - tall.h, 'the tag above the bubble clears its top: ' + above.y + ' vs ' + (tall.y - tall.h));
  const flat = { x: 100, y: 300, w: 80, h: 25 };
  const near = { x: 100, y: 290, w: 80, h: 25 };
  stackTags([flat, near]);
  assert.ok(near.y > tall.y - tall.h, 'with a one-line bubble it stacks lower than it does for a tall one');
});
