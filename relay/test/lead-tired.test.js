// How tired the Lead is: how full its context is. Claude Code hands the number to a session's status
// line, relay/status-line.js sends it to the relay with the session's token, and the relay keeps it
// with the session for the Floor, ticket.js floor and ticket.js tired. The levels on their own, then
// through a real relay with a fake `claude`.
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sessionToken, ROOT } = require('./helpers.js');
const tired = require('../lead-tired.js');
const { line } = require('../status-line.js');

const CLI = path.join(ROOT, 'relay', 'ticket.js'), STATUS_LINE = path.join(ROOT, 'relay', 'status-line.js');
// What Claude Code 2.1.319 handed a status line, cut to the parts used here: before the first reply,
// and after it.
const BEFORE = { session_id: 'bcb99e8e-543c-43d4-a389-b1f31dc30af0', context_window: { total_input_tokens: 0, total_output_tokens: 0, context_window_size: 1000000, current_usage: null, used_percentage: null, remaining_percentage: null } };
const AFTER = { session_id: 'bcb99e8e-543c-43d4-a389-b1f31dc30af0', context_window: { total_input_tokens: 49741, total_output_tokens: 6, context_window_size: 1000000, current_usage: { input_tokens: 2, output_tokens: 6, cache_creation_input_tokens: 19335, cache_read_input_tokens: 30404 }, used_percentage: 5, remaining_percentage: 95 } };
const usedAt = (sid, percent) => ({ session_id: sid, context_window: { context_window_size: 200000, used_percentage: percent } });

test('the levels', async (t) => {
  await t.test('the part used comes from what Claude Code gives the status line', () => {
    assert.strictEqual(tired.percentOf(BEFORE), null, 'no number before the first reply');
    assert.strictEqual(tired.percentOf(AFTER), 5);
    // An older Claude Code with no used_percentage: the tokens of the last call over the window.
    const old = { context_window: { context_window_size: 200000, current_usage: { input_tokens: 1000, cache_creation_input_tokens: 9000, cache_read_input_tokens: 90000, output_tokens: 500 } } };
    assert.strictEqual(tired.percentOf(old), 50);
    assert.strictEqual(tired.percentOf(null), null);
    assert.strictEqual(tired.percentOf({}), null);
  });
  await t.test('three levels, with needs a refresh before Claude Code compacts by itself', () => {
    const at = (p) => tired.levelOf(p).key;
    assert.deepStrictEqual([0, 49, 50, 69, 70, 100].map(at), ['fresh', 'fresh', 'tired', 'tired', 'refresh', 'refresh']);
    assert.strictEqual(tired.levelOf(null), null);
  });
  await t.test('the status line says the level in the session\'s own terminal', () => {
    assert.strictEqual(line(AFTER), '○ context 5% · fresh');
    assert.strictEqual(line(usedAt('x', 62)), '◑ context 62% · getting tired');
    assert.strictEqual(line(usedAt('x', 81)), '● context 81% · needs a refresh');
    assert.strictEqual(line(BEFORE), 'context: no reply yet');
    assert.strictEqual(line(null), 'context: no reply yet');
  });
  await t.test('a number from before a /clear is not the new conversation\'s', () => {
    const t1 = { sessionId: 'a', context: { percent: 80, size: 200000, sessionId: 'a', at: 0 } };
    assert.strictEqual(tired.tiredOf(t1).key, 'refresh');
    assert.strictEqual(tired.tiredOf(Object.assign({}, t1, { sessionId: 'b' })), null);
  });
});

