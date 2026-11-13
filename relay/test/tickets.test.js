// The whole path through a real relay with a fake `claude`, once on each store.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');
const { until, ROOT } = H;

const githubEnv = () => ({ RELAY_TICKET_REPO: 't=o/r', GH_CMD: path.join(__dirname, 'fake-github.js'), FAKE_GITHUB_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'office-github-')) });
async function relay(store) {
  const env = { RELAY_WIP_LIMIT: '2', ...(store ? { RELAY_TICKET_STORE: store } : {}) };
  if (store && store.endsWith('github.js')) Object.assign(env, githubEnv());
  const R = await H.relay(env);
  R.repo = H.makeRepo(R.home);
  return R;
}
// Runs the real command line tool with the environment a session gets.
const agentHeaders = (token) => ({ 'X-Office-Token': token });
const sessionToken = H.sessionToken;

for (const [name, store] of [['local', ''], ['memory', path.join(__dirname, 'memory-store.js')], ['github', path.join(__dirname, '..', 'ticket-stores', 'github.js')]]) {
  test('tickets on the ' + name + ' store', async (t) => {
    const R = await relay(store), { call, repo } = R;
    t.after(R.stop);

    await t.test('a person files straight to Ready', async () => {
      const r = await call('POST', '/tickets', { title: 'First', body: 'Do it.', repo, priority: 'high' });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.body.ticket.status, 'ready');
      assert.strictEqual(r.body.ticket.createdBy, 'you');
      assert.strictEqual((await call('GET', '/tickets')).body.store, name);
    });
    await t.test('bad input is refused', async () => {
      assert.strictEqual((await call('POST', '/tickets', { title: ' ', repo })).status, 400);
      assert.strictEqual((await call('POST', '/tickets', { title: 'x', repo, priority: 'urgent' })).status, 400);
      assert.strictEqual((await call('POST', '/tickets', { title: 'x', repo, blockedBy: ['NOPE-1'] })).status, 400);
      assert.strictEqual((await call('POST', '/tickets', { title: 'x', repo: '/tmp' })).status, 400);
      assert.strictEqual((await call('GET', '/tickets/NOPE-1')).status, 404);
    });
    await t.test('the same title returns the first ticket', async () => {
      const first = (await call('GET', '/tickets')).body.tickets[0];
      const r = await call('POST', '/tickets', { title: 'first', repo });
      assert.strictEqual(r.body.duplicate, true);
      assert.strictEqual(r.body.ticket.id, first.id);
    });
    await t.test('control characters do not reach a brief', async () => {
      const r = await call('POST', '/tickets', { title: 'Clean', body: 'a\x1b[2Jb\rc\u009b\u0085\nd', repo });
      assert.strictEqual(r.body.ticket.body, 'a[2Jbc\nd');
      await call('POST', '/tickets/' + r.body.ticket.id + '/move', { to: 'rejected' });
    });

    const worker = (await call('POST', '/terminals', { cwd: repo })).body;
    const agent = agentHeaders(await until(() => { try { return sessionToken(worker.sessionId); } catch (e) { return null; } }, 'the session'));
    let filed;
    await t.test('an agent files to Triage, under its own name', async () => {
      const r = await call('POST', '/tickets', { title: 'From an agent', body: 'Found this.', status: 'ready', createdBy: 'you' }, agent);
      assert.strictEqual(r.status, 201);
      filed = r.body.ticket;
      assert.strictEqual(filed.status, 'triage');
      assert.notStrictEqual(filed.createdBy, 'you');
      assert.strictEqual(filed.repo, repo);
    });
    await t.test('an agent cannot refile what you rejected, but you can', async () => {
      const a = (await call('POST', '/tickets', { title: 'Turned down', repo }, agent)).body.ticket;
      await call('POST', '/tickets/' + a.id + '/move', { to: 'rejected' });
      const again = await call('POST', '/tickets', { title: 'turned down' }, agent);
      assert.strictEqual(again.body.duplicate, true);
      assert.strictEqual(again.body.ticket.id, a.id);
      assert.strictEqual(again.body.ticket.status, 'rejected');
      assert.strictEqual((await call('POST', '/tickets', { title: 'Turned down', repo })).status, 201);
    });
    await t.test('an agent token only lists and files', async () => {
      assert.strictEqual((await call('GET', '/tickets', null, agent)).status, 200);
      assert.strictEqual((await call('POST', '/tickets/' + filed.id + '/move', { to: 'ready' }, agent)).status, 401);
      assert.strictEqual((await call('POST', '/tickets/' + filed.id + '/start', {}, agent)).status, 401);
      assert.strictEqual((await call('POST', '/tickets/ask', { idea: 'x', repo }, agent)).status, 401);
      assert.strictEqual((await call('GET', '/terminals', null, agent)).status, 401);
      assert.strictEqual((await call('GET', '', null, agent)).status, 401);
      assert.strictEqual((await call('GET', '/tickets', null, { 'X-Office-Token': 'wrong' })).status, 401);
    });
    await t.test('the token is not in the API', async () => {
      const list = await call('GET', '/terminals');
      assert.ok(!JSON.stringify(list.body).includes(agent['X-Office-Token']));
    });
    await t.test('the command line tool files a ticket', async () => {
      const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: agent['X-Office-Token'] };
      const out = execFileSync('node', [path.join(ROOT, 'relay', 'ticket.js'), 'create', 'From', 'the', 'tool', '--body', 'Details', '--priority', 'low'], { env, encoding: 'utf8' });
      assert.match(out, /Filed: \S+ {2}From the tool {2}\(waiting in triage\)/);
      assert.match(execFileSync('node', [path.join(ROOT, 'relay', 'ticket.js'), 'list'], { env, encoding: 'utf8' }), /From the tool/);
    });
    // A four-part body has line breaks, and often quotes, backticks or $( ). Inside the shell's double
    // quotes those run or end the argument, so a body goes on stdin in a quoted heredoc, or in a file (T-49).
    await t.test('a body with line breaks, quotes, backticks and $( ) is stored as written, from stdin or a file', async () => {
      const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: agent['X-Office-Token'] };
      const CLI = path.join(ROOT, 'relay', 'ticket.js');
      const body = 'What to build: a "quoted" word, a `backtick` and $(echo ran) stay as written.\n\nAcceptance criteria:\n- \'single\' quotes, a \\ backslash and $HOME too\n\nOut of scope: none';
      const stored = async (out) => (await call('GET', '/tickets/' + out.match(/Filed: (\S+)/)[1])).body.ticket.body;
      // The command a brief tells a session to type, run by a real shell.
      const piped = execFileSync('/bin/sh', ['-c', 'node "$CLI" create "Body on stdin" --body - <<\'EOF\'\n' + body + '\nEOF\n'], { env: { ...env, CLI }, encoding: 'utf8' });
      assert.strictEqual(await stored(piped), body);
      const file = path.join(R.home, 'body.md');
      fs.writeFileSync(file, body + '\n');
      assert.strictEqual(await stored(execFileSync('node', [CLI, 'create', 'Body in a file', '--body-file', file], { env, encoding: 'utf8' })), body);
      assert.strictEqual(await stored(execFileSync('node', [CLI, 'create', 'Body file on stdin', '--body-file', '-'], { env, input: body, encoding: 'utf8' })), body);
      const fails = (args, input) => { try { execFileSync('node', [CLI, 'create', ...args], { env, input, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { return e.stderr; } assert.fail('it filed: ' + args.join(' ')); };
      assert.match(fails(['Twice', '--body', 'a', '--body-file', file]), /Give the body once/);
      assert.match(fails(['No file', '--body-file', path.join(R.home, 'nope.md')]), /Could not read the body file .*nope\.md: ENOENT/);
      assert.match(fails(['No path', '--body-file']), /Say what follows --body-file/);
      const titles = (await call('GET', '/tickets')).body.tickets.map((x) => x.title);
      for (const title of ['Twice', 'No file', 'No path']) assert.ok(!titles.includes(title), title + ' was not filed');
    });
    await t.test('triage cannot start, and approving makes it ready', async () => {
      assert.strictEqual((await call('POST', '/tickets/' + filed.id + '/start', {})).body.error, 'not_ready');
      assert.strictEqual((await call('POST', '/tickets/' + filed.id + '/move', { to: 'done' })).body.error, 'bad_pr', 'done without a task needs its PR');
      assert.strictEqual((await call('POST', '/tickets/' + filed.id + '/move', { to: 'ready' })).body.ticket.status, 'ready');
    });
    await t.test('a Triage or Ready ticket whose work merged outside the room is done with its PR', async () => {
      const ready = (await call('POST', '/tickets', { title: 'Merged by hand', repo })).body.ticket;
      const triage = (await call('POST', '/tickets', { title: 'Also merged by hand' }, agent)).body.ticket;
      const waiting = (await call('POST', '/tickets', { title: 'Waits on it', repo, blockedBy: [ready.id] })).body.ticket;
      for (const pr of [undefined, '', 'not a link', 'http://github.com/o/r/pull/3', 'https://github.com/o/r/issues/3', 'https://github.com/o/r/pull/3/files',
        'https://github.com/o/r/pull/0', 'https://github.com.evil.example/o/r/pull/3', 'https://example.com/o/r/pull/3', 'javascript:alert(1)', 'https://github.com/o/r/pull/3?x=1']) {
        const r = await call('POST', '/tickets/' + ready.id + '/move', { to: 'done', pr });
        assert.strictEqual(r.status, 400, String(pr));
        assert.strictEqual(r.body.error, 'bad_pr');
      }
      assert.strictEqual((await call('GET', '/tickets/' + ready.id)).body.ticket.status, 'ready', 'a refused link changes nothing');
      const r = await call('POST', '/tickets/' + ready.id + '/move', { to: 'done', pr: 'https://github.com/o/r/pull/32' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.ticket.status, 'done');
      assert.strictEqual(r.body.ticket.pr, 'https://github.com/o/r/pull/32');
      assert.strictEqual(r.body.ticket.task, null);
      assert.strictEqual((await call('POST', '/tickets/' + triage.id + '/move', { to: 'done', pr: 'https://github.com/o/r/pull/33' })).body.ticket.status, 'done');
      const listed = (await call('GET', '/tickets')).body.tickets;
      assert.deepStrictEqual([ready.id, triage.id].map((id) => listed.find((x) => x.id === id)).map((x) => [x.status, x.pr]), [['done', 'https://github.com/o/r/pull/32'], ['done', 'https://github.com/o/r/pull/33']], 'it stays done with its PR');
      assert.deepStrictEqual(listed.find((x) => x.id === waiting.id).waitingFor, [], 'what waited for it is free');
      assert.strictEqual((await call('POST', '/tickets/' + ready.id + '/start', {})).body.error, 'not_ready', 'nobody starts it again');
      assert.strictEqual((await call('POST', '/tickets/' + ready.id + '/move', { to: 'ready' })).status, 409);
      assert.strictEqual((await call('POST', '/tickets/' + waiting.id + '/move', { to: 'done', pr: 'https://github.com/o/r/pull/34' }, agent)).status, 401, 'a session cannot do it');
      await call('POST', '/tickets/' + waiting.id + '/move', { to: 'rejected' });
      assert.strictEqual((await call('POST', '/tickets/' + waiting.id + '/move', { to: 'done', pr: 'https://github.com/o/r/pull/34' })).status, 409, 'not from Rejected');
    });

    let first, blocked;
    await t.test('a blocked ticket waits for its blocker', async () => {
      first = (await call('GET', '/tickets')).body.tickets[0];
      blocked = (await call('POST', '/tickets', { title: 'Second', repo, blockedBy: [first.id] })).body.ticket;
      assert.deepStrictEqual(blocked.waitingFor, [first.id]);
      assert.strictEqual((await call('POST', '/tickets/' + blocked.id + '/start', {})).body.error, 'blocked');
    });
    let task;
    await t.test('starting makes a task with the ticket as its brief', async () => {
      const r = await call('POST', '/tickets/' + first.id + '/start', {});
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.ticket.status, 'started');
      task = r.body.task;
      assert.strictEqual(task.ticket, first.id);
      assert.strictEqual(task.brief, 'Do it.');
      const screen = await until(async () => { const s = await R.screen(r.body.task.worker.terminal); return s.includes('GOT[') && s; }, 'the brief');
      assert.match(screen, /build this now: First\. Do it\./);
      assert.ok(fs.existsSync(task.worktree));
      assert.strictEqual((await call('POST', '/tickets/' + first.id + '/start', {})).body.error, 'started');
      assert.strictEqual((await call('POST', '/tickets/' + first.id + '/move', { to: 'done', pr: 'https://github.com/o/r/pull/9' })).status, 409, 'a started ticket is done when its task is');
    });
    await t.test('the limit on building holds', async () => {
      const a = (await call('POST', '/tickets', { title: 'Third', repo })).body.ticket;
      assert.strictEqual((await call('POST', '/tickets/' + a.id + '/start', {})).status, 200);
      const b = (await call('POST', '/tickets', { title: 'Fourth', repo })).body.ticket;
      assert.strictEqual((await call('POST', '/tickets/' + b.id + '/start', {})).body.error, 'wip_limit');
    });
    await t.test('the ticket follows its task to done, which frees what waited', async () => {
      await call('POST', '/tasks/' + task.id + '/move', { to: 'in_review' });
      let got = (await call('GET', '/tickets/' + first.id)).body.ticket;
      assert.strictEqual(got.task.state, 'in_review');
      assert.strictEqual(got.task.worker, undefined, 'a worker\'s state changing does not redraw the board');
      await call('POST', '/tasks/' + task.id + '/move', { to: 'done' });
      got = (await call('GET', '/tickets/' + first.id)).body.ticket;
      assert.strictEqual(got.status, 'done');
      assert.deepStrictEqual((await call('GET', '/tickets/' + blocked.id)).body.ticket.waitingFor, []);
    });
    await t.test('a session in a task checkout files against the repo', async () => {
      const inTask = (await call('POST', '/terminals', { cwd: task.worktree })).body;
      const headers = agentHeaders(await until(() => { try { return sessionToken(inTask.sessionId); } catch (e) { return null; } }, 'the session'));
      const r = await call('POST', '/tickets', { title: 'Found mid task' }, headers);
      assert.strictEqual(r.body.ticket.repo, repo);
      await call('POST', '/terminals/' + inTask.id + '/stop', {});
    });
    await t.test('reopening a task reopens its ticket', async () => {
      await call('POST', '/tasks/' + task.id + '/move', { to: 'building' });
      assert.strictEqual((await call('GET', '/tickets/' + first.id)).body.ticket.status, 'started');
      await call('POST', '/tasks/' + task.id + '/move', { to: 'done' });
    });
    await t.test('a ticket is done even if nobody listed tickets before its task was cleaned up', async () => {
      await call('POST', '/terminals/' + task.worker.terminal + '/stop', {});
      await until(async () => !(await call('GET', '/tasks/' + task.id)).body.task.worker, 'the worker to go');
      assert.strictEqual((await call('POST', '/tasks/' + task.id + '/clean', {})).status, 200);
      await H.sleep(100);
      assert.strictEqual((await call('GET', '/tickets/' + first.id)).body.ticket.status, 'done');
    });
    await t.test('a rejected blocker frees what waited, and can come back', async () => {
      const a = (await call('POST', '/tickets', { title: 'Might go', repo })).body.ticket;
      const b = (await call('POST', '/tickets', { title: 'Needs it', repo, blockedBy: [a.id] })).body.ticket;
      await call('POST', '/tickets/' + a.id + '/move', { to: 'rejected' });
      const got = (await call('GET', '/tickets/' + b.id)).body.ticket;
      assert.deepStrictEqual(got.waitingFor, []);
      assert.deepStrictEqual(got.rejectedBlockers, [a.id]);
      assert.strictEqual((await call('POST', '/tickets/' + a.id + '/move', { to: 'triage' })).body.ticket.status, 'triage');
      assert.deepStrictEqual((await call('GET', '/tickets/' + b.id)).body.ticket.waitingFor, [a.id]);
    });
    await t.test('the same title in another repo is its own ticket', async () => {
      const other = H.makeRepo(R.home, 'other');
      const r = await call('POST', '/tickets', { title: 'Second', repo: other });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.body.ticket.repo, other);
    });
    await t.test('two filings at once make one ticket', async () => {
      const both = await Promise.all([call('POST', '/tickets', { title: 'Double press', repo }), call('POST', '/tickets', { title: 'Double press', repo })]);
      assert.strictEqual(both.filter((x) => x.body.duplicate).length, 1);
      assert.strictEqual(both[0].body.ticket.id, both[1].body.ticket.id);
    });
    await t.test('a submodule and a separate git folder give the right repo', async () => {
      const sub = H.makeRepo(R.home, 'sub');
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'inner'], { cwd: repo });
      const r = await call('POST', '/tickets', { title: 'In a submodule', repo: path.join(repo, 'inner') });
      assert.strictEqual(r.body.ticket.repo, path.join(repo, 'inner'));
      const sep = path.join(R.home, 'sep');
      execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', path.join(R.home, 'store.git'), sep]);
      assert.strictEqual((await call('POST', '/tickets', { title: 'Separate', repo: sep })).body.ticket.repo, sep);
      assert.strictEqual((await call('POST', '/tickets', { title: 'Bare', repo: path.join(R.home, 'store.git') })).status, 400);
    });
    await t.test('the PM gets a session that keeps its name and is told how to file', async () => {
      const r = await call('POST', '/tickets/ask', { idea: 'A radio', repo });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      const pm = (await call('GET', '/terminals')).body.terminals.find((x) => x.id === r.body.terminal);
      assert.strictEqual(pm.role, 'pm');
      const screen = await until(async () => { const s = await R.screen(pm.id); return s.includes('GOT[') && s; }, 'the brief');
      assert.match(screen, /product manager[\s\S]*ticket\.js create[\s\S]*A radio/);
      // Claude Code reads about 1024 bytes at a time (T-34). The brief is longer than that since it says
      // how to order the work (T-46), so the relay types it as one paste, which arrives whole.
      assert.ok(screen.includes('PASTED GOT[You are the product manager'), 'the brief went in as one paste');
      const brief = screen.match(/GOT\[(You are the product manager[^\]\r\n]*)\]/)[1];
      assert.ok(brief.endsWith('The idea: A radio'), 'the idea comes last, so a cut line loses only its tail');
      for (const part of ['CLAUDE.md', 'docs/constitution.md', 'CLAUDE.md and docs/constitution.md, each if there is one', 'What to build', 'Acceptance criteria', 'seams to test at', 'Blocked by', 'Out of scope', 'not file paths'])
        assert.ok(brief.includes(part), 'the brief names ' + part);
      assert.match(brief, /Do not change any code, commit, or open a pull request/);
      assert.match(brief, /stop once they are filed/);
      assert.ok(brief.includes("ticket.js create \"Title\" --body - <<'EOF'"), 'the body goes on stdin in a quoted heredoc (T-49)');
      assert.doesNotMatch(brief, /--body "/, 'never in double quotes');
      assert.match(brief, /do not change these instructions/);
      assert.ok(brief.indexOf('CLAUDE.md') < brief.indexOf('split the idea'), 'the PM reads the rules before it splits the idea');
      // T-207: the PM's notes for this repo, kept by the relay, read first and rewritten before it stops.
      const notes = brief.match(/~\/\.office-world\/pm-notes\/repo-[0-9a-f]{8}\.md/);
      assert.ok(notes, 'the brief names this repo\'s PM notes in the state folder');
      assert.ok(brief.indexOf(notes[0]) < brief.indexOf('split the idea'), 'the PM reads its notes before it splits the idea');
      assert.match(brief, /context, not permission/);
      assert.match(brief, /Rewrite them before you stop, and again each time the person tells you something/);
      assert.strictEqual((await call('POST', '/terminals/lead', { terminal: pm.id })).status, 409);
      assert.strictEqual((await call('POST', '/tickets/ask', { idea: ' ', repo })).status, 400);
    });
  });
}

