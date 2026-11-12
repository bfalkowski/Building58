// A real relay with a fake `claude` and its own home folder, so your settings, tasks and sessions
// are not touched.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, tries) => { for (let i = 0; i < (tries || 100); i++) { const v = await fn(); if (v) return v; await sleep(100); } throw new Error('Timed out waiting for ' + what); };
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

function makeRepo(home, name) {
  const repo = path.join(home, name || 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
  return repo;
}
// Every test relay uses the same key, so a relay that lost its port to another run (a parallel
// checkout, or another file here) would let the test talk to that run's relay instead. So the test
// waits until its own child says it listens on its port, and tries a new port if it lost this one.
async function relay(extraEnv, existingHome, options) {
  const home = existingHome || fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
  homes.add(home);
  for (let tries = 1; ; tries++) {
    // options.port starts it on that port, as the supervisor starts a relay again after Update.
    try { return await relayOn((options && options.port) || await freePort(), home, extraEnv, existingHome, options); } catch (e) {
      if (!(e.portTaken && tries < 5 && !(options && options.port))) throw e;
    }
  }
}
async function relayOn(port, home, extraEnv, existingHome, options) {
  const base = 'http://127.0.0.1:' + port + '/channels/t';  // not localhost: Node 18's fetch tries ::1 and stops there
  // Tests that restart a relay check what Bring back does, so the next relay brings nothing back by
  // itself unless a test asks with RELAY_RESUME: '1' (relay/test/restart.test.js). Nor does it start its own
  // Lead on the room's channel unless a test asks with RELAY_LEAD: '1' (relay/test/lead-at-start.test.js). Nothing asks gh about
  // PR comments unless a test sets RELAY_REVIEW_POLL_SECONDS (relay/test/pr-comments.test.js), nor about
  // PR states for the chat board unless a test sets RELAY_CHAT_POLL_SECONDS (relay/test/chat.test.js), nor git
  // about origin's main unless a test sets RELAY_MAIN_POLL_SECONDS (relay/test/main-moves.test.js), nor about
  // PR checks, so reviews do not wait for a pipeline, unless a test sets RELAY_PIPELINE_POLL_SECONDS (relay/test/pipeline.test.js).
  // Nothing types the Lead's regular check unless a test sets RELAY_LEAD_CHECK_MS (relay/test/lead-check.test.js).
  // The fake claude sends no hooks, so the check that a told session started waits an hour unless a test
  // sets RELAY_TOLD_CHECK_MS (relay/test/told-stuck-relay.test.js).
  // HOST is set here, so a HOST of your own (0.0.0.0, say) cannot move it off the address the test checks.
  const env = { ...process.env, HOME: home, HOST: '127.0.0.1', PORT: String(port), RELAY_KEY: 'test-key', RELAY_TERMINAL: '1', RELAY_RESUME: '0', RELAY_LEAD: '0', RELAY_REVIEW_POLL_SECONDS: '0', RELAY_CHAT_POLL_SECONDS: '0', RELAY_MAIN_POLL_SECONDS: '0', RELAY_PIPELINE_POLL_SECONDS: '0', RELAY_LEAD_CHECK_MS: '0', RELAY_TOLD_CHECK_MS: '3600000', CLAUDE_CMD: path.join(__dirname, 'fake-claude.sh'), ...(extraEnv || {}) };
  let output = '', stopping = false;
  // options.root runs a copy of the relay from another folder (relay/test/rollback.test.js).
  const child = spawn('node', ['relay/server.js'], { cwd: (options && options.root) || ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
  // A relay that ends when no test stopped it is the first thing to know when a later request fails.
  child.on('exit', (code, signal) => { if (!stopping) process.stderr.write('The test relay on port ' + port + ' ended by itself (' + (signal || 'code ' + code) + '). It said:\n' + output + '\n'); });
  // No request waits forever: a relay that stopped answering fails the test, and does not hang it.
  const call = async (method, p, body, headers) => {
    const r = await fetch(base + p, { method, headers: { ...(headers || { Authorization: 'Bearer test-key' }), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    return { status: r.status, body: await r.json() };
  };
  const health = () => fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
  const ours = async () => (child.exitCode !== null || child.signalCode ? 'gone' : output.includes('Relay on http://127.0.0.1:' + port) && await health());
  const up = await until(ours, 'the relay', 300).catch((e) => { stopping = true; child.kill(); throw e; });  // the test has no R.stop yet, and a live child keeps the file from exiting
  if (up === 'gone') {
    stopping = true;
    const e = new Error('The test relay ended before it started. It said:\n' + output);
    e.portTaken = /already in use/.test(output);
    throw e;
  }
  // The relay prints that it listens before it has connected to the session host and taken its sessions
  // back, and until then it refuses new sessions (no_host). So a test starts once that is done.
  // A relay with no sessions, or a random key, says nothing of that, and is ready as it is.
  if (env.RELAY_TERMINAL === '1' && env.RELAY_KEY) {
    const back = async () => { try { const r = await fetch('http://127.0.0.1:' + port + '/health', { headers: { Authorization: 'Bearer ' + env.RELAY_KEY }, signal: AbortSignal.timeout(5000) }); const b = await r.json(); return !b.restore || b.restore.done; } catch (e) { return false; } };
    await until(back, 'the relay to take its sessions back', 300)
      .catch((e) => { stopping = true; child.kill(); throw e; });
  }
  // The relay starts a PR's first review by itself (relay/reviews.js). Before T-54 only the page did, and
  // no test opens a page, so a test gets that only when it asks with autoReview (relay/test/auto-review.test.js).
  if (env.RELAY_TERMINAL === '1' && !(options && options.autoReview)) await call('POST', '/reviews', { auto: false });
  const screen = async (id, ms) => {  // what a page that opens this session now sees in ms (300) of reading
    const ctl = new AbortController();
    const r = await fetch(base + '/terminals/' + id + '/stream', { headers: { Authorization: 'Bearer test-key' }, signal: ctl.signal });
    let text = '';
    const reader = r.body.getReader(), dec = new TextDecoder();
    setTimeout(() => ctl.abort(), ms || 300);
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); } } catch (e) { /* cut off on purpose */ }
    return [...text.matchAll(/event: out\ndata: "([^"]+)"/g)].map((m) => Buffer.from(m[1], 'base64').toString()).join('');
  };
  const hook = (event) => call('POST', '/commands', { action: 'hook', wait: false, event });
  // A relay that does not end on SIGTERM within 5 seconds is killed, so the test file can still end.
  const kill = async () => {
    stopping = true;
    if (child.exitCode !== null || child.signalCode) return;
    const ended = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    const late = setTimeout(() => child.kill('SIGKILL'), 5000);
    await ended; clearTimeout(late);
  };
  // Two relays can share a home (a restart, or a second relay on the same files). Removing the home
  // first stops every relay still on it, so none is writing while the folder goes, and a cleanup that
  // fails cannot leave a relay alive that keeps the test file from ending (T-184).
  const remove = async () => {
    const live = onHome.get(home) || new Set();
    await Promise.allSettled([...live].map((k) => k()));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  const stop = async () => { try { await kill(); } finally { if (!existingHome) await remove(); } };
  if (!onHome.has(home)) onHome.set(home, new Set());
  onHome.get(home).add(kill);
  child.once('exit', () => onHome.get(home).delete(kill));
  return { call, home, port, base, screen, hook, kill, stop, remove, health, child, output: () => output };
}
// A session's token never appears in the API, so the fake writes it to a file in the relay's home
// (relay/test/fake-claude.sh), one line per start: session id, pid, token. Only homes this test file
// made are read, and only sessions still running count, so parallel runs never see each other's.
// A session started with another's old id shares that id, so there can be several.
const homes = new Set();
const onHome = new Map();  // home -> the kill of each relay started on it
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function sessionTokens(sessionId) {
  const lines = [...homes].flatMap((home) => { try { return fs.readFileSync(path.join(home, '.fake-claude-tokens'), 'utf8').split('\n'); } catch (e) { return []; } });
  const tokens = lines.map((l) => l.split(' ')).filter(([id, pid, token]) => id === sessionId && token && alive(Number(pid))).map((x) => x[2]);
  return [...new Set(tokens)];
}
function sessionToken(sessionId) {
  const [token] = sessionTokens(sessionId);
  if (!token) throw new Error('No token found for session ' + sessionId);
  return token;
}
module.exports = { relay, makeRepo, sleep, until, sessionToken, sessionTokens, ROOT };
