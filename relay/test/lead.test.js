'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');

test('the saved Lead', async (t) => {
  let R = await relay();
  const home = R.home, file = path.join(home, '.office-world', 'lead.json'), repo = makeRepo(home);
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')).t;
  const talk = (id) => R.hook({ hook_event_name: 'UserPromptSubmit', session_id: id.slice(0, 12), title: '' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });

  const a = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await t.test('nothing to offer at first', async () => {
    const g = (await R.call('GET', '/terminals')).body;
    assert.strictEqual(g.restore, null);
    assert.strictEqual(g.lead, null);
  });
  await t.test('a session with no conversation is not saved until the brief starts one', async () => {
    // Hooks reach the relay from it, as a new session's SessionStart says. A Stop would mean a turn began.
    await R.hook({ hook_event_name: 'SessionStart', source: 'startup', session_id: a.sessionId.slice(0, 12) });
    await R.call('POST', '/terminals/' + a.id + '/input', { data: 'printing keeps the brief back for a moment\r' });
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: a.id })).status, 200);
    assert.ok(!fs.existsSync(file));
    await until(() => fs.existsSync(file), 'the brief to save it');
    assert.strictEqual(saved().sessionId, a.sessionId);
  });
  await t.test('once it has talked, it is saved privately', async () => {
    await talk(a.sessionId); await sleep(200);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: a.id })).status, 200);
    assert.strictEqual(saved().sessionId, a.sessionId);
    assert.strictEqual(saved().cwd, repo);
    assert.strictEqual((fs.statSync(file).mode & 0o777).toString(8), '600');
    assert.strictEqual((await R.call('GET', '/terminals')).body.restore, null, 'not offered in the same run');
  });
  const b = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await t.test('a new Lead overwrites it', async () => {
    await talk(b.sessionId); await sleep(200);
    await R.call('POST', '/terminals/lead', { terminal: b.id });
    assert.strictEqual(saved().sessionId, b.sessionId);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: '000000000000' })).status, 404);
    assert.strictEqual(saved().sessionId, b.sessionId);
  });
  const fresh = '11111111-2222-4333-8444-555555555555';
  await t.test('/clear gives the full id, and the file waits for a conversation', async () => {
    await R.call('POST', '/terminals/' + b.id + '/input', { data: 'printing keeps the brief back for a moment\r' });
    await R.hook({ hook_event_name: 'SessionStart', source: 'clear', session_id: fresh.slice(0, 12), full_session_id: fresh, terminal: b.id });
    await sleep(200);
    const term = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === b.id);
    assert.strictEqual(term.sessionId, fresh);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: b.id })).status, 200);
    assert.strictEqual(saved().sessionId, b.sessionId);
    await talk(fresh); await sleep(200);
    await R.call('POST', '/terminals/lead', { terminal: b.id });
    assert.strictEqual(saved().sessionId, fresh);
  });
  await t.test('an old hook with a short id is not saved', async () => {
    await R.hook({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'abcdefabcdef', terminal: b.id });
    await sleep(200); await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'abcdefabcdef' }); await sleep(200);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: b.id })).body.error, 'bad_session');
    assert.strictEqual(saved().sessionId, fresh);
  });
  await R.kill();
  R = await relay({}, home);
  await t.test('after a restart it is offered, until it runs or you answer', async () => {
    const g = (await R.call('GET', '/terminals')).body;
    assert.strictEqual(g.restore.sessionId, fresh);
    const r = (await R.call('POST', '/terminals', { cwd: g.restore.cwd, resume: fresh })).body;
    assert.strictEqual(r.sessionId, fresh);
    assert.strictEqual((await R.call('GET', '/terminals')).body.restore, null);
    await R.call('POST', '/terminals/' + r.id + '/stop', {});
    await until(async () => (await R.call('GET', '/terminals')).body.terminals.length === 0, 'it to stop');
    assert.ok((await R.call('GET', '/terminals')).body.restore, 'offered again if not answered');
    await R.call('POST', '/terminals/lead', { asked: true });
    assert.strictEqual((await R.call('GET', '/terminals')).body.restore, null);
    assert.strictEqual(saved().sessionId, fresh, 'and the file stays');
  });
  await R.kill();
  R = await relay({}, home);
  await t.test('it asks again on the next restart', async () => {
    assert.strictEqual((await R.call('GET', '/terminals')).body.restore.sessionId, fresh);
  });
});

// Settings sends lead: true, so a press made before the page saw another session become the Lead
// (in another tab) does not make the old one the Lead again.
test('a grant with lead: true goes only to the Lead there is now', async (t) => {
  const R = await relay({ RELAY_WIP_LIMIT: '5' });
  t.after(() => R.stop());
  const repo = makeRepo(R.home);
  const start = async () => (await R.call('POST', '/terminals', { cwd: repo })).body;
  const talk = (s) => R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12) });
  const a = await start(), b = await start();
  await talk(a); await talk(b);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: a.id })).status, 200);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: b.id })).status, 200);  // another tab
  const stale = await R.call('POST', '/terminals/lead', { terminal: a.id, lead: true, board: true });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.body.error, 'not_lead');
  const terms = (await R.call('GET', '/terminals')).body.terminals;
  assert.deepStrictEqual([terms.find((x) => x.id === a.id).lead, terms.find((x) => x.id === b.id).lead, terms.find((x) => x.id === a.id).board], [false, true, false], 'B is still the Lead, and A got nothing');
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: b.id, lead: true, board: true })).body.board, true, 'the Lead there is now gets it');
});