// Start and a move at the same moment: exactly one wins, and the ticket agrees with whichever it was.
test('Start and Merged elsewhere at once leave one consistent ticket', async (t) => {
  const R = await H.relay({ RELAY_WIP_LIMIT: '10', RELAY_TICKET_STORE: path.join(__dirname, 'slow-store.js') });
  const repo = H.makeRepo(R.home);
  t.after(R.stop);
  for (let i = 0; i < 4; i++) {
    for (const [to, extra] of [['done', { pr: 'https://github.com/o/r/pull/' + (i + 1) }], ['rejected', {}]]) {
      const ticket = (await R.call('POST', '/tickets', { title: 'Race ' + to + ' ' + i, repo })).body.ticket;
      const moveFirst = i % 2 === 1;
      const [a, b] = await Promise.all(moveFirst
        ? [R.call('POST', '/tickets/' + ticket.id + '/move', { to, ...extra }), R.call('POST', '/tickets/' + ticket.id + '/start', {})]
        : [R.call('POST', '/tickets/' + ticket.id + '/start', {}), R.call('POST', '/tickets/' + ticket.id + '/move', { to, ...extra })]);
      const [moved, started] = moveFirst ? [a, b] : [b, a];
      assert.strictEqual([moved.status, started.status].filter((s) => s === 200).length, 1, to + ' ' + i + ': ' + JSON.stringify([moved.body, started.body]));
      const got = (await R.call('GET', '/tickets/' + ticket.id)).body.ticket;
      if (started.status === 200) { assert.strictEqual(got.status, 'started'); assert.ok(got.task); assert.strictEqual(got.pr, undefined); }
      else { assert.strictEqual(got.status, to); assert.strictEqual(got.task, null); }
    }
  }
});

