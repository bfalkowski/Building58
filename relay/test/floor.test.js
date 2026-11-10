// The Lead knows the Floor: the names the relay gives (relay/seats.js), each session's state, and whether it can be
// stopped. The verdict on its own, then through a real relay with a fake `claude`.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until, sessionToken, ROOT } = require('./helpers.js');
// Not the person's settings file: a PM talk time set on their page would change the verdicts below.
process.env.RELAY_SETTINGS_FILE = path.join(require('os').tmpdir(), 'office-floor-test-no-settings-' + process.pid + '.json');
const { stopVerdict, leadMayStop, PM_TALK, ENTER_SETTLES, TOLD_CHECK } = require('../stop-verdict.js');

const CLI = path.join(ROOT, 'relay', 'ticket.js');
const PR = 'https://github.com/o/r/pull/31';

test('the stop verdict', async (t) => {
  const now = Date.now(), min = 60 * 1000;
  // An idle session that finished a turn 20 minutes ago, and that nobody is typing in.
  const idle = (over) => Object.assign({ id: 'a', state: 'idle', spoke: true, hooked: true, drafting: false, lastEnterAt: now - 20 * min, lastActAt: now - 20 * min }, over);
  const never = [
    ['working', idle({ state: 'working' }), /it is working/],
    ['waiting on the person', idle({ state: 'waiting', message: 'Claude needs your permission to use Bash' }), /waiting on the person: Claude needs your permission/],
    ['text typed in its prompt', idle({ drafting: true }), /text typed in its prompt/],
    ['the Lead', idle({ lead: true }), /it is the Lead/],
    ['the Lead, even idle with nothing typed', idle({ lead: true, spoke: false }), /it is the Lead/],
    ['the PM while it talks to the person', idle({ role: 'pm', typedAt: now - 5 * min }), /the PM is talking to the person: they typed to it 5 min ago/],
    ['Enter just pressed', idle({ lastEnterAt: now - ENTER_SETTLES + 1000 }), /Enter was pressed and no hook has answered yet/],
    ['Enter pressed within the told check, and no hook since', idle({ lastEnterAt: now - ENTER_SETTLES - TOLD_CHECK + 1000 }), /Enter was pressed and no hook has answered yet/],
    // T-209: past the relay's check, the Floor says it did not go in, not that a hook may still come.
    ['Enter pressed long ago, and no hook since', idle({ lastEnterAt: now - 10 * min }), /^Enter was pressed 10 min ago and no turn began, so the prompt did not go in$/],
    ['a first prompt typed long ago, and no turn began', idle({ lastEnterAt: now - 12 * min, owesPrompt: 'Review PR 154' }), /^Enter was pressed 12 min ago and no turn began, so its first prompt did not go in$/],
    ['Enter pressed long ago into a session no hook ever reached', idle({ hooked: false, lastEnterAt: now - 10 * min }), /Enter was pressed and no hook has answered yet/],
    ['spoken to with no hook heard', idle({ hooked: false }), /no hook has said/],
    ['its task is Waiting on you', idle({ task: 'abc123' }), /its task is Waiting on you/, { state: 'waiting_on_you' }],
    ['ended', idle({ exited: true }), /it has ended/],
    ['the trust question on screen', idle({ spoke: false, hooked: false }), /whether to trust its folder/, null, 'trust'],
    ['a menu open on screen', idle(), /a menu is open/, null, 'menu'],
    ['its first prompt not typed yet', idle({ spoke: false, hooked: false, owesPrompt: 'Review PR 31' }), /still owes it its first prompt/],
    ['a task whose brief is on its way', idle({ spoke: false, hooked: false, task: 'abc123', owesTaskBrief: true }), /still owes it its first prompt or brief/, { state: 'building', briefed: false }],
    ['a task whose brief failed', idle({ spoke: false, hooked: false, task: 'abc123' }), /its brief was never delivered/, { state: 'building', briefed: false }],
    ['a caller that did not look at the screen', idle(), /its screen was not checked/, null, undefined],
  ];
  for (const [what, term, why, task, question] of never) {
    await t.test('never safe: ' + what, () => {
      const v = stopVerdict(term, task || null, now, what.startsWith('a caller') ? undefined : question || null);
      assert.strictEqual(v.safe, false);
      assert.match(v.reason, why);
    });
  }
  const safe = [
    ['a reviewer that has posted and is idle', idle({ role: 'reviewer', posted: { kind: 'review' } }), /^its review is posted, idle 20 min$/],
    ['a reviewer that has not posted', idle({ role: 'reviewer' }), /^it has not posted a review, idle 20 min$/],
    ['an idle Dev', idle({ task: 'abc123' }), /^idle 20 min, and Bring back returns it/, { state: 'building' }],
    ['a PM the person left a while ago', idle({ role: 'pm', typedAt: now - PM_TALK() - min }), /^idle 20 min$/],
    ['a session never given a prompt', idle({ spoke: false, hooked: false }), /never given a prompt/],
  ];
  for (const [what, term, why, task] of safe) {
    await t.test('safe: ' + what, () => {
      const v = stopVerdict(term, task || null, now, null);
      assert.strictEqual(v.safe, true, v.reason);
      assert.match(v.reason, why);
    });
  }
});

