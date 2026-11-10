// A session told something that never starts a turn, through a real relay with a fake `claude`: the
// relay tries once more, then the Floor, ticket.js floor and #office say it is stuck, with why.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until, sessionToken, ROOT } = require('./helpers.js');

const CLI = path.join(ROOT, 'relay', 'ticket.js');
const POINTER = /GOT\[[^\]a-z]{0,8}The room chat board has/g;  // what the fake claude got, not the echo of typing

test('a session that was told something and did not start shows as stuck', async (t) => {
  const R = await relay({ RELAY_TOLD_CHECK_MS: '1500' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(150); };
  const finish = async (s) => { await hook(s, { hook_event_name: 'UserPromptSubmit' }); await hook(s, { hook_event_name: 'Stop' }); };
  const rowOf = async (id) => (await R.call('GET', '/floor')).body.sessions.find((r) => r.terminal === id);
  const texts = async (room) => ((await R.call('GET', '/chat/' + room)).body.posts || []).map((p) => p.text);

  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const ticket = (await R.call('POST', '/tickets', { title: 'Merge main', body: 'Do it.', repo })).body.ticket;
  const task = (await R.call('POST', '/tickets/' + ticket.id + '/start', {})).body.task;
  const dev = { id: task.worker.terminal, sessionId: (await R.call('GET', '/tasks/' + task.id)).body.task.owner.sessionId };
  // The name the relay gave the Dev, from the roster's pool (relay/seats.js).
  const name = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === dev.id).who;
  await until(async () => (await R.screen(dev.id)).includes('GOT['), 'the brief');
  await finish(dev); await finish(lead);
  await until(async () => (await R.call('GET', '/tasks/' + task.id)).body.task.briefed, 'the brief to be in, once a turn began after it');
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
  await until(async () => (await R.screen(lead.id)).includes('GOT['), 'the Lead\'s brief');
  await finish(lead);

  await t.test('told, and a turn begins: it stays idle, and is told once', async () => {
    await R.call('POST', '/chat/' + ticket.id, { text: '@' + name + ' one' });
    await until(async () => ((await R.screen(dev.id)).match(POINTER) || []).length === 1, 'the pointer');
    await finish(dev);
    await sleep(4000);
    const row = await rowOf(dev.id);
    assert.strictEqual(row.state, 'idle');
    assert.strictEqual(row.stuck, null);
    assert.strictEqual(((await R.screen(dev.id)).match(POINTER) || []).length, 1, 'not typed again');
  });

  await t.test('told, and no turn begins: one more try, then stuck with how long ago and why', async () => {
    const before = ((await R.screen(dev.id)).match(/GOT\[/g) || []).length;
    await R.call('POST', '/chat/' + ticket.id, { text: '@' + name + ' two' });
    await until(async () => ((await R.screen(dev.id)).match(POINTER) || []).length === 2, 'the pointer');
    const row = await until(async () => { const r = await rowOf(dev.id); return r.stuck && r; }, 'stuck', 100);
    assert.match(row.state, /^stuck: told 0 min ago and did not start, /);
    assert.match(row.desk.doing.words, /^stuck: told 0 min ago, did not start$/);
    assert.match(row.desk.next.text, /^Waiting on you: it did not start on what it was told, .*Bring it back$/);
    // The fake echoes each line, so the note shows since Enter: the second try is Enter, not the note again.
    const screen = await R.screen(dev.id);
    assert.strictEqual((screen.match(POINTER) || []).length, 2, 'the note is not typed twice');
    assert.strictEqual((screen.match(/GOT\[/g) || []).length, before + 2, 'the note, and one Enter');
    assert.ok((await texts('office')).some((x) => x.startsWith(name + ' on T-1 did not start on what the room told it, so it is stuck: ') && x.endsWith('Bring it back.')), 'said in #office');
    await sleep(4000);
    assert.strictEqual(((await R.screen(dev.id)).match(/GOT\[/g) || []).length, before + 2, 'then it stops trying');
  });

  await t.test('ticket.js floor shows it as stuck, not idle', async () => {
    const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: sessionToken(lead.sessionId) };
    const out = execFileSync('node', [CLI, 'floor'], { env, encoding: 'utf8' });
    assert.ok(out.split('\n').some((l) => l.startsWith(name + ' · Dev, T-1 · stuck: told 0 min ago and did not start, ')), out);
  });

  await t.test('a turn that begins in it clears stuck, and the note is not typed again', async () => {
    await finish(dev);
    const row = await rowOf(dev.id);
    assert.strictEqual(row.state, 'idle');
    assert.strictEqual(row.stuck, null);
    await sleep(2000);
    assert.strictEqual(((await R.screen(dev.id)).match(POINTER) || []).length, 2);
  });
});
