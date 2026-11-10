// Hooks sent while the relay is down wait in a queue file in the room's state folder, and the next
// relay applies them in order (relay/hook-queue.js). The test runs its own session host, as the
// supervisor does, so a session runs on through the restart, as it does under Update.
'use strict';
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { launch } = require('../session-host.js');
const queue = require('../hook-queue.js');
const { relay, makeRepo, sleep, until, sessionToken, ROOT } = require('./helpers.js');

const HOOK = path.join(ROOT, 'relay', 'office-hook.js');
const terminals = async (R) => (await R.call('GET', '/terminals')).body.terminals;
const stateOf = async (R, id) => ((await terminals(R)).find((x) => x.id === id) || {}).state;
// The hook as Claude Code runs it, in a session the relay started: its token and its relay's address.
function runHook(R, home, token, event) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OFFICE_|RELAY_)/.test(k)));
  Object.assign(env, { HOME: home, OFFICE_SHOW_TITLES: '0', OFFICE_TICKET_TOKEN: token, OFFICE_HOOK_URL: 'http://127.0.0.1:' + R.port + '/channels/t/commands' });
  const started = Date.now();
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(event), env, encoding: 'utf8', timeout: 10000 });
  return { status: r.status, ms: Date.now() - started };
}
const queueFile = (home) => path.join(home, '.office-world', 'hook-queue.jsonl');

test('a hook sent while the relay is down is applied when it is back', async (t) => {
  const host = launch();
  t.after(() => new Promise((r) => host.stop(r)));
  assert.strictEqual(await host.ready, true);
  const env = { RELAY_WORKER: '1', RELAY_HOST_SOCKET: host.socket, RELAY_RESUME: '1' };
  let R = await relay(env);
  const home = R.home, port = R.port;
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });

  const s = (await R.call('POST', '/terminals', { cwd: home })).body;
  await until(async () => /fake claude/.test(await R.screen(s.id)), 'the session to start');
  const sid = s.sessionId.slice(0, 12), token = sessionToken(s.sessionId);
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid });
  await until(async () => (await stateOf(R, s.id)) === 'working', 'the turn');

  await R.kill();
  await t.test('the hook queues its event, stays fast and exits 0', () => {
    const r = runHook(R, home, token, { hook_event_name: 'Stop', session_id: s.sessionId, cwd: home });
    assert.strictEqual(r.status, 0);
    assert.ok(r.ms < 2500, 'took ' + r.ms + ' ms');
    const lines = fs.readFileSync(queueFile(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].event.hook_event_name, 'Stop');
    assert.ok(lines[0].event.at > 0, 'it carries the time it happened');
    assert.ok(!fs.readFileSync(queueFile(home), 'utf8').includes(token), 'the token itself is not written');
  });

  R = await relay(env, home, { port });
  await t.test('the next relay takes the session back, applies the Stop, and clears the queue', async () => {
    const back = await until(async () => (await terminals(R)).find((x) => x.id === s.id), 'the session back');
    assert.strictEqual(back.sessionId, s.sessionId);
    await until(async () => (await stateOf(R, s.id)) === 'idle', 'the queued Stop');
    assert.ok(!fs.existsSync(queueFile(home)), 'the queue is cleared');
  });

  await t.test('the newest queued event wins, wherever it sits in the file', async () => {
    await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid });
    assert.strictEqual(await stateOf(R, s.id), 'working');
    await R.kill();
    await sleep(500);  // both queued events are newer than the live prompt
    const now = Date.now(), auth = queue.hash(token), to = 'http://127.0.0.1:' + port + '/channels/t/commands';
    // The Stop came last, but sits first in the file.
    queue.append(path.join(home, '.office-world'), { to, auth, event: { hook_event_name: 'Stop', session_id: sid, at: now - 100 } });
    queue.append(path.join(home, '.office-world'), { to, auth, event: { hook_event_name: 'UserPromptSubmit', session_id: sid, at: now - 200 } });
    R = await relay(env, home, { port });
    await until(async () => !fs.existsSync(queueFile(home)), 'the queue to be read');
    await sleep(300);
    assert.strictEqual(await stateOf(R, s.id), 'idle');
  });

  await t.test('an older event never overwrites a newer state', async () => {
    const now = Date.now();
    await R.hook({ hook_event_name: 'Stop', session_id: sid, at: now });
    await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid, at: now - 5000 });
    await sleep(200);
    assert.strictEqual(await stateOf(R, s.id), 'idle');
    await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid, at: now + 1 });
    assert.strictEqual(await stateOf(R, s.id), 'working', 'a newer one still does');
  });

  await t.test('another room\'s event is not applied: another port, or a token that is not this relay\'s', async () => {
    await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid });
    await R.kill();
    const dir = path.join(home, '.office-world'), at = Date.now();
    queue.append(dir, { to: 'http://127.0.0.1:' + (port + 1) + '/channels/t/commands', auth: queue.hash(token), event: { hook_event_name: 'Stop', session_id: sid, at } });
    queue.append(dir, { to: 'http://127.0.0.1:' + port + '/channels/t/commands', auth: queue.hash('not-a-token'), event: { hook_event_name: 'Stop', session_id: sid, at } });
    R = await relay(env, home, { port });
    await until(async () => !fs.existsSync(queueFile(home)), 'the queue to be read');
    await sleep(300);
    assert.strictEqual(await stateOf(R, s.id), 'working');
  });
});

