// The Lead stops finished sessions (article 3), through a real relay with a fake `claude`.
// Only a Lead the person let move the board, only while the relay runs with RELAY_LEAD_STOPS=1,
// never a session the Floor calls not safe, and only the two kinds its brief names: an automatic
// reviewer that has posted, and a Dev whose PR merged or whose task is Done, with its work pushed.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until, sessionToken, ROOT } = require('./helpers.js');

const CLI = path.join(ROOT, 'relay', 'ticket.js');
const PR = 'https://github.com/acme/widgets/pull/7';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(args), { cwd, encoding: 'utf8' }).trim();

// A relay with a Lead the person let move the board, and helpers to drive sessions. The repo has an
// origin that main is pushed to, and a PR 7 a reviewer can check out. Automatic reviews are off, so
// only the sessions a test starts are on the Floor.
async function office(env) {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ RELAY_WIP_LIMIT: '8', RELAY_REVIEW_GRACE_MS: '600000', RELAY_CHAT_POLL_SECONDS: '1', GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh, ...env });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  git(R.home, 'init', '-q', '--bare', origin);
  git(repo, 'config', 'url.' + origin + '.insteadOf', 'https://github.com/acme/widgets.git');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  git(repo, 'push', '-q', 'origin', 'main', 'HEAD:refs/pull/7/head');
  await R.call('POST', '/reviews', { auto: false });
  const answers = (a) => fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify(a));
  const start = async (extra) => (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(150); };
  const finish = async (s) => { await hook(s, { hook_event_name: 'UserPromptSubmit', title: '' }); await hook(s, { hook_event_name: 'Stop' }); };
  const tokenFor = (s) => until(() => { try { return { 'X-Office-Token': sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');
  const running = async (s) => (await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === s.id);
  const rowOf = async (s) => (await R.call('GET', '/floor')).body.sessions.find((r) => r.terminal === s.id);
  // The person the relay gave a session (relay/seats.js), as the Floor names it.
  const nameOf = async (s) => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === s.id).who;
  // An automatic reviewer of PR 7, idle after its turn. posted: its hook said the review went up.
  const reviewer = async (posted) => {
    const r = await R.call('POST', '/checkouts', { from: repo, pr: PR });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    await hook(r.body, { hook_event_name: 'UserPromptSubmit', title: '' });
    if (posted) await hook(r.body, { hook_event_name: 'PostToolUse', tool_name: 'Bash', posted: { kind: 'comment', repo: 'acme/widgets', pr: 7, url: PR + '#issuecomment-42' } });
    await hook(r.body, { hook_event_name: 'Stop' });
    return r.body;
  };
  // A task's Dev, briefed and idle, with its task in the state named.
  const dev = async (state) => {
    const task = (await R.call('POST', '/tasks', { title: 'A task', repo })).body.task;
    const s = { id: task.owner.terminal, sessionId: task.owner.sessionId };
    await until(async () => (await R.screen(s.id)).includes('GOT['), 'the task brief');
    await finish(s);
    if (state) assert.strictEqual((await R.call('POST', '/tasks/' + task.id + '/move', { to: state })).status, 200);
    await until(async () => (await rowOf(s)).safe, 'the Dev to settle');
    return Object.assign(s, { task });
  };
  const lead = await start();
  await finish(lead);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true })).body.board, true);
  const leadToken = await tokenFor(lead);
  const stop = (who, headers) => R.call('POST', '/floor/stop', { who }, headers || leadToken);
  const cli = (...args) => execFileSync('node', [CLI, ...args], { env: { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: leadToken['X-Office-Token'] }, encoding: 'utf8', stdio: 'pipe' });
  const done = async () => { await R.kill().catch(() => {}); await R.remove(); fs.rmSync(gh, { recursive: true, force: true }); };
  return { R, repo, answers, start, hook, finish, tokenFor, running, rowOf, nameOf, reviewer, dev, lead, leadToken, stop, cli, done };
}

test('the switch is off by default', async (t) => {
  const o = await office({});
  t.after(o.done);
  const idle = await o.dev('done'), name = await o.nameOf(idle);
  const r = await o.stop(name);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.error, 'lead_stops_off');
  assert.match(r.body.message, /Let the Lead stop sessions in Settings/);  // the switch moved from the variable to Settings (relay/config.js)
  assert.ok(await o.running(idle), 'nobody was stopped');
  assert.throws(() => o.cli('stop', name), /has not let the Lead stop sessions/);
  // The person turns it on in Settings, with no restart (relay/config.js), and the same ask works.
  assert.strictEqual((await o.R.call('POST', '/settings', { values: { leadStops: true } })).status, 200);
  const after = await o.stop(name);
  assert.strictEqual(after.status, 200, JSON.stringify(after.body));
  await until(async () => !(await o.running(idle)), name + ' to stop');
});

