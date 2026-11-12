// The relay starts with a running Lead on the room's channel (relay/sessions.js, startLead): the saved
// Lead comes back if it can, and otherwise a new plain session in the relay's folder is made the Lead.
// Never a second one. RELAY_LEAD=0 turns it off, and RELAY_RESUME=0 starts with nobody.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, ROOT } = require('./helpers.js');
const roster = require('../../office/roster.js');

// The room's channel comes from office/world.json, not the tests' channel t.
const CHANNEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'office', 'world.json'), 'utf8')).channel;
const ON = { RELAY_RESUME: '1', RELAY_LEAD: '1' };
const roomCall = async (R, method, p, body) => {
  const r = await fetch('http://127.0.0.1:' + R.port + '/channels/' + CHANNEL + p, { method, headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  return { status: r.status, body: await r.json() };
};
const room = async (R) => (await roomCall(R, 'GET', '/terminals')).body;
const leads = async (R) => (await room(R)).terminals.filter((x) => x.running && x.lead);
const newHome = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
const saveLead = (home, saved) => {
  const file = path.join(home, '.office-world', 'lead.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ [CHANNEL]: saved }));
  return file;
};

test('with nothing saved, the relay starts a new Lead called by the Lead desk\'s name', async (t) => {
  let R = await relay(ON);
  const home = R.home;
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const [lead] = await until(async () => { const l = await leads(R); return l.length && l; }, 'a Lead');
  assert.strictEqual(lead.cwd, fs.realpathSync(ROOT), 'it starts in the folder the relay runs in');
  assert.deepStrictEqual([lead.board, lead.merge, lead.starts], [false, false, 0], 'every permission off');
  assert.deepStrictEqual([lead.seat, lead.who], ['lead', roster.lead.name], 'it sits at the Lead\'s desk, with its name');
  assert.strictEqual(roster.lead.name, 'Paul');
  assert.strictEqual((await room(R)).restore, null, 'nothing is offered back');
  await until(async () => /GOT\[You are the Lead/.test(await screenOf(R, lead.id)), 'the Lead\'s brief');

  await t.test('a restart brings it back, and starts no second Lead', async () => {
    // A turn began on the brief, so it has a conversation to come back to.
    await roomCall(R, 'POST', '/commands', { action: 'hook', wait: false, event: { hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12) } });
    await until(() => { try { return JSON.parse(fs.readFileSync(path.join(home, '.office-world', 'lead.json'), 'utf8'))[CHANNEL].sessionId === lead.sessionId; } catch (e) { return false; } }, 'the Lead saved');
    await R.kill();
    R = await relay(ON, home);
    const after = await until(async () => { const l = (await room(R)).terminals.filter((x) => x.running); return l.length && l; }, 'the Lead back');
    assert.strictEqual(after.length, 1, after.map((x) => x.sessionId).join(', '));
    assert.strictEqual(after[0].sessionId, lead.sessionId);
    assert.strictEqual(after[0].lead, true);
  });
});

// The test helper's screen reads channel t, so this reads the room's channel.
async function screenOf(R, id) {
  const ctl = new AbortController();
  const r = await fetch('http://127.0.0.1:' + R.port + '/channels/' + CHANNEL + '/terminals/' + id + '/stream', { headers: { Authorization: 'Bearer test-key' }, signal: ctl.signal });
  let text = '';
  const reader = r.body.getReader(), dec = new TextDecoder();
  setTimeout(() => ctl.abort(), 300);
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); } } catch (e) { /* cut off on purpose */ }
  return [...text.matchAll(/event: out\ndata: "([^"]+)"/g)].map((m) => Buffer.from(m[1], 'base64').toString()).join('');
}

test('the saved Lead comes back as the Lead, with the permissions you granted', async (t) => {
  const home = newHome(), repo = makeRepo(home);
  const sid = '11111111-2222-4333-8444-555555555555';
  saveLead(home, { sessionId: sid, cwd: repo, title: 'Lead work', board: true, merge: false, starts: 0, startsLeft: 0 });
  const R = await relay(ON, home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const [lead] = await until(async () => { const l = await leads(R); return l.length && l; }, 'the saved Lead');
  assert.deepStrictEqual([lead.sessionId, lead.cwd, lead.board, lead.merge], [sid, repo, true, false]);
  assert.strictEqual((await room(R)).restore, null, 'nothing is left to offer back');
  assert.strictEqual((await room(R)).terminals.filter((x) => x.running).length, 1);
});

test('a saved Lead that cannot come back gives way to a new Lead, with no permissions', async (t) => {
  const home = newHome(), repo = makeRepo(home);
  const sid = '22222222-3333-4444-8555-666666666666';
  const file = saveLead(home, { sessionId: sid, cwd: repo, title: 'Lead work', board: true, merge: true, starts: 1, startsLeft: 2 });
  const R = await relay(Object.assign({ FAKE_CLAUDE_FAIL_RESUME: '1' }, ON), home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const [lead] = await until(async () => { const l = (await leads(R)).filter((x) => x.sessionId !== sid); return l.length && l; }, 'a new Lead');
  assert.strictEqual(lead.cwd, fs.realpathSync(ROOT));
  assert.deepStrictEqual([lead.board, lead.merge, lead.starts], [false, false, 0]);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))[CHANNEL];
  assert.deepStrictEqual([saved.board, saved.merge, saved.starts], [false, false, 0], 'the old grants are not kept for the next Lead');
  assert.strictEqual((await leads(R)).length, 1);
});

test('RELAY_LEAD=0 and RELAY_RESUME=0 start no Lead', async (t) => {
  for (const env of [{ RELAY_RESUME: '1', RELAY_LEAD: '0' }, { RELAY_RESUME: '0', RELAY_LEAD: '1' }]) {
    const R = await relay(env);
    t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
    await new Promise((r) => setTimeout(r, 500));
    assert.deepStrictEqual((await room(R)).terminals, [], JSON.stringify(env));
  }
});