test('which kinds the Lead may stop', async (t) => {
  const cases = [
    ['an automatic reviewer that has posted', { reviewOf: 'https://github.com/o/r/pull/31', posted: { kind: 'comment' } }, null, false, true, ''],
    ['an automatic reviewer that has not posted', { reviewOf: 'https://github.com/o/r/pull/31', posted: null }, null, false, false, 'its review is not posted'],
    ['a reviewer the relay did not start for a PR', { role: 'reviewer' }, null, false, false, 'the relay did not start it to review a PR'],
    ['a Dev whose task is Done', { task: 'abc123' }, { state: 'done' }, false, true, 'its task is Done, '],
    ['a Dev whose PR merged', { task: 'abc123' }, { state: 'in_review' }, true, true, 'its PR merged, '],
    ['a Dev whose PR has not merged', { task: 'abc123' }, { state: 'in_review' }, false, false, 'its PR has not merged and its task is not Done'],
    ['a Dev whose task is gone', { task: 'abc123' }, null, true, false, 'its task is not on the board'],
    ['the PM', { role: 'pm' }, null, false, false, 'it is the PM'],
    ['the COO', { role: 'coo' }, null, false, false, 'it is the COO'],
    ['a plain session', {}, null, false, false, 'it is not a reviewer or a Dev'],
  ];
  for (const [what, term, task, merged, may, words] of cases) {
    await t.test(what, () => {
      const v = leadMayStop(term, task, merged);
      assert.strictEqual(v.may, may);
      assert.strictEqual(may ? v.why : v.reason, words);
    });
  }
});

