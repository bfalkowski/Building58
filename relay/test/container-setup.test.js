// The Claude Code settings the container writes before the relay starts (relay/container-setup.js):
// the first run is marked done, so no text style question blocks a session, and the API key from .env
// is approved, so no question about it blocks one either. What the person set is kept.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { claudeConfig, repoList, skills } = require('../container-setup.js');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'container-setup-'));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('a new Claude Code folder gets its first run marked done and a text style', () => {
  const d = dir();
  const config = read(claudeConfig({ CLAUDE_CONFIG_DIR: d }));
  assert.strictEqual(config.hasCompletedOnboarding, true);
  assert.strictEqual(config.theme, 'dark');
  assert.strictEqual(config.customApiKeyResponses, undefined, 'no key, so nothing to approve');
  fs.rmSync(d, { recursive: true });
});

test('what the person set is kept, and the key from .env is approved once', () => {
  const d = dir();
  const key = 'sk-ant-api03-' + 'x'.repeat(30) + 'ENDOFTHEKEY1234567890';
  const tail = key.slice(-20);
  fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ theme: 'light', projects: { '/a': {} }, customApiKeyResponses: { approved: ['other'], rejected: [tail] } }));
  claudeConfig({ CLAUDE_CONFIG_DIR: d, ANTHROPIC_API_KEY: key });
  const config = read(claudeConfig({ CLAUDE_CONFIG_DIR: d, ANTHROPIC_API_KEY: key }));
  assert.strictEqual(config.theme, 'light');
  assert.deepStrictEqual(config.projects, { '/a': {} });
  assert.deepStrictEqual(config.customApiKeyResponses, { approved: ['other', tail], rejected: [] });
  assert.ok(!JSON.stringify(config).includes(key), 'only the last 20 characters, as Claude Code keeps them');
  fs.rmSync(d, { recursive: true });
});

test('a file that is not JSON is set aside and kept, not a reason to stop', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, '.claude.json'), '{ not json');
  assert.strictEqual(read(claudeConfig({ CLAUDE_CONFIG_DIR: d })).hasCompletedOnboarding, true);
  const kept = fs.readdirSync(d).filter((f) => f.startsWith('.claude.json.unreadable-'));
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(d, kept[0]), 'utf8'), '{ not json');
  fs.rmSync(d, { recursive: true });
});

test('ROOM_REPOS is a list of owner/name, by spaces or commas, and anything else is left out', () => {
  const { ok, bad } = repoList('acme/app, acme/api.git\n  other/tool acme/app2 ../etc acme/.. -x/y" other/app');
  assert.deepStrictEqual(ok.map((r) => r.full), ['acme/app', 'acme/api', 'other/tool', 'acme/app2']);
  assert.deepStrictEqual(bad, ['../etc', 'acme/..', '-x/y"', 'other/app (a repo with that name is listed already)']);
  assert.deepStrictEqual(repoList(''), { ok: [], bad: [] });
});

test('the folders the room works in are trusted, so a new checkout under one asks no trust question', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ projects: { '/home/node/repos/app': { allowedTools: ['Bash'] }, '/elsewhere': { hasTrustDialogAccepted: false } } }));
  const config = read(claudeConfig({ CLAUDE_CONFIG_DIR: d }, ['/home/node/building58', '/home/node/repos/app']));
  assert.deepStrictEqual(config.projects['/home/node/repos/app'], { allowedTools: ['Bash'], hasTrustDialogAccepted: true }, 'what was there is kept');
  assert.strictEqual(config.projects['/home/node/building58'].hasTrustDialogAccepted, true);
  assert.strictEqual(config.projects['/elsewhere'].hasTrustDialogAccepted, false, 'a folder not listed is left as it is');
  assert.strictEqual(read(claudeConfig({ CLAUDE_CONFIG_DIR: dir() })).projects, undefined, 'none listed, none added');
  fs.rmSync(d, { recursive: true });
});

