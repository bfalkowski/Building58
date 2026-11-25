'use strict';
// What a Dev is told about a PR that conflicts with main (relay/conflict-text.js).
const test = require('node:test');
const assert = require('node:assert');
const text = require('../conflict-text.js');

const PR = 'https://github.com/acme/widgets/pull/7', HEAD = 'a'.repeat(40);

test('the first message gives the steps', () => {
  const m = text.first(PR);
  for (const step of ['git fetch origin', 'git merge origin/main', 'foreground', 'push nothing else']) assert.ok(m.includes(step), step);
});

test('the second message names the files, and leaves them out when there are none', () => {
  assert.match(text.again(PR, HEAD, ['a.js', 'b/c.js']), /still conflicts with main at aaaaaaa after your push\. The conflicting files are: a\.js, b\/c\.js\./);
  assert.ok(!text.again(PR, HEAD, []).includes('conflicting files'));
});

test('no checkout means no files', async () => {
  assert.deepStrictEqual(await text.conflictFiles(''), []);
});
