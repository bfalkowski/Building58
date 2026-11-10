'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');

const RESUME = { RELAY_RESUME: '1', RELAY_WIP_LIMIT: '5' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, message) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  sh(cwd, 'add', file);
  sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
};
const talk = (R, sid) => R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid.slice(0, 12) });
const idle = (R, sid) => R.hook({ hook_event_name: 'Stop', session_id: sid.slice(0, 12) });
const terminals = async (R) => (await R.call('GET', '/terminals')).body.terminals;
// A task's brief is in once a turn begins after it (relay/delivery.js). The fake sends no hooks, so the
// test says a turn began once the brief shows.
async function takesBrief(R, id, sid) {
  await until(async () => /GOT\[Your task is to build/.test(await R.screen(id)), 'the brief');
  await talk(R, sid); await sleep(200);
}

test('a restart brings every session back', async (t) => {
  let R = await relay(RESUME);
  const home = R.home, repo = makeRepo(home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });

  const lead = (await R.call('POST', '/terminals', { cwd: repo, cols: 100, rows: 30 })).body;
  await talk(R, lead.sessionId); await idle(R, lead.sessionId); await sleep(200);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true })).status, 200);
  const pm = (await R.call('POST', '/terminals', { cwd: repo, role: 'pm', title: 'PM: a radio' })).body;
  await talk(R, pm.sessionId); await idle(R, pm.sessionId);
  const quiet = (await R.call('POST', '/terminals', { cwd: home })).body;  // nobody spoke to it
  const task = (await R.call('POST', '/tasks', { title: 'Add a radio', brief: 'Keep it small.', repo })).body.task;
  await takesBrief(R, task.worker.terminal, task.owner.sessionId);
  await until(async () => (await R.call('GET', '/tasks/' + task.id)).body.task.briefed, 'the task brief');
  await idle(R, task.owner.sessionId);
  await until(async () => !(await terminals(R)).find((x) => x.lead).briefHeld && !(await terminals(R)).find((x) => x.lead).owesBrief, 'the Lead brief');
  const before = await terminals(R);
  assert.strictEqual(before.length, 4);

  await R.kill();
  R = await relay(RESUME, home);
  const after = await until(async () => { const l = await terminals(R); return l.length === 4 && l; }, 'four sessions back');

  await t.test('the same session ids, roles and tasks', () => {
    for (const was of [lead, pm, task.owner]) assert.ok(after.some((x) => x.sessionId === was.sessionId), 'came back: ' + was.sessionId);
    const l = after.find((x) => x.sessionId === lead.sessionId);
    assert.strictEqual(l.lead, true); assert.strictEqual(l.board, true); assert.strictEqual(l.cwd, repo);
    const p = after.find((x) => x.sessionId === pm.sessionId);
    assert.strictEqual(p.role, 'pm'); assert.strictEqual(p.title, 'PM: a radio');
    const w = after.find((x) => x.sessionId === task.owner.sessionId);
    assert.strictEqual(w.task, task.id); assert.strictEqual(w.cwd, task.worktree);
  });
  await t.test('each with claude --resume, and the Lead is not briefed again', async () => {
    const screen = await R.screen(after.find((x) => x.lead).id);
    assert.match(screen, new RegExp('--resume ' + lead.sessionId));
    await sleep(2500);
    assert.doesNotMatch(await R.screen(after.find((x) => x.lead).id), /GOT\[/);
  });
  await t.test('one nobody spoke to starts again in its folder', () => {
    const q = after.find((x) => x.cwd === home);
    assert.ok(q); assert.notStrictEqual(q.sessionId, quiet.sessionId);
  });
  await t.test('the task knows its worker again', async () => {
    const g = (await R.call('GET', '/tasks/' + task.id)).body.task;
    assert.ok(g.worker && g.worker.running);
    assert.ok(g.history.some((h) => h.type === 'resumed'));
  });
  await t.test('a session stopped by hand stays stopped', async () => {
    await R.call('POST', '/terminals/' + after.find((x) => x.cwd === home).id + '/stop', {});
    await until(async () => (await terminals(R)).length === 3, 'it to stop');
    await R.kill();
    R = await relay(RESUME, home);
    await until(async () => (await terminals(R)).length === 3, 'three back');
    await sleep(500);
    assert.strictEqual((await terminals(R)).length, 3);
  });
});

