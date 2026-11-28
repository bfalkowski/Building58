// The model and the skills each role runs with, set in Settings (relay/config.js, the Models and
// skills group). A role is 'lead', 'dev', 'reviewer', 'pm', 'coo' or 'security'.
//
// A model setting is a Claude Code model name or alias, such as opus or claude-sonnet-4-5. Empty means
// no --model flag, so the session runs on the person's own default. relay/terminal.js adds it only when
// it starts a new session for that role, never on --resume.
//
// A skills setting lists skills by their plugin name, such as mattpocock-skills:tdd. Each role's brief
// gets one paragraph that names the skills on its list that are installed on this computer, each at the
// step it belongs to (STEPS), the rest where they fit, and none
// if there are none (article 6 of docs/constitution.md). A skill on a list that is not installed is
// left out of every brief, and #office says once which ones are missing and how to install them.
//
// What is installed comes from Claude Code's own files, read and never written:
//   ~/.claude/plugins/installed_plugins.json   each plugin (name@marketplace) and the folder it is in
//   ~/.claude/settings.json, enabledPlugins     a plugin set to false there is turned off
// A plugin's skills are the folders under its skills/ folder (up to three deep) that hold a SKILL.md.
// CLAUDE_CONFIG_DIR moves ~/.claude, as it does for Claude Code. The list is kept until one of those two
// files changes, so a brief costs two stats.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROLES = ['lead', 'dev', 'reviewer', 'pm', 'coo', 'security'];
const MODEL = /^[A-Za-z0-9][A-Za-z0-9.[\]-]{0,63}$/;
const SKILL = /^[A-Za-z0-9][\w.-]{0,63}(:[A-Za-z0-9][\w.-]{0,63})?$/;
const MAX_SKILLS = 12, MAX_SKILLS_TEXT = 400;
const FOR = { tdd: 'new behavior, or a bug a test can catch', 'diagnosing-bugs': 'a bug', 'codebase-design': 'a change of structure' };
const STEPS = {
  dev: [
    { skill: 'tdd', when: 'Before you write code, run', note: ' (for a code change)' },
    { skill: 'diagnosing-bugs', when: 'When a test fails and the cause is not clear, run' },
    { skill: 'blast-radius', when: 'Before you open the PR, run' },
    { skill: 'pr', when: 'Before you open the PR, run', note: ' for the PR body' }
  ],
  reviewer: [
    { skill: 'code-review', when: 'Start by running' },
    { skill: 'blast-radius', when: 'Start by running', note: ' on the diff' }
  ],
  pm: [{ skill: 'sharpen', when: 'When you check a ticket, run', note: ' on it' }],
  lead: [{ skill: 'recall', when: 'At the start of each look, run' }]
};
const LINE = { dev: 'the PR body', reviewer: 'each review comment' };

const modelOk = (v) => typeof v === 'string' && (v === '' || MODEL.test(v));
function names(v) {
  if (typeof v !== 'string' || v.length > MAX_SKILLS_TEXT) return null;
  const out = v.split(/[\s,]+/).filter(Boolean);
  if (out.length > MAX_SKILLS || !out.every((n) => SKILL.test(n))) return null;
  return [...new Set(out)];
}
const skillsOk = (v) => names(v) !== null;

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } };

function skillDirs(dir, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) return [dir];
  if (!depth) return [];
  return entries.filter((e) => e.isDirectory()).flatMap((e) => skillDirs(path.join(dir, e.name), depth - 1));
}
function skillOf(dir) {
  let head = '';
  try { head = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').slice(0, 4000); } catch (e) { /* a folder with no readable SKILL.md */ }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  const field = (k) => { const m = front && new RegExp('^' + k + ':\\s*(.+)$', 'm').exec(front[1]); return m ? m[1].trim().replace(/^["']|["']$/g, '') : null; };
  return { name: field('name') || path.basename(dir), manual: field('disable-model-invocation') === 'true', file: path.resolve(dir, 'SKILL.md') };
}

let cache = { key: null, skills: new Map(), plugins: new Map() };
function installed() {
  const dir = claudeDir(), list = path.join(dir, 'plugins', 'installed_plugins.json'), settings = path.join(dir, 'settings.json');
  const key = dir + ' ' + mtime(list) + ' ' + mtime(settings);
  if (cache.key === key) return cache;
  const skills = new Map(), plugins = new Map();
  const all = (readJson(list) || {}).plugins || {};
  const enabled = (readJson(settings) || {}).enabledPlugins || {};
  for (const [id, raw] of Object.entries(all)) {
    if (enabled[id] === false) continue;
    const plugin = id.split('@')[0];
    for (const at of [].concat(raw)) {
      if (!at || typeof at.installPath !== 'string') continue;
      plugins.set(plugin, id);
      for (const d of skillDirs(path.join(at.installPath, 'skills'), 3)) {
        const s = skillOf(d);
        skills.set(plugin + ':' + s.name, { manual: s.manual, file: s.file });
      }
    }
  }
  cache = { key, skills, plugins };
  return cache;
}

const about = (v) => ({ skills: (names(v) || []).map((n) => { const s = installed().skills.get(n); return { name: n, installed: !!s, manual: !!(s && s.manual) }; }) });

function brief(role) {
  const config = require('./config.js');
  const have = installed().skills;
  const list = (names(config.get(role + 'Skills')) || []).filter((n) => have.has(n));
  if (!list.length) return '';
  const short = (n) => n.split(':').pop();
  const label = (n) => (have.get(n).manual ? n + ' (it cannot be called, so read ' + have.get(n).file + ' and follow it)' : n);
  const steps = (STEPS[role] || []).map((st) => ({ st, name: list.find((n) => short(n) === st.skill) })).filter((x) => x.name);
  const stepped = new Set(steps.map((x) => x.name));
  const groups = [];
  for (const { st, name } of steps) {
    const g = groups.find((x) => x.when === st.when) || groups[groups.push({ when: st.when, items: [] }) - 1];
    g.items.push(label(name) + (st.note || ''));
  }
  const fits = list.filter((n) => !stepped.has(n));
  const word = (n) => { const why = role === 'dev' && FOR[short(n)]; return why ? n + ' (for ' + why + ')' : n; };
  const called = fits.filter((n) => !have.get(n).manual).map(word);
  const read = fits.filter((n) => have.get(n).manual).map((n) => word(n) + ' at ' + have.get(n).file);
  return (groups.length ? ' ' + groups.map((g) => g.when + ' ' + g.items.join(', then ') + '.').join(' ') : '') +
    (called.length ? ' Use these skills where they fit: ' + called.join(', ') + '.' : '') +
    (read.length ? ' These skills cannot be called, so read the file of each and follow it where it fits: ' + read.join('; ') + '.' : '') +
    (LINE[role] ? ' Put a line in ' + LINE[role] + ' that starts "Skills run: " and lists the skills you ran, or says "Skills run: none".' : '') +
    ' If one is not installed or cannot be called or read, carry on without it. Where a skill and CLAUDE.md or the constitution differ, the repo\'s rules win. ';
}

function missingText() {
  const config = require('./config.js');
  const { skills, plugins } = installed();
  const missing = [...new Set(ROLES.flatMap((r) => names(config.get(r + 'Skills')) || []))].filter((n) => !skills.has(n)).sort();
  if (!missing.length) return '';
  const pins = require('./plugins.js').list();
  const how = [...new Set(missing.map((n) => n.includes(':') ? n.split(':')[0] : null).filter((p) => p && !plugins.has(p)))].map((p) => {
    const k = pins.plugins.find((x) => x.name === p);
    if (!k) return '/plugin install ' + p;
    const add = k.marketplace !== 'claude-plugins-official' && pins.marketplaces[k.marketplace];
    return (add ? '/plugin marketplace add ' + add + ', then ' : '') + '/plugin install ' + p + '@' + k.marketplace;
  });
  const fix = how.length ? ' To install, type in Claude Code: ' + how.join('; ') + '.' : ' Their plugins are installed, so update them, or take the names off the list.';
  const head = 'Skills in Settings that are not installed, so briefs leave them out and sessions carry on without them.' + fix + ' Missing: ';
  let shown = missing.join(', ');
  for (let n = missing.length - 1; head.length + shown.length > 490 && n > 0; n--) shown = missing.slice(0, n).join(', ') + ' and ' + (missing.length - n) + ' more';
  return head + shown + '.';
}
const inContainer = () => (process.env.RELAY_IN_CONTAINER ? process.env.RELAY_IN_CONTAINER === '1' : fs.existsSync('/.dockerenv'));

function lacking() {
  if (process.env.RELAY_NEEDS_SKILLS === '0') return null;
  const config = require('./config.js'), pl = require('./plugins.js');
  const { skills: have, plugins } = installed(), dir = claudeDir();
  const roles = ROLES.map((role) => ({ role, names: (names(config.get(role + 'Skills')) || []).filter((n) => !have.has(n)) })).filter((r) => r.names.length);
  const pins = pl.list().plugins;
  const need = [...new Set(roles.flatMap((r) => r.names.map((n) => (n.includes(':') ? n.split(':')[0] : null))).filter((p) => p && !plugins.has(p)))]
    .map((p) => { const k = pins.find((x) => x.name === p); return k ? pl.idOf(k) : p; });
  const differs = pl.differs(pl.installedIn(dir));
  if (!roles.length && !differs.length) return null;
  return { roles, commands: pl.commands(need, pl.knownMarkets(dir), inContainer()), differs };
}
const said = new Map();
function notice(channel) {
  const text = missingText();
  if (!text || said.get(channel) === text) return;
  said.set(channel, text);
  try { require('./chat.js').announce(channel, text); } catch (e) { console.error('Could not say which skills are missing: ' + e.message); }
}

function roleOf(body, own, lead) {
  if (lead) return 'lead';
  if (body.task) return 'dev';
  if (body.role === 'reviewer' || (own && own.reviewOf)) return 'reviewer';
  return ['pm', 'coo', 'security'].includes(body.role) ? body.role : null;
}
function modelArgs(role) {
  if (!role) return [];
  const m = require('./config.js').get(role + 'Model');
  return m && MODEL.test(m) ? ['--model', m] : [];
}

module.exports = { STEPS, ROLES, MODEL, modelOk, skillsOk, names, installed, about, brief, missingText, lacking, notice, roleOf, modelArgs };
