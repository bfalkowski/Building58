'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');

test('tasks', async (t) => {
  const R = await relay(), { call, screen } = R, repo = makeRepo(R.home);
  t.after(R.stop);
  const talk = (sessionId) => R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sessionId.slice(0, 12) });
  const stopAndWait = async (id) => { await call('POST', '/terminals/' + id + '/stop', {}); await until(async () => !(await call('GET', '/terminals')).body.terminals.some((x) => x.id === id), 'it to stop'); };
  let task, quickId;

  await t.test('the brief says to build it, and goes in once', async () => {
    task = (await call('POST', '/tasks', { title: 'Add a radio', brief: 'Keep it small.', repo })).body.task;
    assert.strictEqual(task.briefed, false);
    const out = await until(async () => { const s = await screen(task.worker.terminal); return s.includes('GOT[') && s; }, 'the brief');
    assert.match(out, /build this now: Add a radio\. Keep it small\./);
    assert.doesNotMatch(out, /PR title/, 'a task with no ticket has no number to put in the title');
    // Typed raw, Claude Code reads a long brief about 1024 bytes at a time and keeps only the last piece.
    assert.match(out, /PASTED GOT\[Your task is to build this now/, 'the brief goes in as one paste');
    assert.match(out, /ticket\.js create "Title" --body - <<'EOF'/, 'it files other work with the body on stdin (T-49)');
    assert.doesNotMatch(out, /--body "/, 'never in double quotes');
    // T-239: a change to CLAUDE.md or the constitution makes the whole PR wait on the person, so it goes elsewhere.
    assert.match(out, /leave CLAUDE\.md and docs\/constitution\.md out of this pull request/, 'the code PR stays free of the two files');
    assert.match(out, /create "CLAUDE\.md and constitution updates"/, 'the wording goes to the grouped ticket');
    assert.match(out, /If it says Already filed with \(triage\) or \(ready\), that open ticket gathers these changes and you cannot edit it, so say so in the PR/, 'with no ticket, no chat channel to ask the Lead in');
    assert.match(out, /cannot ship without the wording/, 'unless the code cannot ship without it');
    // Review of T-239: Already filed also answers for a started or rejected ticket, which nobody can edit.
    assert.match(out, /If it says \(started\) or \(rejected\), file the change as its own ticket titled "CLAUDE\.md and constitution updates for /, 'a started or rejected wording ticket gets a ticket of its own');
    await sleep(1200);
    assert.strictEqual((await call('GET', '/tasks/' + task.id)).body.task.briefed, false, 'typed is not in: no turn has begun');
    await talk(task.owner.sessionId);
    await until(async () => (await call('GET', '/tasks/' + task.id)).body.task.briefed === true, 'it to be marked');
  });
  await t.test('a checkout with a session in it cannot be cleaned up', async () => {
    const other = (await call('POST', '/terminals', { cwd: task.worktree })).body;
    await stopAndWait(task.worker.terminal);
    await call('POST', '/tasks/' + task.id + '/move', { to: 'done' });
    const r = await call('POST', '/tasks/' + task.id + '/clean', {});
    assert.strictEqual(r.body.error, 'in_use');
    assert.ok(fs.existsSync(task.worktree));
    await stopAndWait(other.id);
    assert.strictEqual((await call('POST', '/tasks/' + task.id + '/clean', {})).status, 200);
  });
  await t.test('Clean up names ignored files and deletes them only after a yes that covers them', async () => {
    const exclude = path.join(repo, '.git', 'info', 'exclude');
    fs.appendFileSync(exclude, '.env\nbuild/\n');
    const one = (await call('POST', '/tasks', { title: 'Keep the env', repo })).body.task;
    const clean = (body) => call('POST', '/tasks/' + one.id + '/clean', body);
    fs.writeFileSync(path.join(one.worktree, '.env'), 'SECRET=1\n');
    await stopAndWait(one.worker.terminal);
    await call('POST', '/tasks/' + one.id + '/move', { to: 'done' });
    const asked = await clean({});
    assert.strictEqual(asked.status, 409);
    assert.strictEqual(asked.body.error, 'ignored');
    assert.deepStrictEqual(asked.body.ignored, ['.env']);
    assert.match(asked.body.message, /\.env/);
    assert.ok(fs.existsSync(path.join(one.worktree, '.env')));
    assert.strictEqual((await call('GET', '/tasks/' + one.id)).status, 200, 'the task stays');
    fs.mkdirSync(path.join(one.worktree, 'build')); fs.writeFileSync(path.join(one.worktree, 'build', 'x'), 'x');
    const again = await clean({ ignored: asked.body.ignored });  // a new one since the question
    assert.deepStrictEqual(again.body.ignored.sort(), ['.env', 'build/']);
    assert.ok(fs.existsSync(path.join(one.worktree, '.env')));
    const done = await clean({ ignored: again.body.ignored });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    assert.ok(!fs.existsSync(one.worktree));
  });
  await t.test('uncommitted work in a task is refused first, without asking about ignored files', async () => {
    const one = (await call('POST', '/tasks', { title: 'Has work', repo })).body.task;
    fs.writeFileSync(path.join(one.worktree, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(one.worktree, 'new.txt'), 'wip\n');
    await stopAndWait(one.worker.terminal);
    await call('POST', '/tasks/' + one.id + '/move', { to: 'done' });
    assert.strictEqual((await call('POST', '/tasks/' + one.id + '/clean', {})).body.error, 'dirty');
    fs.rmSync(path.join(one.worktree, 'new.txt'));
    assert.strictEqual((await call('POST', '/tasks/' + one.id + '/clean', { ignored: ['.env'] })).status, 200);
  });
  await t.test('stopping a worker before its brief does not end the relay', async () => {
    const quick = (await call('POST', '/tasks', { title: 'Stopped early', brief: 'Do this.', repo })).body.task;
    const id = quick.worker.terminal;
    await call('POST', '/terminals/' + id + '/stop', {});
    await call('POST', '/terminals/' + id + '/input', { data: 'late' }).catch(() => {});  // the write that used to end it
    await sleep(2200);
    assert.ok(await R.health(), 'the relay is still up');
    const back = await until(async () => { const g = (await call('GET', '/tasks/' + quick.id)).body.task; return !g.worker && g; }, 'the worker to go');
    assert.strictEqual(back.briefed, false);
    assert.ok(back.history.some((h) => /not delivered/.test(h.note || '')));
    quickId = quick.id;
  });
  await t.test('and Bring back starts over with the brief', async () => {
    const r = await call('POST', '/tasks/' + quickId + '/resume', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const out = await until(async () => { const s = await screen(r.body.task.worker.terminal); return s.includes('GOT[') && s; }, 'the brief');
    assert.match(out, /Do this\./);
    assert.doesNotMatch(out, /--resume/);
    await stopAndWait(r.body.task.worker.terminal);
  });
  await t.test('a worker that ends after its brief was typed, before a turn began, gets it again when brought back', async () => {
    const one = (await call('POST', '/tasks', { title: 'Typed only', brief: 'Do that.', repo })).body.task;
    await until(async () => (await screen(one.worker.terminal)).includes('GOT['), 'the brief');
    await stopAndWait(one.worker.terminal);
    const gone = (await call('GET', '/tasks/' + one.id)).body.task;
    assert.strictEqual(gone.briefed, false);
    assert.ok(gone.history.some((h) => /not delivered: the session ended first/.test(h.note || '')));
    const r = await call('POST', '/tasks/' + one.id + '/resume', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const out = await until(async () => { const s = await screen(r.body.task.worker.terminal); return s.includes('GOT[') && s; }, 'the brief in the worker brought back');
    assert.match(out, /Do that\./);
    assert.doesNotMatch(out, /--resume/, 'a conversation with no turn in it has nothing to resume');
    await talk(r.body.task.owner.sessionId);
    await until(async () => (await call('GET', '/tasks/' + one.id)).body.task.briefed === true, 'the brief to be in');
    await stopAndWait(r.body.task.worker.terminal);
  });
  await t.test('a worker whose brief went in resumes its conversation', async () => {
    const one = (await call('POST', '/tasks', { title: 'Comes back', repo })).body.task;
    await until(async () => (await screen(one.worker.terminal)).includes('GOT['), 'the brief');
    await talk(one.owner.sessionId);
    await until(async () => (await call('GET', '/tasks/' + one.id)).body.task.briefed === true, 'the brief');
    await stopAndWait(one.worker.terminal);
    const r = await call('POST', '/tasks/' + one.id + '/resume', {});
    await until(async () => (await screen(r.body.task.worker.terminal)).includes('--resume'), 'the resume');
    await stopAndWait(r.body.task.worker.terminal);
  });
  await t.test('a mistyped folder is named', async () => {
    const r = await call('POST', '/tasks', { title: 'x', repo: path.join(R.home, 'nowhere') });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.message, /There is no folder/);
  });
  await t.test('a second relay on the same file does not write over it', async () => {
    const before = fs.readFileSync(path.join(R.home, '.office-world', 'tasks.json'), 'utf8');
    const second = await relay({}, R.home);
    t.after(second.stop);
    await until(() => /owns .*tasks\.json/.test(second.output()), 'the warning');
    const r = await second.call('POST', '/tasks', { title: 'From the second relay', repo });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(fs.readFileSync(path.join(R.home, '.office-world', 'tasks.json'), 'utf8'), before);
  });
});
test('a relay started inside a Claude Code session does not pass that session on', async (t) => {
  const R = await relay({ CLAUDE_CODE_CHILD_SESSION: '1' }); t.after(R.stop);
  const a = (await R.call('POST', '/terminals', { cwd: R.home })).body;
  const out = await until(async () => { const s = await R.screen(a.id); return s.includes('child session:') && s; }, 'the session');
  assert.match(out, /child session: none/);
});
