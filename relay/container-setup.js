// Gets Claude Code, gh and git ready in the container before the relay starts (docker/start.sh), and
// says which sign-ins it found. It runs at each start and never stops the start.
//
// Claude Code: a new Claude Code first asks for a text style, and asks again whether to use an API key
// found in the environment. Nobody answers those in a room, so this marks the first run done in
// CLAUDE_CONFIG_DIR/.claude.json and approves the ANTHROPIC_API_KEY the person put in .env. It reads the
// sign-in from `claude auth status`, which sees that a token is there, not that it works.
//
// GitHub: with GITHUB_APP_ID, the room acts as that GitHub App (relay/github-app.js): this makes its first
// token, and relay/container-forward.js makes a new one every 45 minutes. Commits are named after its bot.
// Otherwise, with GH_TOKEN, gh is signed in already. This checks the token with `gh api user`, lets git
// push with it (`gh auth setup-git`), and names the commits after that account unless git has a name.
//
// Repos: each owner/name in ROOM_REPOS that is not in ~/repos yet is cloned there, into the repos
// volume. One already there is left as it is: the room fetches what it needs.
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

function claudeConfig(env) {
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
  return 'GitHub: signed in as the App ' + r.login + '. Its token is made again every 45 minutes. git pushes with it.';
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

async function main(env) {
  try { claudeConfig(env); } catch (e) { console.log('Claude Code: could not write its settings: ' + said(e)); }
  console.log(claudeSignIn());
  console.log(env.GITHUB_APP_ID ? await gitHubApp(env) : gitHub(env));
  for (const line of repos(env, os.homedir())) console.log(line);
}

if (require.main === module) main(process.env).catch((e) => console.log('Setup: ' + said(e)));
module.exports = { claudeConfig, repoList };
