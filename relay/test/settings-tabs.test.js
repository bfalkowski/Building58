// Every setting has a tab, and the Settings window has the tabs relay/config.js names, each with a panel
// and a place for its settings (office/index.html, office/settings-tabs.js).
'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const config = require('../config.js');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'office', 'index.html'), 'utf8');
const ids = (re) => [...html.matchAll(re)].map((m) => m[1]);

test('every entry in config.js has a tab that exists', () => {
  const known = new Set(config.TABS.map((t) => t.id));
  for (const s of config.SETTINGS) assert.ok(known.has(s.tab), s.name + ' has no tab, or one that is not in TABS: ' + s.tab);
  for (const t of config.TABS) assert.ok(config.SETTINGS.some((s) => s.tab === t.id) || t.id === 'trust', 'the tab ' + t.id + ' holds no setting');
});

test('the window has one tab button, one panel and one place for settings for each tab, in order', () => {
  const order = config.TABS.map((t) => t.id);
  assert.deepStrictEqual(ids(/<button type="button" role="tab" id="set-tab-([a-z]+)"/g), order);
  assert.deepStrictEqual(ids(/<option value="([a-z]+)">/g).filter((id) => order.includes(id)), order);
  assert.deepStrictEqual(ids(/<div class="set-panel" role="tabpanel" id="set-panel-([a-z]+)"/g), order);
  for (const id of order) assert.ok(html.includes('<div id="set-cfg-' + id + '"></div>'), 'no place for the settings of ' + id);
  for (const t of config.TABS) assert.ok(html.includes('<span class="set-tab-name">' + t.label + '</span>'), 'the tab label ' + t.label);
});

test('the relay tells the page each setting\'s tab', () => {
  for (const s of config.list()) assert.ok(config.TABS.some((t) => t.id === s.tab), s.name);
});

test('the manual lists each setting under its tab, in the order of the tabs', () => {
  const manual = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'manual', 'settings.html'), 'utf8');
  const heads = [...manual.matchAll(/<h3 id="tab-([a-z]+)">/g)];
  assert.deepStrictEqual(heads.map((m) => m[1]), config.TABS.map((t) => t.id));
  heads.forEach((m, i) => {
    const part = manual.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : manual.indexOf('<h2 id="relay">'));
    for (const s of config.SETTINGS.filter((x) => x.tab === m[1] && !/Model$|Skills$/.test(x.name))) assert.ok(part.includes('<span class="ui">' + s.label + '</span>'), s.label + ' is not under ' + m[1] + ' in the manual');
  });
});
