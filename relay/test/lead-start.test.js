// The Lead's own permission to start tickets, and the limits the relay holds it to, through a real
// relay with a fake `claude`. The fake asks whether to trust the folder, so a worker's brief waits
// until the test says the worker has picked it up.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until, sessionToken, ROOT } = require('./helpers.js');

const tokenFor = (s) => until(() => { try { return { 'X-Office-Token': sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the session');
const CLI = path.join(ROOT, 'relay', 'ticket.js');

test('the Lead starts tickets', async (t) => {
  const R = await relay({ RELAY_WIP_LIMIT: '3', FAKE_CLAUDE_TRUST: '1' });
  t.after(R.stop);
  const repo = makeRepo(R.home), file = path.join(R.home, '.office-world', 'lead.json');
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')).t;
  const start = async () => (await R.call('POST', '/terminals', { cwd: repo })).body;
  const talk = async (s) => { await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.slice(0, 12), title: '' }); await sleep(200); };
  const fileReady = async (title, extra) => (await R.call('POST', '/tickets', { title, repo, ...extra })).body.ticket;
  const startAs = (id, headers) => R.call('POST', '/tickets/' + id + '/start', {}, headers);
  const ticket = async (id) => (await R.call('GET', '/tickets/' + id)).body.ticket;
  const building = async () => (await R.call('GET', '/tasks')).body.tasks.filter((x) => x.state === 'building' && x.worker).length;
  // The worker gets past the trust question, so its brief goes in, and a turn begins after it, so it is in
  // (relay/delivery.js). The fake sends no hooks, so the test sends them.
  const pickUp = async (task) => {
    const id = task.worker ? task.worker.terminal : (await R.call('GET', '/tasks/' + task.id)).body.task.worker.terminal;
    await talk(task.owner.sessionId);
    await R.hook({ hook_event_name: 'Stop', session_id: task.owner.sessionId.slice(0, 12) });
    await until(async () => /GOT\[Your task is to build/.test(await R.screen(id)), 'the brief typed');
    await talk(task.owner.sessionId);
    await until(async () => (await R.call('GET', '/tasks/' + task.id)).body.task.briefed, 'the brief');
  };

  const lead = await start();
  await talk(lead.sessionId);
  const leadToken = await tokenFor(lead);
  await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true });

  const first = await fileReady('First normal');
  const urgent = await fileReady('Urgent but blocked', { priority: 'high', blockedBy: [first.id] });
  const later = await fileReady('Later low', { priority: 'low' });

  await t.test('it is off by default, even for a Lead that can move the board', async () => {
    const r = await startAs(first.id, leadToken);
    assert.strictEqual(r.status, 401);
    assert.match(r.body.message, /only one you have let start tickets/);
    assert.strictEqual((await ticket(first.id)).status, 'ready');
    assert.strictEqual(saved().starts, 0);
  });
  await t.test('the number has to stay under the WIP limit, and a session cannot give it to itself', async () => {
    for (const n of [3, 0.5, -1, '2']) {
      const r = await R.call('POST', '/terminals/lead', { terminal: lead.id, starts: n });
      assert.strictEqual(r.body.error, 'bad_starts', String(n));
      assert.match(r.body.message, /fewer than 1 to 2 tasks are building/);
    }
    for (const total of [undefined, 0, 21, 1.5]) assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, starts: 1, total })).body.error, 'bad_starts', 'total ' + total);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, starts: 1, total: 10 }, leadToken)).status, 401);
    const quiet = await start();
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: quiet.id, starts: 1, total: 10 })).body.error, 'no_conversation');
    await R.call('POST', '/terminals/lead', { terminal: lead.id });  // the Lead again, as it was
    await R.call('POST', '/terminals/' + quiet.id + '/stop', {});
    assert.strictEqual((await R.call('GET', '/tickets')).body.leadStarts, 0);
  });
  await t.test('you give it with a number, and it is saved with the Lead', async () => {
    const r = await R.call('POST', '/terminals/lead', { terminal: lead.id, starts: 2, total: 10 });
    assert.deepStrictEqual([r.body.starts, r.body.board], [2, true]);
    assert.strictEqual(saved().starts, 2);
    const terms = (await R.call('GET', '/terminals')).body;
    assert.strictEqual(terms.terminals.find((x) => x.id === lead.id).starts, 2);
    assert.strictEqual(terms.wipLimit, 3);
    assert.strictEqual((await R.call('GET', '/tickets')).body.leadStarts, 2);
  });
  await t.test('it starts in Board order, and never a ticket that waits for another', async () => {
    const blocked = await startAs(urgent.id, leadToken);
    assert.strictEqual(blocked.body.error, 'blocked');
    assert.match(blocked.body.message, new RegExp('Waiting for ' + first.id));
    const skipped = await startAs(later.id, leadToken);
    assert.strictEqual(skipped.body.error, 'not_next');
    assert.match(skipped.body.message, new RegExp('Start ' + first.id + ' first'));
    assert.strictEqual((await ticket(later.id)).status, 'ready');
  });
  let firstTask;
  await t.test('a burst of starts gets one through', async () => {
    // Two tickets: while one is starting, the other is next on the Board, so only the Lead's own hold stops it.
    const burst = await Promise.all([first, later, first, later, first, later].map((x) => startAs(x.id, leadToken)));
    assert.deepStrictEqual(burst.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409]);
    firstTask = burst.find((r) => r.status === 200).body.task;
    assert.strictEqual(firstTask.ticket, first.id);
    assert.strictEqual((await R.call('GET', '/tasks')).body.tasks.length, 1);
    const card = await ticket(first.id);
    assert.strictEqual(card.status, 'started');
    assert.strictEqual(card.task.by, 'Lead', 'the Board shows who started it');
    assert.ok(Math.abs(Date.parse(card.task.startedAt) - Date.now()) < 60000, 'and when');
    assert.strictEqual((await R.call('GET', '/tasks/' + firstTask.id)).body.task.history[0].by, 'Lead');
    assert.match(R.output(), new RegExp('The Lead started ' + first.id));
  });
  await t.test('the next waits until the last worker has picked up its brief', async () => {
    const r = await startAs(later.id, leadToken);
    assert.strictEqual(r.body.error, 'one_at_a_time');
    assert.match(r.body.message, new RegExp('The worker on ' + first.id + ' has not picked up its brief'));
    await pickUp(firstTask);
    const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: leadToken['X-Office-Token'] };
    assert.match(execFileSync('node', [CLI, 'start', later.id], { env, encoding: 'utf8' }), new RegExp('Started: ' + later.id + ' {2}Later low {2}\\(task [0-9a-f]{6}\\)'));
    await pickUp((await R.call('GET', '/tasks/' + (await ticket(later.id)).task.id)).body.task);
  });
  await t.test('a burst past the limit starts nothing, and you still can', async () => {
    assert.strictEqual(await building(), 2);
    const more = await fileReady('One more');
    const burst = await Promise.all([1, 2, 3, 4, 5].map(() => startAs(more.id, leadToken)));
    assert.ok(burst.every((r) => r.status === 409), burst.map((r) => r.status).join());
    assert.ok(burst.some((r) => r.body.error === 'lead_limit'));
    assert.match(burst.find((r) => r.body.error === 'lead_limit').body.message, /2 tasks are building, and the person lets you start one only while fewer than 2 are/);
    assert.strictEqual(await building(), 2);
    assert.strictEqual((await ticket(more.id)).status, 'ready');
    const yours = await startAs(more.id);
    assert.strictEqual(yours.status, 200);
    assert.strictEqual((await ticket(more.id)).task.by, 'you');
  });
  await t.test('you can take it back, which stops further starts and leaves running work alone', async () => {
    await R.call('POST', '/tasks/' + firstTask.id + '/move', { to: 'done' });
    const another = await fileReady('After taking back');
    const r = await R.call('POST', '/terminals/lead', { terminal: lead.id, starts: 0 });
    assert.strictEqual(r.body.starts, 0);
    assert.strictEqual(saved().starts, 0);
    assert.strictEqual(saved().board, true, 'moving the board is a separate permission');
    assert.strictEqual((await startAs(another.id, leadToken)).status, 401);
    const tasks = (await R.call('GET', '/tasks')).body.tasks;
    assert.strictEqual(tasks.filter((x) => x.worker).length, 3, 'every worker still runs');
    assert.strictEqual((await R.call('GET', '/tickets')).body.leadStarts, 0);
  });
  await t.test('a new Lead does not inherit it', async () => {
    await R.call('POST', '/terminals/lead', { terminal: lead.id, starts: 1, total: 10 });
    const next = await start();
    await talk(next.sessionId);
    await R.call('POST', '/terminals/lead', { terminal: next.id });
    const terms = (await R.call('GET', '/terminals')).body.terminals;
    assert.deepStrictEqual(terms.filter((x) => x.starts).map((x) => x.id), []);
    assert.strictEqual(saved().starts, 0);
  });
});

