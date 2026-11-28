// What each role's brief says about its Settings skills (relay/skills.js STEPS): each listed skill at its
// step, a skill with no step where it fits, one that is off the list not at all, and each brief under its
// size. It runs in this process, so the settings file is a throwaway one.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'office-steps-'));
process.env.RELAY_SETTINGS_FILE = path.join(scratch, 'settings.json');
process.env.RELAY_STATE_DIR = scratch;

function fakeClaude(plugins) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-claude-'));
  const list = {}, enabled = {};
  for (const [id, names] of Object.entries(plugins)) {
    const at = path.join(dir, 'plugins', 'cache', id.split('@')[1], id.split('@')[0], '1.0.0');
    for (const n of names) {
      fs.mkdirSync(path.join(at, 'skills', n), { recursive: true });
      fs.writeFileSync(path.join(at, 'skills', n, 'SKILL.md'), '---\nname: ' + n + '\ndescription: a skill\n---\n');
    }
    list[id] = [{ scope: 'user', installPath: at, version: '1.0.0' }];
    enabled[id] = true;
  }
  fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: list }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ enabledPlugins: enabled }));
  return dir;
}

test('with the default lists each role\'s brief names each skill at its step, a skill taken off the list is not named, and each brief stays under its size', (t) => {
  const dir = fakeClaude({ 'mattpocock-skills@claude-plugins-official': ['tdd', 'diagnosing-bugs', 'codebase-design', 'pr', 'code-review', 'writing-for-agents'], 'pstack@cursor-plugins': ['blast-radius', 'principle-prove-it-works', 'sharpen', 'recall', 'principle-explain-the-number'] });
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => { if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was; fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(scratch, { recursive: true, force: true }); });
  const skills = require('../skills.js'), config = require('../config.js');
  const of = (role) => skills.brief(role);
  assert.ok(of('dev').includes('Before you write code, run mattpocock-skills:tdd (for a code change). When a test fails and the cause is not clear, run mattpocock-skills:diagnosing-bugs. Before you open the PR, run pstack:blast-radius, then mattpocock-skills:pr for the PR body.'), of('dev'));
  assert.ok(of('dev').includes('Use these skills where they fit: mattpocock-skills:codebase-design (for a change of structure), pstack:principle-prove-it-works.'), 'a skill with no step keeps where it fits');
  assert.ok(of('dev').includes('End the PR body with one line, "Skills run: "'));
  assert.ok(of('reviewer').includes('Start by running mattpocock-skills:code-review, then pstack:blast-radius on the diff.'), of('reviewer'));
  assert.ok(of('reviewer').includes('End each review comment with one line, "Skills run: "'));
  assert.ok(of('pm').includes('When you check a ticket, run pstack:sharpen on it.'), of('pm'));
  assert.ok(of('pm').includes('Use these skills where they fit: mattpocock-skills:writing-for-agents.'));
  assert.ok(of('lead').includes('At the start of each look, run pstack:recall.'), of('lead'));
  assert.ok(of('coo').includes('Use these skills where they fit: pstack:principle-explain-the-number.'));
  const limits = { dev: 800, reviewer: 500, pm: 400, lead: 300, coo: 300, security: 300 };
  for (const role of skills.ROLES) assert.ok(Buffer.byteLength(of(role)) <= limits[role], role + ' brief is ' + Buffer.byteLength(of(role)) + ' bytes, over ' + limits[role]);

  const base = config.get('devSkills');
  config.set({ values: { devSkills: base.replace('mattpocock-skills:tdd, ', '').replace(', pstack:blast-radius', '') } });
  assert.ok(!of('dev').includes('tdd') && !of('dev').includes('blast-radius'), 'a skill taken off the list is not named');
  assert.ok(of('dev').includes('When a test fails and the cause is not clear, run mattpocock-skills:diagnosing-bugs. Before you open the PR, run mattpocock-skills:pr for the PR body.'), of('dev'));
  config.set({ values: { reviewerSkills: 'pstack:recall' } });
  assert.ok(!of('reviewer').includes('code-review'), 'the reviewer list decides, not the dev list');
});