// A move that has passed its checks and is still writing holds Start back: with a write that takes
// 300 ms, Start pressed while it writes once won too, and the ticket ended Started with a task and the PR (T-91).
test('Start pressed while a move to Done is still writing waits for it, and loses', async (t) => {
  const R = await H.relay({ RELAY_WIP_LIMIT: '10', RELAY_TICKET_STORE: path.join(__dirname, 'slow-store.js'), SLOW_STORE_UPDATE_MS: '300' });
  const repo = H.makeRepo(R.home);
  t.after(R.stop);
  for (const [to, extra] of [['done', { pr: 'https://github.com/o/r/pull/7' }], ['rejected', {}]]) {
    const ticket = (await R.call('POST', '/tickets', { title: 'Slow ' + to, repo })).body.ticket;
    const moving = R.call('POST', '/tickets/' + ticket.id + '/move', { to, ...extra });
    await H.sleep(250);  // the move has read the ticket (150 ms) and is writing (300 ms)
    const [moved, started] = await Promise.all([moving, R.call('POST', '/tickets/' + ticket.id + '/start', {})]);
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
    assert.strictEqual(started.status, 409, JSON.stringify(started.body));
    assert.strictEqual(started.body.error, 'not_ready');
    const got = (await R.call('GET', '/tickets/' + ticket.id)).body.ticket;
    assert.deepStrictEqual([got.status, got.task], [to, null]);
  }
});

test('a ticket filed on GitHub with only a label lists, works in the relay\'s folder, and starts', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
  const repo = H.makeRepo(home), env = githubEnv();
  fs.writeFileSync(path.join(env.FAKE_GITHUB_DIR, 'state.json'), JSON.stringify({ 'o/r': { next: 2, labels: ['office:ready'], issues: [
    { number: 1, id: 9001, title: 'From GitHub', body: 'Fix it.', state: 'open', state_reason: null, labels: ['office:ready'], user: { login: 'someone' }, blockedBy: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }
  ] } }));
  const R = await H.relay({ RELAY_WIP_LIMIT: '2', RELAY_TICKET_STORE: path.join(__dirname, '..', 'ticket-stores', 'github.js'), RELAY_TICKET_FOLDER: repo, ...env }, home);
  t.after(async () => { await R.kill(); await R.remove(); });
  const [ticket] = (await R.call('GET', '/tickets')).body.tickets;
  assert.deepStrictEqual([ticket.id, ticket.status, ticket.repo, ticket.base, ticket.createdBy], ['1', 'ready', repo, undefined, 'someone on GitHub']);
  const r = await R.call('POST', '/tickets/1/start', {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.ticket.status, 'started');
  assert.strictEqual(r.body.task.brief, 'Fix it.');
  const issue = JSON.parse(fs.readFileSync(path.join(env.FAKE_GITHUB_DIR, 'state.json'), 'utf8'))['o/r'].issues[0];
  assert.ok(issue.labels.includes('office:started'));
  assert.match(issue.body, /"repo":"[^"]+","createdBy":"someone on GitHub","sig":"[0-9a-f]{32}"/, 'the relay signs the folder it chose');
});
test('a plain New task counts against the limit too', async (t) => {
  const R = await relay(); t.after(R.stop);
  for (const title of ['One', 'Two']) assert.strictEqual((await R.call('POST', '/tasks', { title, repo: R.repo })).status, 201);
  assert.strictEqual((await R.call('POST', '/tasks', { title: 'Three', repo: R.repo })).body.error, 'wip_limit');
});
test('a store that fails while starting leaves nothing running', async (t) => {
  const R = await relay(path.join(__dirname, 'failing-store.js')); t.after(R.stop);
  const a = (await R.call('POST', '/tickets', { title: 'no-started', repo: R.repo })).body.ticket;
  const r = await R.call('POST', '/tickets/' + a.id + '/start', {});
  assert.strictEqual(r.status, 502, 'a tracker\'s own status does not pass as ours');
  assert.strictEqual(r.body.error, 'store');
  assert.deepStrictEqual((await R.call('GET', '/tasks')).body.tasks, []);
  assert.deepStrictEqual((await R.call('GET', '/terminals')).body.terminals, []);
});
test('a store that fails during Clean up keeps the task, so the ticket can still hear', async (t) => {
  const R = await relay(path.join(__dirname, 'failing-store.js')); t.after(R.stop);
  const a = (await R.call('POST', '/tickets', { title: 'no-done', repo: R.repo })).body.ticket;
  const task = (await R.call('POST', '/tickets/' + a.id + '/start', {})).body.task;
  await R.call('POST', '/terminals/' + task.worker.terminal + '/stop', {});
  await until(async () => !(await R.call('GET', '/tasks/' + task.id)).body.task.worker, 'the worker to go');
  await R.call('POST', '/tasks/' + task.id + '/move', { to: 'done' });
  const r = await R.call('POST', '/tasks/' + task.id + '/clean', {});
  assert.strictEqual(r.status, 502);
  assert.ok(fs.existsSync(task.worktree));
  assert.strictEqual((await R.call('GET', '/tasks/' + task.id)).status, 200);
});
test('moves respect the limit only where they add to it', async (t) => {
  const R = await relay(); t.after(R.stop);
  const make = async (title) => (await R.call('POST', '/tasks', { title, repo: R.repo })).body.task;
  const a = await make('A'), b = await make('B');
  await R.call('POST', '/tasks/' + a.id + '/move', { to: 'in_review' });
  const c = await make('C');
  assert.strictEqual((await R.call('POST', '/tasks/' + a.id + '/move', { to: 'changes_requested' })).body.error, 'wip_limit', 'back to building is over');
  assert.strictEqual((await R.call('POST', '/tasks/' + b.id + '/move', { to: 'changes_requested' })).status, 200, 'already building adds nothing');
  await R.call('POST', '/terminals/' + a.worker.terminal + '/stop', {});
  await until(async () => !(await R.call('GET', '/tasks/' + a.id)).body.task.worker, 'the worker to go');
  assert.strictEqual((await R.call('POST', '/tasks/' + a.id + '/resume', {})).status, 200, 'a task in review can always come back');
  assert.ok(c);
});
test('two relays on one tickets file do not erase each other', async (t) => {
  const R = await relay(); t.after(R.stop);
  const first = (await R.call('POST', '/tickets', { title: 'Keep me', repo: R.repo })).body.ticket;
  const second = await H.relay({}, R.home); t.after(second.stop);
  await until(() => /owns .*tickets\.json/.test(second.output()), 'the warning');
  await second.call('POST', '/tickets', { title: 'From the second', repo: R.repo });
  const saved = JSON.parse(fs.readFileSync(path.join(R.home, '.office-world', 'tickets.json'), 'utf8'));
  assert.deepStrictEqual(saved.t.tickets.map((x) => x.id), [first.id]);
});
test('a worktree of a bare repo files against itself, and can start', async (t) => {
  const R = await relay(); t.after(R.stop);
  const bare = path.join(R.home, 'r.git'), wt = path.join(R.home, 'wt');
  execFileSync('git', ['clone', '-q', '--bare', R.repo, bare]);
  execFileSync('git', ['worktree', 'add', '-q', wt, 'main'], { cwd: bare });
  const a = (await R.call('POST', '/tickets', { title: 'In a bare worktree', repo: wt })).body.ticket;
  assert.strictEqual(a.repo, wt);
  assert.strictEqual((await R.call('POST', '/tickets/' + a.id + '/start', {})).status, 200);
});