test('Bring back keeps the number, unless the WIP limit has dropped to it since', async (t) => {
  let R = await relay({ RELAY_WIP_LIMIT: '3' });
  const home = R.home, repo = makeRepo(home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' }); await sleep(200);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, starts: 2, total: 10 })).body.starts, 2);
  for (const [wip, kept] of [['3', 2], ['2', 0]]) {
    await R.kill();
    R = await relay({ RELAY_WIP_LIMIT: wip }, home);
    const offered = (await R.call('GET', '/terminals')).body.restore;
    const back = (await R.call('POST', '/terminals', { cwd: offered.cwd, resume: offered.sessionId, lead: true })).body;
    assert.strictEqual(back.lead, true);
    assert.strictEqual(back.starts, kept, 'WIP limit ' + wip);
  }
});

test('the Lead starts only what a person approved, and only when every blocker is done', async (t) => {
  const R = await relay({ RELAY_WIP_LIMIT: '3' });
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const start = async () => (await R.call('POST', '/terminals', { cwd: repo })).body;
  const talk = async (s) => { await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.slice(0, 12), title: '' }); await sleep(200); };
  const file = async (title, headers, extra) => (await R.call('POST', '/tickets', { title, repo, ...extra }, headers)).body.ticket;
  const move = (id, to, headers) => R.call('POST', '/tickets/' + id + '/move', { to }, headers);
  const startAs = (id, headers) => R.call('POST', '/tickets/' + id + '/start', {}, headers);
  const lead = await start(), worker = await start();
  await talk(lead.sessionId); await talk(worker.sessionId);
  const leadToken = await tokenFor(lead), workerToken = await tokenFor(worker);
  await t.test('a request that takes one permission back can grant the other', async () => {
    const r = await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true, starts: 0 });
    assert.deepStrictEqual([r.body.board, r.body.starts], [true, 0]);
    const both = await R.call('POST', '/terminals/lead', { terminal: lead.id, board: false, starts: 2, total: 10 });
    assert.deepStrictEqual([both.body.board, both.body.starts], [false, 2]);
    await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true });
  });

  const own = await file('The Lead files and approves this', leadToken, { priority: 'high' });
  const theirs = await file('A worker files this', workerToken, { priority: 'high' });
  await t.test('a ticket the Lead approved itself is skipped, and refused if named', async () => {
    assert.strictEqual(own.status, 'triage');
    assert.strictEqual((await move(own.id, 'ready', leadToken)).body.ticket.approvedBy, 'Lead');
    assert.strictEqual((await move(theirs.id, 'ready', leadToken)).status, 200);
    const yours = await file('You file this');
    assert.strictEqual(yours.approvedBy, 'you');
    for (const id of [own.id, theirs.id]) {
      const r = await startAs(id, leadToken);
      assert.strictEqual(r.body.error, 'not_approved', id);
      assert.match(r.body.message, /No person approved/);
    }
    // High priority does not put them first: the Lead goes on to the one you filed.
    assert.strictEqual((await startAs(yours.id, leadToken)).status, 200);
  });
  await t.test('once you approve it, the Lead can start it', async () => {
    await move(theirs.id, 'rejected'); await move(theirs.id, 'triage');
    assert.strictEqual((await move(theirs.id, 'ready')).body.ticket.approvedBy, 'you');
    const task = (await R.call('GET', '/tasks')).body.tasks[0];
    await until(async () => /GOT\[Your task is to build/.test(await R.screen(task.worker.terminal)), 'the brief typed');
    await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: task.owner.sessionId.slice(0, 12) });  // in once a turn begins (relay/delivery.js)
    await until(async () => (await R.call('GET', '/tasks/' + task.id)).body.task.briefed, 'the brief');
    assert.strictEqual((await startAs(theirs.id, leadToken)).status, 200);
  });
  await t.test('a rejected blocker holds the Lead back, and you judge it', async () => {
    for (const task of (await R.call('GET', '/tasks')).body.tasks) await R.call('POST', '/tasks/' + task.id + '/move', { to: 'done' });
    const dropped = await file('Dropped');
    await move(dropped.id, 'rejected');
    const after = await file('After the dropped one', undefined, { blockedBy: [dropped.id] });
    const r = await startAs(after.id, leadToken);
    assert.strictEqual(r.body.error, 'blocker_not_done');
    assert.match(r.body.message, new RegExp(dropped.id + ' was rejected or is not on the Board'));
    const plain = await file('Plain one');
    assert.strictEqual((await startAs(plain.id, leadToken)).body.error, 'one_at_a_time', 'the blocked one is skipped in Board order, and the last start still holds the next');
    assert.strictEqual((await startAs(after.id)).status, 200, 'you can still start it');
  });
});