test('Update', async (t) => {
  // The relay's folder, as a clone of a remote that gets new commits.
  const R0 = await relay(RESUME);
  const home = R0.home;
  await R0.kill();
  const origin = path.join(home, 'origin.git'), src = makeRepo(home, 'src'), dir = path.join(home, 'relay-folder');
  commit(src, 'relay/x.js', '1\n', 'relay file'); commit(src, 'office/x.html', '1\n', 'page file');
  sh(home, 'clone', '-q', '--bare', src, origin);
  sh(home, 'clone', '-q', origin, dir);
  sh(src, 'remote', 'add', 'origin', origin);
  let R = await relay(Object.assign({ RELAY_UPDATE_DIR: dir }, RESUME), home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const update = (body) => R.call('POST', '/update', body || {});

  await t.test('refuses a folder with local changes, and says why', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    const r = await update();
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'local_changes'); assert.match(r.body.message, /a\.txt/);
    sh(dir, 'checkout', 'a.txt');
  });
  await t.test('refuses a folder on another branch, and says why', async () => {
    sh(dir, 'checkout', '-qb', 'other');
    const r = await update();
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'not_main'); assert.match(r.body.message, /on other, not main/);
    sh(dir, 'checkout', '-q', 'main');
  });
  await t.test('nothing new', async () => {
    const r = await update();
    assert.strictEqual(r.status, 200, r.body.message); assert.strictEqual(r.body.changed, false);
  });
  await t.test('only page files: the page reloads, and the relay keeps running', async () => {
    commit(src, 'office/x.html', '2\n', 'page change'); sh(src, 'push', '-q', 'origin', 'main');
    const r = await update();
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.reload, true); assert.deepStrictEqual(r.body.files, ['office/x.html']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'office/x.html'), 'utf8'), '2\n');
  });
  await t.test('relay files: waits until no session is in a turn, restarts while one is at a question, and the sessions run on through it', async () => {
    const s = (await R.call('POST', '/terminals', { cwd: dir })).body;
    await R.call('POST', '/terminals/' + s.id + '/input', { data: 'before the restart\r' });
    await until(async () => /GOT\[before the restart\]/.test(await R.screen(s.id)), 'the echo');
    await talk(R, s.sessionId); await sleep(200);  // in a turn
    commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
    const run = (await R.call('GET', '/update')).body.run;
    const r = await update();
    assert.strictEqual(r.status, 202); assert.strictEqual(r.body.restart, true); assert.strictEqual(r.body.run, run);
    assert.deepStrictEqual(r.body.update.waitingOn.map((w) => w.why), ['in a turn']);
    assert.strictEqual((await update()).body.error, 'updating');
    await sleep(1500);
    assert.strictEqual((await R.call('GET', '/update')).body.update.state, 'waiting', 'still waiting');
    // Fetched, not pulled: the old relay must not serve new files from its folder while it waits.
    assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), r.body.from, 'the folder is as it was while the update waits');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'relay/x.js'), 'utf8'), '1\n');
    // At a question it can move only when the relay types into it, so the restart goes on.
    await R.hook({ hook_event_name: 'Notification', session_id: s.sessionId.slice(0, 12), message: 'Claude needs your permission to use Bash' });
    // The new relay has no update under way, and the session is still at its desk: the same process,
    // which never started again, with its output so far.
    const back = await until(async () => {
      try {
        const u = (await R.call('GET', '/update')).body;
        if (u.update || u.run === run) return null;
        const list = await terminals(R);
        return list.length === 1 && list[0];
      } catch (e) { return null; }  // between the two relays
    }, 'the relay to restart with the session');
    assert.strictEqual(back.id, s.id); assert.strictEqual(back.sessionId, s.sessionId);
    assert.strictEqual(back.state, 'waiting', 'still at its question'); assert.match(back.message, /permission to use Bash/);
    await idle(R, s.sessionId);
    assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), r.body.to, 'pulled just before the restart');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'relay/x.js'), 'utf8'), '2\n');
    const starts = fs.readFileSync(path.join(home, '.fake-claude-tokens'), 'utf8').split('\n').filter((l) => l.startsWith(s.sessionId + ' '));
    assert.strictEqual(starts.length, 1, 'claude started once, not again with --resume');
    process.kill(Number(starts[0].split(' ')[1]), 0);  // and it is still running
    const screen = await R.screen(s.id);
    assert.match(screen, /GOT\[before the restart\]/); assert.doesNotMatch(screen, /--resume/);
    await R.call('POST', '/terminals/' + s.id + '/input', { data: 'after the restart\r' });
    await until(async () => /GOT\[after the restart\]/.test(await R.screen(s.id)), 'it to still take keys');
    assert.match(R.output(), /Took back .* still running/);
    assert.strictEqual(R.child.exitCode, null, 'the supervisor kept running');
    assert.match(R.output(), /Starting the relay again/);
  });
  await t.test('calling it off', async () => {
    const s = (await terminals(R))[0];
    await talk(R, s.sessionId); await sleep(200);
    commit(src, 'relay/x.js', '3\n', 'another relay change'); sh(src, 'push', '-q', 'origin', 'main');
    const head = sh(dir, 'rev-parse', 'HEAD');
    assert.strictEqual((await update()).status, 202);
    assert.strictEqual((await update({ cancel: true })).body.update, null);
    assert.match((await R.call('GET', '/update')).body.note, /called off/);
    await idle(R, s.sessionId); await sleep(1500);
    assert.strictEqual((await terminals(R))[0].id, s.id, 'no restart');
    assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), head, 'calling it off leaves the folder as it was');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'relay/x.js'), 'utf8'), '2\n');
  });
  await t.test('a folder that cannot fast-forward when the quiet moment comes calls the restart off, and changes nothing', async () => {
    const s = (await terminals(R))[0], head = sh(dir, 'rev-parse', 'HEAD');
    await talk(R, s.sessionId); await sleep(200);
    const run = (await R.call('GET', '/update')).body.run;
    assert.strictEqual((await update()).status, 202);
    fs.writeFileSync(path.join(dir, 'relay/x.js'), 'edited by hand\n');
    await idle(R, s.sessionId);
    const note = await until(async () => { const g = (await R.call('GET', '/update')).body; return !g.update && g.note; }, 'the restart to be called off');
    assert.match(note, /could not fast-forward .*local changes/);
    assert.strictEqual((await R.call('GET', '/update')).body.run, run, 'no restart');
    assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), head);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'relay/x.js'), 'utf8'), 'edited by hand\n');
    sh(dir, 'checkout', 'relay/x.js');
  });
  await t.test('after calling it off, Update offers the restart again', async () => {
    const r = await update();
    assert.strictEqual(r.status, 202, r.body.message); assert.strictEqual(r.body.restart, true);
    assert.match(r.body.message, /Fetched/);
    assert.deepStrictEqual(r.body.update.files, ['relay/x.js']);
    await update({ cancel: true });
  });
  await t.test('after a pull by hand, Update offers the restart again, though nothing is new to pull', async () => {
    sh(dir, 'pull', '-q', '--ff-only');
    const r = await update();
    assert.strictEqual(r.status, 202, r.body.message); assert.strictEqual(r.body.restart, true);
    assert.match(r.body.message, /Nothing new to pull/);
    assert.deepStrictEqual(r.body.update.files, ['relay/x.js']);
    await update({ cancel: true });
  });
  await t.test('and a later page-only pull still offers it, rather than only reloading', async () => {
    commit(src, 'office/x.html', '3\n', 'page change'); sh(src, 'push', '-q', 'origin', 'main');
    const r = await update();
    assert.strictEqual(r.status, 202); assert.strictEqual(r.body.reload, undefined);
    assert.deepStrictEqual(r.body.files, ['office/x.html']); assert.deepStrictEqual(r.body.update.files, ['relay/x.js']);
    await update({ cancel: true });
  });
});

