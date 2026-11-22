// Gets Claude Code, gh and git ready in the container before the relay starts (docker/start.sh), and
// says which sign-ins it found. It runs at each start and never stops the start.
//
// Claude Code: a new Claude Code first asks for a text style, and asks again whether to use an API key
// found in the environment. Nobody answers those in a room, so this marks the first run done in
// CLAUDE_CONFIG_DIR/.claude.json and approves the ANTHROPIC_API_KEY the person put in .env. It reads the
// sign-in from `claude auth status`, which sees that a token is there, not that it works.
//
// GitHub: with GH_TOKEN, gh is signed in already. This checks the token with `gh api user`, lets git
// push with it (`gh auth setup-git`), and names the commits after that account unless git has a name.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { oneLine } = require('./clean.js');

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim();
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

function main(env) {
  try { claudeConfig(env); } catch (e) { console.log('Claude Code: could not write its settings: ' + said(e)); }
  console.log(claudeSignIn());
  console.log(gitHub(env));
}

if (require.main === module) main(process.env);
module.exports = { claudeConfig };
