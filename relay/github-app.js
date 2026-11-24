// The room on GitHub as a GitHub App, not as a person (docs/manual/running.html#container-github-app).
// A fine-grained personal token cannot read check runs, and the relay reads them in every gh pr view, while
// a classic token reaches every repo of the account. An App reaches only the repos it is installed on, reads
// checks, and acts as its own bot, with tokens that last one hour.
//
//   node relay/github-app.js create --env <file> [--org <org>] [--name <name>] [--workflows]
//     Runs GitHub's App manifest flow from this computer: a page on 127.0.0.1 sends the App's settings to
//     GitHub, you press Create there, and GitHub sends back the App's id and private key, which go into the
//     .env file as GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (the key as base64, on one line). Then it says
//     where to install the App. --workflows also lets the App change files in .github/workflows.
//     With --print in place of --env, it prints those two lines, and GITHUB_APP_INSTALL=<link>, for the
//     caller to keep: setup.sh runs it this way inside the image, with --host 0.0.0.0 and a --port it
//     publishes, when the computer has no Node.
//
//   signIn(env) -> { login, botId, expiresAt }, in the container (relay/container-setup.js and
//     relay/container-forward.js): makes an installation token and gives it to gh, in its hosts.yml, which
//     gh reads at each run, so a new token reaches sessions that are already running. git pushes through
//     gh (gh auth setup-git). With GITHUB_APP_INSTALLATION_ID it uses that installation, or the only one,
//     or the one for the owner of the first repo in ROOM_REPOS.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const API = 'https://api.github.com';
const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function keyOf(env) {
  const raw = String(env.GITHUB_APP_PRIVATE_KEY || '').trim();
  if (!raw) throw new Error('GITHUB_APP_PRIVATE_KEY is empty.');
  return raw.includes('BEGIN') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString('utf8');
}

function jwt(appId, pem, now) {
  const t = Math.floor((now || Date.now()) / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: t - 60, exp: t + 540, iss: String(appId) }));
  return head + '.' + body + '.' + b64url(crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), pem));
}