test('a session that cannot come back stays on the list, marked failed', async (t) => {
  let R = await relay(RESUME);
  const home = R.home, file = path.join(home, '.office-world', 'sessions.json');
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const a = (await R.call('POST', '/terminals', { cwd: home })).body;
  await talk(R, a.sessionId); await idle(R, a.sessionId); await sleep(200);
  await R.kill();

  R = await relay(Object.assign({ FAKE_CLAUDE_FAIL_RESUME: '1' }, RESUME), home);
  const failed = await until(async () => { const g = (await R.call('GET', '/terminals')).body; return g.failed.length && g.failed; }, 'it to fail');
  assert.strictEqual(failed[0].sessionId, a.sessionId); assert.strictEqual(failed[0].tries, 1); assert.match(failed[0].why, /exit code 1/);
  assert.strictEqual((await terminals(R)).filter((x) => x.running).length, 0);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).t.some((s) => s.sessionId === a.sessionId && s.failed), 'kept on the list');
  assert.match(R.output(), new RegExp('Session ' + a.sessionId + ' .*could not come back'));
  await R.kill();

  await t.test('the next start tries again, and it comes back', async () => {
    R = await relay(RESUME, home);
    const back = await until(async () => { const l = await terminals(R); return l.length === 1 && l[0]; }, 'it to come back');
    assert.strictEqual(back.sessionId, a.sessionId);
    await sleep(500);
    assert.deepStrictEqual((await R.call('GET', '/terminals')).body.failed, []);
    await R.kill();
  });
  await t.test('Forget takes it off the list', async () => {
    R = await relay(Object.assign({ FAKE_CLAUDE_FAIL_RESUME: '1' }, RESUME), home);
    await until(async () => (await R.call('GET', '/terminals')).body.failed.length, 'it to fail');
    assert.deepStrictEqual((await R.call('POST', '/terminals/failed', { sessionId: a.sessionId })).body.failed, []);
    assert.ok(!JSON.parse(fs.readFileSync(file, 'utf8')).t);
  });
});

test('nothing is typed while an update is under way, so a saved message is never cut off', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-test-')));
  const origin = path.join(home, 'origin.git'), src = makeRepo(home, 'src'), dir = path.join(home, 'relay-folder'), gh = path.join(home, 'gh');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, origin); sh(home, 'clone', '-q', origin, dir); sh(src, 'remote', 'add', 'origin', origin);
  fs.mkdirSync(gh); fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify({ prs: {} }));
  let R = await relay(Object.assign({ RELAY_UPDATE_DIR: dir, GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh }, RESUME), home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const deliveries = () => { try { return JSON.parse(fs.readFileSync(path.join(home, '.office-world', 'deliveries.json'), 'utf8')).t || []; } catch (e) { return []; } };

  const lead = (await R.call('POST', '/terminals', { cwd: dir })).body;
  await talk(R, lead.sessionId); await idle(R, lead.sessionId); await sleep(200);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
  await until(async () => !(await terminals(R))[0].owesBrief, 'the Lead brief');
  await talk(R, lead.sessionId); await sleep(200);  // in a turn
  await R.call('POST', '/huddle', { lead: true });
  await until(() => deliveries().some((d) => d.key === 'huddle-lead'), 'the report to be saved for the Lead');
  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
  const run = (await R.call('POST', '/update', {})).body.run;
  assert.ok(run);
  const before = await R.screen(lead.id);
  await idle(R, lead.sessionId);  // the turn ends: the restart and the saved report both see it
  const back = await restarted(R, run).then((l) => l[0]);
  await t.test('the report was not typed before the restart, and is still saved', () => {
    assert.doesNotMatch(before, /Huddle report/);
    assert.ok(deliveries().some((d) => d.key === 'huddle-lead'));
    assert.strictEqual(back.sessionId, lead.sessionId); assert.strictEqual(back.lead, true);
  });
  await t.test('it goes in once the Lead that came back is heard from', async () => {
    await idle(R, lead.sessionId);
    const screen = await until(async () => { const s = await R.screen(back.id); return /GOT\[Huddle report/.test(s) && s; }, 'the report');
    assert.ok(screen);
    // Read again once the output has settled: a stream opened while output is fresh can show it twice (T-58).
    await sleep(1000);
    assert.strictEqual((await R.screen(back.id)).match(/GOT\[Huddle report/g).length, 1);
    await until(() => !deliveries().some((d) => d.key === 'huddle-lead'), 'it to leave the file');
  });
});

test('while an update waits for one session, nothing is typed into an idle one', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-test-')));
  const origin = path.join(home, 'origin.git'), src = makeRepo(home, 'src'), dir = path.join(home, 'relay-folder'), gh = path.join(home, 'gh');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, origin); sh(home, 'clone', '-q', origin, dir); sh(src, 'remote', 'add', 'origin', origin);
  fs.mkdirSync(gh); fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify({ prs: {} }));
  const R = await relay(Object.assign({ RELAY_UPDATE_DIR: dir, GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh }, RESUME), home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const lead = (await R.call('POST', '/terminals', { cwd: dir })).body, other = (await R.call('POST', '/terminals', { cwd: dir })).body;
  await talk(R, lead.sessionId); await idle(R, lead.sessionId); await sleep(200);
  await R.call('POST', '/terminals/lead', { terminal: lead.id });
  await until(async () => !(await terminals(R)).find((x) => x.id === lead.id).owesBrief, 'the Lead brief');
  await talk(R, other.sessionId); await sleep(200);  // keeps the update waiting
  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
  assert.strictEqual((await R.call('POST', '/update', {})).status, 202);
  await R.call('POST', '/huddle', { lead: true });
  await sleep(3000);
  assert.doesNotMatch(await R.screen(lead.id), /GOT\[Huddle report/, 'held while the update waits');
  assert.strictEqual((await R.call('GET', '/huddle')).body.leadNews.state, 'saved');
  await R.call('POST', '/update', { cancel: true });
  await until(async () => /GOT\[Huddle report/.test(await R.screen(lead.id)), 'it to go in once the update is called off');
  await t.test('Enter pressed in the panel counts as busy before its hook arrives', async () => {
    await idle(R, other.sessionId); await idle(R, lead.sessionId);
    await R.call('POST', '/terminals/' + other.id + '/input', { data: 'hello\r' });
    const r = await R.call('POST', '/update', {});
    assert.strictEqual(r.status, 202);
    assert.strictEqual(r.body.update.waitingOn.find((w) => w.terminal === other.id).why, 'just sent a prompt');
    await R.call('POST', '/update', { cancel: true });
  });
});

test('a relay that started no session, such as the demo\'s, leaves the saved list alone', async (t) => {
  const R = await relay({ RELAY_RESUME: '0' });
  t.after(R.stop);
  await R.kill();
  const file = path.join(R.home, '.office-world', 'sessions.json');
  const list = { t: [{ sessionId: '11111111-2222-4333-8444-555555555555', talked: true, cwd: R.home }] };
  fs.writeFileSync(file, JSON.stringify(list));
  const again = await relay({ RELAY_RESUME: '0' }, R.home);
  assert.strictEqual((await again.call('GET', '/terminals')).body.terminals.length, 0, 'nobody brought back');
  await again.kill();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), list);
});

