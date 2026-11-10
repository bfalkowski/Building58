// The Lead's own permission to move the board, through a real relay with a fake `claude`.
'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until, sessionToken, sessionTokens, ROOT } = require('./helpers.js');

const tokenFor = (s) => until(() => { try { return { 'X-Office-Token': sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the session');
const CLI = path.join(ROOT, 'relay', 'ticket.js');

test('moving the board', async (t) => {
  // The Lead's move to Done asks gh about the PR (T-91). Every PR it names here merged in o/r, unless it says otherwise.
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const pull = (n, repoName) => 'https://github.com/' + (repoName || 'o/r') + '/pull/' + n;
  const prs = {};
  for (const n of [32, 40, 41, 42, 43]) prs[pull(n)] = { state: 'MERGED', url: pull(n) };
  Object.assign(prs, { [pull(50)]: { state: 'OPEN', url: pull(50) }, [pull(51)]: { state: 'CLOSED', url: pull(51) },
    [pull(5, 'x/y')]: { state: 'MERGED', url: pull(5, 'x/y') }, [pull(52, 'O/R')]: { state: 'MERGED', url: pull(52) }, [pull(40, 'O/R')]: { state: 'MERGED', url: pull(40) },
    [pull(6, 'p/q')]: { state: 'MERGED', url: pull(6, 'p/q') }, [pull(8, 'm/r')]: { state: 'MERGED', url: pull(8, 'm/r') }, [pull(54)]: { state: 'MERGED', url: pull(54, 'o/r-renamed') } });
  fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify({ prs }));
  const ghEnv = { GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh };
  let R = await relay({ RELAY_WIP_LIMIT: '5', ...ghEnv });
  const home = R.home, repo = makeRepo(home), file = path.join(home, '.office-world', 'lead.json');
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], { cwd: repo });
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')).t;
  const start = async (extra) => (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
  const talk = async (s) => { await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12), title: '' }); await sleep(200); };
  const fileAs = async (headers, title) => (await R.call('POST', '/tickets', { title, repo }, headers)).body.ticket;
  const moveTicket = (id, to, headers) => R.call('POST', '/tickets/' + id + '/move', { to }, headers);
  const moveTask = (id, to, headers, extra) => R.call('POST', '/tasks/' + id + '/move', { to, ...extra }, headers);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });

  const lead = await start(), other = await start();
  await talk(lead); await talk(other);
  const leadToken = await tokenFor(lead), otherToken = await tokenFor(other);
  const task = (await R.call('POST', '/tasks', { title: 'A task', repo })).body.task;

  await t.test('being saved as the Lead, as the desk does, gives nothing', async () => {
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
    assert.strictEqual(saved().board, false);
    const filed = await fileAs(otherToken, 'Waiting one');
    const r = await moveTicket(filed.id, 'ready', leadToken);
    assert.strictEqual(r.status, 401);
    assert.match(r.body.message, /Only a Lead you have let move the board/);
  });
  await t.test('a reviewer and a task worker cannot be given it', async () => {
    const reviewer = await start({ role: 'reviewer' });
    await talk(reviewer);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: reviewer.id, board: true })).body.error, 'task');
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: task.owner.terminal, board: true })).body.error, 'task');
    assert.strictEqual(saved().sessionId, lead.sessionId);
    assert.strictEqual(saved().board, false);
    await R.call('POST', '/terminals/' + reviewer.id + '/stop', {});
  });
  await t.test('a session cannot give it to itself', async () => {
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true }, leadToken)).status, 401);
    assert.strictEqual(saved().board, false);
  });
  await t.test('once you give it, the Lead moves tickets and tasks with its own token', async () => {
    const r = await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true });
    assert.strictEqual(r.body.board, true);
    assert.strictEqual(saved().board, true);
    const terms = (await R.call('GET', '/terminals')).body.terminals;
    assert.strictEqual(terms.find((x) => x.id === lead.id).board, true);
    assert.strictEqual(terms.find((x) => x.id === other.id).board, false);
    const accepted = await fileAs(otherToken, 'To accept');
    assert.strictEqual(accepted.status, 'triage');
    assert.strictEqual((await moveTicket(accepted.id, 'ready', leadToken)).body.ticket.status, 'ready');
    assert.strictEqual((await moveTicket(accepted.id, 'rejected', leadToken)).body.ticket.status, 'rejected');
    assert.strictEqual((await moveTicket(accepted.id, 'done', leadToken)).status, 409, 'the usual rules still hold');
    const moved = await moveTask(task.id, 'in_review', leadToken, { by: 'you', note: 'PR is up' });
    assert.deepStrictEqual(Object.keys(moved.body.task).sort(), ['branch', 'id', 'pr', 'state']);
    assert.strictEqual(moved.body.task.state, 'in_review');
    const last = (await R.call('GET', '/tasks/' + task.id)).body.task.history.at(-1);
    assert.strictEqual(last.by, 'Lead', 'it cannot sign its moves as you');
    assert.strictEqual(last.note, 'PR is up');
  });
  await t.test('it grants nothing else', async () => {
    const ready = await fileAs(undefined, 'Ready one');
    const refused = [
      ['POST', '/tickets/' + ready.id + '/start', {}], ['POST', '/tickets/ask', { idea: 'x', repo }],
      ['GET', '/tasks/' + task.id], ['POST', '/tasks', { title: 'x', repo }],
      ['POST', '/tasks/' + task.id + '/resume', {}], ['POST', '/tasks/' + task.id + '/clean', {}],
      ['GET', '/terminals'], ['POST', '/terminals', { cwd: repo }], ['POST', '/terminals/lead', { terminal: other.id, board: true }],
      ['POST', '/terminals/' + other.id + '/input', { data: 'x' }], ['GET', '/checkouts'], ['GET', ''], ['GET', '/events'],
      ['GET', '/tickets/' + ready.id + '/move']
    ];
    for (const [method, p, body] of refused) assert.strictEqual((await R.call(method, p, body, leadToken)).status, 401, method + ' ' + p);
    // A token may send the hooks of its own session to /commands (relay/test/two-offices.test.js), and nothing else.
    assert.strictEqual((await R.call('POST', '/commands', { action: 'state' }, leadToken)).status, 403, 'POST /commands');
    assert.strictEqual((await R.call('GET', '/tickets/' + ready.id)).body.ticket.status, 'ready');
  });
  await t.test('the Lead finds a task with no ticket through its own token, and sees only the board\'s view of it', async () => {
    const seen = await R.call('GET', '/tasks', null, leadToken);
    assert.strictEqual(seen.status, 200);
    const found = seen.body.tasks.find((x) => x.title === 'A task');
    assert.strictEqual(found.id, task.id);
    assert.deepStrictEqual(Object.keys(found).sort(), ['branch', 'id', 'pr', 'state', 'title']);
    assert.ok(!(await R.call('GET', '/tickets', null, leadToken)).body.tickets.some((x) => x.task && x.task.id === task.id), 'list cannot show it');
    assert.strictEqual((await moveTask(found.id, 'in_review', leadToken)).status, 200);
    assert.strictEqual((await R.call('GET', '/tasks', null, otherToken)).status, 401);
  });
  await t.test('another session is still refused', async () => {
    const filed = await fileAs(otherToken, 'Not yours');
    assert.strictEqual((await moveTicket(filed.id, 'ready', otherToken)).status, 401);
    assert.strictEqual((await moveTask(task.id, 'building', otherToken)).status, 401);
    assert.strictEqual((await R.call('GET', '/tickets/' + filed.id)).body.ticket.status, 'triage');
    assert.strictEqual((await moveTicket(filed.id, 'ready', { 'X-Office-Token': 'wrong' })).status, 401);
  });
  await t.test('the Lead uses it from the command line', async () => {
    const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: leadToken['X-Office-Token'] };
    const filed = await fileAs(otherToken, 'By the tool');
    assert.match(execFileSync('node', [CLI, 'move', filed.id, 'ready'], { env, encoding: 'utf8' }), new RegExp('Moved: ' + filed.id + ' {2}ready'));
    assert.match(execFileSync('node', [CLI, 'tasks'], { env, encoding: 'utf8' }), new RegExp(task.id + ' {2}\\w+ {2}A task {2}' + task.branch));
    assert.match(execFileSync('node', [CLI, 'task', task.id, 'waiting_on_you'], { env, encoding: 'utf8' }), new RegExp('Moved: ' + task.id + ' {2}waiting_on_you'));
    assert.match(execFileSync('node', [CLI, 'list'], { env, encoding: 'utf8' }), /By the tool/);
    const merged = await fileAs(otherToken, 'Merged without a task');
    assert.match(execFileSync('node', [CLI, 'move', merged.id, 'done', 'https://github.com/o/r/pull/32'], { env, encoding: 'utf8' }), new RegExp('Moved: ' + merged.id + ' {2}done {2}https://github.com/o/r/pull/32'));
    assert.throws(() => execFileSync('node', [CLI, 'move', filed.id, 'done'], { env, encoding: 'utf8', stdio: 'pipe' }), /give the link of the PR that merged it/);
    assert.throws(() => execFileSync('node', [CLI, 'move', filed.id, 'done', 'https://github.com/o/r/pull/32'], { env: { ...env, OFFICE_TICKET_TOKEN: otherToken['X-Office-Token'] }, encoding: 'utf8', stdio: 'pipe' }), /Only a Lead you have let move the board/);
    const denied = { ...env, OFFICE_TICKET_TOKEN: otherToken['X-Office-Token'] };
    assert.throws(() => execFileSync('node', [CLI, 'move', filed.id, 'rejected'], { env: denied, encoding: 'utf8', stdio: 'pipe' }), /Only a Lead you have let move the board/);
  });
  await t.test('Merged elsewhere refuses a PR that is another task\'s or another ticket\'s', async () => {
    const moveDone = (id, pr) => R.call('POST', '/tickets/' + id + '/move', { to: 'done', pr }, leadToken);
    const say = (pr) => R.hook({ hook_event_name: 'PostToolUse', session_id: task.owner.sessionId.slice(0, 12), pr_url: pr, cwd: task.worktree });
    await say('https://github.com/o/r/pull/40'); await say('https://github.com/o/r/pull/41');
    assert.strictEqual((await R.call('GET', '/tasks/' + task.id)).body.task.pr, 'https://github.com/o/r/pull/41');
    const unrelated = await fileAs(otherToken, 'Unrelated');
    for (const pr of ['https://github.com/o/r/pull/41', 'https://github.com/O/R/pull/40']) {
      const r = await moveDone(unrelated.id, pr);
      assert.strictEqual(r.status, 409, pr);
      assert.strictEqual(r.body.error, 'pr_taken');
      assert.match(r.body.message, new RegExp('already the PR of task ' + task.id + ' · A task'));
    }
    const first = await fileAs(otherToken, 'First');
    assert.strictEqual((await moveDone(first.id, 'https://github.com/o/r/pull/42')).status, 200);
    const again = await moveDone(unrelated.id, 'https://github.com/o/r/pull/42');
    assert.strictEqual(again.status, 409);
    assert.match(again.body.message, new RegExp('already the PR of ticket ' + first.id + ' · First'));
    assert.strictEqual((await R.call('GET', '/tickets/' + unrelated.id)).body.ticket.status, 'triage');
    assert.strictEqual((await moveDone(unrelated.id, 'https://github.com/o/r/pull/43')).status, 200, 'its own PR still works');
  });
  // A Lead is an agent and can paste the wrong link, so its move to Done holds only for a PR that gh says
  // merged, in the ticket's repo (T-91). A person's move does not ask gh (relay/test/tickets.test.js).
  await t.test('the Lead marks a ticket Done only with a PR that merged in its repo', async () => {
    const moveDone = (id, pr) => R.call('POST', '/tickets/' + id + '/move', { to: 'done', pr }, leadToken);
    const ticket = await fileAs(otherToken, 'Merged somewhere');
    for (const [pr, error, says] of [[pull(50), 'pr_not_merged', /has not merged: it is open/], [pull(51), 'pr_not_merged', /has not merged: it is closed/],
      [pull(5, 'x/y'), 'pr_elsewhere', /is in x\/y, not in o\/r, the repo of /], [pull(53), 'pr_unchecked', /gh could not read/]]) {
      const r = await moveDone(ticket.id, pr);
      assert.deepStrictEqual([r.status, r.body.error], [409, error], pr + ': ' + JSON.stringify(r.body));
      assert.match(r.body.message, says);
    }
    assert.strictEqual((await R.call('GET', '/tickets/' + ticket.id)).body.ticket.status, 'triage', 'a refused PR changes nothing');
    const calls = fs.readFileSync(path.join(gh, 'calls.log'), 'utf8');
    assert.ok(calls.includes('pr view ' + pull(50) + ' --json state,url'), calls);
    const r = await moveDone(ticket.id, pull(52, 'O/R'));
    assert.strictEqual(r.status, 200, 'the owner and repo ignore case: ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.ticket.pr, pull(52, 'O/R'));
    await until(() => R.output().includes('The Lead moved ' + ticket.id + ' to done with ' + pull(52, 'O/R')), 'the log line with the PR');
    // A move the relay refuses anyway says why at once, and does not ask gh first.
    const late = await moveDone(ticket.id, pull(55));
    assert.deepStrictEqual([late.status, late.body.error], [409, 'bad_move'], JSON.stringify(late.body));
    assert.ok(!fs.readFileSync(path.join(gh, 'calls.log'), 'utf8').includes(pull(55)), 'gh was not asked');
  });
  await t.test('a remote rewritten by insteadOf or pushed to on GitHub counts, and so does a link to a repo gh says was renamed', async () => {
    const moveDone = (id, pr) => R.call('POST', '/tickets/' + id + '/move', { to: 'done', pr }, leadToken);
    const g = (...args) => execFileSync('git', args, { cwd: repo });
    g('config', 'url.https://github.com/.insteadOf', 'gh-work:');
    g('remote', 'add', 'work', 'gh-work:p/q.git');
    g('remote', 'add', 'mirror', 'https://gitlab.example.com/m/r.git');
    g('remote', 'set-url', '--push', 'mirror', 'git@github.com:m/r.git');
    try {
      for (const [title, pr] of [['Merged in the work remote', pull(6, 'p/q')], ['Merged where the mirror pushes', pull(8, 'm/r')], ['Merged before a rename', pull(54)]]) {
        const r = await moveDone((await fileAs(otherToken, title)).id, pr);
        assert.strictEqual(r.status, 200, title + ': ' + JSON.stringify(r.body));
      }
    } finally {
      g('remote', 'remove', 'work'); g('remote', 'remove', 'mirror');
      g('config', '--unset', 'url.https://github.com/.insteadOf');
    }
  });
  const fresh = crypto.randomUUID();
  await t.test('/clear keeps it, and the new conversation is what gets saved', async () => {
    await R.call('POST', '/terminals/' + lead.id + '/input', { data: 'printing keeps the brief back for a moment\r' });
    await R.hook({ hook_event_name: 'SessionStart', source: 'clear', session_id: fresh.slice(0, 12), full_session_id: fresh, terminal: lead.id });
    await sleep(200);
    const filed = await fileAs(otherToken, 'After clear');
    assert.strictEqual((await moveTicket(filed.id, 'ready', leadToken)).status, 200);
    assert.strictEqual(saved().board, false, 'the old id no longer carries it');
    const nothing = await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true });
    assert.strictEqual(nothing.body.error, 'no_conversation');
    assert.match(nothing.body.message, /before it can move the board/);
  });
  await t.test('starting a session with the holder\'s old id does not make a second holder', async () => {
    const old = await start({ resume: lead.sessionId });
    const token = { 'X-Office-Token': await until(() => { try { return sessionTokens(lead.sessionId).find((x) => x !== leadToken['X-Office-Token']); } catch (e) { return null; } }, 'the second session') };
    const terms = (await R.call('GET', '/terminals')).body.terminals;
    assert.deepStrictEqual(terms.filter((x) => x.board).map((x) => x.id), [lead.id]);
    const filed = await fileAs(otherToken, 'Old id');
    assert.strictEqual((await moveTicket(filed.id, 'ready', token)).status, 401);
    assert.strictEqual((await moveTicket(filed.id, 'ready', leadToken)).status, 200);
    await R.call('POST', '/terminals/' + old.id + '/stop', {});
    await until(async () => !(await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === old.id), 'it to stop');
  });
  await t.test('the next prompt saves it under the new id', async () => {
    await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: fresh.slice(0, 12), title: '' }); await sleep(200);
    await R.call('POST', '/terminals/lead', { terminal: lead.id });
    assert.strictEqual(saved().sessionId, fresh);
    assert.strictEqual(saved().board, true);
  });
  await t.test('you can take it back, and give it again', async () => {
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, board: false })).body.board, false);
    assert.strictEqual(saved().board, false);
    const filed = await fileAs(otherToken, 'After taking back');
    assert.strictEqual((await moveTicket(filed.id, 'ready', leadToken)).status, 401);
    await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true });
    assert.strictEqual((await moveTicket(filed.id, 'ready', leadToken)).status, 200);
  });
  await t.test('taking it back reaches the holder, whichever session is named', async () => {
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: other.id, board: false })).body.board, false);
    assert.deepStrictEqual((await R.call('GET', '/terminals')).body.terminals.filter((x) => x.board), []);
    assert.strictEqual(saved().board, false);
    const filed = await fileAs(otherToken, 'Revoked by name');
    assert.strictEqual((await moveTicket(filed.id, 'ready', leadToken)).status, 401);
    await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true });
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: '000000000000', board: false })).status, 200, 'even a session that has gone');
    assert.strictEqual((await moveTicket(filed.id, 'ready', leadToken)).status, 401);
    await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true });
  });
  await t.test('a new Lead does not get it, and the old one loses it', async () => {
    await R.call('POST', '/terminals/lead', { terminal: other.id });
    assert.strictEqual(saved().sessionId, other.sessionId);
    assert.strictEqual(saved().board, false);
    const filed = await fileAs(otherToken, 'After a new Lead');
    assert.strictEqual((await moveTicket(filed.id, 'ready', leadToken)).status, 401);
    assert.strictEqual((await moveTicket(filed.id, 'ready', otherToken)).status, 401);
    await R.call('POST', '/terminals/lead', { terminal: other.id, board: true });
    const again = await R.call('GET', '/terminals');
    assert.strictEqual(again.body.terminals.find((x) => x.id === lead.id).board, false);
  });
  await t.test('the token is still not in the API', async () => {
    assert.ok(!JSON.stringify((await R.call('GET', '/terminals')).body).includes(leadToken['X-Office-Token']));
  });

  await R.kill();
  R = await relay({ RELAY_WIP_LIMIT: '5', ...ghEnv }, home);
  await t.test('Bring back keeps it, and only for that session', async () => {
    const g = (await R.call('GET', '/terminals')).body;
    assert.strictEqual(g.restore.sessionId, other.sessionId);
    const elsewhere = await start({ resume: lead.sessionId });
    const back = await start({ resume: g.restore.sessionId, lead: true });
    const filed = await fileAs(await tokenFor(elsewhere), 'After a restart');
    assert.strictEqual((await moveTicket(filed.id, 'ready', await tokenFor(elsewhere))).status, 401);
    assert.strictEqual((await moveTicket(filed.id, 'ready', await tokenFor(back))).status, 200);
    await R.call('POST', '/terminals/' + back.id + '/stop', {});
    await R.call('POST', '/terminals/' + elsewhere.id + '/stop', {});
    await until(async () => (await R.call('GET', '/terminals')).body.terminals.length === 0, 'them to stop');
  });

  await R.kill();
  const wrong = crypto.randomUUID();
  fs.writeFileSync(file, JSON.stringify({ t: { sessionId: wrong, cwd: repo, title: 'Review PR #9', savedAt: '2026-11-01T00:00:00.000Z' } }));
  R = await relay({ RELAY_WIP_LIMIT: '5', ...ghEnv }, home);
  await t.test('a Lead saved before this permission existed does not have it', async () => {
    assert.strictEqual((await R.call('GET', '/terminals')).body.restore.sessionId, wrong);
    const back = await start({ resume: wrong, lead: true });
    const token = await tokenFor(back);
    const filed = await fileAs(token, 'From the old Lead');
    assert.strictEqual((await moveTicket(filed.id, 'ready', token)).status, 401);
    assert.strictEqual((await R.call('GET', '/terminals')).body.terminals[0].board, false);
  });
});