test('the relay learns how tired the Lead is from its status line', async (t) => {
  const R = await relay();
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const a = (await R.call('POST', '/terminals', { cwd: repo })).body, b = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.call('POST', '/terminals/lead', { terminal: a.id });
  const aToken = await until(() => { try { return sessionToken(a.sessionId); } catch (e) { return null; } }, 'the Lead\'s token');
  const bToken = await until(() => { try { return sessionToken(b.sessionId); } catch (e) { return null; } }, 'the other token');
  const hookUrl = R.base + '/commands';
  // The status line as Claude Code runs it in that session: with the env the relay gave it, JSON on stdin.
  const statusLine = (token, input) => spawnSync('node', [STATUS_LINE], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000, env: { ...process.env, OFFICE_HOOK_URL: hookUrl, OFFICE_TICKET_TOKEN: token } });
  const lead = async () => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === a.id);
  const cli = (...args) => execFileSync('node', [CLI].concat(args), { env: { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: aToken }, encoding: 'utf8' });

  await t.test('every session the room starts gets the room\'s status line', async () => {
    const screen = await until(async () => { const s = await R.screen(a.id); return s.includes('statusLine') && s; }, 'the settings');
    assert.ok(screen.includes(STATUS_LINE), 'it runs relay/status-line.js');
  });
  await t.test('before the status line says anything, nobody guesses', async () => {
    assert.strictEqual((await lead()).tired, null);
    assert.match(cli('tired'), /^The relay does not know yet/);
    assert.match(cli('floor'), /Lead · idle · context use not known yet/);
  });
  await t.test('the status line prints the level and the relay keeps it with the session', async () => {
    const r = statusLine(aToken, usedAt(a.sessionId, 62));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '◑ context 62% · getting tired\n');
    const got = await until(async () => (await lead()).tired, 'the relay to keep it');
    assert.strictEqual(got.percent, 62); assert.strictEqual(got.key, 'tired'); assert.strictEqual(got.label, 'getting tired'); assert.strictEqual(got.size, 200000);
  });
  await t.test('the Lead reads the same number from the relay', () => {
    assert.match(cli('tired'), /^The Lead is getting tired: 62% of its context window used since its last \/clear or refresh\. Fresh below 50%, getting tired from 50%, needs a refresh from 70%\.\n$/);
    assert.match(cli('floor'), /Lead · idle · context 62% used, getting tired/);
  });
  await t.test('the Floor has it for the Lead only', async () => {
    const rows = (await R.call('GET', '/floor')).body.sessions;
    assert.strictEqual(rows.find((s) => s.terminal === a.id).tired.key, 'tired');
    assert.strictEqual(rows.find((s) => s.terminal === b.id).tired, null);
  });
  await t.test('only a session\'s own status line sets its number', async () => {
    // Another session's token with the Lead's conversation: it is not that session's conversation.
    let r = await fetch(R.base + '/terminals/context', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': bToken }, body: JSON.stringify({ session_id: a.sessionId, percent: 5 }) });
    assert.strictEqual(r.status, 409);
    // The person's key is not a status line.
    r = await R.call('POST', '/terminals/context', { session_id: a.sessionId, percent: 5 });
    assert.strictEqual(r.status, 403);
    // No token at all.
    r = await fetch(R.base + '/terminals/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: a.sessionId, percent: 5 }) });
    assert.strictEqual(r.status, 401);
    assert.strictEqual((await lead()).tired.percent, 62, 'unchanged');
  });
  await t.test('needs a refresh from 70%', async () => {
    assert.strictEqual(statusLine(aToken, usedAt(a.sessionId, 74)).stdout, '● context 74% · needs a refresh\n');
    await until(async () => (await lead()).tired.key === 'refresh', 'needs a refresh');
  });
  await t.test('after /clear, the old number is gone until the new conversation\'s status line comes', async () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    await R.hook({ hook_event_name: 'SessionStart', source: 'clear', session_id: sid.slice(0, 12), full_session_id: sid, terminal: a.id });
    await until(async () => (await lead()).sessionId === sid, 'the new conversation');
    assert.strictEqual((await lead()).tired, null);
    statusLine(aToken, usedAt(sid, 3));
    await until(async () => { const x = (await lead()).tired; return x && x.key === 'fresh' && x.percent === 3; }, 'fresh again');
  });
  await t.test('with the relay away, the status line still prints and exits 0 within the second it gives the relay', () => {
    const at = Date.now();
    const r = spawnSync('node', [STATUS_LINE], { input: JSON.stringify(usedAt('x', 10)), encoding: 'utf8', timeout: 5000, env: { ...process.env, OFFICE_HOOK_URL: 'http://127.0.0.1:9/channels/t/commands', OFFICE_TICKET_TOKEN: 'nope' } });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '○ context 10% · fresh\n');
    assert.ok(Date.now() - at < 2500, 'took ' + (Date.now() - at) + ' ms');
  });
});
