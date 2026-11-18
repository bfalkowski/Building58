// A ticket body in the shell's double quotes runs its backticks and $( ) as commands and ends at a
// quote, so ticket.js reads a body from stdin or a file (T-49). This checks that CLAUDE.md, the
// manual and the code in relay/, where the briefs live, show only those forms (T-152).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const QUOTED = /--body\s+(?:\\?"|&quot;)/;

function filesIn(dir, ext) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' || d.name === 'test' || d.name.startsWith('.') ? [] : filesIn(p, ext);
    return ext.test(d.name) ? [p] : [];
  });
}

test('CLAUDE.md, the manual and the briefs give a ticket body only on stdin or from a file', () => {
  assert.ok(QUOTED.test('create "T" --body "What to do"') && QUOTED.test('--body &quot;x&quot;') && QUOTED.test("' --body \\\"x'"), 'the match finds a quoted body');
  assert.ok(!QUOTED.test("create \"T\" --body - <<'EOF'") && !QUOTED.test('--body-file body.md') && !QUOTED.test("['--body', '-F']"), 'and not the stdin or file form');
  const files = [path.join(REPO, 'CLAUDE.md')]
    .concat(filesIn(path.join(REPO, 'docs'), /\.(html|md)$/))
    .concat(filesIn(path.join(REPO, 'relay'), /\.js$/));
  const found = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (QUOTED.test(line)) found.push(path.relative(REPO, file) + ':' + (i + 1) + ': ' + line.trim().slice(0, 120));
    });
  }
  assert.deepStrictEqual(found, [], "Show --body - <<'EOF' or --body-file body.md, not a body in double quotes.");
});
