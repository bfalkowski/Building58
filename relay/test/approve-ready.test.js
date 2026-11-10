'use strict';
// Approve all Ready: one press marks every Ready ticket with no person's approval as approved by you,
// so Autopilot and the Lead can start it. Tickets from before approvals were kept have none.
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sessionToken } = require('./helpers.js');

test('Approve all Ready', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-test-')));
  const repo = makeRepo(home), at = new Date().toISOString();
  const old = (id, extra) => Object.assign({ id, title: 'Old ' + id, body: '', priority: 'normal', repo, status: 'ready', createdBy: 'Worker on something', createdAt: at, updatedAt: at, blockedBy: [] }, extra);
  fs.mkdirSync(path.join(home, '.office-world'), { recursive: true });
  fs.writeFileSync(path.join(home, '.office-world', 'tickets.json'), JSON.stringify({ t: { next: 5, tickets: [
    old('T-1'), old('T-2', { approvedBy: 'none' }), old('T-3', { approvedBy: 'Lead' }), old('T-4', { status: 'triage' })
  ] } }));
  const R = await relay(null, home);
  t.after(R.stop);
  const get = async () => (await R.call('GET', '/tickets')).body.tickets;
  const byId = async (id) => (await get()).find((x) => x.id === id);

  await t.test('the Board says which Ready tickets no person approved', async () => {
    assert.deepStrictEqual((await get()).filter((x) => x.status === 'ready' && !x.approved).map((x) => x.id), ['T-1', 'T-2', 'T-3']);
  });
  await t.test('a session cannot approve them', async () => {
    const s = (await R.call('POST', '/terminals', { cwd: repo })).body;
    const token = { 'X-Office-Token': await until(() => { try { return sessionToken(s.sessionId); } catch (e) { return null; } }, 'its token') };
    assert.strictEqual((await R.call('POST', '/tickets/approve-ready', {}, token)).status, 401);
    assert.strictEqual((await byId('T-1')).approved, false);
  });
  await t.test('it approves only the tickets the button showed', async () => {
    const r = await R.call('POST', '/tickets/approve-ready', { ids: ['T-2', 'T-4', 'T-9'] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.approved, ['T-2'], 'T-4 is in Triage and T-9 is not there');
    assert.strictEqual((await byId('T-1')).approved, false, 'T-1 was not shown, so it waits');
    assert.strictEqual((await R.call('POST', '/tickets/approve-ready', { ids: 'T-1' })).status, 400, 'ids is a list');
  });
  await t.test('with no list, one press approves every Ready ticket left, and nothing in Triage', async () => {
    const r = await R.call('POST', '/tickets/approve-ready', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.approved, ['T-1', 'T-3']);
    for (const id of ['T-1', 'T-2', 'T-3']) {
      const x = await byId(id);
      assert.strictEqual(x.approvedBy, 'you'); assert.strictEqual(x.approved, true);
    }
    assert.strictEqual((await byId('T-4')).status, 'triage');
    assert.strictEqual((await byId('T-4')).approved, false);
    assert.deepStrictEqual((await R.call('POST', '/tickets/approve-ready', {})).body.approved, [], 'nothing left to approve');
  });
});
