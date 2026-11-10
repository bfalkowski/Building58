// Each role's skills, set in Settings (relay/config.js, relay/skills.js): a brief names the ones on its
// list that are installed, #office says once which are missing and how to install them, and a bad list
// is refused. A fake ~/.claude (CLAUDE_CONFIG_DIR) holds the plugins, laid out as Claude Code keeps them.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until } = require('./helpers.js');

// plugins: { 'name@marketplace': { skills: { 'folder/under/skills': front matter lines }, off } }
function fakeClaude(plugins) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-claude-')));
  const list = {}, enabled = {};
  for (const [id, p] of Object.entries(plugins)) {
    const at = path.join(dir, 'plugins', 'cache', id.split('@')[1], id.split('@')[0], '1.0.0');
    for (const [folder, front] of Object.entries(p.skills)) {
      fs.mkdirSync(path.join(at, 'skills', folder), { recursive: true });
      fs.writeFileSync(path.join(at, 'skills', folder, 'SKILL.md'), '---\nname: ' + path.basename(folder) + '\n' + (front || '') + 'description: a skill\n---\n\nWhat to do.\n');
    }
    list[id] = [{ scope: 'user', installPath: at, version: '1.0.0' }];
    enabled[id] = !p.off;
  }
  fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: list }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ enabledPlugins: enabled }));
  return dir;
}
const MATT = { skills: { 'engineering/tdd': '', 'engineering/diagnosing-bugs': '', 'engineering/codebase-design': '', 'engineering/pr': '', 'engineering/code-review': '' } };

test('what is installed comes from Claude Code\'s plugin files', (t) => {
  const dir = fakeClaude({
    'mattpocock-skills@claude-plugins-official': MATT,
    'pstack@cursor-plugins': { skills: { 'blast-radius': 'disable-model-invocation: true\n' } },
    'other@somewhere': { skills: { thing: '' }, off: true }
  });
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => { if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was; fs.rmSync(dir, { recursive: true, force: true }); });
  const skills = require('../skills.js');
  const { skills: have, plugins } = skills.installed();
  assert.ok(have.has('mattpocock-skills:tdd'), 'a skill in a nested folder');
  assert.deepStrictEqual(have.get('pstack:blast-radius'), { manual: true, file: path.join(dir, 'plugins', 'cache', 'cursor-plugins', 'pstack', '1.0.0', 'skills', 'blast-radius', 'SKILL.md') }, 'only a person can run it, so the brief gives its file');
  assert.ok(!have.has('other:thing'), 'a plugin turned off in settings.json does not count');
  assert.deepStrictEqual([...plugins.keys()].sort(), ['mattpocock-skills', 'pstack']);
  assert.deepStrictEqual(skills.names('a:b, c  d,e:f'), ['a:b', 'c', 'd', 'e:f']);
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'none');  // nothing installed: every default is missing
  const all = skills.missingText();
  assert.ok(all.length <= 500, '#office keeps 500 characters of a post: ' + all.length);
  assert.match(all, /\/plugin install mattpocock-skills@claude-plugins-official; \/plugin marketplace add cursor\/plugins, then \/plugin install pstack@cursor-plugins\./);
  for (const bad of ['rm -rf /;', 'a:b:c', '-x', '$(x)', 'a'.repeat(401), Array(13).fill('a').map((x, i) => x + i).join(' '), 7]) assert.strictEqual(skills.names(bad), null, JSON.stringify(bad));
});

