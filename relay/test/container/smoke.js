// The container smoke test, run inside a container from the image (docker/smoke.sh). With the fake
// claude as CLAUDE_CMD, it checks that the relay is healthy, that a session starts, and that a hook
// from that session reaches the relay. It also checks that the image's tools run.
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || '8787';
const BASE = 'http://127.0.0.1:' + PORT;
const AUTH = { Authorization: 'Bearer ' + process.env.RELAY_KEY, 'Content-Type': 'application/json' };
const APP = path.join(os.homedir(), 'building58');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: AUTH, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  return { status: r.status, body: await r.json() };
}
async function until(what, check, seconds) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const v = await check().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error('Gave up waiting for ' + what + '.');
    await sleep(500);
  }
}
function ok(what, cond, detail) {
  if (!cond) throw new Error(what + ' failed' + (detail ? ': ' + detail : '.'));
  console.log('ok   ' + what);
}

(async () => {
  for (const [tool, args] of [['claude', ['--version']], ['gh', ['--version']], ['git', ['--version']], ['python3', ['--version']], ['ps', ['-o', 'pid=', '-p', '1']]]) {
    const out = execFileSync(tool, args, { encoding: 'utf8' }).split('\n')[0];
    ok(tool + ' runs (' + out.trim() + ')', true);
  }
  const want = process.env.CLAUDE_CODE_VERSION;
  if (want) ok('claude is the pinned version ' + want, execFileSync('claude', ['--version'], { encoding: 'utf8' }).startsWith(want));

  await until('the relay', async () => (await fetch(BASE + '/health', { signal: AbortSignal.timeout(2000) })).ok, 90);
  ok('the relay answers /health', true);
  ok('the Building58 folder is a git checkout', fs.existsSync(path.join(APP, '.git')));
  const settings = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
  ok('the hooks are in ~/.claude/settings.json', settings.includes('office-hook.js'));
  ok('the key is not in ~/.claude/settings.json', !settings.includes(process.env.RELAY_KEY));
  const config = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8'));
  ok('Claude Code\'s first run is marked done, so no text style question blocks a session', config.hasCompletedOnboarding === true);

  const list = await call('GET', '/channels/office/terminals');
  ok('the Claude Code panel is on', list.status === 200 && list.body.enabled === true, JSON.stringify(list.body));
  const started = await call('POST', '/channels/office/terminals', { cwd: path.join(os.homedir(), 'repos') });
  ok('a session starts', started.status === 201, JSON.stringify(started.body));
  const id = started.body.id;

  const mine = async () => (await call('GET', '/channels/office/terminals')).body.terminals.find((x) => x.id === id);
  const sessionId = (await until('the session id', async () => (await mine()).sessionId, 30));
  const token = await until('the session\'s token', async () => {
    const lines = fs.readFileSync(path.join(os.homedir(), '.fake-claude-tokens'), 'utf8').trim().split('\n').map((l) => l.split(' '));
    const found = lines.filter((l) => l[0] === sessionId && l[2]).pop();
    return found ? found[2] : null;
  }, 30);
  const before = await mine();
  ok('the session is idle before its hook', before.state === 'idle', before.state);
  const hook = spawnSync('node', [path.join(APP, 'relay', 'office-hook.js')], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: path.join(os.homedir(), 'repos') }),
    env: Object.assign({}, process.env, { OFFICE_HOOK_URL: BASE + '/channels/office/commands', OFFICE_TICKET_TOKEN: token }),
    encoding: 'utf8'
  });
  ok('the hook exits 0', hook.status === 0, hook.stderr);
  await until('the relay to hear the hook', async () => (await mine()).state === 'working', 30);
  ok('the relay heard the hook: the session is working', true);
  console.log('The container smoke test passed.');
})().catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