test('the hook queues in the folder RELAY_STATE_DIR names, so two rooms keep apart', () => {
  const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-queue-'));
  try {
    const other = path.join(home, 'second-office');
    fs.mkdirSync(other); fs.mkdirSync(path.join(home, '.office-world'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OFFICE_|RELAY_)/.test(k)));
    Object.assign(env, { HOME: home, RELAY_STATE_DIR: other, OFFICE_SHOW_TITLES: '0', OFFICE_TICKET_TOKEN: 'abc', OFFICE_HOOK_URL: 'http://127.0.0.1:9/channels/t/commands' });
    const r = spawnSync('node', [HOOK], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'x' }), env, encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(r.status, 0);
    assert.ok(fs.existsSync(path.join(other, 'hook-queue.jsonl')));
    assert.ok(!fs.existsSync(path.join(home, '.office-world', 'hook-queue.jsonl')));
    // No room has run with that folder, so nothing is kept.
    fs.rmSync(other, { recursive: true });
    spawnSync('node', [HOOK], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'x' }), env, encoding: 'utf8', timeout: 10000 });
    assert.ok(!fs.existsSync(other), 'no folder made');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a PR opened while the relay is down gets its first review once it is back', async (t) => {
  let R = await relay({}, null, { autoReview: true });
  const home = R.home, port = R.port, repo = makeRepo(home), origin = path.join(home, 'origin.git');
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  execFileSync('git', ['init', '-q', '--bare', origin]);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: repo });
  execFileSync('git', ['push', '-qf', origin, 'HEAD:refs/pull/7/head'], { cwd: repo });
  const pr = 'https://github.com/acme/widgets/pull/7';
  await R.kill();
  // As the hook queues it for a session started by hand: with the key, for this relay's port.
  queue.append(path.join(home, '.office-world'), { to: 'http://127.0.0.1:' + port + '/channels/t/commands', auth: queue.hash('test-key'),
    event: { hook_event_name: 'PostToolUse', session_id: 'by-hand-0001', tool_name: 'Bash', pr_url: pr, cwd: repo, at: Date.now() } });
  R = await relay({}, home, { autoReview: true, port });
  const reviewer = await until(async () => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.role === 'reviewer' && x.pr === pr), 'the first review');
  assert.strictEqual(reviewer.title, 'Review PR #7');
});
