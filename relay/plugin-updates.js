// The weekly update check for the plugins pinned in plugins.json (the workflow in docs/plugin-updates.yml runs it).
// It looks in each pinned plugin's marketplace for a newer version and, with --write, moves that one pin.
//
//   node relay/plugin-updates.js                      prints the updates, a JSON list, and changes nothing
//   node relay/plugin-updates.js --write <name>       moves the pin of plugin <name> to the newest version
//   --market <name>=<folder>                          reads that marketplace from a folder instead of cloning its repo
//   --file <path>                                     reads and writes another plugins.json
//
// An update is { name, marketplace, from: { version, commit }, to: { version, commit } }, where to is newer than from. A marketplace
// entry's source is a folder of the marketplace (its commit is the marketplace's) or a git repo with a sha (its commit is that
// sha), as Claude Code reads them. Nothing here installs anything. The pull request that moves a pin is reviewed like code.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { compare } = require('./claude-version.js');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trim();
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const MANIFESTS = ['.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json'];
const PLUGIN_FILES = ['.claude-plugin/plugin.json', 'plugin.json'];

function entryOf(dir, name) {
  for (const m of MANIFESTS) {
    const list = (readJson(path.join(dir, m)) || {}).plugins;
    const entry = Array.isArray(list) && list.find((p) => p && p.name === name);
    if (entry) return entry;
  }
  return null;
}

function inFolder(dir, source) {
  const at = path.join(dir, source);
  let commit = '';
  try { commit = git(['rev-parse', 'HEAD'], dir); } catch (e) { commit = ''; }
  for (const f of PLUGIN_FILES) {
    const v = (readJson(path.join(at, f)) || {}).version;
    if (v) return { version: String(v), commit };
  }
  return null;
}

function inRepo(source) {
  const url = source.url || (source.repo ? 'https://github.com/' + source.repo + '.git' : null);
  if (!url) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-source-'));
  try {
    git(['init', '--quiet'], tmp);
    git(['fetch', '--quiet', '--depth', '1', url, source.sha || 'HEAD'], tmp);
    const commit = git(['rev-parse', 'FETCH_HEAD'], tmp);
    for (const f of PLUGIN_FILES) {
      let text;
      try { text = git(['show', 'FETCH_HEAD:' + f], tmp); } catch (e) { continue; }
      const v = (JSON.parse(text) || {}).version;
      if (v) return { version: String(v), commit };
    }
    return null;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function latest(dir, name) {
  const entry = entryOf(dir, name);
  if (!entry) return null;
  if (typeof entry.source === 'string') return inFolder(dir, entry.source);
  if (entry.source && typeof entry.source === 'object') {
    const found = inRepo(entry.source);
    return found && entry.version ? { version: String(entry.version), commit: found.commit } : found;
  }
  return null;
}

function check(list, folders) {
  const out = [], cloned = [];
  try {
    for (const p of list.plugins) {
      let dir = folders[p.marketplace];
      if (!dir) {
        const repo = list.marketplaces[p.marketplace];
        if (!repo) continue;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-market-'));
        cloned.push(dir);
        git(['clone', '--quiet', '--depth', '1', 'https://github.com/' + repo + '.git', dir]);
        folders[p.marketplace] = dir;
      }
      const now = latest(dir, p.name);
      if (now && compare(now.version, p.version) > 0) out.push({ name: p.name, marketplace: p.marketplace, from: { version: p.version, commit: p.commit }, to: now });
    }
  } finally { for (const d of cloned) fs.rmSync(d, { recursive: true, force: true }); }
  return out;
}

function write(file, update) {
  const list = readJson(file);
  const pin = list.plugins.find((p) => p.name === update.name);
  pin.version = update.to.version;
  if (update.to.commit) pin.commit = update.to.commit;
  fs.writeFileSync(file, JSON.stringify(list, null, 2).replace(/\{\n\s+"name": ("[^"]*"),\n\s+"marketplace": ("[^"]*"),\n\s+"version": ("[^"]*"),\n\s+"commit": ("[^"]*")\n\s+\}/g, '{ "name": $1, "marketplace": $2, "version": $3, "commit": $4 }') + '\n');
}

function main(argv) {
  const folders = {};
  let file = path.join(__dirname, '..', 'plugins.json'), only = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--market') { const [k, v] = String(argv[++i]).split('='); folders[k] = v; } else if (argv[i] === '--file') file = argv[++i];
    else if (argv[i] === '--write') only = argv[++i];
  }
  const found = check(readJson(file), folders).filter((u) => !only || u.name === only);
  if (only) for (const u of found) write(file, u);
  console.log(JSON.stringify(found, null, 2));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { check, write, latest };
