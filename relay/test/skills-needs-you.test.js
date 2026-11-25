// Needs you says when the skills a role's settings name are not installed, with the commands that install
// them (docker compose exec in a container), and when a pinned plugin is installed at another version. The line
// goes away once the skills are installed as the list pins them (relay/skills.js lacking, relay/needs-you-plan.js).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, skillsHome } = require('./helpers.js');
const { listOf } = require('../needs-you-plan.js');

const line = async (R) => ((await R.call('GET', '/needs-you')).body.items.find((i) => i.kind === 'skills') || {}).line;

test('with a role\'s skill missing Needs you shows the line with the install commands, and with it installed the line is gone', async (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'office-no-claude-'));
  const full = skillsHome(fs.mkdtempSync(path.join(os.tmpdir(), 'office-full-claude-')));
  const R = await relay({ CLAUDE_CONFIG_DIR: empty, RELAY_IN_CONTAINER: '1', RELAY_NEEDS_SKILLS: '1' });
  t.after(async () => { await R.stop(); fs.rmSync(empty, { recursive: true, force: true }); fs.rmSync(path.dirname(full), { recursive: true, force: true }); });
  const missing = await line(R);
  assert.match(missing, /^Install the skills the briefs use\. Not installed, by role: Lead: pstack:recall; Devs: mattpocock-skills:tdd, /);
  assert.match(missing, /Reviewers: mattpocock-skills:code-review, pstack:blast-radius;/);
  assert.match(missing, /Run: docker compose exec room claude plugin /);
  for (const c of ['docker compose exec room claude plugin install mattpocock-skills@claude-plugins-official', 'docker compose exec room claude plugin marketplace add cursor/plugins', 'docker compose exec room claude plugin install pstack@cursor-plugins']) assert.ok(missing.includes(c), c);
  fs.cpSync(path.join(full, 'plugins'), path.join(empty, 'plugins'), { recursive: true });
  const installed = JSON.parse(fs.readFileSync(path.join(empty, 'plugins', 'installed_plugins.json'), 'utf8'));
  for (const list of Object.values(installed.plugins)) list[0].installPath = list[0].installPath.replace(full, empty);
  fs.writeFileSync(path.join(empty, 'plugins', 'installed_plugins.json'), JSON.stringify(installed));
  assert.strictEqual(await line(R), undefined, 'every skill is installed, so no line');
});

test('outside a container the commands are Claude Code\'s own, and a plugin at another version shows both versions', async (t) => {
  const dir = skillsHome(fs.mkdtempSync(path.join(os.tmpdir(), 'office-claude-')));
  const file = path.join(dir, 'plugins', 'installed_plugins.json');
  const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
  installed.plugins['pstack@cursor-plugins'][0].version = '0.15.28';
  installed.plugins['pstack@cursor-plugins'][0].gitCommitSha = 'd457567' + '0'.repeat(33);
  fs.writeFileSync(file, JSON.stringify(installed));
  const R = await relay({ CLAUDE_CONFIG_DIR: dir, RELAY_IN_CONTAINER: '0', RELAY_NEEDS_SKILLS: '1' });
  t.after(async () => { await R.stop(); fs.rmSync(path.dirname(dir), { recursive: true, force: true }); });
  assert.strictEqual(await line(R), 'Installed plugins differ from plugins.json: pstack@cursor-plugins is 0.15.28 (d457567) here and 0.15.48 (41e4009) in the list.');
});

test('the line names roles and commands, and only what is wrong', () => {
  assert.deepStrictEqual(listOf({ skills: null }), []);
  assert.deepStrictEqual(listOf({ skills: { roles: [], commands: [], differs: [] } }), []);
  const [item] = listOf({ skills: { roles: [{ role: 'reviewer', names: ['pstack:blast-radius'] }], commands: ['claude plugin install pstack@cursor-plugins'], differs: [] } });
  assert.deepStrictEqual([item.kind, item.line], ['skills', 'Install the skills the briefs use. Not installed, by role: Reviewers: pstack:blast-radius. Their briefs go out without them. Run: claude plugin install pstack@cursor-plugins.']);
});
