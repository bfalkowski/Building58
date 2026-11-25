// One list of plugins: plugins.json, .claude/settings.json (Claude Code offers them in a trusted folder), the
// ROOM_PLUGINS default in .env.example (a container installs them) and the skills relay/config.js names for each
// role must agree, so a machine gets what the briefs use. The weekly update check runs from the workflow in docs.
'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const plugins = require('../plugins.js');
const config = require('../config.js');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const list = plugins.list();
const listed = list.plugins.map(plugins.idOf).sort();

test('.claude/settings.json offers the listed plugins from the listed marketplaces', () => {
  const settings = JSON.parse(read('.claude/settings.json'));
  assert.deepStrictEqual(Object.keys(settings.enabledPlugins).sort(), listed);
  assert.ok(Object.values(settings.enabledPlugins).every((v) => v === true));
  const markets = Object.fromEntries(Object.entries(settings.extraKnownMarketplaces).map(([k, v]) => [k, v.source.repo]));
  assert.deepStrictEqual(markets, list.marketplaces);
});

test('the ROOM_PLUGINS default in .env.example is the list', () => {
  const line = read('.env.example').split('\n').find((l) => l.startsWith('ROOM_PLUGINS='));
  assert.deepStrictEqual(plugins.ids(line.slice('ROOM_PLUGINS='.length)).plugins.sort(), listed);
});

test('every plugin in the list is pinned to a version and a commit, in a marketplace the list names', () => {
  for (const p of list.plugins) {
    assert.match(p.version, /^\d+\.\d+\.\d+$/, p.name);
    assert.match(p.commit, /^[0-9a-f]{40}$/, p.name);
    assert.ok(list.marketplaces[p.marketplace], p.name + ' needs its marketplace in the list');
  }
});

test('each skill relay/config.js names for a role is in a plugin of the list, and each plugin is used', () => {
  const names = new Set(list.plugins.map((p) => p.name));
  const used = new Set();
  for (const s of config.SETTINGS.filter((x) => x.kind === 'skills')) {
    for (const n of String(s.def).split(/[\s,]+/).filter(Boolean)) {
      const plugin = n.split(':')[0];
      assert.ok(names.has(plugin), s.name + ' names ' + n + ', whose plugin is not in plugins.json');
      used.add(plugin);
    }
  }
  assert.deepStrictEqual([...used].sort(), [...names].sort(), 'a plugin in the list that no role uses');
});

test('a plugin installed at another version or commit than the list shows both', () => {
  const p = list.plugins[0], id = plugins.idOf(p);
  assert.deepStrictEqual(plugins.differs(new Map([[id, { version: p.version, commit: p.commit }]])), []);
  assert.deepStrictEqual(plugins.differs(new Map([[id, { version: p.version, commit: p.commit.slice(0, 9) }]])), [], 'a short commit is the same commit');
  const other = plugins.differs(new Map([[id, { version: '0.0.1', commit: 'a'.repeat(40) }]]));
  assert.strictEqual(other.length, 1);
  assert.deepStrictEqual([other[0].want.version, other[0].have.version], [p.version, '0.0.1']);
  assert.deepStrictEqual(plugins.differs(new Map()), [], 'a plugin not installed is the missing-skills line, not this one');
});

test('the weekly workflow runs the update check and opens or updates one pull request for each plugin', () => {
  const text = read('docs/plugin-updates.yml');
  assert.match(text, /schedule:\s+- cron: '[^']+ \* \* 1'/, 'weekly');
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /node relay\/plugin-updates\.js > updates\.json/);
  assert.match(text, /node relay\/plugin-updates\.js --write "\$name"/);
  assert.match(text, /plugin-updates\/\$name/, 'one branch for each plugin');
  assert.match(text, /gh pr edit "\$branch"[\s\S]*gh pr create/, 'an open pull request is updated, not opened twice');
  assert.match(text, /Move \$name to \$to \(pinned \$from\)/);
  const live = path.join(root, '.github', 'workflows', 'plugin-updates.yml');
  if (fs.existsSync(live)) assert.strictEqual(fs.readFileSync(live, 'utf8'), text, 'the workflow in .github is the copy in docs');
});
