// What access the room's sessions run with, for the security officer (relay/security.js). Names only:
// this file never returns the value of a variable, a token or a key file, and relay/test/security.test.js
// checks that with made-up keys.
//
//   env          what relay/session-env.js passes on to each session, takes out, and adds
//   logins       the logins in the home folder a session inherits, such as gh, ssh and aws
//   folders      where each session runs, and the person's Claude Code permission settings
//   rungs        which Lead may merge, start tickets or move the board (article 5)
//   secretCheck  whether the pre-commit hook is on, and what the check finds in the tracked files
//   gaps         where that is short of article 7, local with the least access
// measure() is a plain function of what it is given, so a test can call it with a made-up home.
'use strict';
const fs = require('fs');
const path = require('path');
const sessionEnv = require('./session-env.js');

// A name from a file, such as a host or a profile: letters, digits, dots, dashes and @ only.
const word = (v) => String(v).replace(/[^\w.@-]/g, '').slice(0, 64);
const shown = (home, p) => (p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
const isDir = (f) => { try { return fs.statSync(f).isDirectory(); } catch (e) { return false; } };
const list = (items) => [...new Set(items.map(word).filter(Boolean))].join(', ');

// Each login: where it lives, and what it says about itself without its secret.
const LOGINS = [
  // gh keeps a token per host in hosts.yml, unless it is in the macOS keychain. Only the hosts are read.
  ['gh', (home, env) => path.join(env.GH_CONFIG_DIR || path.join(home, '.config', 'gh'), 'hosts.yml'),
    (text) => { const hosts = list(text.match(/^[^\s#][^:\s]*(?=:\s*$)/gm) || []); return hosts ? 'hosts: ' + hosts : 'no hosts'; }],
  ['git credentials', (home) => path.join(home, '.git-credentials'), () => null],
  ['ssh', (home) => path.join(home, '.ssh'), null, (dir) => {
    let keys = [];
    try { keys = fs.readdirSync(dir).filter((f) => /^id_/.test(f) && !f.endsWith('.pub')).sort(); } catch (e) { /* none */ }
    return keys.length ? 'keys: ' + list(keys) : 'no keys';
  }],
  ['aws', (home, env) => env.AWS_SHARED_CREDENTIALS_FILE || path.join(home, '.aws', 'credentials'),
    (text) => { const p = list((text.match(/^\s*\[([^\]]+)\]/gm) || []).map((x) => x.replace(/[[\]\s]/g, ''))); return p ? 'profiles: ' + p : 'no profiles'; }],
  ['gcloud', (home, env) => env.CLOUDSDK_CONFIG || path.join(home, '.config', 'gcloud'), null, () => null],
  ['npm', (home) => path.join(home, '.npmrc'), (text) => (/_authToken|_auth\s*=|_password/.test(text) ? 'has a token' : 'no token')],
  ['netrc', (home) => path.join(home, '.netrc'), () => null],
  ['docker', (home) => path.join(home, '.docker', 'config.json'), (text) => (/"auths"\s*:\s*\{\s*"/.test(text) ? 'has logins' : 'no logins')]
];
function logins(home, env) {
  return LOGINS.map(([name, where, ofFile, ofDir]) => {
    const p = where(home, env || {});
    const out = { name, file: shown(home, p), found: false };
    if (ofDir) { if (!isDir(p)) return out; out.found = true; const d = ofDir(p); if (d) out.detail = d; return out; }
    const text = read(p);
    if (text === null) return out;
    out.found = true;
    const d = ofFile(text);
    if (d) out.detail = d;
    return out;
  });
}

// Where a session runs. A checkout of its own is under a .worktrees folder (relay/checkouts.js).
function whereOf(cwd, root) {
  if (/[\\/]\.worktrees[\\/]/.test(cwd)) return 'its own checkout';
  if (cwd === root || cwd.startsWith(root + path.sep)) return 'the relay\'s own folder';
  return 'another folder';
}

// The person's Claude Code permission settings, without the rules' words: a rule can name a command
// with a key in it.
function claudeSettings(dir) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) || {}; } catch (e) { return { read: false }; }
  const p = s.permissions || {};
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  return { read: true, defaultMode: typeof p.defaultMode === 'string' ? word(p.defaultMode) : null, additionalDirectories: Array.isArray(p.additionalDirectories) ? p.additionalDirectories.length : 0, allow: n(p.allow), ask: n(p.ask), deny: n(p.deny) };
}

// in: { env, home, root, live: [{ who, role, cwd, board, merge, starts }], claude, secretCheck: { hookOn, found } }
function measure(input) {
  const home = input.home, root = input.root, live = input.live || [];
  const env = sessionEnv.names(input.env || {});
  const all = logins(home, input.env);
  // A file that holds no login, such as a docker config with no auths, is not one a session can use.
  const found = all.filter((l) => l.found && !/^no /.test(l.detail || ''));
  const sessions = live.map((s) => ({ who: word(s.who || 'a session'), role: s.role || 'session', cwd: shown(home, s.cwd || ''), where: whereOf(s.cwd || '', root) }));
  const claude = input.claude || { read: false };
  const leads = (k) => live.filter((s) => s.role === 'Lead' && (k === 'starts' ? s.starts > 0 : !!s[k])).map((s) => word(s.who || 'the Lead'));
  const rungs = { leadMerges: leads('merge'), leadStarts: leads('starts'), leadMovesBoard: leads('board') };
  const sc = input.secretCheck || {};
  const secretCheck = {
    hookOn: sc.hookOn === undefined ? null : !!sc.hookOn,
    found: (sc.found || []).slice(0, 20),  // each is a file, a line and a kind, never the value (.githooks/check-secrets.js)
    ci: 'CI runs the check on what each pull request adds, and on every tracked file (Secret scan).',
    caughtNote: 'The relay does not see what the pre-commit hook stopped on a computer, so what it caught before a commit is not counted. Only what the tracked files hold now is.'
  };

  // Article 7: before tickets start by themselves (rung 3) or merge by themselves (rung 4), a session gets
  // only the access its ticket needs: its own checkout and the logins its ticket uses.
  const gaps = [];
  const gap = (what, rung) => gaps.push({ what, waits: rung });
  if (env.loginLike.length) gap('Every session inherits variables that look like logins: ' + env.loginLike.join(', ') + '. Article 7 asks for only the logins its ticket uses.', 'rungs 3 and 4');
  if (found.length) gap('Every session can use these logins in the home folder: ' + found.map((l) => l.name + (l.detail ? ' (' + l.detail + ')' : '')).join('; ') + '. Article 7 asks for only the logins its ticket uses.', 'rungs 3 and 4');
  if (rungs.leadMerges.length) gap('The Lead (' + rungs.leadMerges.join(', ') + ') may merge, with the person\'s full GitHub login, not only the access a merge needs.', 'rung 4');
  if (rungs.leadStarts.length) gap('The Lead (' + rungs.leadStarts.join(', ') + ') may start tickets, and each runs with the person\'s logins.', 'rung 3');
  const own = sessions.filter((s) => s.where === 'the relay\'s own folder');
  if (own.length) gap(own.map((s) => s.who + ' (' + s.role + ')').join(', ') + ' run' + (own.length === 1 ? 's' : '') + ' in the relay\'s own folder, which the global hooks run from, so it can change the running relay\'s files.', 'article 7');
  const other = sessions.filter((s) => s.where === 'another folder');
  if (other.length) gap(other.map((s) => s.who + ' (' + s.role + ')').join(', ') + ' run' + (other.length === 1 ? 's' : '') + ' outside a checkout of its own.', 'article 7');
  if (secretCheck.hookOn === false) gap('The secret check\'s pre-commit hook is off in the relay\'s folder: git core.hooksPath is not .githooks. CI still runs the check.', 'article 7');
  if (secretCheck.found.length) gap('The secret check finds ' + secretCheck.found.length + ' line(s) in the tracked files that look like a key.', 'article 7');
  if (claude.defaultMode === 'bypassPermissions') gap('Claude Code\'s default mode is bypassPermissions, so no session asks before it acts.', 'article 7');

  return {
    at: input.now || new Date().toISOString(),
    env: Object.assign(env, { note: 'Names only. A session gets the relay\'s environment, which is the person\'s, without what is removed, and with what is added (relay/session-env.js). The relay takes its own key out of its environment as it starts (relay/server.js), so it is not in this list to remove.' }),
    logins: all,
    folders: {
      sessions, claude,
      note: 'The relay passes no permission flag, so each session runs with the person\'s Claude Code settings. The operating system lets a session read and change every file the person\'s user can: those settings and their prompts are the only fence.'
    },
    rungs, secretCheck, gaps,
    cannotShow: ['logins kept in the macOS keychain or another credential store', 'what each login is allowed to do on its service, such as the scopes of the gh token', 'what a session read or ran: the relay sees hooks, not every command', 'the project settings in each checkout\'s own .claude folder', 'a secret in a saved report that matches none of the secret check\'s patterns and is not a value the relay holds, such as a .netrc password or a key body without its BEGIN line']
  };
}

module.exports = { measure, logins, claudeSettings };