test('the Lead never stops a session the verdict calls not safe', async (t) => {
  const o = await office({ RELAY_LEAD_STOPS: '1' });
  const { R } = o;
  t.after(o.done);

  const working = await o.start(), waiting = await o.start(), menu = await o.start(), other = await o.start();
  const pm = await o.start({ role: 'pm', title: 'PM: an idea' }), posted = await o.reviewer(true);
  const name = {};
  for (const [k, s] of Object.entries({ working, waiting, menu, posted })) name[k] = await o.nameOf(s);
  await o.hook(working, { hook_event_name: 'UserPromptSubmit', title: '' });
  await o.finish(waiting); await o.hook(waiting, { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
  await o.finish(menu); await R.call('POST', '/terminals/' + menu.id + '/input', { data: 'Enter to confirm\r' });  // the fake echoes it, so a menu's words are on screen
  await o.hook(menu, { hook_event_name: 'Stop' });
  await o.finish(pm); await R.call('POST', '/terminals/' + pm.id + '/input', { data: 'tell me more' }); await R.call('POST', '/terminals/' + pm.id + '/input', { data: '\x15' });

  await t.test('only the Lead the person let move the board may ask', async () => {
    const otherToken = await o.tokenFor(working);
    assert.strictEqual((await o.stop(name.posted, otherToken)).status, 401, 'another session');
    // The relay key is the person's Stop on the Floor: it names a desk by its id, and asks the same verdict.
    const key = await o.stop(working.id, { Authorization: 'Bearer test-key' });
    assert.deepStrictEqual([key.status, key.body.error], [409, 'not_safe'], 'the person\'s Stop asks the same verdict');
    assert.ok(await o.running(working));
    assert.strictEqual((await R.call('POST', '/terminals/lead', { board: false })).body.board, false);
    assert.strictEqual((await o.stop(name.posted)).status, 401, 'the Lead, once the person takes the board back');
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: o.lead.id, board: true })).body.board, true);
    assert.ok(await o.running(posted));
  });

  await t.test('it refuses a session that is busy, waiting on the person, the Lead, or the PM talking to the person', async () => {
    const refused = [
      [name.working, working, 'Not stopped: it is working.'],
      [name.waiting, waiting, 'Not stopped: it is waiting on the person: Claude needs your permission to use Bash.'],
      [name.menu, menu, 'Not stopped: a menu is open on its screen.'],
      ['Lead', o.lead, 'Not stopped: it is the Lead.'],
    ];
    for (const [who, s, message] of refused) {
      const r = await o.stop(who);
      assert.deepStrictEqual([r.status, r.body.error, r.body.message], [409, 'not_safe', message], who);
      assert.ok(await o.running(s), who + ' is still running');
    }
    const p = await o.stop(pm.id);  // by its desk's id
    assert.deepStrictEqual([p.status, p.body.message], [409, 'Not stopped: the PM is talking to the person: they typed to it 0 min ago.']);
    assert.ok(await o.running(pm));
  });

  await t.test('a name it cannot pin to a session stops nobody', async () => {
    const none = await o.stop('Nobody');
    assert.deepStrictEqual([none.status, none.body.error], [404, 'no_session']);
    assert.strictEqual((await o.stop('')).status, 400);
    assert.ok(await o.running(other) && await o.running(pm));
  });
});