test('the automatic restore after a restart keeps the number and the starts left, unless the WIP limit has dropped to it', async (t) => {
  let R = await relay({ RELAY_RESUME: '1', RELAY_WIP_LIMIT: '3' });
  const home = R.home, repo = makeRepo(home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' }); await sleep(200);
  await R.call('POST', '/terminals/lead', { terminal: lead.id, starts: 2, total: 3 });
  const ticket = (await R.call('POST', '/tickets', { title: 'Before the restart', repo })).body.ticket;
  assert.strictEqual((await R.call('POST', '/tickets/' + ticket.id + '/start', {}, await tokenFor(lead))).status, 200);
  for (const [wip, kept, left] of [['3', 2, 2], ['2', 0, 0]]) {
    await R.kill();
    R = await relay({ RELAY_RESUME: '1', RELAY_WIP_LIMIT: wip }, home);
    const back = await until(async () => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.sessionId === lead.sessionId), 'the Lead back');
    assert.strictEqual(back.lead, true);
    assert.strictEqual(back.starts, kept, 'WIP limit ' + wip);
    assert.strictEqual(back.startsLeft, left, 'WIP limit ' + wip);
  }
});

test('a grant has a total: each start uses one, and the last turns the permission off', async (t) => {
  const R = await relay({ RELAY_WIP_LIMIT: '3' });
  t.after(R.stop);
  const repo = makeRepo(R.home), file = path.join(R.home, '.office-world', 'lead.json');
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')).t;
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' }); await sleep(200);
  const token = await tokenFor(lead);
  const now = async () => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === lead.id);
  const startAs = (ticket) => R.call('POST', '/tickets/' + ticket.id + '/start', {}, token);
  const r = await R.call('POST', '/terminals/lead', { terminal: lead.id, starts: 2, total: 2 });
  assert.deepStrictEqual([r.body.starts, r.body.startsLeft], [2, 2]);
  const tickets = [];
  for (const title of ['One', 'Two', 'Three']) tickets.push((await R.call('POST', '/tickets', { title, repo })).body.ticket);
  assert.strictEqual((await startAs(tickets[0])).status, 200);
  const once = await now();
  assert.deepStrictEqual([once.starts, once.startsLeft, saved().startsLeft], [2, 1, 1]);
  assert.deepStrictEqual([once.lastStart.ticket, once.lastStart.left], [tickets[0].id, 1], 'what the page announces');
  assert.strictEqual((await R.call('GET', '/tickets')).body.leadStartsLeft, 1);
  const task = (await R.call('GET', '/tasks')).body.tasks[0];
  await until(async () => /GOT\[Your task is to build/.test(await R.screen(task.worker.terminal)), 'the brief typed');
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: task.owner.sessionId.slice(0, 12) });  // in once a turn begins (relay/delivery.js)
  await until(async () => (await R.call('GET', '/tasks/' + task.id)).body.task.briefed, 'the brief');
  assert.strictEqual((await startAs(tickets[1])).status, 200);
  const off = await now();
  assert.deepStrictEqual([off.starts, off.startsLeft, off.lastStart.left, saved().starts], [0, 0, 0, 0], 'the last start turns it off');
  assert.match(R.output(), /That was its last start/);
  assert.strictEqual((await startAs(tickets[2])).status, 401);
  assert.strictEqual((await R.call('GET', '/tasks')).body.tasks.filter((x) => x.worker).length, 2, 'what it started keeps running');
});