// ROOM_PLUGINS: each plugin not installed is installed once into the claude volume, and the Skills line says so.
function fakeRun(dir, log, options) {
  const o = options || {};
  const pins = require('../plugins.js').list().plugins;
  return (cmd, args) => {
    log.push(args.join(' '));
    if (cmd !== 'claude') throw new Error('only claude');
    if (args[1] === 'marketplace') {
      const known = path.join(dir, 'plugins', 'known_marketplaces.json');
      fs.mkdirSync(path.dirname(known), { recursive: true });
      const now = fs.existsSync(known) ? read(known) : {};
      const markets = require('../plugins.js').list().marketplaces;
      now[Object.keys(markets).find((k) => markets[k] === args[3])] = {};
      fs.writeFileSync(known, JSON.stringify(now));
      return '';
    }
    const id = args[2];
    if (o.fail === id) { const e = new Error('Command failed'); e.stderr = 'network down\n'; throw e; }
    const pin = pins.find((p) => p.name + '@' + p.marketplace === id);
    const file = path.join(dir, 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const all = fs.existsSync(file) ? read(file) : { version: 2, plugins: {} };
    all.plugins[id] = [{ installPath: path.join(dir, 'x'), version: o.version || pin.version, gitCommitSha: o.version ? 'c'.repeat(40) : pin.commit }];
    fs.writeFileSync(file, JSON.stringify(all));
    return '';
  };
}

test('ROOM_PLUGINS installs each listed plugin once, skips the ones installed, and prints the Skills line', () => {
  const d = dir(), log = [], env = { CLAUDE_CONFIG_DIR: d, ROOM_PLUGINS: 'mattpocock-skills@claude-plugins-official, pstack@cursor-plugins' };
  const first = skills(env, fakeRun(d, log));
  assert.deepStrictEqual(first, ['Skills: installed mattpocock-skills@claude-plugins-official, pstack@cursor-plugins.']);
  assert.deepStrictEqual(log, ['plugin install mattpocock-skills@claude-plugins-official', 'plugin marketplace add cursor/plugins', 'plugin install pstack@cursor-plugins'], 'the built-in marketplace needs no add');
  log.length = 0;
  assert.deepStrictEqual(skills(env, fakeRun(d, log)), ['Skills: already there mattpocock-skills@claude-plugins-official, pstack@cursor-plugins.']);
  assert.deepStrictEqual(log, [], 'a second start installs nothing');
  fs.rmSync(d, { recursive: true });
});

test('a failed install is named and does not stop the others or the start', () => {
  const d = dir(), log = [], env = { CLAUDE_CONFIG_DIR: d, ROOM_PLUGINS: 'pstack@cursor-plugins mattpocock-skills@claude-plugins-official' };
  const out = skills(env, fakeRun(d, log, { fail: 'pstack@cursor-plugins' }));
  assert.deepStrictEqual(out, ['Skills: installed mattpocock-skills@claude-plugins-official. failed pstack@cursor-plugins (network down), so the next start tries again.']);
  fs.rmSync(d, { recursive: true });
});

test('an installed version other than the list\'s is said, with both', () => {
  const d = dir(), env = { CLAUDE_CONFIG_DIR: d, ROOM_PLUGINS: 'pstack@cursor-plugins' };
  const [line] = skills(env, fakeRun(d, [], { version: '9.9.9' }));
  assert.match(line, /^Skills: installed pstack@cursor-plugins\. at another version than plugins\.json: pstack@cursor-plugins is 9\.9\.9 \(ccccccc\), the list says 0\.\d+\.\d+ \(41e4009\)\.$/);
  fs.rmSync(d, { recursive: true });
});

test('no ROOM_PLUGINS, or none, installs nothing and says so; a bad item is left out', () => {
  const d = dir(), log = [];
  assert.match(skills({ CLAUDE_CONFIG_DIR: d }, fakeRun(d, log))[0], /^Skills: none in ROOM_PLUGINS/);
  assert.match(skills({ CLAUDE_CONFIG_DIR: d, ROOM_PLUGINS: 'none' }, fakeRun(d, log))[0], /^Skills: none in ROOM_PLUGINS/);
  const out = skills({ CLAUDE_CONFIG_DIR: d, ROOM_PLUGINS: 'a;b nope@x' }, fakeRun(d, log));
  assert.match(out[0], /^Skills: a;b is not plugin@marketplace or owner\/repo, so it is left out\./);
  assert.match(out[1], /failed nope@x \(no marketplace x in plugins\.json/);
  assert.deepStrictEqual(log, []);
  fs.rmSync(d, { recursive: true });
});
