// The model and the skills each role runs with, set in Settings (relay/config.js, the Models and
// skills group). A role is 'lead', 'dev', 'reviewer', 'pm', 'coo' or 'security'.
//
// A model setting is a Claude Code model name or alias, such as opus or claude-sonnet-4-5. Empty means
// no --model flag, so the session runs on the person's own default. relay/terminal.js adds it only when
// it starts a new session for that role, never on --resume.
//
// A skills setting lists skills by their plugin name, such as mattpocock-skills:tdd. Each role's brief
// gets one paragraph that names the skills on its list that are installed on this computer, and none
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
const MODEL = /^[A-Za-z0-9][A-Za-z0-9.[\]-]{0,63}$/;  // never starts with -, so it cannot read as a flag
const SKILL = /^[A-Za-z0-9][\w.-]{0,63}(:[A-Za-z0-9][\w.-]{0,63})?$/;
const MAX_SKILLS = 12, MAX_SKILLS_TEXT = 400;
// Where to get the two plugins the defaults name. claude-plugins-official is Claude Code's own marketplace.
const KNOWN = {
  'mattpocock-skills': { market: 'claude-plugins-official' },
  pstack: { market: 'cursor-plugins', add: 'cursor/plugins' }
};
// What the Dev's brief says each one is for, when its list names it.
const FOR = { tdd: 'new behavior, or a bug a test can catch', 'diagnosing-bugs': 'a bug', 'codebase-design': 'a change of structure' };

const modelOk = (v) => typeof v === 'string' && (v === '' || MODEL.test(v));
// The names in a skills setting: words split by commas or spaces. null if it is not a list of names.
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

// The SKILL.md folders under dir, up to depth folders down.
function skillDirs(dir, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) return [dir];
  if (!depth) return [];
  return entries.filter((e) => e.isDirectory()).flatMap((e) => skillDirs(path.join(dir, e.name), depth - 1));
}
// A skill's name from its front matter, or its folder's. manual: only a person can run it
// (disable-model-invocation), so a session cannot call it with the Skill tool, and its brief points it
// to the file to read instead.
function skillOf(dir) {
  let head = '';
  try { head = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').slice(0, 4000); } catch (e) { /* a folder with no readable SKILL.md */ }
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  const field = (k) => { const m = front && new RegExp('^' + k + ':\\s*(.+)$', 'm').exec(front[1]); return m ? m[1].trim().replace(/^["']|["']$/g, '') : null; };
  return { name: field('name') || path.basename(dir), manual: field('disable-model-invocation') === 'true', file: path.resolve(dir, 'SKILL.md') };
}

let cache = { key: null, skills: new Map(), plugins: new Map() };
// { skills: Map 'plugin:skill' -> { manual, file }, plugins: Map plugin name -> 'name@marketplace' }, both
// only for plugins that are installed and not turned off.
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

// For Settings: each skill on a list, whether it is installed, and whether only a person can run it.
const about = (v) => ({ skills: (names(v) || []).map((n) => { const s = installed().skills.get(n); return { name: n, installed: !!s, manual: !!(s && s.manual) }; }) });

// The paragraph for a role's brief, with a space on each side, or '' when its list names nothing installed.
// A skill a session can call is named for the Skill tool. One only a person can run is named with the
// full path of its SKILL.md, to read and follow. The path is local, and goes only into this computer's
// sessions: never into #office, Settings or anything sent off it.
function brief(role) {
  const config = require('./config.js');  // it loads this file
  const have = installed().skills;
  const list = (names(config.get(role + 'Skills')) || []).filter((n) => have.has(n));
  if (!list.length) return '';
  const word = (n) => { const why = role === 'dev' && FOR[n.split(':').pop()]; return why ? n + ' (for ' + why + ')' : n; };
  const called = list.filter((n) => !have.get(n).manual).map(word);
  const read = list.filter((n) => have.get(n).manual).map((n) => word(n) + ' at ' + have.get(n).file);
  return (called.length ? ' Use these skills where they fit: ' + called.join(', ') + '.' : '') +
    (read.length ? ' These skills cannot be called, so read the file of each and follow it where it fits: ' + read.join('; ') + '.' : '') +
    ' If one is not installed or cannot be called or read, carry on without it. Where a skill and CLAUDE.md or the constitution differ, the repo\'s rules win. ';
}

// The skills on any role's list that are not installed, and how to install them. '' when none are.
function missingText() {
  const config = require('./config.js');
  const { skills, plugins } = installed();
  const missing = [...new Set(ROLES.flatMap((r) => names(config.get(r + 'Skills')) || []))].filter((n) => !skills.has(n)).sort();
  if (!missing.length) return '';
  const how = [...new Set(missing.map((n) => n.includes(':') ? n.split(':')[0] : null).filter((p) => p && !plugins.has(p)))].map((p) => {
    const k = KNOWN[p];
    if (!k) return '/plugin install ' + p;
    return (k.add ? '/plugin marketplace add ' + k.add + ', then ' : '') + '/plugin install ' + p + '@' + k.market;
  });
  // #office keeps 500 characters of a post, so the commands come first and the names are cut to fit.
  const fix = how.length ? ' To install, type in Claude Code: ' + how.join('; ') + '.' : ' Their plugins are installed, so update them, or take the names off the list.';
  const head = 'Skills in Settings that are not installed, so briefs leave them out and sessions carry on without them.' + fix + ' Missing: ';
  let shown = missing.join(', ');
  for (let n = missing.length - 1; head.length + shown.length > 490 && n > 0; n--) shown = missing.slice(0, n).join(', ') + ' and ' + (missing.length - n) + ' more';
  return head + shown + '.';
}
// Says it in #office once per relay start, and again only when the missing list changes.
const said = new Map();  // channel -> the text said last
function notice(channel) {
  const text = missingText();
  if (!text || said.get(channel) === text) return;
  said.set(channel, text);
  try { require('./chat.js').announce(channel, text); } catch (e) { console.error('Could not say which skills are missing: ' + e.message); }
}

// The role a session starts as: the Lead, a task's Dev, a reviewer, the PM, the COO or the security officer. null for a plain session.
function roleOf(body, own, lead) {
  if (lead) return 'lead';
  if (body.task) return 'dev';
  if (body.role === 'reviewer' || (own && own.reviewOf)) return 'reviewer';
  return ['pm', 'coo', 'security'].includes(body.role) ? body.role : null;
}
// The --model flag for a new session in that role, or [].
function modelArgs(role) {
  if (!role) return [];
  const m = require('./config.js').get(role + 'Model');
  return m && MODEL.test(m) ? ['--model', m] : [];
}

module.exports = { ROLES, MODEL, modelOk, skillsOk, names, installed, about, brief, missingText, notice, roleOf, modelArgs };
