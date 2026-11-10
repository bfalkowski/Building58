'use strict';
// Two rooms on one computer: each relay keeps its state in its own folder (RELAY_STATE_DIR), and
// the sessions a relay starts report their hooks to that relay, even when the hooks in
// ~/.claude/settings.json name another one.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn } = require('child_process');
const { relay, makeRepo, until, sessionToken, ROOT } = require('./helpers.js');

const HOOK = path.join(ROOT, 'relay', 'office-hook.js');
const newHome = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
const text = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; } };
const terminal = async (R, id) => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === id);
// Runs the real hook with one event on stdin and the environment given, as Claude Code would.
function runHook(env, event) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('exit', resolve);
    child.stdin.end(JSON.stringify(event));
  });
}

test('two relays with their own state folders keep apart, and both save', async (t) => {
  const home = newHome();
  const dirA = path.join(home, 'office-a'), dirB = path.join(home, 'office-b');
  let B = null;
  const A = await relay({ RELAY_STATE_DIR: dirA }, home);
  t.after(async () => { await A.stop(); if (B) await B.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  B = await relay({ RELAY_STATE_DIR: dirB }, home);
  const repo = makeRepo(home);

  // A Board change on each.
  const a = await A.call('POST', '/tickets', { title: 'Only in room A', repo });
  assert.strictEqual(a.status, 201, JSON.stringify(a.body));
  const b = await B.call('POST', '/tickets', { title: 'Only in room B', repo });
  assert.strictEqual(b.status, 201, JSON.stringify(b.body));
  const titles = async (R) => (await R.call('GET', '/tickets')).body.tickets.map((x) => x.title);
  assert.deepStrictEqual(await titles(A), ['Only in room A']);
  assert.deepStrictEqual(await titles(B), ['Only in room B']);

  // A session on each, and a hook event on A for A's session.
  const sa = (await A.call('POST', '/terminals', { cwd: repo })).body;
  const sb = (await B.call('POST', '/terminals', { cwd: repo })).body;
  await until(async () => (await A.screen(sa.id)).includes('❯'), 'A\'s session');
  await until(async () => (await B.screen(sb.id)).includes('❯'), 'B\'s session');
  await A.hook({ hook_event_name: 'UserPromptSubmit', session_id: sa.sessionId.slice(0, 12), title: 'Working in A' });
  await until(async () => (await terminal(A, sa.id)).state === 'working', 'A\'s session to work');
  assert.notStrictEqual((await terminal(B, sb.id)).state, 'working', 'B never heard A\'s hook');
  assert.strictEqual((await B.call('GET', '/terminals')).body.terminals.length, 1, 'B runs only its own session');

  // Both saved, each in its own folder, and nothing went to ~/.office-world.
  await until(() => text(path.join(dirA, 'tickets.json')).includes('Only in room A') && text(path.join(dirB, 'tickets.json')).includes('Only in room B'), 'both relays to save their tickets');
  assert.doesNotMatch(text(path.join(dirA, 'tickets.json')), /room B/);
  assert.doesNotMatch(text(path.join(dirB, 'tickets.json')), /room A/);
  await until(() => {
    const ids = (dir) => ((readJson(path.join(dir, 'sessions.json')) || {}).t || []).map((s) => s.sessionId);
    return ids(dirA).includes(sa.sessionId) && ids(dirB).includes(sb.sessionId) && !ids(dirA).includes(sb.sessionId) && !ids(dirB).includes(sa.sessionId);
  }, 'each relay to save only its own session');
  assert.ok(!fs.existsSync(path.join(home, '.office-world', 'tickets.json')), 'no tickets in the default folder');
  assert.doesNotMatch(A.output() + B.output(), /Another relay \(pid \d+\) owns/, 'neither relay found its files taken');
});

test('a session started by relay A reports to A, even when the hook command names relay B', async (t) => {
  const home = newHome();
  // Global hooks are installed, so the relay gives the session no hooks of its own.
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'OFFICE_RELAY_KEY=key-b node ' + HOOK }] }] } }));
  // Relay B only listens, so the test sees anything that reaches it.
  const toB = [];
  const B = http.createServer((req, res) => { toB.push(req.method + ' ' + req.url); res.end('{}'); });
  await new Promise((r) => B.listen(0, '127.0.0.1', r));
  const A = await relay({ RELAY_STATE_DIR: path.join(home, 'office-a') }, home);
  t.after(async () => { await A.stop(); B.close(); fs.rmSync(home, { recursive: true, force: true }); });

  const s = (await A.call('POST', '/terminals', { cwd: home })).body;
  const out = await until(async () => { const x = await A.screen(s.id); return /office hook url: \S+/.test(x) && x; }, 'the session');
  const url = out.match(/office hook url: (\S+)/)[1];
  assert.strictEqual(url, 'http://127.0.0.1:' + A.port + '/channels/t/commands', 'the relay names itself to the session');
  const token = sessionToken(s.sessionId);

  // The session's environment, with the global hook's inline settings for B on top.
  const env = { PATH: process.env.PATH, HOME: home, OFFICE_TERMINAL_ID: s.id, OFFICE_CHANNEL: 't', OFFICE_TICKET_TOKEN: token, OFFICE_HOOK_URL: url,
    OFFICE_RELAY_KEY: 'key-b', OFFICE_RELAY_URL: 'http://127.0.0.1:' + B.address().port };
  await runHook(env, { hook_event_name: 'UserPromptSubmit', session_id: s.sessionId, cwd: home });
  await until(async () => (await terminal(A, s.id)).state === 'working', 'A to hear the hook');
  assert.deepStrictEqual(toB, [], 'nothing went to B');

  // A session started by hand has none of these, and goes where its own settings say.
  const plain = { PATH: process.env.PATH, HOME: home, OFFICE_RELAY_KEY: 'key-b', OFFICE_RELAY_URL: 'http://127.0.0.1:' + B.address().port, OFFICE_CHANNEL: 'office' };
  await runHook(plain, { hook_event_name: 'Stop', session_id: 'by-hand', cwd: home });
  assert.deepStrictEqual(toB, ['POST /channels/office/commands']);
});