test('an approval does not outlive a reject, even when the ticket is put back in Ready outside the relay', async (t) => {
  let R = await relay({ RELAY_WIP_LIMIT: '3' });
  const home = R.home, repo = makeRepo(home), file = path.join(home, '.office-world', 'tickets.json');
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const ticket = (await R.call('POST', '/tickets', { title: 'Approved, then rejected', repo })).body.ticket;
  assert.strictEqual(ticket.approvedBy, 'you');
  assert.strictEqual((await R.call('POST', '/tickets/' + ticket.id + '/move', { to: 'rejected' })).body.ticket.approvedBy, 'none');
  // As a label on GitHub would: Ready again, with nobody approving it through the relay.
  await R.kill();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.t.tickets.find((x) => x.id === ticket.id).status = 'ready';
  fs.writeFileSync(file, JSON.stringify(saved));
  R = await relay({ RELAY_WIP_LIMIT: '3' }, home);
  const back = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: back.sessionId.slice(0, 12), title: '' }); await sleep(200);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: back.id, starts: 1, total: 1 })).body.starts, 1);
  const r = await R.call('POST', '/tickets/' + ticket.id + '/start', {}, await tokenFor(back));
  assert.strictEqual(r.body.error, 'not_approved');
  assert.strictEqual((await R.call('POST', '/tickets/' + ticket.id + '/start', {})).status, 200, 'you can still start it');
});

