// The Lead's session is hard to stop by accident (T-225). POST /terminals/<id>/stop refuses the Lead
// unless the request says it is meant, with lead: true. Other sessions stop with no flag. When the
// Lead's session ends, by a stop or by itself, the page and the Floor say so and offer Bring back.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');

async function withLead(t) {
  const R = await relay();
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const start = async () => (await R.call('POST', '/terminals', { cwd: repo })).body;
  const talk = async (s) => { await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12), title: '' }); await R.hook({ hook_event_name: 'Stop', session_id: s.sessionId.slice(0, 12) }); await sleep(150); };
  const running = async (s) => (await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === s.id && x.running);
  const lead = await start();
  await talk(lead);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
  return { R, repo, start, talk, running, lead };
}

test('a stop with no flag does not stop the Lead, and one with lead: true does', async (t) => {
  const { R, start, running, lead } = await withLead(t);
  const r = await R.call('POST', '/terminals/' + lead.id + '/stop', {});
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'lead');
  assert.match(r.body.message, /Bring back/);
  assert.match(r.body.message, /Refresh the Lead/);
  await sleep(300);
  assert.ok(await running(lead), 'the Lead still runs');

  const other = await start();
  assert.strictEqual((await R.call('POST', '/terminals/' + other.id + '/stop', {})).status, 200, 'another session stops with no flag');
  await until(async () => !(await running(other)), 'the other session to stop');

  assert.strictEqual((await R.call('GET', '/terminals')).body.restore, null, 'nothing to bring back while the Lead runs');
  assert.strictEqual((await R.call('GET', '/floor')).body.leadEnded, null);

  assert.strictEqual((await R.call('POST', '/terminals/' + lead.id + '/stop', { lead: true })).status, 200);
  await until(async () => !(await running(lead)), 'the Lead to stop');
  const g = await until(async () => { const b = (await R.call('GET', '/terminals')).body; return b.restore ? b : null; }, 'Bring back to be offered');
  assert.strictEqual(g.restore.sessionId, lead.sessionId);
  assert.strictEqual(g.restore.ended, 'stopped');
  const floor = (await R.call('GET', '/floor')).body;
  assert.strictEqual(floor.leadEnded.ended, 'stopped');
  assert.match(floor.leadEnded.says, /Bring back/);

  const back = await R.call('POST', '/terminals', { cwd: g.restore.cwd, resume: g.restore.sessionId, lead: true });
  assert.strictEqual(back.status, 201, JSON.stringify(back.body));
  const now = (await R.call('GET', '/terminals')).body;
  assert.ok(now.terminals.find((x) => x.id === back.body.id).lead, 'it came back as the Lead');
  assert.strictEqual(now.restore, null);
  assert.strictEqual((await R.call('GET', '/floor')).body.leadEnded, null);
});

test('a Lead that ends by itself is offered back, and the Floor says so', async (t) => {
  const { R, running, lead } = await withLead(t);
  await R.call('POST', '/terminals/' + lead.id + '/input', { data: '/exit\r' });
  await until(async () => !(await running(lead)), 'the Lead to end');
  const g = await until(async () => { const b = (await R.call('GET', '/terminals')).body; return b.restore ? b : null; }, 'Bring back to be offered');
  assert.strictEqual(g.restore.ended, 'ended');
  const floor = (await R.call('GET', '/floor')).body;
  assert.match(floor.leadEnded.says, /The Lead's session ended/);
});

test('Clean up keeps the checkout the saved Lead runs in, after it ends', async (t) => {
  const R = await relay();
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const made = await R.call('POST', '/checkouts', { from: repo });
  assert.strictEqual(made.status, 201, JSON.stringify(made.body));
  const s = made.body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12), title: '' });
  await R.hook({ hook_event_name: 'Stop', session_id: s.sessionId.slice(0, 12) });
  await sleep(150);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: s.id })).status, 200);
  assert.strictEqual((await R.call('POST', '/terminals/' + s.id + '/stop', { lead: true })).status, 200);
  await until(async () => !(await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === s.id), 'the Lead to stop');
  const r = await R.call('POST', '/checkouts/' + s.checkout.id + '/clean', {});
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'lead');
  assert.match(r.body.message, /Lead/);
});
