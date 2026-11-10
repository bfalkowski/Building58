// The relay and the room stand apart from the worlds (CLAUDE.md, docs/constitution.md article 13).
// A world is a folder with a world.json (relay/server.js, worlds()). No code in relay/, office/ or
// shared/ names another world, and the relay's startup lines come from the world.json files alone.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relay } = require('./helpers.js');

const REPO = path.join(__dirname, '..', '..');
const isWorld = (dir) => fs.existsSync(path.join(REPO, dir, 'world.json'));
// Every world but the room, which is the relay's own page. A world from its own repo is linked in
// as a folder link, so follow links too.
const isDir = (d) => d.isDirectory() || (d.isSymbolicLink() && fs.statSync(path.join(REPO, d.name), { throwIfNoEntry: false })?.isDirectory());
const others = fs.readdirSync(REPO, { withFileTypes: true }).filter((d) => isDir(d) && d.name !== 'office' && isWorld(d.name)).map((d) => d.name);
const namesIn = (worlds, text) => worlds.filter((w) => new RegExp('\\b' + w + '\\b', 'i').test(text));
const names = (text) => namesIn(others, text);
function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' || d.name.startsWith('.') || p === path.join(REPO, 'relay', 'test') ? [] : filesIn(p);
    return /\.(js|sh|py|html|css|md|json)$/.test(d.name) && d.name !== 'world.json' ? [p] : [];
  });
}

test('no code in relay/, office/ or shared/ names another world', () => {
  assert.deepStrictEqual(namesIn(['garden'], 'Same as The Garden does'), ['garden'], 'the match finds a world name in any case');
  const found = [];
  for (const top of ['relay', 'office', 'shared']) {
    for (const file of filesIn(path.join(REPO, top))) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const hit = names(line);
        if (hit.length) found.push(path.relative(REPO, file) + ':' + (i + 1) + ' names ' + hit.join(', ') + ': ' + line.trim().slice(0, 120));
      });
    }
  }
  assert.deepStrictEqual(found, [], 'Move world code into the world\'s own folder, and describe the contract instead of a world.');
});

test('the relay lists the worlds it finds, from their world.json, at startup', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worlds-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'garden'));
  fs.writeFileSync(path.join(root, 'garden', 'world.json'), JSON.stringify({ name: 'the garden', channel: 'yard' }));
  fs.writeFileSync(path.join(root, 'garden', 'index.html'), '<p>garden</p>');
  fs.mkdirSync(path.join(root, 'notes'));  // a folder with no world.json is not a world
  fs.mkdirSync(path.join(root, 'broken'));
  fs.writeFileSync(path.join(root, 'broken', 'world.json'), '{ not json');
  const R = await relay({ RELAY_ROOT: root });
  t.after(R.stop);
  const lines = R.output().split('\n').filter((l) => l.startsWith('Open '));
  assert.deepStrictEqual(lines, ['Open the garden: http://localhost:' + R.port + '/garden/?channel=yard&key=test-key']);
  const page = await fetch('http://127.0.0.1:' + R.port + '/garden/');
  assert.strictEqual(await page.text(), '<p>garden</p>', 'and serves its folder');
});
