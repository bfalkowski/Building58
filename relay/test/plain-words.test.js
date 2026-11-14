// Plain words have no em dash (CLAUDE.md, docs/constitution.md article 12). relay/test/manual.test.js
// checks the manual. This checks the code and text in relay/, office/ and shared/, which is where
// interface text lives. Binary files, like the baked .png and .glb, are not read. A test that needs an
// em dash writes it as \u2014, and an entity as &(mdash);.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const DASH = /\u2014|&(?:mdash|#8212|#x2014);/i;

function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' || d.name.startsWith('.') ? [] : filesIn(p);
    return /\.(js|html|css|md|json|sh|py)$/.test(d.name) ? [p] : [];
  });
}

test('no code in relay/, office/ or shared/ has an em dash', () => {
  assert.ok(DASH.test('alex \u2014 session') && DASH.test('a &' + 'mdash; b') && !DASH.test('alex · session - a'), 'the match finds an em dash and only that');
  const found = [];
  for (const top of ['relay', 'office', 'shared']) {
    for (const file of filesIn(path.join(REPO, top))) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (DASH.test(line)) found.push(path.relative(REPO, file) + ':' + (i + 1) + ': ' + line.trim().slice(0, 120));
      });
    }
  }
  assert.deepStrictEqual(found, [], 'Use a period, a comma, a colon or · instead.');
});