async function api(method, p, auth, body) {
  const r = await fetch(API + p, { method, headers: Object.assign({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'building58', 'Content-Type': 'application/json' }, auth ? { Authorization: auth } : {}), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  if (!r.ok) throw new Error('GitHub answered ' + r.status + ' to ' + method + ' ' + p + ': ' + String((json && json.message) || text).slice(0, 200));
  return json;
}

function ownerOf(env) {
  const first = String(env.ROOM_REPOS || '').split(/[\s,]+/).filter(Boolean)[0] || '';
  return first.includes('/') ? first.split('/')[0].toLowerCase() : '';
}

async function installationOf(env, appJwt) {
  if (env.GITHUB_APP_INSTALLATION_ID) return String(env.GITHUB_APP_INSTALLATION_ID);
  const list = await api('GET', '/app/installations', 'Bearer ' + appJwt);
  if (!list.length) throw new Error('The App is not installed anywhere yet. Install it on the repos the room works on.');
  if (list.length === 1) return String(list[0].id);
  const owner = ownerOf(env), hit = list.find((i) => i.account && String(i.account.login).toLowerCase() === owner);
  if (hit) return String(hit.id);
  throw new Error('The App has ' + list.length + ' installations. Set GITHUB_APP_INSTALLATION_ID to one of: ' + list.map((i) => i.id + ' (' + (i.account && i.account.login) + ')').join(', ') + '.');
}

function hostsYml(login, token) {
  return 'github.com:\n    users:\n        ' + login + ':\n            oauth_token: ' + token + '\n    oauth_token: ' + token + '\n    git_protocol: https\n    user: ' + login + '\n';
}

function giveGh(login, token, home) {
  const dir = process.env.GH_CONFIG_DIR || path.join(home || os.homedir(), '.config', 'gh');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'hosts.yml');
  fs.writeFileSync(file + '.tmp', hostsYml(login, token), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

async function signIn(env) {
  const appJwt = jwt(env.GITHUB_APP_ID, keyOf(env));
  const app = await api('GET', '/app', 'Bearer ' + appJwt);
  const id = await installationOf(env, appJwt);
  const tok = await api('POST', '/app/installations/' + id + '/access_tokens', 'Bearer ' + appJwt);
  const login = app.slug + '[bot]';
  const bot = await api('GET', '/users/' + encodeURIComponent(login), 'Bearer ' + tok.token);
  giveGh(login, tok.token);
  return { login, botId: bot.id, expiresAt: tok.expires_at, app: app.slug };
}

function manifest(name, redirect, workflows) {
  const perms = { contents: 'write', pull_requests: 'write', issues: 'write', checks: 'read', statuses: 'read', actions: 'read', metadata: 'read' };
  if (workflows) perms.workflows = 'write';
  return { name, url: 'https://github.com/bfalkowski/Building58', redirect_url: redirect, public: false, default_permissions: perms, default_events: [], hook_attributes: { url: 'https://example.com/building58-no-webhook', active: false } };
}

function setEnv(file, values) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  for (const [k, v] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(k + '='));
    if (i >= 0) lines[i] = k + '=' + v; else lines.splice(lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, 0, k + '=' + v);
  }
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function create(args) {
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const envFile = opt('--env');
  const print = args.includes('--print');
  if (!envFile && !print) { console.error('Say which .env gets the App: node relay/github-app.js create --env <file>, or --print'); process.exit(2); }
  const port = Number(opt('--port')) || 0, host = opt('--host') || '127.0.0.1';
  const org = opt('--org'), name = opt('--name') || 'building58-room-' + crypto.randomBytes(3).toString('hex');
  const state = crypto.randomBytes(16).toString('hex');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const page = (code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8"><title>Building58 GitHub App</title><body style="font:16px system-ui;margin:3em">' + html); };
    if (url.pathname === '/') {
      const to = 'https://github.com/' + (org ? 'organizations/' + encodeURIComponent(org) + '/settings/apps/new' : 'settings/apps/new') + '?state=' + state;
      const m = JSON.stringify(manifest(name, 'http://localhost:' + server.address().port + '/done', args.includes('--workflows')));
      page(200, '<p>Sending the App settings to GitHub...</p><form id="f" method="post" action="' + attr(to) + '"><input type="hidden" name="manifest" value="' + attr(m) + '"><button>Continue to GitHub</button></form><script>document.getElementById("f").submit()</script>');
      return;
    }
    if (url.pathname !== '/done') { page(404, 'Not here.'); return; }
    if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) { page(400, 'This answer is not from the GitHub page this command opened.'); return; }
    try {
      const app = await api('POST', '/app-manifests/' + encodeURIComponent(url.searchParams.get('code')) + '/conversions', null);
      const values = { GITHUB_APP_ID: String(app.id), GITHUB_APP_PRIVATE_KEY: Buffer.from(app.pem).toString('base64') };
      const install = 'https://github.com/apps/' + app.slug + '/installations/new';
      if (print) {
        page(200, '<h2>Created ' + attr(app.slug) + '</h2><p>Go back to the terminal.</p>');
        for (const [k, v] of Object.entries(values)) console.log(k + '=' + v);
        console.log('GITHUB_APP_INSTALL=' + install);
        setTimeout(() => process.exit(0), 500);
        return;
      }
      setEnv(envFile, values);
      page(200, '<h2>Created ' + attr(app.slug) + '</h2><p>Its id and key are in ' + attr(envFile) + '.</p><p><a href="' + attr(install) + '">Install it on the repos the room works on</a>.</p>');
      console.log('Created the GitHub App ' + app.slug + ' (id ' + app.id + ').');
      console.log('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are in ' + envFile + '.');
      console.log('Now install it on the repos the room works on: ' + install);
      setTimeout(() => process.exit(0), 500);
    } catch (e) { page(500, 'GitHub did not finish: ' + attr(e.message)); console.error(e.message); setTimeout(() => process.exit(1), 500); }
  });
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? 'Port ' + port + ' is in use. Free it, or pick another with --port (setup.sh: SETUP_APP_PORT=<port> ./setup.sh).' : e.message); process.exit(1); });
  server.listen(port, host, () => {
    const start = 'http://localhost:' + server.address().port + '/';
    console.log('Opening ' + start + ' to create the App "' + name + '" on GitHub' + (org ? ' for ' + org : '') + '.');
    const tell = () => console.log('Open it in your browser.');
    if (args.includes('--no-open')) { tell(); return; }
    try { const c = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [start], { stdio: 'ignore', detached: true }); c.on('error', tell); c.unref(); } catch (e) { tell(); }
  });
}

if (require.main === module) {
  if (process.argv[2] === 'create') create(process.argv.slice(3));
  else if (process.argv[2] === 'sign-in') signIn(process.env).then((r) => console.log(JSON.stringify(r)), (e) => { console.error(e.message); process.exit(1); });
  else { console.error('Usage: node relay/github-app.js create --env <file> [--org <org>] [--name <name>] [--workflows] [--no-open]'); process.exit(2); }
}
module.exports = { jwt, keyOf, hostsYml, manifest, setEnv, signIn, ownerOf };