test('the Lead is held to the WIP limit like anyone', async (t) => {
  const R = await relay({ RELAY_WIP_LIMIT: '1' });
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' }); await sleep(200);
  await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true });
  const token = await tokenFor(lead);
  const a = (await R.call('POST', '/tasks', { title: 'First', repo })).body.task;
  await R.call('POST', '/tasks/' + a.id + '/move', { to: 'in_review' }, token);
  assert.strictEqual((await R.call('POST', '/tasks', { title: 'Second', repo })).status, 201);
  const r = await R.call('POST', '/tasks/' + a.id + '/move', { to: 'building' }, token);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'wip_limit');
  assert.strictEqual((await R.call('GET', '/tasks/' + a.id)).body.task.state, 'in_review');
});

// The Lead's move reads the ticket before its turn to decide whether to ask gh. A ticket that changes while
// the move waits, here from Rejected back to Triage, must not let the Lead's link through unchecked (T-91).
test('a ticket that changes while the Lead\'s move to Done waits is not marked Done unchecked', async (t) => {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify({ prs: {} }));
  // Each write takes a second, so the Lead's move, sent 200 ms after the person's, lands inside that write
  // even on a loaded machine.
  const R = await relay({ RELAY_WIP_LIMIT: '5', RELAY_TICKET_STORE: path.join(__dirname, 'slow-store.js'), SLOW_STORE_UPDATE_MS: '1000', GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' });
  const leadToken = await tokenFor(lead);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true })).body.board, true);
  const ticket = (await R.call('POST', '/tickets', { title: 'Rejected, then back', repo })).body.ticket;
  assert.strictEqual((await R.call('POST', '/tickets/' + ticket.id + '/move', { to: 'rejected' })).status, 200);
  const back = R.call('POST', '/tickets/' + ticket.id + '/move', { to: 'triage' });  // reads (150 ms), then writes (1000 ms)
  await sleep(200);
  const r = await R.call('POST', '/tickets/' + ticket.id + '/move', { to: 'done', pr: 'https://github.com/o/r/pull/9' }, leadToken);
  assert.strictEqual((await back).status, 200);
  assert.deepStrictEqual([r.status, r.body.error], [409, 'changed'], JSON.stringify(r.body));
  assert.strictEqual((await R.call('GET', '/tickets/' + ticket.id)).body.ticket.status, 'triage');
});
