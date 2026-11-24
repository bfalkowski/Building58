// The room page sends no key. The relay's cookie carries it (docs/manual/running.html#relay-key), so
// the page scripts in office/ and shared/ neither read key from the address nor send key=.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const scripts = ['office', 'shared'].flatMap((d) => fs.readdirSync(path.join(REPO, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)));

test('no page script reads key from the address or sends key=', () => {
  assert.ok(scripts.length > 20 && scripts.includes(path.join('shared', 'relay.js')), 'the check finds the page scripts');
  const found = scripts.filter((f) => /\bkey=|get\(['"]key['"]\)|searchParams/.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
  assert.deepStrictEqual(found, [], 'these scripts still use key= or read key from the address');
});