test('with the GitHub issues store, an issue reopened on GitHub as Ready after a reject is not approved', async (t) => {
  const os = require('os');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
  const repo = makeRepo(home), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-github-'));
  const R = await relay({ RELAY_WIP_LIMIT: '3', RELAY_TICKET_STORE: path.join(ROOT, 'relay', 'ticket-stores', 'github.js'), RELAY_TICKET_REPO: 't=o/r', RELAY_TICKET_FOLDER: repo, RELAY_TICKET_CACHE_MS: '0', GH_CMD: path.join(__dirname, 'fake-github.js'), FAKE_GITHUB_DIR: dir }, home);
  t.after(async () => { await R.kill(); await R.remove(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ticket = (await R.call('POST', '/tickets', { title: 'Approved, then rejected', repo })).body.ticket;
  assert.strictEqual(ticket.approvedBy, 'you');
  assert.strictEqual((await R.call('POST', '/tickets/' + ticket.id + '/move', { to: 'rejected' })).body.ticket.approvedBy, 'none');
  // Someone reopens it on GitHub with the Ready label. The signed note still holds what the relay wrote.
  const file = path.join(dir, 'state.json'), state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const issue = state['o/r'].issues.find((i) => String(i.number) === ticket.id);
  Object.assign(issue, { state: 'open', state_reason: null, labels: issue.labels.filter((l) => !l.startsWith('office:') || l.startsWith('office:priority')).concat('office:ready') });
  fs.writeFileSync(file, JSON.stringify(state));
  const reopened = await until(async () => { const x = (await R.call('GET', '/tickets/' + ticket.id)).body.ticket; return x.status === 'ready' && x; }, 'it to read as Ready');
  assert.strictEqual(reopened.approvedBy, 'none');
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' }); await sleep(200);
  await R.call('POST', '/terminals/lead', { terminal: lead.id, starts: 1, total: 1 });
  const r = await R.call('POST', '/tickets/' + ticket.id + '/start', {}, await tokenFor(lead));
  assert.strictEqual(r.body.error, 'not_approved');
});
