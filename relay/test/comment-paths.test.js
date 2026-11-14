// A code comment that names a repo file sends the reader there, so the file must exist. This reads
// the comments in the .js, .css, .sh and .py files of relay/, office/ and shared/. A comment is the
// text after //, /*, # or a leading *, each followed by a space, so a URL's :// is not one. In it, a
// path is a word that starts with relay/, office/, shared/, docs/, .github/ or .githooks/ and ends
// in .js, .html, .css, .md, .json, .sh, .py or .yml. Each one must be a file or folder in the repo.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const COMMENT = /(?:^|\s)(?:\/\/|\/\*|\*|#)\s(.*)$/;
const PATH = /(?<![\w./-])((?:relay|office|shared|docs|\.github|\.githooks)\/[\w./-]*\w\.(?:js|html|css|md|json|sh|py|yml))\b/g;

// The repo paths a line's comment names.
function paths(line) {
  const c = line.match(COMMENT);
  return c ? [...c[1].matchAll(PATH)].map((m) => m[1]) : [];
}

function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' || d.name.startsWith('.') ? [] : filesIn(p);
    return /\.(js|css|sh|py)$/.test(d.name) ? [p] : [];
  });
}

test('each repo file a code comment names exists', () => {
  // The missing file is split in two, so that this line does not name it in a comment of its own.
  assert.deepStrictEqual(paths('  // and relay/' + 'office-demo.js sends the events, see docs/manual/relay.html.'), ['relay/' + 'office-demo.js', 'docs/manual/relay.html']);
  assert.deepStrictEqual(paths(' * Read office/look.js first'), ['office/look.js']);
  assert.deepStrictEqual(paths("const f = 'relay/server.js'; // the relay"), [], 'a path in code, not in the comment, is not checked');
  assert.deepStrictEqual(paths("fetch('http://x/relay/a.js') // ok"), [], 'nor is a URL');
  assert.deepStrictEqual(paths('// the my-relay/a.js file'), [], 'nor a path that does not start at the repo root');
  const found = [];
  let seen = 0;
  for (const top of ['relay', 'office', 'shared']) {
    for (const file of filesIn(path.join(REPO, top))) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const p of paths(line)) {
          seen++;
          if (!fs.existsSync(path.join(REPO, p))) found.push(path.relative(REPO, file) + ':' + (i + 1) + ' names ' + p);
        }
      });
    }
  }
  assert.ok(seen > 100, 'the scan finds the paths the comments name');
  assert.deepStrictEqual(found, [], 'Fix the comment to name the file that is there now.');
});