test('the demo keeps its sessions in a list of its own', async (t) => {
  const own = path.join(require('os').tmpdir(), 'office-demo-test-' + process.pid, 'sessions.json');
  const R = await relay({ RELAY_RESUME: '0', RELAY_SESSIONS_FILE: own });
  t.after(async () => { await R.stop(); fs.rmSync(path.dirname(own), { recursive: true, force: true }); });
  await R.call('POST', '/terminals', { cwd: R.home });
  await until(() => fs.existsSync(own), 'its own list');
  assert.ok(!fs.existsSync(path.join(R.home, '.office-world', 'sessions.json')), 'the room\'s list is untouched');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'office.js'), 'utf8'), /DEMO_ENV = \{ RELAY_RESUME: '0', RELAY_SESSIONS_FILE:/);
});

test('the supervisor says so when the relay cannot start', async () => {
  const blocker = require('net').createServer().listen(0, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const { spawnSync } = require('child_process');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-test-')));
  try {
    const r = spawnSync('node', ['relay/server.js'], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 20000,
      env: { ...process.env, HOME: home, HOST: '127.0.0.1', PORT: String(blocker.address().port), RELAY_KEY: 'k' } });  // the address the blocker holds
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /already in use/);
    assert.match(r.stderr, /The relay stopped with exit code 1\./);
    assert.match(r.stderr, /Start it again .* and they all come back/);
  } finally { blocker.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

// A relay whose Update pulls from a clone, and a repo whose PR 7 can be reviewed, as in checkouts.test.js.
async function updatable(extraEnv, existingHome) {
  const home = existingHome || fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-test-')));
  const origin = path.join(home, 'origin.git'), src = path.join(home, 'src'), dir = path.join(home, 'relay-folder'), repo = path.join(home, 'repo');
  if (!existingHome) {
    makeRepo(home, 'src'); commit(src, 'relay/x.js', '1\n', 'relay file');
    sh(home, 'clone', '-q', '--bare', src, origin); sh(home, 'clone', '-q', origin, dir); sh(src, 'remote', 'add', 'origin', origin);
    makeRepo(home, 'repo');
    const prs = path.join(home, 'prs.git');
    sh(home, 'init', '-q', '--bare', prs);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[url "' + prs + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
    sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    sh(repo, 'push', '-q', prs, 'HEAD:refs/pull/7/head');
  }
  const R = await relay(Object.assign({ RELAY_UPDATE_DIR: dir }, RESUME, extraEnv), home);
  const relayChange = (n) => { commit(src, 'relay/x.js', n + '\n', 'relay change ' + n); sh(src, 'push', '-q', 'origin', 'main'); };
  return { R, home, repo, relayChange };
}
const PR = 'https://github.com/acme/widgets/pull/7';
const saved = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, '.office-world', 'sessions.json'), 'utf8')).t || []; } catch (e) { return []; } };
// The sessions keep their desks through a restart, so the run the relay gives Update tells the new relay apart.
const restarted = (R, run) => until(async () => {
  try { if ((await R.call('GET', '/update')).body.run === run) return null; const l = (await terminals(R)).filter((x) => x.running); return l.length && l; } catch (e) { return null; }
}, 'the relay to restart');