// A repo whose main folder stays on main, with a linked worktree on a branch that has moved on.
function branchedRepo(R, branch) {
  const wt = path.join(R.home, 'wt-' + branch.replace(/\W/g, '-'));
  execFileSync('git', ['worktree', 'add', '-q', '-b', branch, wt, 'main'], { cwd: R.repo });
  fs.writeFileSync(path.join(wt, 'only-here.txt'), 'x\n');
  execFileSync('git', ['add', 'only-here.txt'], { cwd: wt });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'moved on'], { cwd: wt });
  return wt;
}
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
async function sessionIn(R, cwd) {
  const s = (await R.call('POST', '/terminals', { cwd })).body;
  return agentHeaders(await until(() => { try { return sessionToken(s.sessionId); } catch (e) { return null; } }, 'the session'));
}
// The fake claude echoes the brief as GOT[...] on one line, so wait for its closing ] and the line's end,
// not just GOT[, or a check on the end of the brief can read it half drawn.
const briefOf = (R, task) => until(async () => { const s = await R.screen(task.worker.terminal); return /GOT\[[^\r\n]*\]\r?\n/.test(s) && s; }, 'the brief');

test('a ticket filed from a linked worktree starts from that branch, not the main folder\'s', async (t) => {
  const R = await relay(); t.after(R.stop);
  const wt = branchedRepo(R, 'feature/x');
  const filed = await R.call('POST', '/tickets', { title: 'From the worktree', repo: wt });
  assert.strictEqual(filed.status, 201, JSON.stringify(filed.body));
  assert.strictEqual(filed.body.ticket.repo, R.repo);
  assert.strictEqual(filed.body.ticket.base, 'feature/x');
  assert.strictEqual((await R.call('GET', '/tickets')).body.tickets[0].base, 'feature/x');

  const started = await R.call('POST', '/tickets/' + filed.body.ticket.id + '/start', {});
  assert.strictEqual(started.status, 200, JSON.stringify(started.body));
  const task = started.body.task;
  assert.strictEqual(task.base, 'feature/x');
  assert.strictEqual(gitIn(task.worktree, 'rev-parse', 'HEAD'), gitIn(wt, 'rev-parse', 'HEAD'));
  assert.ok(fs.existsSync(path.join(task.worktree, 'only-here.txt')));
  assert.match(await briefOf(R, task), /pull request against feature\/x\./);
  assert.strictEqual(gitIn(R.repo, 'symbolic-ref', '--short', 'HEAD'), 'main', 'the main folder is left alone');
});
test('the recorded base wins over a branch the ticket text names (T-52)', async (t) => {
  const R = await relay(); t.after(R.stop);
  const filed = (await R.call('POST', '/tickets', { title: 'Old text', body: 'Work from office-worker-sessions and open the PR against it.', repo: R.repo })).body.ticket;
  assert.strictEqual(filed.base, 'main');
  const task = (await R.call('POST', '/tickets/' + filed.id + '/start', {})).body.task;
  assert.strictEqual(task.base, 'main');
  const brief = (await briefOf(R, task)).replace(/\s+/g, ' ');
  assert.match(brief, /Work from office-worker-sessions/, 'the ticket text is still in the brief');
  assert.match(brief, /This branch belongs to main, the base this task records\. That base wins over any other branch the ticket text names, unless the person tells you otherwise in this session\. Do not reset, rebase or switch this branch onto a different branch\. Catching up with main is fine\./);
  assert.match(brief, /open a pull request against main\./);
});
test('a session files against the repo\'s default branch, not its task\'s base or its own branch', async (t) => {
  const R = await relay(); t.after(R.stop);
  const wt = branchedRepo(R, 'feature');
  const first = (await R.call('POST', '/tickets', { title: 'The task', repo: wt })).body.ticket;
  const task = (await R.call('POST', '/tickets/' + first.id + '/start', {})).body.task;
  assert.strictEqual(task.base, 'feature');
  const headers = await sessionIn(R, task.worktree);

  const filed = (await R.call('POST', '/tickets', { title: 'Found mid task', base: 'feature' }, headers)).body.ticket;
  assert.strictEqual(filed.repo, R.repo);
  assert.strictEqual(filed.base, 'main', 'not the task\'s base, and what it asks for does not count');

  gitIn(task.worktree, 'checkout', '-q', '--detach');
  assert.strictEqual((await R.call('POST', '/tickets', { title: 'Found while detached' }, headers)).body.ticket.base, 'main');
  assert.strictEqual((await R.call('POST', '/tickets', { title: 'From a plain session' }, await sessionIn(R, wt))).body.ticket.base, 'main');

  await R.call('POST', '/tickets/' + filed.id + '/move', { to: 'ready' });
  const next = (await R.call('POST', '/tickets/' + filed.id + '/start', {})).body.task;
  assert.strictEqual(next.base, 'main');
  assert.ok(!fs.existsSync(path.join(next.worktree, 'only-here.txt')));
  assert.match(await briefOf(R, next), /pull request against main\./);
});
test('the default branch is the one the remote names, even when the main folder is on another', async (t) => {
  const R = await relay(); t.after(R.stop);
  const remote = path.join(R.home, 'remote.git');
  execFileSync('git', ['clone', '-q', '--bare', R.repo, remote]);
  gitIn(R.repo, 'branch', 'trunk');
  gitIn(R.repo, 'remote', 'add', 'origin', remote);
  gitIn(R.repo, 'push', '-q', 'origin', 'trunk');
  gitIn(R.repo, 'fetch', '-q', 'origin');
  gitIn(R.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  gitIn(R.repo, 'checkout', '-q', '-b', 'old');
  const r = await R.call('POST', '/tickets', { title: 'From the Lead' }, await sessionIn(R, R.repo));
  assert.strictEqual(r.body.ticket.base, 'trunk');
});
// T-5: the PM asked from a linked worktree works there, not in the main folder, and files against its branch.
test('the PM asked from a linked worktree reads that branch and files against it', async (t) => {
  const R = await relay(); t.after(R.stop);
  const wt = branchedRepo(R, 'feature');
  const r = await R.call('POST', '/tickets/ask', { idea: 'A radio', repo: wt });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const pm = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === r.body.terminal);
  // Since T-40 it reads that branch in a checkout of its own, not in the folder you gave.
  assert.ok(fs.existsSync(path.join(pm.cwd, 'only-here.txt')), 'it reads that branch');
  assert.strictEqual(gitIn(pm.cwd, 'rev-parse', 'HEAD'), gitIn(wt, 'rev-parse', 'HEAD'));
  const filed = (await R.call('POST', '/tickets', { title: 'From the PM' }, await until(() => { try { return agentHeaders(sessionToken(pm.sessionId)); } catch (e) { return null; } }, 'the PM'))).body.ticket;
  assert.strictEqual(filed.base, 'feature');
  assert.strictEqual(filed.repo, R.repo, 'the ticket still belongs to the repo');
  assert.strictEqual(filed.createdBy, 'PM');
  // A plain session in the same folder still files against the default branch.
  assert.strictEqual((await R.call('POST', '/tickets', { title: 'From a worker' }, await sessionIn(R, wt))).body.ticket.base, 'main');
  gitIn(wt, 'checkout', '-q', '--detach');
  const detached = await R.call('POST', '/tickets/ask', { idea: 'A clock', repo: wt });
  assert.strictEqual(detached.status, 400);
  assert.strictEqual(detached.body.error, 'no_branch');
});
// T-40: the PM reads the base at the remote's latest commit, in a checkout of its own that goes when it ends.
const pmOf = async (R, r) => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === r.body.terminal);
// Ignored files count too. The PM's checkout is in .worktrees while it runs, as a task's is, and not after.
const folderState = (dir, ...ignored) => [gitIn(dir, 'symbolic-ref', '--short', 'HEAD'), gitIn(dir, 'rev-parse', 'HEAD'), gitIn(dir, 'status', '--porcelain', '--ignored').split('\n').filter((l) => l && !ignored.includes(l)).join('\n')];
async function stopPm(R, pm) {
  await R.call('POST', '/terminals/' + pm.id + '/stop', {});
  await until(() => !fs.existsSync(pm.cwd), 'the PM\'s checkout to go', 300);
  assert.ok(!gitIn(R.repo, 'worktree', 'list').includes(pm.cwd), 'git no longer lists it');
}
test('the PM reads the remote\'s latest base, and leaves the main folder as it was', async (t) => {
  const R = await relay(); t.after(R.stop);
  const remote = path.join(R.home, 'remote.git'), other = path.join(R.home, 'other');
  execFileSync('git', ['clone', '-q', '--bare', R.repo, remote]);
  gitIn(R.repo, 'remote', 'add', 'origin', remote);
  gitIn(R.repo, 'fetch', '-q', 'origin');
  gitIn(R.repo, 'branch', '-q', '--set-upstream-to', 'origin/main', 'main');
  // Someone else pushes the rules, so only origin/main has CLAUDE.md, and local main is behind.
  execFileSync('git', ['clone', '-q', remote, other]);
  fs.writeFileSync(path.join(other, 'CLAUDE.md'), '# Rules\n');
  gitIn(other, 'add', 'CLAUDE.md');
  gitIn(other, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'the rules');
  gitIn(other, 'push', '-q', 'origin', 'main');
  const before = folderState(R.repo);
  const r = await R.call('POST', '/tickets/ask', { idea: 'A radio', repo: R.repo });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const pm = await pmOf(R, r);
  assert.notStrictEqual(fs.realpathSync(pm.cwd), fs.realpathSync(R.repo), 'the PM has a checkout of its own');
  assert.ok(fs.existsSync(path.join(pm.cwd, 'CLAUDE.md')), 'the PM reads the rules that are only on origin/main');
  assert.strictEqual(gitIn(pm.cwd, 'rev-parse', 'HEAD'), gitIn(other, 'rev-parse', 'HEAD'), 'at the remote\'s latest commit');
  assert.throws(() => gitIn(pm.cwd, 'symbolic-ref', '-q', 'HEAD'), 'on no branch');
  await until(async () => (await R.screen(pm.id)).includes('GOT['), 'the brief');
  assert.deepStrictEqual(folderState(R.repo, '!! .worktrees/'), before, 'the main folder keeps its branch, its commit and its files');
  assert.ok(!fs.existsSync(path.join(R.repo, 'CLAUDE.md')));
  // What it files still records the branch it was asked from.
  const filed = (await R.call('POST', '/tickets', { title: 'From the PM' }, await until(() => { try { return agentHeaders(sessionToken(pm.sessionId)); } catch (e) { return null; } }, 'the PM'))).body.ticket;
  assert.strictEqual(filed.base, 'main');
  assert.strictEqual(filed.repo, R.repo);
  await stopPm(R, pm);
  assert.deepStrictEqual(folderState(R.repo), before);
});
test('with no remote, or a remote that cannot be reached, the PM reads the local branch and the log says why', async (t) => {
  const R = await relay(); t.after(R.stop);
  const head = gitIn(R.repo, 'rev-parse', 'HEAD');
  const alone = await R.call('POST', '/tickets/ask', { idea: 'A radio', repo: R.repo });
  assert.strictEqual(alone.status, 201, JSON.stringify(alone.body));
  const pm = await pmOf(R, alone);
  assert.strictEqual(gitIn(pm.cwd, 'rev-parse', 'HEAD'), head);
  await until(() => /The PM reads main as it is here: .* has no remote for it\./.test(R.output()), 'the log line');
  await stopPm(R, pm);
  gitIn(R.repo, 'remote', 'add', 'origin', path.join(R.home, 'not-there.git'));
  const away = await R.call('POST', '/tickets/ask', { idea: 'A clock', repo: R.repo });
  assert.strictEqual(away.status, 201, JSON.stringify(away.body));
  const pm2 = await pmOf(R, away);
  assert.strictEqual(gitIn(pm2.cwd, 'rev-parse', 'HEAD'), head);
  await until(() => /The PM reads main as it is here: origin could not be reached/.test(R.output()), 'the log line');
  await stopPm(R, pm2);
});
test('with no remote and no main or master, a session files against the main folder\'s branch', async (t) => {
  const R = await relay(); t.after(R.stop);
  gitIn(R.repo, 'branch', '-m', 'main', 'develop');
  const r = await R.call('POST', '/tickets', { title: 'Odd repo' }, await sessionIn(R, R.repo));
  assert.strictEqual(r.body.ticket.base, 'develop');
});
test('a person can change a ticket\'s base before it starts, and the brief follows', async (t) => {
  const R = await relay(); t.after(R.stop);
  const wt = branchedRepo(R, 'feature');
  const filed = (await R.call('POST', '/tickets', { title: 'Wrong base', repo: wt })).body.ticket;
  assert.strictEqual(filed.base, 'feature');
  const agent = await sessionIn(R, wt);
  const triaged = (await R.call('POST', '/tickets', { title: 'From an agent' }, agent)).body.ticket;

  for (const [base, error] of [['', 'bad_base'], ['fix#12', 'bad_base'], ['nope', 'no_base']]) {
    const r = await R.call('POST', '/tickets/' + filed.id + '/base', { base });
    assert.strictEqual(r.status, 400, base);
    assert.strictEqual(r.body.error, error, base);
  }
  assert.strictEqual((await R.call('POST', '/tickets/' + filed.id + '/base', { base: 'main' }, agent)).status, 401, 'not a session');
  assert.strictEqual((await R.call('GET', '/tickets/' + filed.id)).body.ticket.base, 'feature', 'nothing refused changed it');

  const triage = await R.call('POST', '/tickets/' + triaged.id + '/base', { base: 'feature' });
  assert.strictEqual(triage.status, 200, 'Triage too');
  assert.strictEqual(triage.body.ticket.base, 'feature');

  const changed = await R.call('POST', '/tickets/' + filed.id + '/base', { base: 'main' });
  assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
  assert.strictEqual(changed.body.ticket.base, 'main');
  assert.strictEqual((await R.call('GET', '/tickets')).body.tickets.find((x) => x.id === filed.id).base, 'main');
  const task = (await R.call('POST', '/tickets/' + filed.id + '/start', {})).body.task;
  assert.strictEqual(task.base, 'main');
  assert.ok(!fs.existsSync(path.join(task.worktree, 'only-here.txt')));
  assert.match(await briefOf(R, task), /pull request against main\./);

  const late = await R.call('POST', '/tickets/' + filed.id + '/base', { base: 'feature' });
  assert.strictEqual(late.status, 409, 'not once it has started');
  assert.strictEqual(late.body.error, 'not_ready');
});
// A ticket's kind (T-104): set when it is filed, from the Board or ticket.js create --kind, and changed
// by the person on the Board until it starts. The four kinds are always there; only the person adds one.
for (const [name, store] of [['local', ''], ['github', path.join(__dirname, '..', 'ticket-stores', 'github.js')]]) {
  test('a ticket carries a kind from filing until it starts (' + name + ')', async (t) => {
    const R = await relay(store); t.after(R.stop);
    const agent = await sessionIn(R, R.repo);
    const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: agent['X-Office-Token'] };
    const cli = (...args) => execFileSync('node', [path.join(ROOT, 'relay', 'ticket.js'), ...args], { env, encoding: 'utf8' });

    const docs = (await R.call('POST', '/tickets', { title: 'Explain the Board', repo: R.repo, kind: ' Docs ' })).body.ticket;
    assert.strictEqual(docs.kind, 'docs', 'cleaned and lowercased');
    const none = (await R.call('POST', '/tickets', { title: 'No kind', repo: R.repo })).body.ticket;
    assert.ok(!none.kind, 'a ticket can have no kind');
    const bad = await R.call('POST', '/tickets', { title: 'Odd kind', repo: R.repo, kind: 'two words' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.error, 'bad_kind');

    // A session files with one of the kinds there are, and cannot add one.
    assert.match(cli('create', 'A flaky test', '--kind', 'tests', '--body', 'Fix it'), /Filed: \S+ {2}A flaky test/);
    const fromCli = (await R.call('GET', '/tickets')).body.tickets.find((x) => x.title === 'A flaky test');
    assert.strictEqual(fromCli.kind, 'tests');
    assert.strictEqual(fromCli.status, 'triage');
    assert.match(cli('list'), /A flaky test {2}\(kind tests\)/);
    assert.throws(() => cli('create', 'A chore', '--kind', 'chore', '--body', 'Tidy'), /Only the person adds a new kind/);
    // The person adds one by giving it, and then a session can use it too.
    const chore = await R.call('POST', '/tickets', { title: 'Tidy the logs', repo: R.repo, kind: 'chore' });
    assert.strictEqual(chore.status, 201, JSON.stringify(chore.body));
    assert.deepStrictEqual((await R.call('GET', '/tickets')).body.kinds, ['docs', 'tests', 'bug', 'feature', 'chore']);
    assert.match(cli('kinds'), /^docs\ntests\nbug\nfeature\nchore\n$/);
    assert.match(cli('create', 'Another chore', '--kind', 'chore', '--body', 'Tidy'), /Filed:/);

    // Only the person changes it: a session's token cannot.
    assert.strictEqual((await R.call('POST', '/tickets/' + docs.id + '/kind', { kind: 'bug' }, agent)).status, 401, 'not a session');
    const changed = await R.call('POST', '/tickets/' + docs.id + '/kind', { kind: 'bug' });
    assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
    assert.strictEqual(changed.body.ticket.kind, 'bug');
    assert.strictEqual((await R.call('GET', '/tickets/' + docs.id)).body.ticket.kind, 'bug', 'the store kept it');
    assert.strictEqual((await R.call('POST', '/tickets/' + fromCli.id + '/kind', { kind: 'feature' })).status, 200, 'Triage too');
    const cleared = await R.call('POST', '/tickets/' + fromCli.id + '/kind', { kind: '' });
    assert.ok(!cleared.body.ticket.kind, 'an empty kind takes it away');
    assert.strictEqual((await R.call('POST', '/tickets/' + docs.id + '/kind', { kind: 'Not ok!' })).body.error, 'bad_kind');

    if (name !== 'local') return;  // starting needs a checkout, which the fake GitHub has no use for
    assert.strictEqual((await R.call('POST', '/tickets/' + docs.id + '/start', {})).status, 200);
    const late = await R.call('POST', '/tickets/' + docs.id + '/kind', { kind: 'docs' });
    assert.strictEqual(late.status, 409, 'not once it has started');
    assert.strictEqual(late.body.error, 'not_ready');
    assert.strictEqual((await R.call('GET', '/tickets/' + docs.id)).body.ticket.kind, 'bug');
  });
}
// A ticket's labels sort the Board. The person adds and changes them at any status; a session files
// with labels there are already, and cannot change a ticket's labels.
for (const [name, store] of [['local', ''], ['github', path.join(__dirname, '..', 'ticket-stores', 'github.js')]]) {
  test('a ticket carries labels, and only the person adds a new one (' + name + ')', async (t) => {
    const R = await relay(store); t.after(R.stop);
    const agent = await sessionIn(R, R.repo);
    const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: agent['X-Office-Token'] };
    const cli = (...args) => execFileSync('node', [path.join(ROOT, 'relay', 'ticket.js'), ...args], { env, encoding: 'utf8' });

    const flaky = (await R.call('POST', '/tickets', { title: 'A test fails now and then', repo: R.repo, labels: [' Flaky ', 'tests', 'flaky'] })).body.ticket;
    assert.deepStrictEqual(flaky.labels, ['flaky', 'tests'], 'cleaned, lowercased, each once');
    const none = (await R.call('POST', '/tickets', { title: 'No labels', repo: R.repo })).body.ticket;
    assert.ok(!(none.labels || []).length, 'a ticket can have none');
    const bad = await R.call('POST', '/tickets', { title: 'Odd label', repo: R.repo, labels: ['two words'] });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.error, 'bad_label');
    const many = await R.call('POST', '/tickets', { title: 'Too many', repo: R.repo, labels: ['a', 'b', 'c', 'd', 'e', 'f'] });
    assert.strictEqual(many.body.error, 'bad_label', 'at most five');
    assert.deepStrictEqual((await R.call('GET', '/tickets')).body.labels, ['flaky', 'tests'], 'the labels in use, A to Z');

    // A session files with labels there are, and cannot add one.
    assert.match(cli('create', 'Another flaky test', '--label', 'flaky', '--body', 'Fix it'), /Filed:/);
    const fromCli = (await R.call('GET', '/tickets')).body.tickets.find((x) => x.title === 'Another flaky test');
    assert.deepStrictEqual(fromCli.labels, ['flaky']);
    assert.match(cli('list'), /Another flaky test {2}\(labels flaky\)/);
    assert.match(cli('labels'), /^flaky\ntests\n$/);
    assert.throws(() => cli('create', 'A chore', '--label', 'chore', '--body', 'Tidy'), /Only the person adds a new label/);

    // Only the person changes them: a session's token cannot.
    assert.strictEqual((await R.call('POST', '/tickets/' + flaky.id + '/labels', { labels: ['tests'] }, agent)).status, 401, 'not a session');
    const changed = await R.call('POST', '/tickets/' + flaky.id + '/labels', { labels: ['ci', 'flaky'] });
    assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
    assert.deepStrictEqual(changed.body.ticket.labels, ['ci', 'flaky'], 'the list given replaces the one there');
    assert.deepStrictEqual((await R.call('GET', '/tickets/' + flaky.id)).body.ticket.labels, ['ci', 'flaky'], 'the store kept them');
    assert.deepStrictEqual((await R.call('GET', '/tickets')).body.labels, ['ci', 'flaky'], 'a label no ticket has goes from the list');
    assert.strictEqual((await R.call('POST', '/tickets/' + flaky.id + '/labels', {})).body.error, 'bad_param');
    const cleared = await R.call('POST', '/tickets/' + fromCli.id + '/labels', { labels: [] });
    assert.deepStrictEqual(cleared.body.ticket.labels, [], '[] takes them away');

    if (name !== 'local') return;  // starting needs a checkout, which the fake GitHub has no use for
    assert.strictEqual((await R.call('POST', '/tickets/' + flaky.id + '/start', {})).status, 200);
    const late = await R.call('POST', '/tickets/' + flaky.id + '/labels', { labels: ['flaky'] });
    assert.strictEqual(late.status, 200, 'labels still change once it has started');
    assert.deepStrictEqual(late.body.ticket.labels, ['flaky']);
  });
}
test('a base change that would make two open tickets with one title on one branch is refused', async (t) => {
  const R = await relay(); t.after(R.stop);
  const wt = branchedRepo(R, 'old');
  const onOld = (await R.call('POST', '/tickets', { title: 'Fix login', repo: wt })).body.ticket;
  const onMain = (await R.call('POST', '/tickets', { title: 'fix login', repo: R.repo })).body.ticket;
  assert.notStrictEqual(onOld.id, onMain.id);
  const r = await R.call('POST', '/tickets/' + onOld.id + '/base', { base: 'main' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'duplicate');
  assert.strictEqual(r.body.ticket.id, onMain.id);
  assert.strictEqual((await R.call('GET', '/tickets/' + onOld.id)).body.ticket.base, 'old');
  await R.call('POST', '/tickets/' + onMain.id + '/move', { to: 'rejected' });
  assert.strictEqual((await R.call('POST', '/tickets/' + onOld.id + '/base', { base: 'main' })).status, 200, 'a rejected twin does not count');
});
test('a base change at the same moment as Start either lands first or is refused, never half', async (t) => {
  const R = await relay(); t.after(R.stop);
  // Start goes a little later each round, so both orders happen. Either way they must agree.
  for (let i = 0; i < 8; i++) {
    const wt = branchedRepo(R, 'race-' + i);
    const a = (await R.call('POST', '/tickets', { title: 'Race ' + i, repo: wt })).body.ticket;
    const changing = R.call('POST', '/tickets/' + a.id + '/base', { base: 'main' });
    await H.sleep(i * 12);
    const [started, changed] = await Promise.all([R.call('POST', '/tickets/' + a.id + '/start', {}), changing]);
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    const want = changed.status === 200 ? 'main' : 'race-' + i;
    if (changed.status !== 200) assert.strictEqual(changed.body.error, 'not_ready');
    assert.strictEqual(started.body.task.base, want);
    assert.strictEqual((await R.call('GET', '/tickets/' + a.id)).body.ticket.base, want, 'the card and the task agree');
    await R.call('POST', '/tasks/' + started.body.task.id + '/move', { to: 'done' });
  }
});
test('a person gets the branch of the folder they gave, even a task\'s', async (t) => {
  const R = await relay(); t.after(R.stop);
  const task = (await R.call('POST', '/tasks', { title: 'Under way', repo: R.repo })).body.task;
  assert.strictEqual((await R.call('POST', '/tickets', { title: 'On top of it', repo: task.worktree })).body.ticket.base, task.branch);
  assert.strictEqual((await R.call('POST', '/tickets', { title: 'From the main folder', repo: R.repo, base: 'nope' })).body.ticket.base, 'main');
});
test('a folder on no branch cannot file, since there is nothing to start from', async (t) => {
  const R = await relay(); t.after(R.stop);
  const wt = branchedRepo(R, 'feature');
  gitIn(wt, 'checkout', '-q', '--detach');
  const r = await R.call('POST', '/tickets', { title: 'Detached', repo: wt });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'no_branch');
  assert.deepStrictEqual((await R.call('GET', '/tickets')).body.tickets, []);
});
test('a folder in the middle of a rebase is told to finish it, not to check out a branch', async (t) => {
  const R = await relay(); t.after(R.stop);
  const wt = branchedRepo(R, 'feature');
  assert.throws(() => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'rebase', '--exec', 'false', 'HEAD~1'], { cwd: wt, stdio: 'ignore' }));
  const r = await R.call('POST', '/tickets', { title: 'Mid rebase', repo: wt });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'no_branch');
  assert.match(r.body.message, /middle of a rebase/);
  assert.doesNotMatch(r.body.message, /[Cc]heck out/);
});
test('a folder in the middle of a bisect is told to finish it, not to check out a branch', async (t) => {
  const R = await relay(); t.after(R.stop);
  const wt = branchedRepo(R, 'feature');
  for (const m of ['two', 'three']) execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', m], { cwd: wt });
  execFileSync('git', ['bisect', 'start', 'HEAD', 'main'], { cwd: wt, stdio: 'ignore' });
  assert.throws(() => gitIn(wt, 'symbolic-ref', '-q', 'HEAD'), 'git really has left the branch');
  const r = await R.call('POST', '/tickets', { title: 'Mid bisect', repo: wt });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'no_branch');
  assert.match(r.body.message, /middle of a bisect/);
  assert.doesNotMatch(r.body.message, /[Cc]heck out/);
});
test('a git failure while reading the branch is reported as what it is', async (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'office-git-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/bash\nif [ "$1" = symbolic-ref ]; then echo "fatal: disk on fire" >&2; exit 128; fi\nexec "' + real + '" "$@"\n', { mode: 0o755 });
  const R = await H.relay({ PATH: bin + path.delimiter + process.env.PATH }); t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const r = await R.call('POST', '/tickets', { title: 'Broken', repo });
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.body.error, 'git');
  assert.match(r.body.message, /disk on fire/);
  assert.deepStrictEqual((await R.call('GET', '/tickets')).body.tickets, []);
});
test('a branch name Start would refuse is refused at filing, and says why', async (t) => {
  const R = await relay(); t.after(R.stop);
  for (const name of ['fix#12', 'feat+x', 'user@thing', 'caf\u00e9']) {
    const wt = branchedRepo(R, name);
    const r = await R.call('POST', '/tickets', { title: 'From ' + name, repo: wt });
    assert.strictEqual(r.status, 400, name);
    assert.strictEqual(r.body.error, 'bad_base');
    assert.ok(r.body.message.includes(name), r.body.message);
    assert.match(r.body.message, /only use/);
  }
  assert.deepStrictEqual((await R.call('GET', '/tickets')).body.tickets, []);
  const task = await R.call('POST', '/tasks', { title: 'Asked by name', repo: R.repo, base: 'fix#12' });
  assert.strictEqual(task.body.error, 'bad_base', 'Start gives the same answer');
});
test('the same title is a duplicate only on the same branch', async (t) => {
  const R = await relay(); t.after(R.stop);
  const a = branchedRepo(R, 'feature/a'), b = branchedRepo(R, 'release/b');
  const first = await R.call('POST', '/tickets', { title: 'Fix login', repo: a });
  assert.strictEqual(first.status, 201);
  const again = await R.call('POST', '/tickets', { title: 'fix login', repo: a });
  assert.strictEqual(again.body.duplicate, true);
  assert.strictEqual(again.body.ticket.id, first.body.ticket.id);
  const other = await R.call('POST', '/tickets', { title: 'Fix login', repo: b });
  assert.strictEqual(other.status, 201);
  assert.notStrictEqual(other.body.ticket.id, first.body.ticket.id);
  assert.strictEqual(other.body.ticket.base, 'release/b');
  assert.strictEqual((await R.call('POST', '/tickets', { title: 'Fix login', repo: b })).body.ticket.id, other.body.ticket.id);

  const onMain = await R.call('POST', '/tickets', { title: 'Fix login', repo: R.repo });
  await R.call('POST', '/tickets/' + onMain.body.ticket.id + '/move', { to: 'rejected' });
  const agent = await sessionIn(R, a);
  const fromAgent = (await R.call('POST', '/tickets', { title: 'Fix login' }, agent)).body;
  assert.strictEqual(fromAgent.ticket.id, onMain.body.ticket.id, 'an agent files on main, wherever it is');
  assert.strictEqual(fromAgent.ticket.status, 'rejected', 'and a rejection still holds on its own branch');
});
test('a ticket from before bases is a duplicate on any branch', async (t) => {
  const R = await relay(); t.after(R.stop);
  const wt = branchedRepo(R, 'feature');
  const a = (await R.call('POST', '/tickets', { title: 'Old', repo: R.repo })).body.ticket;
  await R.kill();
  const file = path.join(R.home, '.office-world', 'tickets.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.t.tickets[0].base;
  fs.writeFileSync(file, JSON.stringify(saved));
  const again = await H.relay({}, R.home); t.after(again.stop);
  const r = await again.call('POST', '/tickets', { title: 'Old', repo: wt });
  assert.strictEqual(r.body.duplicate, true);
  assert.strictEqual(r.body.ticket.id, a.id);
});
test('a base that has since been deleted says so, and the ticket stays Ready for a new base', async (t) => {
  const R = await relay(); t.after(R.stop);
  const wt = branchedRepo(R, 'short-lived');
  const a = (await R.call('POST', '/tickets', { title: 'Too late', repo: wt })).body.ticket;
  gitIn(R.repo, 'worktree', 'remove', '--force', wt);
  gitIn(R.repo, 'branch', '-D', 'short-lived');
  const r = await R.call('POST', '/tickets/' + a.id + '/start', {});
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'no_base');
  assert.match(r.body.message, /short-lived/);
  assert.match(r.body.message, /Change this ticket's base on the Board/);
  assert.strictEqual((await R.call('GET', '/tickets/' + a.id)).body.ticket.status, 'ready');
  assert.deepStrictEqual((await R.call('GET', '/tasks')).body.tasks, []);
  assert.strictEqual((await R.call('POST', '/tickets/' + a.id + '/base', { base: 'main' })).status, 200, 'its base can be changed');
  assert.strictEqual((await R.call('POST', '/tickets/' + a.id + '/start', {})).body.task.base, 'main', 'and then it starts');
});
test('Start again on a deleted base leaves a ticket that can be rejected', async (t) => {
  const R = await relay(); t.after(R.stop);
  const wt = branchedRepo(R, 'short-lived');
  const a = (await R.call('POST', '/tickets', { title: 'Stuck', repo: wt })).body.ticket;
  gitIn(R.repo, 'worktree', 'remove', '--force', wt);
  gitIn(R.repo, 'branch', '-D', 'short-lived');
  await R.kill();
  const file = path.join(R.home, '.office-world', 'tickets.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.t.tickets[0].status = 'started';
  fs.writeFileSync(file, JSON.stringify(saved));
  const again = await H.relay({}, R.home); t.after(again.stop);
  assert.strictEqual((await again.call('POST', '/tickets/' + a.id + '/start', {})).body.error, 'no_base');
  assert.strictEqual((await again.call('POST', '/tickets/' + a.id + '/move', { to: 'rejected' })).status, 200);
});
test('a ticket filed before bases were recorded starts from the main folder\'s branch', async (t) => {
  const R = await relay(); t.after(R.stop);
  const a = (await R.call('POST', '/tickets', { title: 'Old', repo: R.repo })).body.ticket;
  await R.kill();
  const file = path.join(R.home, '.office-world', 'tickets.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.t.tickets[0].base;
  fs.writeFileSync(file, JSON.stringify(saved));
  const again = await H.relay({}, R.home); t.after(again.stop);
  const r = await again.call('POST', '/tickets/' + a.id + '/start', {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.task.base, 'main');
});
// The repo with a real remote, and a second clone that can move the remote on without it.
function withRemote(R) {
  const bare = path.join(R.home, 'origin.git'), other = path.join(R.home, 'other-clone');
  execFileSync('git', ['clone', '-q', '--bare', R.repo, bare]);
  gitIn(R.repo, 'remote', 'add', 'origin', bare);
  gitIn(R.repo, 'fetch', '-q', 'origin');
  gitIn(R.repo, 'branch', '-q', '-u', 'origin/main', 'main');
  execFileSync('git', ['clone', '-q', bare, other]);
  return { bare, other };
}
const commitIn = (cwd, m) => { execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', m], { cwd }); return gitIn(cwd, 'rev-parse', 'HEAD'); };
async function startFrom(R, title, repo) {
  const a = (await R.call('POST', '/tickets', { title, repo })).body.ticket;
  const r = await R.call('POST', '/tickets/' + a.id + '/start', {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.task;
}
test('a base behind its remote starts from the remote, and leaves the local branch alone', async (t) => {
  const R = await relay(); t.after(R.stop);
  const { other } = withRemote(R);
  const local = gitIn(R.repo, 'rev-parse', 'main');
  const newer = commitIn(other, 'newer');
  gitIn(other, 'push', '-q', 'origin', 'main');
  const task = await startFrom(R, 'Behind', R.repo);
  assert.strictEqual(gitIn(task.worktree, 'rev-parse', 'HEAD'), newer);
  assert.strictEqual(gitIn(R.repo, 'rev-parse', 'main'), local);
  assert.strictEqual(task.base, 'main');
  assert.ok(task.history.some((h) => /was behind origin/.test(h.note || '')));
  assert.doesNotMatch(await briefOf(R, task), /not on origin|could not be reached/);
});
test('starting a task brings no tags from the remote into the repo', async (t) => {
  const R = await relay(); t.after(R.stop);
  const { other } = withRemote(R);
  commitIn(other, 'tagged');
  gitIn(other, 'tag', 'from-remote');
  gitIn(other, 'push', '-q', 'origin', 'main', 'from-remote');
  const task = await startFrom(R, 'No tags', R.repo);
  assert.strictEqual(gitIn(task.worktree, 'rev-parse', 'HEAD'), gitIn(other, 'rev-parse', 'HEAD'));
  assert.strictEqual(gitIn(R.repo, 'tag', '--list'), '');
});
test('a task from a linked worktree checks that branch against its remote, and goes under the main checkout', async (t) => {
  const R = await relay(); t.after(R.stop);
  const { other } = withRemote(R);
  const wt = branchedRepo(R, 'feat');
  gitIn(wt, 'push', '-q', '-u', 'origin', 'feat');
  gitIn(other, 'fetch', '-q', 'origin');
  gitIn(other, 'checkout', '-q', 'feat');
  const newer = commitIn(other, 'newer on feat');
  gitIn(other, 'push', '-q', 'origin', 'feat');
  const task = await startFrom(R, 'From linked', wt);
  assert.strictEqual(task.base, 'feat');
  assert.strictEqual(path.dirname(task.worktree), path.join(R.repo, '.worktrees'));
  assert.strictEqual(gitIn(task.worktree, 'rev-parse', 'HEAD'), newer);
  assert.ok(task.history.some((h) => /was behind origin/.test(h.note || '')));
});
test('a base level with its remote says nothing extra', async (t) => {
  const R = await relay(); t.after(R.stop);
  withRemote(R);
  const task = await startFrom(R, 'Level', R.repo);
  assert.strictEqual(task.baseNote, null);
  assert.strictEqual(gitIn(task.worktree, 'rev-parse', 'HEAD'), gitIn(R.repo, 'rev-parse', 'main'));
});
test('a base ahead of its remote keeps its commits, and the brief says the PR will show them', async (t) => {
  const R = await relay(); t.after(R.stop);
  withRemote(R);
  const mine = commitIn(R.repo, 'not pushed');
  const task = await startFrom(R, 'Ahead', R.repo);
  assert.strictEqual(gitIn(task.worktree, 'rev-parse', 'HEAD'), mine);
  assert.match(await briefOf(R, task), /local commits on main that are not on origin/);
});
test('a base that has moved both ways keeps its commits too', async (t) => {
  const R = await relay(); t.after(R.stop);
  const { other } = withRemote(R);
  commitIn(other, 'theirs');
  gitIn(other, 'push', '-q', 'origin', 'main');
  const mine = commitIn(R.repo, 'mine');
  const task = await startFrom(R, 'Diverged', R.repo);
  assert.strictEqual(gitIn(task.worktree, 'rev-parse', 'HEAD'), mine);
  assert.match(task.baseNote, /local commits/);
});
test('a base force-pushed on the remote is not mistaken for an unreachable remote', async (t) => {
  const R = await relay(); t.after(R.stop);
  const { other } = withRemote(R);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten'], { cwd: other });
  gitIn(other, 'push', '-q', '--force', 'origin', 'main');
  const task = await startFrom(R, 'Rewritten', R.repo);
  assert.match(task.baseNote, /local commits/);
  assert.strictEqual(gitIn(task.worktree, 'rev-parse', 'HEAD'), gitIn(R.repo, 'rev-parse', 'main'));
});
test('a base never pushed still starts, and the brief does not promise a PR GitHub would refuse', async (t) => {
  const R = await relay(); t.after(R.stop);
  const { bare } = withRemote(R);
  const wt = branchedRepo(R, 'local-only');
  const task = await startFrom(R, 'Unpushed', wt);
  assert.strictEqual(task.base, 'local-only');
  assert.strictEqual(gitIn(task.worktree, 'rev-parse', 'HEAD'), gitIn(wt, 'rev-parse', 'HEAD'));
  assert.match(await briefOf(R, task), /local-only is not on origin yet[\s\S]*do not push local-only yourself/);
  assert.strictEqual(gitIn(bare, 'branch', '--list', 'local-only'), '', 'nothing was pushed for you');
});
test('a remote that cannot be reached does not stop a task', async (t) => {
  const R = await relay(); t.after(R.stop);
  withRemote(R);
  gitIn(R.repo, 'remote', 'set-url', 'origin', path.join(R.home, 'gone.git'));
  const task = await startFrom(R, 'Offline', R.repo);
  assert.strictEqual(gitIn(task.worktree, 'rev-parse', 'HEAD'), gitIn(R.repo, 'rev-parse', 'main'));
  assert.match(await briefOf(R, task), /origin could not be reached/);
});
test('a repo with no remote gets the plain brief', async (t) => {
  const R = await relay(); t.after(R.stop);
  const task = await startFrom(R, 'No remote', R.repo);
  assert.strictEqual(task.baseNote, null);
  assert.match(await briefOf(R, task), /pull request against main\. Start the PR title with T-1 and a colon, as in "T-1: No remote"\. Do not merge it\.\]?/);
  assert.match(await briefOf(R, task), /Then run gh pr checks --watch on it\. If a check fails, fix it on this branch, push, and watch again\. Say the work is ready only once every check passes/, 'no review or merge before a green pipeline (T-11)');
});
test('a reset store does not match old tasks', async (t) => {
  const R = await relay(); t.after(R.stop);
  const file = path.join(R.home, '.office-world', 'tickets.json');
  const a = (await R.call('POST', '/tickets', { title: 'Old', repo: R.repo })).body.ticket;
  assert.strictEqual((await R.call('POST', '/tickets/' + a.id + '/start', {})).status, 200);
  await R.kill();
  fs.rmSync(file);
  const again = await H.relay({}, R.home); t.after(again.stop);
  const b = (await again.call('POST', '/tickets', { title: 'New', repo: R.repo })).body.ticket;
  assert.strictEqual(b.id, a.id);
  assert.strictEqual(b.task, null);
  assert.strictEqual((await again.call('POST', '/tickets/' + b.id + '/start', {})).status, 200);
});
