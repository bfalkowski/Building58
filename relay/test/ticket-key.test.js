'use strict';
// A room on a new server with another key: Needs you names the tickets whose notes it cannot check, and a
// person's move to Ready signs a new note with the person's approval (docs/manual/running.html#ticket-key-moves).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const env = (dir, key) => ({ RELAY_TICKET_STORE: path.join(__dirname, '..', 'ticket-stores', 'github.js'), RELAY_TICKET_REPO: 't=o/r', GH_CMD: path.join(__dirname, 'fake-github.js'), FAKE_GITHUB_DIR: dir, RELAY_TICKET_CACHE_MS: '0', RELAY_TICKET_KEY: key });

test('a ticket written with key A is read by a relay with key B: Needs you names it, and a person\'s move approves it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-github-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await H.relay(env(dir, 'key A'));
  const repo = H.makeRepo(A.home);
  const ready = (await A.call('POST', '/tickets', { title: 'Ready one', repo })).body.ticket;
  const triage = (await A.call('POST', '/tickets', { title: 'Triage one', repo })).body.ticket;
  const third = (await A.call('POST', '/tickets', { title: 'Third one', repo })).body.ticket;
  assert.strictEqual(ready.approved, true);
  await A.kill();
  const file = path.join(dir, 'state.json'), state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const issue = state['o/r'].issues.find((i) => String(i.number) === String(triage.id));
  issue.labels = issue.labels.filter((n) => n !== 'office:ready').concat('office:triage');
  fs.writeFileSync(file, JSON.stringify(state));

  const B = await H.relay(env(dir, 'key B'), A.home);
  t.after(B.stop);
  const read = (await B.call('GET', '/tickets/' + ready.id)).body.ticket;
  assert.strictEqual(read.approved, false, 'key B does not read the approval');
  const needs = (await B.call('GET', '/needs-you')).body;
  const item = needs.items.find((i) => i.kind === 'ticket-key');
  assert.ok(item, JSON.stringify(needs));
  assert.match(item.line, /^3 tickets have notes signed with another key: approvals and order are not read\./);
  assert.match(item.line, /RELAY_TICKET_KEY/, 'and it names the fix');

  const bodies = () => JSON.parse(fs.readFileSync(file, 'utf8'))['o/r'].issues.map((i) => i.body);
  const before = bodies();
  const order = await B.call('POST', '/tickets/' + ready.id + '/order', { after: third.id });
  assert.notStrictEqual(order.status, 200, 'a new place cannot rewrite a note that does not check');
  assert.deepStrictEqual(bodies(), before, 'the notes are as they were');
  assert.strictEqual((await B.call('GET', '/needs-you')).body.items.filter((i) => i.kind === 'ticket-key').length, 1, 'and the line stays');

  const lead = (await B.call('POST', '/terminals', { cwd: repo })).body;
  await B.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' });
  assert.strictEqual((await B.call('POST', '/terminals/lead', { terminal: lead.id, board: true })).status, 200);
  const token = await H.until(() => { try { return { 'X-Office-Token': H.sessionToken(lead.sessionId) }; } catch (e) { return null; } }, 'the token');
  const byLead = await B.call('POST', '/tickets/' + ready.id + '/move', { to: 'rejected' }, token);
  assert.notStrictEqual(byLead.status, 200, 'a session\'s move cannot write over a note that does not check');
  assert.match(JSON.stringify(byLead.body), /key did not sign/);
  assert.deepStrictEqual(bodies(), before, 'and the notes are as they were');

  const closed = await B.call('POST', '/tickets/' + third.id + '/move', { to: 'done', pr: 'https://github.com/o/r/pull/3' });
  assert.strictEqual(closed.status, 200, JSON.stringify(closed.body) + ' a ticket whose note does not check can still be closed');
  const dropped = await B.call('POST', '/tickets/' + ready.id + '/move', { to: 'rejected' });
  assert.strictEqual(dropped.status, 200, JSON.stringify(dropped.body));
  const back = await B.call('POST', '/tickets/' + ready.id + '/move', { to: 'triage' });
  assert.strictEqual(back.status, 200, JSON.stringify(back.body));
  for (const id of [ready.id, triage.id]) {
    const moved = await B.call('POST', '/tickets/' + id + '/move', { to: 'ready' });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
    assert.strictEqual(moved.body.ticket.approved, true, 'the person\'s move approves under key B');
  }
  const after = (await B.call('GET', '/needs-you')).body;
  assert.strictEqual(after.items.some((i) => i.kind === 'ticket-key'), false, 'Needs you has no line once every note reads');
});