test('a session token sends only hooks, and only about its own session', async (t) => {
  const R = await relay();
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const s = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const other = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await until(async () => (await R.screen(s.id)).includes('❯') && (await R.screen(other.id)).includes('❯'), 'the sessions');
  const headers = { 'X-Office-Token': sessionToken(s.sessionId) };
  const send = (body) => R.call('POST', '/commands', body, headers);

  assert.strictEqual((await send({ action: 'add', thing: 'dog', wait: false })).status, 403, 'not a hook');
  assert.strictEqual((await send({ action: 'hook', wait: false, event: { hook_event_name: 'UserPromptSubmit', session_id: other.sessionId.slice(0, 12) } })).status, 403, 'another session');
  assert.notStrictEqual((await terminal(R, other.id)).state, 'working');
  await send({ action: 'hook', wait: false, event: { hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12) } });
  await until(async () => (await terminal(R, s.id)).state === 'working', 'its own hook to count');
  assert.strictEqual((await R.call('POST', '/commands', { action: 'hook', wait: false, event: {} }, { 'X-Office-Token': 'wrong' })).status, 401);
});

test('RELAY_STATE_DIR moves every state file, the Lead\'s notes too, and a file\'s own variable still wins', async (t) => {
  const home = newHome(), dir = path.join(home, 'state'), tickets = path.join(home, 'elsewhere', 'tickets.json');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const load = (env) => JSON.parse(execFileSync(process.execPath, ['-e', 'const r = require("./relay/lead-refresh.js"); console.log(JSON.stringify({ notes: r.NOTES, prompt: r.NOTES_PROMPT + r.READ_PROMPT }))'], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: 'utf8' }));
  assert.strictEqual(load({}).notes, '~/.office-world/lead-notes/notes.md', 'the default');
  const moved = load({ RELAY_STATE_DIR: dir });
  assert.strictEqual(moved.notes, '~/state/lead-notes/notes.md', 'under the home folder, so shown from ~');
  assert.strictEqual(load({ RELAY_STATE_DIR: '/var/office-b' }).notes, '/var/office-b/lead-notes/notes.md');
  assert.strictEqual(moved.prompt.split(moved.notes).length, 3, 'both prompts name the moved notes');

  const R = await relay({ RELAY_STATE_DIR: dir, RELAY_TICKETS_FILE: tickets }, home);
  t.after(R.stop);
  const repo = makeRepo(home);
  assert.strictEqual((await R.call('POST', '/tickets', { title: 'Kept elsewhere', repo })).status, 201);
  assert.strictEqual((await R.call('POST', '/settings', { values: { wipLimit: 4 } })).status, 200);
  await until(() => text(tickets).includes('Kept elsewhere') && fs.existsSync(path.join(dir, 'settings.json')), 'the files');
  assert.ok(!fs.existsSync(path.join(dir, 'tickets.json')), 'RELAY_TICKETS_FILE wins');
  assert.ok(!fs.existsSync(path.join(home, '.office-world')), 'nothing in the default folder');
});
