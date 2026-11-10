// At level 5 (Autopilot) the Lead keeps two rights (T-161, article 5): stop a session the Floor calls
// safe to stop, and move a task to Done once its PR has merged. Only the relay starts and merges work.
// Through a real relay with a fake `claude` and a fake `gh`.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until, sessionToken, ROOT } = require('./helpers.js');
const { leadBrief, AUTOPILOT } = require('../lead-brief.js');

const CLI = path.join(ROOT, 'relay', 'ticket.js');
const KEEPS = 'stop a session the Floor calls safe to stop, and move a task to Done once its PR has merged';
const NEVER = 'Never merge a pull request: merging stays with the person.';
const RUNG = 'Read the merge rung in docs/constitution.md';

test('the brief under Autopilot names the two rights and never merging, whatever the merge switch says', () => {
  const relayDir = path.join('/', 'r'.repeat(119), 'relay');
  for (const merge of [false, true]) {
    const b = leadBrief(relayDir, { merge, autopilot: true });
    assert.ok(b.includes(AUTOPILOT), 'merge ' + merge);
    assert.ok(b.includes('Never merge a pull request.') && b.includes('You keep two rights: ' + KEEPS + '.'));
    assert.ok(!b.includes(RUNG), 'it does not point to the merge rung');
    assert.ok(Buffer.byteLength(b) < 1024, Buffer.byteLength(b) + ' bytes, from a checkout root of 120 characters');
  }
  assert.ok(!leadBrief(relayDir).includes('Autopilot'), 'with Autopilot off the brief is as before');
});