test('the floor', async (t) => {
  const R = await relay({ RELAY_WIP_LIMIT: '5' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const start = async (extra) => (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(150); };
  const finish = async (s) => { await hook(s, { hook_event_name: 'UserPromptSubmit', title: '' }); await hook(s, { hook_event_name: 'Stop' }); };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const floor = async (headers) => R.call('GET', '/floor', undefined, headers);
  const rowOf = async (s) => (await floor()).body.sessions.find((r) => r.terminal === s.id);
  const tokenFor = (s) => until(() => { try { return { 'X-Office-Token': sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');

  const lead = await start(), working = await start(), waiting = await start(), drafting = await start(), fresh = await start();
  const pm = await start({ role: 'pm', title: 'PM: an idea' }), reviewer = await start({ role: 'reviewer', pr: PR, title: 'Review' });
  const task = (await R.call('POST', '/tasks', { title: 'A task', repo })).body.task;
  const dev = (await terminals()).find((x) => x.id === task.owner.terminal);

  await t.test('the relay gives each session a person of its own, and GET /terminals returns it', async () => {
    const list = await terminals(), names = list.map((x) => x.who);
    assert.strictEqual(list.length, 8);
    assert.ok(names.every((n) => typeof n === 'string' && n), names.join(', '));
    assert.strictEqual(new Set(names).size, 8, 'nobody twice');
    assert.ok(!names.includes('Lead'), 'nobody is at the Lead\'s desk while there is no Lead and other desks are free');
    assert.strictEqual((await R.call('POST', '/terminals/names', { names: { [working.id]: 'Nobody' } })).status, 404, 'no page names a session');
  });

  await finish(lead);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
  await hook(working, { hook_event_name: 'UserPromptSubmit', title: '' });
  await finish(waiting); await hook(waiting, { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
  await finish(drafting); await R.call('POST', '/terminals/' + drafting.id + '/input', { data: 'half a thought' });
  await finish(reviewer);
  await finish(pm); await R.call('POST', '/terminals/' + pm.id + '/input', { data: 'tell me more' }); await R.call('POST', '/terminals/' + pm.id + '/input', { data: '\x15' });  // typed, then cleared
  await until(async () => (await R.screen(dev.id)).includes('GOT['), 'the task brief');
  await finish(dev);

  const nameOf = async (s) => (await terminals()).find((x) => x.id === s.id).who;
  await t.test('each session has its name, role, ticket and PR, and state', async () => {
    const m = await rowOf(working);
    assert.deepStrictEqual([m.name, m.named, m.role, m.state], [await nameOf(working), true, 'session', 'working']);
    const theo = await rowOf(reviewer);
    assert.deepStrictEqual([theo.role, theo.pr, theo.state], ['reviewer', PR, 'idle']);
    assert.deepStrictEqual(theo.desk.reviewing, { pr: PR, prNumber: '#31', dev: null }, 'no Dev on the Floor has PR 31, so the reviewer names only the PR');
    assert.strictEqual(typeof theo.minutesSinceHook, 'number');
    assert.deepStrictEqual([(await rowOf(dev)).role, (await rowOf(dev)).name], ['Dev', await nameOf(dev)]);
    assert.strictEqual((await rowOf(pm)).role, 'PM');
    assert.deepStrictEqual([(await rowOf(lead)).role, (await rowOf(lead)).name], ['Lead', 'Lead'], 'the Lead sits at the Lead\'s desk');
    assert.strictEqual((await rowOf(waiting)).state, 'waiting on the person');
    const f = await rowOf(fresh);
    assert.deepStrictEqual([f.named, f.name, f.minutesSinceHook], [true, await nameOf(fresh), null]);
  });

  await t.test('the verdict at the route: never safe while working, waiting, typed in, the Lead, or the PM talking', async () => {
    const verdict = async (s) => { const r = await rowOf(s); return [r.canStop, r.why]; };
    assert.deepStrictEqual(await verdict(working), [false, 'it is working']);
    assert.deepStrictEqual(await verdict(waiting), [false, 'it is waiting on the person: Claude needs your permission to use Bash']);
    assert.deepStrictEqual(await verdict(drafting), [false, 'the person has text typed in its prompt']);
    assert.deepStrictEqual(await verdict(lead), [false, 'it is the Lead']);
    assert.deepStrictEqual(await verdict(pm), [false, 'the PM is talking to the person: they typed to it 0 min ago']);
    // Safe, but not one the Lead may stop (relay/test/lead-stop.test.js has each kind at the stop route).
    const safe = async (s) => { const r = await rowOf(s); return [r.safe, r.canStop, r.why]; };
    assert.deepStrictEqual(await safe(fresh), [true, false, 'not one the Lead may stop: it is not a reviewer or a Dev']);
    assert.deepStrictEqual(await safe(reviewer), [true, false, 'not one the Lead may stop: the relay did not start it to review a PR']);
    // The relay typed the task's brief with Enter, so it waits for that to settle before it says safe.
    await until(async () => (await rowOf(dev)).safe, 'the Dev to settle');
    assert.deepStrictEqual(await safe(dev), [true, false, 'not one the Lead may stop: its PR has not merged and its task is not Done']);
    await R.call('POST', '/tasks/' + task.id + '/move', { to: 'waiting_on_you' });
    assert.deepStrictEqual(await verdict(dev), [false, 'its task is Waiting on you']);
  });

  await t.test('only the Lead\'s token reads it, and ticket.js floor prints a line each', async () => {
    const leadToken = await tokenFor(lead), otherToken = await tokenFor(working);
    assert.strictEqual((await floor(leadToken)).status, 200);
    assert.strictEqual((await floor(otherToken)).status, 401);
    assert.strictEqual((await floor({})).status, 401);
    const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: leadToken['X-Office-Token'] };
    const out = execFileSync('node', [CLI, 'floor'], { env, encoding: 'utf8' });
    const line = (text) => assert.ok(out.split('\n').includes(text), text + ' in:\n' + out);
    line(await nameOf(reviewer) + ' · reviewer of PR 31 · idle · last hook 0 min ago · not one the Lead may stop: the relay did not start it to review a PR');
    line(await nameOf(working) + ' · session · working · last hook 0 min ago · not safe to stop: it is working');
    line(await nameOf(dev) + ' · Dev · idle · last hook 0 min ago · not safe to stop: its task is Waiting on you');
    line(await nameOf(fresh) + ' · session · idle · no hook yet · not one the Lead may stop: it is not a reviewer or a Dev');
    assert.strictEqual(out.trim().split('\n').length, 8);
    assert.throws(() => execFileSync('node', [CLI, 'floor'], { env: { ...env, OFFICE_TICKET_TOKEN: otherToken['X-Office-Token'] }, encoding: 'utf8', stdio: 'pipe' }), /Only the Lead can read the floor/);
  });

  await t.test('a menu on screen is not safe, though hooks say idle', async () => {
    await R.call('POST', '/terminals/' + fresh.id + '/input', { data: 'Enter to confirm\r' });  // the fake echoes it, so the words of a menu are on screen
    await until(async () => (await rowOf(fresh)).why === 'a menu is open on its screen', 'the menu to show');
    assert.strictEqual((await rowOf(fresh)).canStop, false);
  });
});

test('the floor, while Claude Code asks whether to trust the folder', async (t) => {
  const R = await relay({ RELAY_WIP_LIMIT: '5', FAKE_CLAUDE_TRUST: '1' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const rowOf = async (s) => (await R.call('GET', '/floor')).body.sessions.find((r) => r.terminal === s.id);
  const plain = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const task = (await R.call('POST', '/tasks', { title: 'A task', repo })).body.task;
  await sleep(2000);  // past the moment the screen settles, and the brief is still held by the question

  await t.test('a session at the trust question is not safe, though it was never given a prompt', async () => {
    assert.deepStrictEqual([(await rowOf(plain)).canStop, (await rowOf(plain)).why], [false, 'it is asking the person whether to trust its folder']);
  });
  await t.test('a Dev whose brief the relay has not typed yet is not safe', async () => {
    const dev = await rowOf({ id: task.owner.terminal });
    assert.deepStrictEqual([dev.role, dev.canStop, dev.why], ['Dev', false, 'the relay still owes it its first prompt or brief']);
  });
});

// T-186: a PR merged while its Dev's fixes were still uncommitted. The Floor tells the Lead, before its own
// merge, why a merge now would leave a Dev's work out (relay/merge-hold.js).
test('the floor names a merge hold for a Dev whose PR is open', async (t) => {
  const R = await relay({ RELAY_WIP_LIMIT: '5' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(150); };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const rowOf = async (s) => (await R.call('GET', '/floor')).body.sessions.find((r) => r.terminal === s.id);
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await hook(lead, { hook_event_name: 'UserPromptSubmit', title: '' }); await hook(lead, { hook_event_name: 'Stop' });
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
  const task = (await R.call('POST', '/tasks', { title: 'A task', repo })).body.task;
  const dev = (await terminals()).find((x) => x.id === task.owner.terminal);
  const wt = (await R.call('GET', '/tasks')).body.tasks.find((x) => x.id === task.id).worktree;
  await until(async () => (await R.screen(dev.id)).includes('GOT['), 'the task brief');

  await t.test('none before the Dev has a PR', async () => {
    await hook(dev, { hook_event_name: 'UserPromptSubmit', title: '' });
    assert.strictEqual((await rowOf(dev)).mergeHold, null);
  });
  await t.test('while the Dev works on its open PR, a merge waits for it', async () => {
    await hook(dev, { hook_event_name: 'PostToolUse', pr_url: PR, cwd: wt });
    assert.strictEqual((await rowOf(dev)).mergeHold, 'Its Dev is working, maybe still answering the latest review, so the PR may not hold every fix yet.');
  });
  await t.test('an idle Dev with uncommitted changes holds the merge, and ticket.js floor says so', async () => {
    require('fs').writeFileSync(path.join(wt, 'fix.txt'), 'not committed\n');
    await hook(dev, { hook_event_name: 'Stop' });
    const why = 'Its Dev stopped, but its checkout has uncommitted changes, so the PR does not hold all its work.';
    assert.strictEqual((await rowOf(dev)).mergeHold, why);
    const token = await until(() => { try { return sessionToken(lead.sessionId); } catch (e) { return null; } }, 'the token');
    const out = execFileSync('node', [CLI, 'floor'], { env: { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: token }, encoding: 'utf8' });
    assert.ok(out.includes(' · merge hold: ' + why + ' · '), out);
  });
});
