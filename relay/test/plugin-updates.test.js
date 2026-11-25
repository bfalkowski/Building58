// The weekly update check (relay/plugin-updates.js): given a marketplace with a newer version it moves one
// plugin's pin and nothing else, and given a marketplace at the pinned version it changes nothing.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');
const updates = require('../plugin-updates.js');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-updates-'));
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function commit(dir, message) { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); return git(dir, 'rev-parse', 'HEAD'); }

// A marketplace folder with one plugin in a folder of it and one in a repo of its own, each at a version.
function marketplace(inFolder, inRepo) {
  const repo = tmp(), market = tmp();
  git(repo, 'init', '-q');
  write(path.join(repo, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'outer', version: inRepo }));
  const sha = commit(repo, 'outer ' + inRepo);
  git(market, 'init', '-q');
  write(path.join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'm', plugins: [{ name: 'inner', source: './inner' }, { name: 'outer', source: { source: 'url', url: repo, sha } }] }));
  write(path.join(market, 'inner', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'inner', version: inFolder }));
  const head = commit(market, 'inner ' + inFolder);
  return { market, head, sha, dirs: [repo, market] };
}
function pins(dir) {
  const file = path.join(dir, 'plugins.json');
  write(file, JSON.stringify({ marketplaces: { m: 'o/m' }, plugins: [{ name: 'inner', marketplace: 'm', version: '1.0.0', commit: 'a'.repeat(40) }, { name: 'outer', marketplace: 'm', version: '2.0.0', commit: 'b'.repeat(40) }] }));
  return file;
}

test('a newer version in the marketplace moves that plugin\'s pin, and only that plugin', (t) => {
  const m = marketplace('1.1.0', '2.0.0'), dir = tmp();
  t.after(() => [dir, ...m.dirs].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const file = pins(dir), before = fs.readFileSync(file, 'utf8');
  const found = updates.check(JSON.parse(before), { m: m.market });
  assert.deepStrictEqual(found.map((u) => [u.name, u.from.version, u.to.version, u.to.commit]), [['inner', '1.0.0', '1.1.0', m.head]], 'the plugin in a repo is at its pinned version');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'checking changes nothing');
  updates.write(file, found[0]);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(after.plugins.map((p) => [p.name, p.version, p.commit]), [['inner', '1.1.0', m.head], ['outer', '2.0.0', 'b'.repeat(40)]]);
  assert.deepStrictEqual(updates.check(after, { m: m.market }), [], 'once moved, the pin is current');
});

test('a plugin kept in a repo of its own is read at the sha the marketplace names', (t) => {
  const m = marketplace('1.0.0', '2.3.0'), dir = tmp();
  t.after(() => [dir, ...m.dirs].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const found = updates.check(JSON.parse(fs.readFileSync(pins(dir), 'utf8')), { m: m.market });
  assert.deepStrictEqual(found.map((u) => [u.name, u.to.version, u.to.commit]), [['outer', '2.3.0', m.sha]]);
});

test('a marketplace at the pinned version, or older, gives nothing and writes nothing', (t) => {
  const m = marketplace('1.0.0', '1.9.0'), dir = tmp();
  t.after(() => [dir, ...m.dirs].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const file = pins(dir), before = fs.readFileSync(file, 'utf8');
  assert.deepStrictEqual(updates.check(JSON.parse(before), { m: m.market }), []);
  const out = execFileSync('node', [path.join(__dirname, '..', 'plugin-updates.js'), '--file', file, '--market', 'm=' + m.market, '--write', 'inner'], { encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(out), []);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('--write moves the one plugin it names', (t) => {
  const m = marketplace('1.2.0', '2.5.0'), dir = tmp();
  t.after(() => [dir, ...m.dirs].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const file = pins(dir);
  execFileSync('node', [path.join(__dirname, '..', 'plugin-updates.js'), '--file', file, '--market', 'm=' + m.market, '--write', 'outer'], { encoding: 'utf8' });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(after.plugins.map((p) => p.version), ['1.0.0', '2.5.0'], 'inner has a newer version too, and waits for its own pull request');
});