test('the Lead stops only a posted automatic reviewer, or a Dev whose PR merged or whose task is Done', async (t) => {
  const o = await office({ RELAY_LEAD_STOPS: '1', RELAY_LEAD_STOP_LIMIT: '3' });
  const { R } = o;
  t.after(o.done);

  const plain = await o.start(), pm = await o.start({ role: 'pm', title: 'PM: an idea' });
  const posted = await o.reviewer(true), unposted = await o.reviewer(false);
  const done = await o.dev('done'), building = await o.dev(), merged = await o.dev(), unsaved = await o.dev('done');
  const name = {};
  for (const [k, s] of Object.entries({ posted, unposted, done, merged, unsaved })) name[k] = await o.nameOf(s);
  // The merged Dev's PR merged, and the relay heard it from gh. Its task is still Building.
  const MAX_PR = 'https://github.com/acme/widgets/pull/9';
  o.answers({ prs: { [MAX_PR]: { state: 'MERGED', statusCheckRollup: [] } } });
  await o.hook(merged, { hook_event_name: 'PostToolUse', tool_name: 'Bash', pr_url: MAX_PR });
  await until(async () => (await o.rowOf(merged)).why.startsWith('its PR merged'), 'the relay to hear that PR 9 merged');

  // Each refused one: on the Floor it is safe but not the Lead's, and the route refuses it and names it.
  const refuses = async (what, s, why) => {
    const row = await o.rowOf(s);
    assert.deepStrictEqual([row.safe, row.canStop, row.why], [true, false, 'not one the Lead may stop: ' + why], what + ' on the Floor');
    const r = await o.stop(s.id);
    assert.deepStrictEqual([r.status, r.body.error], [403, 'not_the_leads'], what);
    assert.ok(r.body.message.startsWith('Not stopped: not one the Lead may stop: ' + why + '. The Lead stops only'), r.body.message);
    assert.strictEqual(r.body.session.sessionId, s.sessionId, 'the refusal names the session');
    assert.ok(await o.running(s), what + ' is still running');
  };

  await t.test('it refuses a session the person just added, and the same one once it is idle', async () => {
    assert.strictEqual((await o.rowOf(plain)).why, 'not one the Lead may stop: it is not a reviewer or a Dev');
    await refuses('a session the person just added', plain, 'it is not a reviewer or a Dev');
    await o.finish(plain);
    await refuses('an idle plain session', plain, 'it is not a reviewer or a Dev');
  });

  await t.test('it refuses the PM the person is not talking to', async () => {
    // The verdict calls such a PM safe, the same as one the person last typed to longer ago than
    // Keep the PM after you type for (relay/test/floor.test.js). It stays the person's to stop.
    await o.finish(pm);
    await refuses('the PM', pm, 'it is the PM');
  });

  await t.test('it refuses a reviewer that has not posted, and a Dev whose PR has not merged', async () => {
    await refuses('a reviewer that has not posted', unposted, 'its review is not posted');
    await refuses('a Dev whose PR has not merged', building, 'its PR has not merged and its task is not Done');
    assert.match(o.cli('floor'), new RegExp('^' + name.unposted + ' · reviewer of PR 7 · idle · last hook \\d+ min ago · not one the Lead may stop: its review is not posted$', 'm'), 'not "not safe to stop": it is safe, but the person\'s');
  });

  await t.test('it refuses a Done Dev with uncommitted changes, or a commit that is not pushed', async () => {
    const dir = unsaved.task.worktree;
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    await refuses('a Dev with uncommitted changes', unsaved, 'its checkout has uncommitted changes');
    git(dir, 'add', 'b.txt'); git(dir, 'commit', '-qm', 'b');
    await refuses('a Dev with a commit that is not pushed', unsaved, 'its checkout has 1 commit that is not pushed');
  });

  await t.test('it stops a posted automatic reviewer by name, and ticket.js, the log and the page say who', async () => {
    const out = o.cli('stop', name.posted.toLowerCase());
    assert.match(out, new RegExp('^Stopped: ' + name.posted + ' \\(reviewer, session ' + posted.sessionId + '\\): its review is posted, idle \\d+ min$', 'm'));
    assert.match(out, new RegExp('^To bring it back: Resume with session id ' + posted.sessionId + '\\.$', 'm'), 'one with no task comes back with Resume');
    await until(async () => !(await o.running(posted)), 'the reviewer to stop');
    await until(() => R.output().includes('The Lead stopped ' + name.posted + ' (reviewer, session ' + posted.sessionId + ') on t: its review is posted'), 'the log line');
    const office = (await R.call('GET', '/chat/office')).body.posts.map((x) => x.text);
    assert.ok(office.some((x) => x.startsWith('The Lead stopped ' + name.posted + ' (reviewer, session ' + posted.sessionId + '): its review is posted, idle ')), office.join('\n'));
  });

  await t.test('it stops a Dev whose task is Done by its task id, and the checkout, branch and Bring back stay', async () => {
    const { task } = done;
    const r = await o.stop(task.id);
    assert.strictEqual(r.status, 200, r.body.message);
    assert.deepStrictEqual([r.body.stopped.name, r.body.stopped.role, r.body.stopped.task, r.body.stopped.sessionId], [name.done, 'Dev', task.id, task.owner.sessionId]);
    assert.match(r.body.stopped.why, /^its task is Done, idle \d+ min, and Bring back returns it to the same checkout$/);
    await until(async () => !(await o.running(done)), 'the Dev to stop');
    assert.ok(fs.existsSync(task.worktree), 'its checkout stays');
    assert.strictEqual(execFileSync('git', ['-C', o.repo, 'branch', '--list', task.branch], { encoding: 'utf8' }).trim().replace(/^[*+]\s*/, ''), task.branch, 'its branch stays');
    const after = (await R.call('GET', '/tasks/' + task.id)).body.task;
    assert.match(after.history.at(-1).note, /^The Lead stopped its worker: its task is Done, idle/);
    const back = await R.call('POST', '/tasks/' + task.id + '/resume', {});
    assert.strictEqual(back.status, 200, back.body.message);
    const worker = back.body.task.worker.terminal;
    await until(async () => (await R.screen(worker)).includes('fake claude --resume ' + task.owner.sessionId), 'the same conversation');
  });

  await t.test('it stops a Dev whose PR merged, though its task is not Done', async () => {
    assert.match(o.cli('floor'), new RegExp('^' + name.merged + ' · Dev, PR 9 · idle · last hook \\d+ min ago · safe to stop: its PR merged, idle \\d+ min, and Bring back returns it to the same checkout$', 'm'));
    const r = await o.stop(name.merged);
    assert.strictEqual(r.status, 200, r.body.message);
    assert.match(r.body.stopped.why, /^its PR merged, idle \d+ min/);
    await until(async () => !(await o.running(merged)), 'the Dev to stop');
  });

  await t.test('it stops at most RELAY_LEAD_STOP_LIMIT sessions an hour', async () => {
    git(unsaved.task.worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/' + unsaved.task.branch);  // now all of its work is pushed
    assert.strictEqual((await o.rowOf(unsaved)).canStop, true, (await o.rowOf(unsaved)).why);
    const r = await o.stop(name.unsaved);
    assert.deepStrictEqual([r.status, r.body.error], [429, 'limit'], 'three stopped this hour');
    assert.ok(await o.running(unsaved));
  });
});

test('each desk says its ticket, column and next step, and the person stops the safe ones', async (t) => {
  const o = await office({});
  const { R } = o;
  t.after(o.done);
  const posted = await o.reviewer(true), unposted = await o.reviewer(false);
  const done = await o.dev('done'), review = await o.dev('in_review'), waiting = await o.dev();
  // Waiting on you is never safe, so dev() could not wait for it to settle in that state.
  assert.strictEqual((await R.call('POST', '/tasks/' + waiting.task.id + '/move', { to: 'waiting_on_you', note: 'constitution change' })).status, 200);
  const desk = async (s) => (await o.rowOf(s)).desk;
  const key = { Authorization: 'Bearer test-key' };
  const press = (body) => R.call('POST', '/floor/stop', body, key);

  await t.test('each desk on GET /floor', async () => {
    const d = await desk(done);
    assert.deepStrictEqual([d.title, d.column.label, d.next, d.stop.safe], ['A task', 'Done', { text: 'Done, safe to stop', owner: 'you' }, true]);
    assert.match(d.stop.reason, /^its task is Done, idle \d+ min/);
    assert.match(d.doing.words, /^idle \d+ min$/);
    const r = await desk(review);
    assert.deepStrictEqual([r.column.label, r.next, r.stop.safe], ['In review', { text: 'Waiting on you: read what the Dev wrote, it has no PR yet', owner: 'you' }, false]);
    const w = await desk(waiting);
    assert.deepStrictEqual([w.column.label, w.next.owner, w.stop.safe], ['Waiting on you', 'you', false]);
    assert.strictEqual(w.next.text, 'Waiting on you: constitution change');
    const p = await desk(posted);
    assert.deepStrictEqual([p.prNumber, p.review, p.next, p.stop.safe], ['#7', 'review posted', { text: 'Done, safe to stop', owner: 'you' }, true]);
    assert.deepStrictEqual([(await desk(unposted)).stop.safe, (await desk(o.lead)).next.owner, (await desk(o.lead)).stop.safe], [false, 'Lead', false]);
  });

  await t.test('Stop stops one safe desk, and refuses one that is not', async () => {
    const no = await press({ who: review.id });
    assert.deepStrictEqual([no.status, no.body.error], [409, 'not_safe']);
    assert.ok(await o.running(review));
    assert.strictEqual((await press({ who: 'ffffffffffff' })).status, 404);
    const yes = await press({ who: posted.id });
    assert.strictEqual(yes.status, 200, JSON.stringify(yes.body));
    assert.deepStrictEqual(yes.body.stopped.map((x) => x.terminal), [posted.id]);
    await until(async () => !(await o.running(posted)), 'the reviewer to stop');
  });

  await t.test('Stop all safe stops only the safe desks, with the Lead\'s switch off', async () => {
    const all = await press({ all: true });
    assert.strictEqual(all.status, 200, JSON.stringify(all.body));
    assert.deepStrictEqual(all.body.stopped.map((x) => x.terminal), [done.id]);
    await until(async () => !(await o.running(done)), 'the Done Dev to stop');
    for (const s of [unposted, review, waiting, o.lead]) assert.ok(await o.running(s), 'still running');
    const history = (await R.call('GET', '/tasks')).body.tasks.find((x) => x.id === done.task.id).history;
    assert.ok(history.some((h) => h.type === 'note' && /^You stopped its worker from the Floor: its task is Done/.test(h.note)), 'its history says who stopped it');
  });
});