test('a first prompt still waiting when the relay restarts goes in after it', async (t) => {
  // A first prompt goes in while an update waits (relay/test/update-first-prompt.test.js), so this
  // reviewer is kept from being ready: Claude Code asks whether to trust the folder, and nobody answers
  // until after the restart.
  const { R, home, repo, relayChange } = await updatable({ FAKE_CLAUDE_TRUST: '1' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const other = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await talk(R, other.sessionId); await sleep(200);  // in a turn, so the update waits
  relayChange(2);
  const update = await R.call('POST', '/update', {});
  assert.strictEqual(update.status, 202);
  const reviewer = (await R.call('POST', '/checkouts', { from: repo, pr: PR, prompt: 'Please review it.' })).body;
  assert.ok(reviewer.id, JSON.stringify(reviewer));
  await sleep(2500);  // past the moment the screen settles
  await t.test('it waits at the question, saved with its session, and does not hold the update', async () => {
    assert.doesNotMatch(await R.screen(reviewer.id), /GOT\[Please review it/);
    assert.strictEqual(saved(home).find((s) => s.sessionId === reviewer.sessionId).owesPrompt.split(' Mark each finding')[0], 'Please review it.', 'the brief, then the verdict ask that the route adds to a review of a PR');
    assert.doesNotMatch(R.output(), /did not get its prompt/);
    const waitingOn = (await R.call('GET', '/update')).body.update.waitingOn.map((w) => w.terminal);
    assert.deepStrictEqual(waitingOn, [other.id]);
  });
  await idle(R, other.sessionId);
  const back = await restarted(R, update.body.run);
  await t.test('the reviewer is still at its desk in its checkout, and gets it once the question is answered, once', async () => {
    const r = await until(() => back.find((x) => x.role === 'reviewer'), 'the reviewer');
    assert.strictEqual(r.cwd, reviewer.cwd); assert.strictEqual(r.pr, PR);
    await sleep(2500);
    assert.doesNotMatch(await R.screen(r.id), /GOT\[Please review it/, 'not while the question is up');
    // The person answers it. Enough output after the question shows it is gone.
    await R.call('POST', '/terminals/' + r.id + '/input', { data: 'yes'.repeat(150) + '\r' });
    // Claude Code, past the question, sends SessionStart. A first prompt is a saved delivery (T-209), and
    // like any delivery it is not typed into a session spoken to that no hook has reached.
    await R.hook({ hook_event_name: 'SessionStart', source: 'startup', session_id: r.sessionId.slice(0, 12) });
    const screen = await until(async () => { const s = await R.screen(r.id); return /GOT\[Please review it/.test(s) && s; }, 'the prompt');
    assert.ok(screen);
    // Read again once the output has settled: a stream opened while output is fresh can show it twice (T-58).
    await sleep(1000);
    assert.strictEqual((await R.screen(r.id)).match(/GOT\[Please review it/g).length, 1);
    assert.ok(saved(home).find((s) => s.role === 'reviewer').owesPrompt, 'typed, and still owed until a turn begins (T-209)');
    await talk(R, r.sessionId);
    await until(() => !saved(home).find((s) => s.role === 'reviewer').owesPrompt, 'it to leave the list');
  });
});

test('Update waits for a session no hook has reached, and for a checkout being made', async (t) => {
  const { R, repo, relayChange } = await updatable();
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  relayChange(2);
  await t.test('a session spoken to with no hooks may be in a turn', async () => {
    const quiet = (await R.call('POST', '/terminals', { cwd: repo })).body;
    await R.call('POST', '/terminals/' + quiet.id + '/input', { data: 'hello\r' });
    await sleep(5500);  // past the few seconds Enter counts for
    const r = await R.call('POST', '/update', {});
    assert.strictEqual(r.status, 202);
    assert.match(r.body.update.waitingOn.find((w) => w.terminal === quiet.id).why, /no hooks reach the relay/);
    await sleep(1000);
    assert.strictEqual((await R.call('GET', '/update')).body.update.state, 'waiting');
    await R.call('POST', '/update', { cancel: true });
    await R.call('POST', '/terminals/' + quiet.id + '/stop', {});
    await until(async () => !(await terminals(R)).some((x) => x.running), 'it to stop');
  });
  await t.test('a checkout whose git worktree add is still running', async () => {
    // git runs post-checkout when it adds the worktree, so a slow one keeps the checkout being made.
    fs.mkdirSync(path.join(repo, 'slow-hooks'));
    fs.writeFileSync(path.join(repo, 'slow-hooks', 'post-checkout'), '#!/bin/sh\nsleep 3\n', { mode: 0o755 });
    sh(repo, 'config', 'core.hooksPath', path.join(repo, 'slow-hooks'));
    const adding = R.call('POST', '/checkouts', { from: repo });
    await sleep(1000);
    const r = await R.call('POST', '/update', {});
    assert.strictEqual(r.status, 202);
    assert.ok(r.body.update.waitingOn.some((w) => w.title === 'A new checkout'), JSON.stringify(r.body.update.waitingOn));
    await R.call('POST', '/update', { cancel: true });
    assert.strictEqual((await adding).status, 201);
  });
});

test('a reviewer that cannot come back keeps its checkout', async (t) => {
  let { R, home, repo } = await updatable();
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const reviewer = (await R.call('POST', '/checkouts', { from: repo, pr: PR })).body;
  await talk(R, reviewer.sessionId); await idle(R, reviewer.sessionId); await sleep(200);
  await R.kill();
  ({ R } = await updatable({ FAKE_CLAUDE_FAIL_RESUME: '1' }, home));
  await until(async () => (await R.call('GET', '/terminals')).body.failed.length, 'it to fail');
  await sleep(1500);  // the sweep, and the clean-up when it ended
  await t.test('the folder stays, and the next start brings it back there', async () => {
    assert.ok(fs.existsSync(reviewer.cwd));
    assert.ok((await R.call('GET', '/checkouts')).body.checkouts.some((c) => c.path === reviewer.cwd));
    await R.kill();
    ({ R } = await updatable({}, home));
    const back = await until(async () => (await terminals(R)).find((x) => x.running && x.sessionId === reviewer.sessionId), 'it to come back');
    assert.strictEqual(back.cwd, reviewer.cwd);
  });
  await t.test('one whose folder is gone is not kept', async () => {
    await R.kill();
    fs.rmSync(reviewer.cwd, { recursive: true, force: true });
    ({ R } = await updatable({}, home));
    await sleep(1500);
    assert.deepStrictEqual((await R.call('GET', '/terminals')).body.failed, []);
    assert.match(R.output(), /Could not bring back/);
  });
});

test('quitting soon after a restart is not a failure', async (t) => {
  let R = await relay(RESUME);
  const home = R.home;
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const a = (await R.call('POST', '/terminals', { cwd: home })).body;
  await talk(R, a.sessionId); await idle(R, a.sessionId); await sleep(200);
  await R.kill();
  R = await relay(RESUME, home);
  const back = await until(async () => (await terminals(R)).find((x) => x.running), 'it to come back');
  await R.call('POST', '/terminals/' + back.id + '/input', { data: '/exit\r' });
  await until(async () => !(await terminals(R)).some((x) => x.running), 'it to quit');
  await sleep(300);
  assert.deepStrictEqual((await R.call('GET', '/terminals')).body.failed, []);
  assert.doesNotMatch(R.output(), /could not come back/);
});

test('an automatic reviewer brought back still ends once its review is posted', async (t) => {
  const GRACE = { RELAY_REVIEW_GRACE_MS: '1000' };
  let { R, home, repo } = await updatable(GRACE);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const reviewer = (await R.call('POST', '/checkouts', { from: repo, pr: PR })).body;
  await talk(R, reviewer.sessionId); await idle(R, reviewer.sessionId); await sleep(200);
  await R.kill();
  ({ R } = await updatable(GRACE, home));
  const back = await until(async () => (await terminals(R)).find((x) => x.running && x.sessionId === reviewer.sessionId), 'it to come back');
  // The real hook, as Claude Code would run it after the review is posted.
  const payload = { hook_event_name: 'PostToolUse', session_id: reviewer.sessionId, cwd: back.cwd, tool_name: 'Bash', tool_input: { command: 'gh pr comment 7 --body "Looks right."' },
    tool_response: { stdout: PR + '#issuecomment-42\n', stderr: '', interrupted: false } };
  const r = require('child_process').spawnSync('node', [path.join(__dirname, '..', 'office-hook.js')], { input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, OFFICE_RELAY_KEY: 'test-key', OFFICE_RELAY_URL: 'http://127.0.0.1:' + R.port, OFFICE_CHANNEL: 't' } });
  assert.strictEqual(r.status, 0);
  await idle(R, reviewer.sessionId);
  await until(async () => !(await terminals(R)).some((x) => x.running && x.id === back.id), 'the reviewer to leave');
  assert.strictEqual((await R.call('GET', '/terminals')).body.finished[0].pr, PR);
});

// The real hook, saying an automatic reviewer's comment went up on PR 7.
function postedReview(R, home, s, cwd) {
  const payload = { hook_event_name: 'PostToolUse', session_id: s.sessionId, cwd: cwd || s.cwd, tool_name: 'Bash', tool_input: { command: 'gh pr comment 7 --body "Looks right."' },
    tool_response: { stdout: PR + '#issuecomment-42\n', stderr: '', interrupted: false } };
  const r = require('child_process').spawnSync('node', [path.join(__dirname, '..', 'office-hook.js')], { input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, OFFICE_RELAY_KEY: 'test-key', OFFICE_RELAY_URL: 'http://127.0.0.1:' + R.port, OFFICE_CHANNEL: 't' } });
  assert.strictEqual(r.status, 0);
}
// The hook gives up on the relay after a second, which a loaded machine can take, so it sends again
// until the relay has saved the post.
async function posts(R, home, s) {
  await until(async () => {
    if (saved(home).some((x) => x.sessionId === s.sessionId && x.posted)) return true;
    postedReview(R, home, s); await sleep(200); return false;
  }, 'the post to reach the relay');
}

test('Update waits for a reviewer that has posted to leave', async (t) => {
  const { R, home, repo, relayChange } = await updatable({ RELAY_REVIEW_GRACE_MS: '4000' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const reviewer = (await R.call('POST', '/checkouts', { from: repo, pr: PR })).body;
  await talk(R, reviewer.sessionId);
  await posts(R, home, reviewer);
  relayChange(2);  // before its turn ends, since the wait to leave starts then
  await idle(R, reviewer.sessionId);
  const r = await R.call('POST', '/update', {});
  assert.strictEqual(r.status, 202);
  assert.match(r.body.update.waitingOn.find((w) => w.terminal === reviewer.id).why, /has posted its review/);
  await sleep(1000);
  assert.strictEqual((await R.call('GET', '/update')).body.update.state, 'waiting');
  // It leaves after its wait, and then the relay restarts with nobody to bring back.
  await until(async () => { try { return (await R.call('GET', '/update')).body.run !== r.body.run; } catch (e) { return false; } }, 'the relay to restart');
  assert.ok(!saved(home).some((s) => s.sessionId === reviewer.sessionId));
  assert.ok(!(await terminals(R)).some((x) => x.running));
});

test('a reviewer that had posted when the relay stopped leaves once it is back', async (t) => {
  let { R, home, repo } = await updatable({ RELAY_REVIEW_GRACE_MS: '60000' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const reviewer = (await R.call('POST', '/checkouts', { from: repo, pr: PR })).body;
  await talk(R, reviewer.sessionId);
  await posts(R, home, reviewer);
  await idle(R, reviewer.sessionId); await sleep(200);
  assert.deepStrictEqual(saved(home).find((s) => s.sessionId === reviewer.sessionId).posted, { kind: 'comment', url: PR + '#issuecomment-42' });
  await R.kill();
  ({ R } = await updatable({ RELAY_REVIEW_GRACE_MS: '1000' }, home));
  const back = await until(async () => (await terminals(R)).find((x) => x.running && x.sessionId === reviewer.sessionId), 'it to come back');
  await until(async () => !(await terminals(R)).some((x) => x.running && x.id === back.id), 'it to leave');
  const done = (await R.call('GET', '/terminals')).body.finished[0];
  assert.deepStrictEqual([done.id, done.pr, done.url], [back.id, PR, PR + '#issuecomment-42']);
});

test('two presses of Update at once pull only once', async (t) => {
  const { R, repo, relayChange } = await updatable();
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const other = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await talk(R, other.sessionId); await sleep(200);  // keeps the update waiting
  relayChange(2);
  const both = await Promise.all([R.call('POST', '/update', {}), R.call('POST', '/update', {})]);
  assert.deepStrictEqual(both.map((r) => r.status).sort(), [202, 409]);
  assert.strictEqual(both.find((r) => r.status === 409).body.error, 'updating');
  assert.strictEqual((R.output().match(/Update: Fetched/g) || []).length, 1);
  await R.call('POST', '/update', { cancel: true });
});

test('Update moves main only to its upstream, even when another fetch rewrote FETCH_HEAD', async (t) => {
  // A task's fetch of its base (relay/tasks.js) can land between Update's fetch and its plan, and
  // leaves FETCH_HEAD naming that branch for merge. This git does that after every plain fetch.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-fetch-')));
  const bin = path.join(tmp, 'bin'), other = path.join(tmp, 'other-sha');
  fs.mkdirSync(bin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\n"' + realGit + '" "$@" || exit $?\n'
    + 'if [ "$1 $2 $#" = "fetch --quiet 2" ] && [ -s "' + other + '" ]; then printf "%s\\t\\tbranch \'feat\' of origin\\n" "$(cat "' + other + '")" > "$("' + realGit + '" rev-parse --git-path FETCH_HEAD)"; fi\n', { mode: 0o755 });
  const { R, home } = await updatable({ PATH: bin + ':' + process.env.PATH });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const src = path.join(home, 'src'), dir = path.join(home, 'relay-folder');
  // A branch cut from main, with a change of its own, not merged.
  sh(src, 'checkout', '-qb', 'feat'); commit(src, 'office/feat.html', 'unmerged\n', 'unmerged work'); sh(src, 'push', '-q', 'origin', 'feat');
  fs.writeFileSync(other, sh(src, 'rev-parse', 'HEAD'));
  sh(src, 'checkout', '-q', 'main'); commit(src, 'office/x.html', 'merged\n', 'merged page'); sh(src, 'push', '-q', 'origin', 'main');
  const main = sh(src, 'rev-parse', 'HEAD');
  const r = await R.call('POST', '/update', {});
  assert.strictEqual(r.status, 200, r.body.message); assert.strictEqual(r.body.reload, true);
  assert.strictEqual(r.body.to, main);
  assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), main, 'main is on its upstream, not on the unmerged branch');
  assert.ok(!fs.existsSync(path.join(dir, 'office/feat.html')));
});

test('Update waits for an open huddle', async (t) => {
  const gh = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-gh-')));
  fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify({ prs: {} }));
  const { R, repo, relayChange } = await updatable({ RELAY_HUDDLE_ANSWER_SECONDS: '3', GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); fs.rmSync(gh, { recursive: true, force: true }); });
  const s = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await talk(R, s.sessionId); await idle(R, s.sessionId);
  assert.strictEqual((await R.call('POST', '/huddle', { ask: true })).body.open, true);
  relayChange(2);
  const r = await R.call('POST', '/update', {});
  assert.strictEqual(r.status, 202);
  assert.ok(r.body.update.waitingOn.some((w) => w.title === 'A huddle'), JSON.stringify(r.body.update.waitingOn));
  // It closes after its answer time, and then the relay restarts.
  await until(async () => { try { return (await R.call('GET', '/update')).body.run !== r.body.run; } catch (e) { return false; } }, 'the relay to restart');
});

test('Update waits for a session answered at its question while it still prints, and not once it goes quiet', async (t) => {
  const { R, repo, relayChange } = await updatable({});
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const s = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const sid = s.sessionId.slice(0, 12);
  await talk(R, s.sessionId);
  await R.hook({ hook_event_name: 'Notification', session_id: sid, message: 'Claude needs your permission to use Bash' });
  await sleep(200);
  // The person approves it. A long command then runs with no hook until it ends, its spinner moving, and
  // PostToolUse leaves the relay saying waiting, as it always has.
  await R.call('POST', '/terminals/' + s.id + '/input', { data: '/spin\r' });
  await until(async () => /Thinking/.test(await R.screen(s.id)), 'the spinner');
  await R.hook({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Bash' });
  relayChange(2);
  const r = await R.call('POST', '/update', {});
  assert.strictEqual(r.status, 202, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.update.waitingOn.map((w) => [w.terminal, w.why]), [[s.id, 'answered its question, so it is in a turn']]);
  assert.strictEqual((await terminals(R)).find((x) => x.id === s.id).state, 'waiting', 'no hook has said otherwise');
  // While its screen moves, past the time the answer itself counts, its turn goes on, and a Stop now
  // would be lost, so the update still waits.
  for (let i = 0; i < 7; i++) {
    await sleep(1000);
    const u = (await R.call('GET', '/update')).body;
    assert.strictEqual(u.run, r.body.run, 'no restart while it prints');
    assert.strictEqual(u.update.state, 'waiting');
  }
  // Quiet, as after Esc, it holds nothing, and the relay restarts.
  await R.call('POST', '/terminals/' + s.id + '/input', { data: '/still\r' });
  await until(async () => { try { return (await R.call('GET', '/update')).body.run !== r.body.run; } catch (e) { return false; } }, 'the relay to restart');
});

test('the relay key reaches no git or gh the relay starts', async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-env-')));
  const bin = path.join(tmp, 'bin'), log = path.join(tmp, 'env.log'), gh = path.join(tmp, 'gh');
  fs.mkdirSync(bin); fs.mkdirSync(gh);
  fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify({ prs: {} }));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // Each writes down the environment it was given, then does the real work.
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nenv >> "$ENV_LOG"\nexec "' + realGit + '" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nenv >> "$ENV_LOG"\nexec "' + process.execPath + '" "' + path.join(__dirname, 'fake-gh.js') + '" "$@"\n', { mode: 0o755 });
  // No RELAY_KEY, so the supervisor picks a random one.
  const { R, repo } = await updatable({ RELAY_KEY: '', PATH: bin + ':' + process.env.PATH, ENV_LOG: log, GH_CMD: path.join(bin, 'gh'), FAKE_GH_DIR: gh });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const key = (await until(() => R.output().match(/Key: ([0-9a-f]{24})/), 'the key'))[1];
  const call = (method, p, body) => R.call(method, p, body, { Authorization: 'Bearer ' + key });
  assert.strictEqual((await call('POST', '/terminals', { cwd: repo })).status, 201);
  assert.strictEqual((await call('POST', '/huddle', {})).status, 200);
  await call('POST', '/update', {});
  const seen = fs.readFileSync(log, 'utf8');
  assert.match(seen, /ENV_LOG=/, 'git and gh ran');
  assert.ok(!seen.includes(key), 'the key is in the environment of git or gh');
  assert.doesNotMatch(seen, /^RELAY_KEY/m);
});

test('a failed task worker comes back as its task', async (t) => {
  let R = await relay(RESUME);
  const home = R.home, repo = makeRepo(home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const task = (await R.call('POST', '/tasks', { title: 'Add a radio', brief: 'Keep it small.', repo })).body.task;
  await takesBrief(R, task.worker.terminal, task.owner.sessionId);
  await until(async () => (await R.call('GET', '/tasks/' + task.id)).body.task.briefed, 'the task brief');
  await idle(R, task.owner.sessionId); await sleep(200);
  await R.kill();
  R = await relay(Object.assign({ FAKE_CLAUDE_FAIL_RESUME: '1' }, RESUME), home);
  const failed = await until(async () => { const g = (await R.call('GET', '/terminals')).body; return g.failed.length && g.failed[0]; }, 'it to fail');
  assert.strictEqual(failed.task, task.id);
  await R.kill();
  // What the panel's Bring back on that line does: the task's own resume, then Forget.
  R = await relay({}, home);
  assert.strictEqual((await R.call('POST', '/tasks/' + task.id + '/resume', {})).status, 200);
  assert.deepStrictEqual((await R.call('POST', '/terminals/failed', { sessionId: failed.sessionId })).body.failed, []);
  const w = (await terminals(R)).find((x) => x.running);
  assert.strictEqual(w.task, task.id); assert.strictEqual(w.sessionId, task.owner.sessionId);
});

test('a task brief typed, with no turn begun when the relay stops, goes in again after it', async (t) => {
  let R = await relay(RESUME);
  const home = R.home, repo = makeRepo(home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const task = (await R.call('POST', '/tasks', { title: 'Add a bell', brief: 'Ring it.', repo })).body.task;
  await until(async () => /GOT\[Your task is to build this now: Add a bell/.test(await R.screen(task.worker.terminal)), 'the brief');
  await sleep(300);
  await R.kill();
  R = await relay(RESUME, home);
  const w = await until(async () => (await terminals(R)).find((x) => x.task === task.id), 'the worker back');
  const screen = await until(async () => { const s = await R.screen(w.id); return /GOT\[Your task is to build this now: Add a bell/.test(s) && s; }, 'the brief again');
  assert.doesNotMatch(screen, /--resume/, 'no turn began, so there is no conversation to resume');
  await talk(R, w.sessionId);
  await until(async () => (await R.call('GET', '/tasks/' + task.id)).body.task.briefed, 'the brief to be in');
});

test('a session with no conversation comes back fresh, not as Could not come back', async (t) => {
  let R = await relay(RESUME);
  const home = R.home;
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const start = (sid) => R.hook({ hook_event_name: 'SessionStart', source: 'startup', session_id: sid.slice(0, 12) });
  // Enter at the question about trusting the folder: hooks reach the relay, and no prompt went in.
  const trusted = (await R.call('POST', '/terminals', { cwd: home, title: 'Trusted' })).body;
  await R.call('POST', '/terminals/' + trusted.id + '/input', { data: '\r' });
  await start(trusted.sessionId);
  // A conversation, then /clear: the new session id has no conversation yet.
  const cleared = (await R.call('POST', '/terminals', { cwd: home, title: 'Cleared' })).body;
  await start(cleared.sessionId); await R.call('POST', '/terminals/' + cleared.id + '/input', { data: 'hello\r' }); await talk(R, cleared.sessionId);
  const fresh = '0a0b0c0d-1111-4222-8333-444455556666';
  await R.hook({ hook_event_name: 'SessionStart', source: 'clear', terminal: cleared.id, session_id: fresh.slice(0, 12), full_session_id: fresh });
  // A conversation, then /compact: the same session id, and its conversation is still there.
  const compacted = (await R.call('POST', '/terminals', { cwd: home, title: 'Compacted' })).body;
  await start(compacted.sessionId); await talk(R, compacted.sessionId);
  await R.hook({ hook_event_name: 'SessionStart', source: 'compact', terminal: compacted.id, session_id: compacted.sessionId.slice(0, 12), full_session_id: compacted.sessionId });
  // A turn whose prompt's hook was lost: only its Stop reached the relay.
  const lostPrompt = (await R.call('POST', '/terminals', { cwd: home, title: 'Lost prompt' })).body;
  await start(lostPrompt.sessionId); await idle(R, lostPrompt.sessionId);
  // Typed into, and no hook ever reached the relay.
  const silent = (await R.call('POST', '/terminals', { cwd: home, title: 'Silent' })).body;
  await R.call('POST', '/terminals/' + silent.id + '/input', { data: 'hello\r' });
  await sleep(300);
  await R.kill();

  await t.test('only the ones with a conversation are saved as talked', () => {
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.office-world', 'sessions.json'), 'utf8'));
    const all = Object.values(saved).flat();
    assert.strictEqual(all.find((s) => s.title === 'Trusted').talked, false);
    assert.strictEqual(all.find((s) => s.sessionId === fresh).talked, false, '/clear also takes away its title');
    assert.strictEqual(all.find((s) => s.sessionId === compacted.sessionId).talked, true);
    assert.strictEqual(all.find((s) => s.title === 'Lost prompt').talked, true, 'a Stop means a turn began');
    const quiet = all.find((s) => s.title === 'Silent');
    assert.strictEqual(quiet.talked, false);
    assert.strictEqual(quiet.spoke, true, 'kept, so a take-back still knows no hooks reach the relay from it');
  });
  await t.test('they come back fresh, and none of them fails', async () => {
    R = await relay(Object.assign({ FAKE_CLAUDE_FAIL_RESUME: '1' }, RESUME), home);
    const back = await until(async () => { const l = (await terminals(R)).filter((x) => x.running); return l.length === 3 && l; }, 'three back');
    assert.ok(back.some((b) => b.title === 'Trusted')); assert.ok(back.some((b) => b.title === 'Silent'));
    for (const x of back) assert.doesNotMatch(await R.screen(x.id), /--resume/);
    const failed = (await R.call('GET', '/terminals')).body.failed;
    assert.deepStrictEqual(failed.map((f) => f.sessionId).sort(), [compacted.sessionId, lostPrompt.sessionId].sort(), 'only the ones with a conversation tried --resume');
  });
});