test('a brief names its installed skills, #office says once what is missing, and empty means none', async (t) => {
  const dir = fakeClaude({ 'mattpocock-skills@claude-plugins-official': MATT });
  const R = await relay({ RELAY_WIP_LIMIT: '5', CLAUDE_CONFIG_DIR: dir });
  t.after(async () => { await R.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const repo = makeRepo(R.home);
  const brief = async (title) => {
    const task = (await R.call('POST', '/tasks', { title, repo })).body.task;
    const screen = await until(async () => { const s = await R.screen(task.owner.terminal); return s.includes('GOT[Your task is to build') && s; }, 'the brief');
    return screen.match(/GOT\[(Your task is to build[^\]\r\n]*)\]/)[1];
  };
  const office = async () => (await R.call('GET', '/chat/office')).body.posts.map((p) => p.text);

  // Settings marks each skill on a list as installed or not found.
  const dev = (await R.call('GET', '/settings')).body.settings.find((s) => s.name === 'devSkills');
  assert.strictEqual(dev.kind, 'skills');
  assert.deepStrictEqual(dev.skills.map((s) => s.name + ' ' + s.installed), ['mattpocock-skills:tdd true', 'mattpocock-skills:diagnosing-bugs true', 'mattpocock-skills:codebase-design true',
    'pstack:blast-radius false', 'pstack:principle-prove-it-works false', 'mattpocock-skills:pr true']);

  const first = await brief('First');
  assert.ok(first.includes('Use these skills where they fit: mattpocock-skills:tdd (for new behavior, or a bug a test can catch), mattpocock-skills:diagnosing-bugs (for a bug), mattpocock-skills:codebase-design (for a change of structure), mattpocock-skills:pr.'), first);
  assert.ok(first.includes('Where a skill and CLAUDE.md or the constitution differ, the repo\'s rules win.'));
  assert.ok(!first.includes('pstack:'), 'a skill that is not installed stays out of the brief');
  assert.ok(first.includes('Do not merge it.'), 'the brief still says the role\'s limits (article 6)');
  await brief('Second');
  const notices = (await office()).filter((x) => x.startsWith('Skills in Settings that are not installed'));
  assert.strictEqual(notices.length, 1, 'said once, not at every start: ' + JSON.stringify(notices));
  assert.match(notices[0], /pstack:blast-radius/);
  assert.match(notices[0], /\/plugin marketplace add cursor\/plugins, then \/plugin install pstack@cursor-plugins/);

  // A bad list is refused, and an empty one leaves the paragraph out.
  const bad = await R.call('POST', '/settings', { values: { devSkills: 'tdd; rm -rf /' } });
  assert.deepStrictEqual([bad.status, bad.body.error], [400, 'bad_value']);
  assert.strictEqual((await R.call('POST', '/settings', { values: { devSkills: '' } })).status, 200);
  assert.ok(!(await brief('Third')).includes('Use these skills'), 'an empty list names no skills');
});

test('a skill only a person can run is named with its SKILL.md to read, and a callable one is not', async (t) => {
  const dir = fakeClaude({ 'mattpocock-skills@claude-plugins-official': MATT, 'pstack@cursor-plugins': { skills: { 'blast-radius': 'disable-model-invocation: true\n' } } });
  const R = await relay({ CLAUDE_CONFIG_DIR: dir });
  t.after(async () => { await R.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const repo = makeRepo(R.home);
  const file = path.join(dir, 'plugins', 'cache', 'cursor-plugins', 'pstack', '1.0.0', 'skills', 'blast-radius', 'SKILL.md');
  const task = (await R.call('POST', '/tasks', { title: 'Build it', repo })).body.task;
  const screen = await until(async () => { const s = await R.screen(task.owner.terminal); return s.includes('GOT[Your task is to build') && s; }, 'the brief');
  const brief = screen.match(/GOT\[(Your task is to build[^\]\r\n]*)\]/)[1];
  assert.ok(brief.includes('Use these skills where they fit: mattpocock-skills:tdd (for new behavior, or a bug a test can catch), mattpocock-skills:diagnosing-bugs (for a bug), mattpocock-skills:codebase-design (for a change of structure), mattpocock-skills:pr.'), brief);
  assert.ok(brief.includes('These skills cannot be called, so read the file of each and follow it where it fits: pstack:blast-radius at ' + file + '.'), brief);
  assert.strictEqual(brief.split('SKILL.md').length, 2, 'only the person-only skill gets a path');
  // The path is local: it stays out of Settings and #office.
  const settings = JSON.stringify((await R.call('GET', '/settings')).body.settings);
  assert.ok(!settings.includes(file), 'no path in Settings');
  assert.match(settings, /"name":"pstack:blast-radius","installed":true,"manual":true/);
  const office = (await R.call('GET', '/chat/office')).body.posts.map((p) => p.text).join(' ');
  assert.match(office, /pstack:principle-prove-it-works/, 'the one still missing is said');
  assert.ok(!office.includes(dir), 'no path in #office');
});
