// Gets Claude Code, gh and git ready in the container before the relay starts (docker/start.sh), and
// says which sign-ins it found. It runs at each start and never stops the start.
//
// Claude Code: a new Claude Code first asks for a text style, and asks again whether to use an API key
// found in the environment. Nobody answers those in a room, so this marks the first run done in
// CLAUDE_CONFIG_DIR/.claude.json and approves the ANTHROPIC_API_KEY the person put in .env. Claude Code
// also asks whether to trust each new folder, and a new task's checkout is a new folder. The person listed
// the repos in ROOM_REPOS, and the room runs from the Building58 folder, so those folders are marked trusted:
// Claude Code trusts a folder inside a trusted one, so each checkout under .worktrees starts with no question. It reads the
// sign-in from `claude auth status`, which sees that a token is there, not that it works.
//
// GitHub: with GITHUB_APP_ID, the room acts as that GitHub App (relay/github-app.js): this makes its first
// token, and relay/container-forward.js makes a new one every 10 minutes. Commits are named after its bot.
// Otherwise, with GH_TOKEN, gh is signed in already. This checks the token with `gh api user`, lets git
// push with it (`gh auth setup-git`), and names the commits after that account unless git has a name.
//
// Repos: each owner/name in ROOM_REPOS that is not in ~/repos yet is cloned there, into the repos
// volume. One already there is left as it is: the room fetches what it needs.
//
// Skills: with ROOM_PLUGINS (plugin@marketplace, by spaces or commas), each plugin not installed yet is installed
// into the claude volume, once the person has listed it, since a plugin is code every session runs. The line
// says what was installed, what was there, what failed and any plugin at another version than plugins.json.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { oneLine } = require('./clean.js');

const run = (cmd, args, ms) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: ms || 20000 }).trim();
const said = (e) => oneLine((e && (e.stderr || e.message)) || e, 200);

function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return {}; }
  try { return JSON.parse(text); } catch (e) {
    fs.renameSync(file, file + '.unreadable-' + Date.now());
    return {};
  }
}

function claudeConfig(env, trusted) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const file = path.join(dir, '.claude.json');
  const config = readJson(file);
  config.hasCompletedOnboarding = true;
  if (!config.theme) config.theme = 'dark';
  if (env.ANTHROPIC_API_KEY) {
    const tail = env.ANTHROPIC_API_KEY.slice(-20);
    const answers = config.customApiKeyResponses || {};
    const approved = Array.isArray(answers.approved) ? answers.approved : [];
    const rejected = Array.isArray(answers.rejected) ? answers.rejected : [];
    config.customApiKeyResponses = { approved: approved.includes(tail) ? approved : approved.concat(tail), rejected: rejected.filter((x) => x !== tail) };
  }
  if (trusted && trusted.length) {
    config.projects = config.projects && typeof config.projects === 'object' ? config.projects : {};
    for (const folder of trusted) config.projects[folder] = Object.assign({}, config.projects[folder], { hasTrustDialogAccepted: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(config, null, 2));
  fs.renameSync(file + '.tmp', file);
  return file;
}

function claudeSignIn() {
  let out;
  try { out = run('claude', ['auth', 'status', '--json']); } catch (e) { out = e.stdout; }
  let status;
  try { status = JSON.parse(out); } catch (e) { return 'Claude Code: could not read the sign-in from claude auth status.'; }
  if (status.loggedIn) return 'Claude Code: signed in (' + oneLine(status.authMethod, 40) + ', ' + oneLine(status.apiProvider, 40) + ').';
  return 'Claude Code: not signed in. Set CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) or ANTHROPIC_API_KEY in .env, then run docker compose up -d again.';
}

async function gitHubApp(env) {
  let r;
  try { r = await require('./github-app.js').signIn(env); } catch (e) { return 'GitHub: the App could not sign in: ' + said(e); }
  try { run('gh', ['auth', 'setup-git']); } catch (e) { return 'GitHub: signed in as ' + r.login + ', but git cannot push with it: ' + said(e); }
  run('git', ['config', '--global', 'user.name', r.login]);
  run('git', ['config', '--global', 'user.email', r.botId + '+' + r.login + '@users.noreply.github.com']);
  return 'GitHub: signed in as the App ' + r.login + '. Its token is made again every 10 minutes. git pushes with it.';
}

function gitHub(env) {
  if (!env.GH_TOKEN) return 'GitHub: no GH_TOKEN in .env. Sessions cannot push or open pull requests.';
  let user;
  try { user = JSON.parse(run('gh', ['api', 'user'])); } catch (e) { return 'GitHub: GH_TOKEN did not work: ' + said(e); }
  const login = oneLine(user.login, 60);
  try { run('gh', ['auth', 'setup-git']); } catch (e) { return 'GitHub: signed in as ' + login + ', but git cannot push with it: ' + said(e); }
  const has = (key) => { try { return !!run('git', ['config', '--global', key]); } catch (e) { return false; } };
  if (!has('user.name')) run('git', ['config', '--global', 'user.name', oneLine(user.name, 100) || login]);
  if (!has('user.email')) run('git', ['config', '--global', 'user.email', user.id + '+' + login + '@users.noreply.github.com']);
  return 'GitHub: signed in as ' + login + '. git pushes with the same token.';
}

const REPO = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;
function repoList(value) {
  const ok = [], bad = [];
  for (const item of String(value || '').split(/[\s,]+/).filter(Boolean)) {
    const m = item.match(REPO);
    if (!m || m[2] === '.' || m[2] === '..') bad.push(oneLine(item, 100));
    else if (!ok.some((r) => r.name === m[2])) ok.push({ owner: m[1], name: m[2], full: m[1] + '/' + m[2] });
    else bad.push(oneLine(item, 100) + ' (a repo with that name is listed already)');
  }
  return { ok, bad };
}

function repos(env, home) {
  const { ok, bad } = repoList(env.ROOM_REPOS);
  const lines = bad.map((b) => 'Repos: ' + b + ' is not owner/name, so it is left out.');
  if (!ok.length && !bad.length) return ['Repos: none in ROOM_REPOS. Add owner/name for each repo the room works on.'];
  for (const r of ok) {
    const dir = path.join(home, 'repos', r.name);
    if (fs.existsSync(path.join(dir, '.git'))) { lines.push('Repos: ' + r.full + ' is in ' + dir + '.'); continue; }
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) { lines.push('Repos: ' + dir + ' is there but is not a git repo, so ' + r.full + ' is not cloned.'); continue; }
    const part = dir + '.cloning';
    fs.rmSync(part, { recursive: true, force: true });
    try {
      run('git', ['clone', '--quiet', 'https://github.com/' + r.full + '.git', part], 600000);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(part, dir);
      lines.push('Repos: cloned ' + r.full + ' into ' + dir + '.');
    } catch (e) {
      fs.rmSync(part, { recursive: true, force: true });
      lines.push('Repos: could not clone ' + r.full + ', so the next start tries again: ' + said(e));
    }
  }
  return lines;
}

