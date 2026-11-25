// The one list of Claude Code plugins the room's briefs use: plugins.json at the top of the repo. It holds
// each marketplace's GitHub repo and each plugin's marketplace, version and git commit. The same plugins are
// in .claude/settings.json (so Claude Code offers them when someone trusts the folder) and in ROOM_PLUGINS in
// .env.example (so a container installs them), and relay/test/plugins-agree.test.js fails when they differ.
// Moving to a newer version is a pull request that changes plugins.json (relay/plugin-updates.js makes it).
//
//   list() -> { marketplaces: { name: 'owner/repo' }, plugins: [{ name, marketplace, version, commit }] }
//   ids(text) -> the name@marketplace items and owner/repo items in a ROOM_PLUGINS value, split by spaces or commas
//   installedIn(dir) -> Map of name@marketplace -> { version, commit } from Claude Code's installed_plugins.json
//   differs(have) -> the pinned plugins installed at another version or commit: [{ id, want, have }]
//   commands(names, known, inContainer) -> the commands that install the plugins named, in Claude Code's own CLI
//
// A commit matches when one is the start of the other, so a short commit is enough to compare.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(__dirname, '..', 'plugins.json');
const ID = /^[A-Za-z0-9][\w.-]{0,63}@[A-Za-z0-9][\w.-]{0,63}$/;
const SOURCE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
const BUILT_IN = 'claude-plugins-official';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const list = () => readJson(FILE) || { marketplaces: {}, plugins: [] };
const idOf = (p) => p.name + '@' + p.marketplace;
const claudeDir = (env) => (env || process.env).CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function ids(text) {
  const out = { plugins: [], sources: [], bad: [] };
  for (const item of String(text || '').split(/[\s,]+/).filter((x) => x && x !== 'none')) {
    if (ID.test(item)) { if (!out.plugins.includes(item)) out.plugins.push(item); } else if (SOURCE.test(item)) out.sources.push(item);
    else out.bad.push(item.slice(0, 80));
  }
  return out;
}

function installedIn(dir) {
  const all = (readJson(path.join(dir, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
  const out = new Map();
  for (const [id, raw] of Object.entries(all)) {
    const at = [].concat(raw).find((x) => x && typeof x.installPath === 'string');
    if (at) out.set(id, { version: String(at.version || ''), commit: String(at.gitCommitSha || '') });
  }
  return out;
}

const sameCommit = (a, b) => !!a && !!b && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));
const short = (c) => String(c || '').slice(0, 7);
const label = (v) => (v.version || 'unknown version') + (v.commit ? ' (' + short(v.commit) + ')' : '');

function differs(have) {
  const out = [];
  for (const p of list().plugins) {
    const got = have.get(idOf(p));
    if (!got) continue;
    if ((p.version && got.version && got.version !== p.version) || (p.commit && got.commit && !sameCommit(p.commit, got.commit))) {
      out.push({ id: idOf(p), want: { version: p.version, commit: p.commit }, have: got });
    }
  }
  return out;
}

function commands(names, knownMarkets, inContainer) {
  const l = list(), marks = new Set(knownMarkets || []);
  const prefix = inContainer ? 'docker compose exec room ' : '';
  const out = [];
  for (const id of names) {
    const market = id.split('@')[1], repo = l.marketplaces[market];
    if (repo && market !== BUILT_IN && !marks.has(market)) { out.push(prefix + 'claude plugin marketplace add ' + repo); marks.add(market); }
    out.push(prefix + 'claude plugin install ' + id);
  }
  return out;
}

const knownMarkets = (dir) => Object.keys(readJson(path.join(dir, 'plugins', 'known_marketplaces.json')) || {});

module.exports = { list, ids, idOf, installedIn, differs, commands, knownMarkets, claudeDir, sameCommit, label, short, readJson, ID, SOURCE, BUILT_IN };
