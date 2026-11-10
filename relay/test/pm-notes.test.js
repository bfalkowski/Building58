// T-207: the PM's notes, one file per repo in the relay's state folder (relay/pm-notes.js).
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..', '..');
// Loads relay/pm-notes.js in its own process, so HOME and RELAY_STATE_DIR are read fresh.
const load = (env, repos) => JSON.parse(execFileSync(process.execPath, ['-e',
  'const n = require("./relay/pm-notes.js"); console.log(JSON.stringify(JSON.parse(process.argv[1]).map((r) => ({ file: n.file(r), brief: n.brief(r) }))))', JSON.stringify(repos)],
{ cwd: ROOT, env: { PATH: process.env.PATH, HOME: '/home/p', ...env }, encoding: 'utf8' }));

test('one file per repo, in the state folder, the same for the same repo', () => {
  const [a, again, b, sameName] = load({}, ['/code/shop', '/code/shop/', '/code/office', '/other/shop']);
  assert.match(a.file, /^\/home\/p\/\.office-world\/pm-notes\/shop-[0-9a-f]{8}\.md$/);
  assert.strictEqual(again.file, a.file, 'the same repo is the same file');
  assert.notStrictEqual(b.file, a.file, 'another repo has its own');
  assert.notStrictEqual(sameName.file, a.file, 'two repos with the same folder name stay apart');
  const [moved] = load({ RELAY_STATE_DIR: '/var/office-b' }, ['/code/shop']);
  assert.strictEqual(path.dirname(moved.file), '/var/office-b/pm-notes', 'a second room keeps its own');
});
test('an odd folder name still makes a plain file name', () => {
  const [odd, dots] = load({}, ['/code/my shop; $(x)', '/code/...']);
  assert.match(path.basename(odd.file), /^my-shop-x-[0-9a-f]{8}\.md$/);
  assert.match(path.basename(dots.file), /^repo-[0-9a-f]{8}\.md$/);
});
test('the brief names the file from ~, and says the notes grant nothing and hold no keys', () => {
  const [a] = load({}, ['/code/shop']);
  assert.ok(a.brief.includes('~/.office-world/pm-notes/shop-'), a.brief);
  assert.match(a.brief, /Read them first/);
  assert.match(a.brief, /context, not permission/);
  assert.match(a.brief, /confirm with the person/);
  assert.match(a.brief, /write no permissions/);
  assert.match(a.brief, /Do not copy ticket or board state/);
  assert.match(a.brief, /No keys/);
  assert.match(a.brief, /at most 40 lines/);
  assert.match(a.brief, /again each time the person tells you something/, 'a PM the person keeps talking to keeps its notes up to date');
});