test('at level 5 the Lead keeps stops and moving merged tasks to Done, and nothing else', async (t) => {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ RELAY_WIP_LIMIT: '8', RELAY_LEAD_STOPS: '1', RELAY_REVIEW_GRACE_MS: '600000', RELAY_CHAT_POLL_SECONDS: '1', GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); fs.rmSync(gh, { recursive: true, force: true }); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(args), { cwd, encoding: 'utf8' }).trim();
  git(R.home, 'init', '-q', '--bare', origin);
  git(repo, 'config', 'url.' + origin + '.insteadOf', 'https://github.com/acme/widgets.git');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  git(repo, 'push', '-q', 'origin', 'main');
  await R.call('POST', '/reviews', { auto: false });
  const answers = (a) => fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify(a));
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(150); };
  const finish = async (s) => { await hook(s, { hook_event_name: 'UserPromptSubmit', title: '' }); await hook(s, { hook_event_name: 'Stop' }); };
  const running = async (s) => (await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === s.id);
  const rowOf = async (s) => (await R.call('GET', '/floor')).body.sessions.find((r) => r.terminal === s.id);
  const nameOf = async (s) => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === s.id).who;
  const taskOf = async (id) => (await R.call('GET', '/tasks/' + id)).body.task;
  // A task's Dev, briefed and idle, with its task Building.
  const dev = async () => {
    const task = (await R.call('POST', '/tasks', { title: 'A task', repo })).body.task;
    const s = { id: task.owner.terminal, sessionId: task.owner.sessionId };
    await until(async () => (await R.screen(s.id)).includes('GOT['), 'the task brief');
    await finish(s);
    await until(async () => (await rowOf(s)).safe, 'the Dev to settle');
    return Object.assign(s, { task });
  };

  // The person's Lead, with the switches level 5 turns on: the board and stops. Autopilot may start only
  // a ticket that is not there, so it starts nothing here.
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await finish(lead);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true })).body.board, true);
  const token = await until(() => { try { return sessionToken(lead.sessionId); } catch (e) { return null; } }, 'the token');
  const cli = (...args) => execFileSync('node', [CLI, ...args], { env: { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: token }, encoding: 'utf8', stdio: 'pipe' });
  const refused = (fn, what) => assert.throws(fn, (e) => (/Autopilot is on, so only the relay starts and merges work\. The Lead keeps two rights: /.test(String(e.stderr) + String(e.stdout) + e.message) ? true : assert.fail(what + ': ' + e.stderr)), what);
  const headers = { 'X-Office-Token': token };

  const merged = await dev(), building = await dev();
  const MERGED_PR = 'https://github.com/acme/widgets/pull/9';
  answers({ prs: { [MERGED_PR]: { state: 'MERGED', statusCheckRollup: [] } } });
  await hook(merged, { hook_event_name: 'PostToolUse', tool_name: 'Bash', pr_url: MERGED_PR });
  await until(async () => (await rowOf(merged)).why.startsWith('its PR merged'), 'the relay to hear that PR 9 merged');
  const filed = (await R.call('POST', '/tickets', { title: 'Filed by the Lead', repo }, headers)).body.ticket;
  const ready = (await R.call('POST', '/tickets', { title: 'Approved by the person', repo })).body.ticket;
  assert.deepStrictEqual([filed.status, ready.status], ['triage', 'ready']);

  const ap = await R.call('POST', '/autopilot', { on: true, only: 'T-999999' });
  assert.strictEqual(ap.body.on, true, JSON.stringify(ap.body));

  await t.test('the Lead is briefed again, with the two rights', async () => {
    await until(async () => (await R.screen(lead.id)).includes(AUTOPILOT.trim()), 'the Autopilot brief');
  });

  await t.test('ticket.js stop works on a session the Floor calls safe to stop', async () => {
    // A merged Dev is safe to stop and one the Lead may stop, with the same verdict as at level 2.
    const name = await nameOf(merged);
    assert.match(cli('stop', name), new RegExp('^Stopped: ' + name + ' '), 'stopped by name');
    await until(async () => !(await running(merged)), 'the merged Dev to stop');
  });

  await t.test('ticket.js task <id> done works for a task whose PR merged', async () => {
    cli('task', merged.task.id, 'done');
    assert.strictEqual((await taskOf(merged.task.id)).state, 'done');
    assert.strictEqual((await taskOf(merged.task.id)).history.at(-1).by, 'Lead');
  });

  await t.test('Done is refused for a task whose PR has not merged', async () => {
    refused(() => cli('task', building.task.id, 'done'), 'a task with no merged PR');
    const r = await R.call('POST', '/tasks/' + building.task.id + '/move', { to: 'done' }, headers);
    assert.deepStrictEqual([r.status, r.body.error], [403, 'autopilot']);
    assert.ok(r.body.message.includes(KEEPS + '. The relay has not seen this PR merge'), r.body.message);
    assert.strictEqual((await taskOf(building.task.id)).state, 'building');
  });

  await t.test('a move to any other column is refused, for tasks and tickets, even for a merged task', async () => {
    for (const to of ['in_review', 'changes_requested', 'waiting_on_you', 'building']) refused(() => cli('task', merged.task.id, to), 'task to ' + to);
    for (const to of ['in_review', 'waiting_on_you']) refused(() => cli('task', building.task.id, to), 'task to ' + to);
    refused(() => cli('move', filed.id, 'ready'), 'accepting a ticket from Triage');
    refused(() => cli('move', filed.id, 'rejected'), 'rejecting a ticket');
    refused(() => cli('move', ready.id, 'triage'), 'a Ready ticket back to Triage');
    refused(() => cli('move', ready.id, 'done', 'https://github.com/acme/widgets/pull/12'), 'a ticket to Done with a PR the relay never saw merge');
    assert.strictEqual((await taskOf(merged.task.id)).state, 'done');
    assert.strictEqual((await taskOf(building.task.id)).state, 'building');
    const tickets = (await R.call('GET', '/tickets')).body.tickets;
    assert.deepStrictEqual([filed.id, ready.id].map((id) => tickets.find((x) => x.id === id).status), ['triage', 'ready']);
  });

  await t.test('ticket.js start is refused, even with the start switch on', async () => {
    const r = await R.call('POST', '/terminals/lead', { terminal: lead.id, lead: true, starts: 1, total: 1 });
    assert.strictEqual(r.body.starts, 1, JSON.stringify(r.body));
    refused(() => cli('start', ready.id), 'a start');
    assert.strictEqual((await R.call('GET', '/tasks')).body.tasks.length, 2, 'nothing started');
    await R.call('POST', '/terminals/lead', { starts: 0 });
  });

  await t.test('a merge stays with Autopilot: the brief says never merge', async () => {
    const screen = await R.screen(lead.id);
    const last = screen.split('GOT[You are the Lead of this room.').at(-1).split(']')[0];
    assert.ok(last.includes('Never merge a pull request.') && !last.includes(RUNG), last);
  });

  await t.test('with Autopilot off, the Lead moves the board as at level 2 again, and is told', async () => {
    assert.strictEqual((await R.call('POST', '/autopilot', { on: false })).body.on, false);
    cli('move', filed.id, 'ready');
    const tickets = (await R.call('GET', '/tickets')).body.tickets;
    assert.strictEqual(tickets.find((x) => x.id === filed.id).status, 'ready');
    await until(async () => (await R.screen(lead.id)).split('GOT[You are the Lead of this room.').at(-1).includes(NEVER), 'the brief without Autopilot');
  });
});