function skills(env, run) {
  const pl = require('./plugins.js'), dir = pl.claudeDir(env), want = pl.ids(env.ROOM_PLUGINS), pins = pl.list();
  const lines = want.bad.map((b) => 'Skills: ' + b + ' is not plugin@marketplace or owner/repo, so it is left out.');
  if (!want.plugins.length && !want.sources.length) return lines.concat('Skills: none in ROOM_PLUGINS, so briefs name no skills. Add plugin@marketplace for each plugin to install.');
  const did = [], had = [], failed = [];
  const attempt = (what, args) => { try { run('claude', args, 300000); return true; } catch (e) { failed.push(what + ' (' + said(e) + ')'); return false; } };
  const markets = new Set(pl.knownMarkets(dir));
  for (const source of want.sources) attempt('marketplace ' + source, ['plugin', 'marketplace', 'add', source]);
  for (const id of want.plugins) {
    const have = pl.installedIn(dir).get(id);
    if (have) { had.push(id); continue; }
    const market = id.split('@')[1], repo = pins.marketplaces[market];
    if (!markets.has(market) && market !== pl.BUILT_IN) {
      if (!repo) { failed.push(id + ' (no marketplace ' + market + ' in plugins.json: add its owner/repo to ROOM_PLUGINS)'); continue; }
      if (!attempt('marketplace ' + repo, ['plugin', 'marketplace', 'add', repo])) continue;
      markets.add(market);
    }
    if (attempt(id, ['plugin', 'install', id])) did.push(id);
  }
  const now = pl.installedIn(dir);
  const off = pl.differs(now).filter((d) => want.plugins.includes(d.id));
  const parts = [];
  if (did.length) parts.push('installed ' + did.join(', '));
  if (had.length) parts.push('already there ' + had.join(', '));
  if (failed.length) parts.push('failed ' + failed.join('; ') + ', so the next start tries again');
  if (off.length) parts.push('at another version than plugins.json: ' + off.map((d) => d.id + ' is ' + pl.label(d.have) + ', the list says ' + pl.label(d.want)).join('; '));
  return lines.concat('Skills: ' + parts.join('. ') + '.');
}

async function main(env) {
  const home = os.homedir();
  const trusted = [path.join(home, 'building58')].concat(repoList(env.ROOM_REPOS).ok.map((r) => path.join(home, 'repos', r.name)));
  try { claudeConfig(env, trusted); } catch (e) { console.log('Claude Code: could not write its settings: ' + said(e)); }
  console.log(claudeSignIn());
  console.log(env.GITHUB_APP_ID ? await gitHubApp(env) : gitHub(env));
  for (const line of repos(env, home)) console.log(line);
  try { for (const line of skills(env, run)) console.log(line); } catch (e) { console.log('Skills: could not check the plugins: ' + said(e)); }
}

if (require.main === module) main(process.env).catch((e) => console.log('Setup: ' + said(e)));
module.exports = { claudeConfig, repoList, skills };
