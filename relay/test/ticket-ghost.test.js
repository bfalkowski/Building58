'use strict';
// The person moves a started ticket with no task, a ghost, back to Ready (docs/manual/roles.html).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const PR = 'https://github.com/o/r/pull/9';
const makeGhost = {
  local: { env: () => ({}), make: (R, id) => {
    const file = path.join(R.home, '.office-world', 'tickets.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.t.tickets.find((x) => x.id === id).status = 'started';
    fs.writeFileSync(file, JSON.stringify(saved));
  } },
  github: { env: () => ({ RELAY_TICKET_STORE: path.join(__dirname, '..', 'ticket-stores', 'github.js'), RELAY_TICKET_REPO: 't=o/r', GH_CMD: path.join(__dirname, 'fake-github.js'), FAKE_GITHUB_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'office-github-')) }), make: (R, id, env) => {
    const file = path.join(env.FAKE_GITHUB_DIR, 'state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const issue = state['o/r'].issues.find((i) => '#' + i.number === id || String(i.number) === String(id).replace(/\D/g, ''));
    issue.labels = issue.labels.filter((n) => n !== 'office:ready').concat('office:started');
    fs.writeFileSync(file, JSON.stringify(state));
  } }
};

for (const [name, how] of Object.entries(makeGhost)) {
  test('a ghost ticket goes back to Ready for the person only, on the ' + name + ' store', async (t) => {
    const env = how.env();
    const R0 = await H.relay(env);
    const repo = H.makeRepo(R0.home);
    const a = (await R0.call('POST', '/tickets', { title: 'Ghost', repo, priority: 'high' })).body.ticket;
    const b = (await R0.call('POST', '/tickets', { title: 'Running', repo })).body.ticket;
    await R0.kill();
    how.make(R0, a.id, env);
    const R = await H.relay(env, R0.home);
    t.after(R.stop);
    const ghost = (await R.call('GET', '/tickets/' + a.id)).body.ticket;
    assert.strictEqual(ghost.status, 'started');
    assert.strictEqual(ghost.task, null);

    const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
    await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' });
    await R.call('POST', '/terminals/lead', { terminal: lead.id });
    const token = await H.until(() => { try { return { 'X-Office-Token': H.sessionToken(lead.sessionId) }; } catch (e) { return null; } }, 'the token');
    const refused = await R.call('POST', '/tickets/' + a.id + '/move', { to: 'ready' }, token);
    assert.ok([401, 403].includes(refused.status), JSON.stringify(refused.body) + ' a session, the Lead included, cannot make this move');
    assert.strictEqual((await R.call('GET', '/tickets/' + a.id)).body.ticket.status, 'started');

    const r = await R.call('POST', '/tickets/' + a.id + '/move', { to: 'ready' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ticket.status, 'ready');
    assert.strictEqual(r.body.ticket.priority, 'high');
    assert.strictEqual(r.body.ticket.approved, true, 'it keeps its approval');
    assert.strictEqual(r.body.ticket.rank, ghost.rank, 'and its place');
    const last = r.body.ticket.history.at(-1);
    assert.deepStrictEqual([last.stage, last.from, last.to, last.by], ['moved', 'started', 'ready', 'you']);

    const started = await R.call('POST', '/tickets/' + b.id + '/start', {});
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    const withTask = await R.call('POST', '/tickets/' + b.id + '/move', { to: 'ready' });
    assert.strictEqual(withTask.status, 409, 'not while it has a task');
    assert.strictEqual(withTask.body.error, 'started');
    assert.strictEqual((await R.call('POST', '/tickets/' + a.id + '/move', { to: 'done', pr: PR })).status, 200, 'Ready moves as before');
  });
}
