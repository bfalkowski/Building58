// The Lead is chosen on purpose and told its job, through a real relay with a fake `claude`.
'use strict';
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until, ROOT } = require('./helpers.js');

// The terminal echoes what is typed, so count what the fake says it got.
const BRIEF = 'GOT[You are the Lead of this room.';
const briefs = (screen) => screen.split(BRIEF).length - 1;

// Claude Code reads keys about 1024 bytes at a time and keeps only the last piece (T-34), so text that
// could be that long goes in as one paste (relay/typed.js). The brief names full paths, so it grows with
// the checkout root, and it goes in as a paste from any root. Until T-85 it had to fit in one read.
test('the Lead\'s brief goes in as one paste, whatever the length of the checkout root', () => {
  const { leadBrief } = require('../lead-brief.js');
  const { asTyped } = require('../typed.js');
  const pasted = (text) => asTyped(text) === '\x1b[200~' + text + '\x1b[201~';
  for (const length of [1, 120, 250, 1000]) {
    const root = path.join('/', 'r'.repeat(length - 1));
    for (const opts of [{}, { merge: true }, { autopilot: true }]) {
      const brief = leadBrief(path.join(root, 'relay'), opts);
      // Keys go in whole only within one read. A short root gives a brief that short, and that is fine.
      assert.ok(pasted(brief) || Buffer.byteLength(brief) < 1024, 'root of ' + length + ', ' + JSON.stringify(opts));
      if (length >= 250) assert.ok(pasted(brief), 'a long root gives a paste');
      assert.ok(brief.includes(JSON.stringify(path.join(root, 'relay', 'ticket.js'))), 'it names ticket.js in full');
    }
  }
  // With merging on, it points to the constitution beside ticket.js rather than naming another full path.
  assert.ok(leadBrief('/r/relay', { merge: true }).includes('the merge rung in docs/constitution.md of ticket.js\'s repo'), 'it points to the constitution');
  // Short text is typed as keys, and bytes count, not characters: 700 letters of two bytes are 1400.
  assert.strictEqual(asTyped('/clear'), '/clear');
  assert.ok(!pasted('e'.repeat(700)), 'short text is keys');
  assert.ok(pasted('\u00e9'.repeat(700)), 'long in bytes is a paste');
  assert.strictEqual(asTyped('a\x1bb'.repeat(400)), '\x1b[200~' + 'ab'.repeat(400) + '\x1b[201~', 'nothing inside can end the paste early');
});

// The relay gives a task's Dev the reviews on its PR (relay/pr-comments.js, T-17), so a Lead that carried
// them too would tell the Dev twice (T-76). The Lead passes decisions on, and checks that Devs act on reviews.
test('the Lead\'s brief leaves reviews to the relay and checks that Devs act on them', () => {
  const { leadBrief } = require('../lead-brief.js');
  for (const opts of [{}, { merge: true }, { autopilot: true }]) {
    const brief = leadBrief(path.join(ROOT, 'relay'), opts);
    assert.doesNotMatch(brief, /Pass reviews/, 'it does not carry reviews: ' + JSON.stringify(opts));
    assert.ok(brief.includes('Pass decisions on.'), 'it still passes decisions on');
    assert.ok(brief.includes('Devs get PR reviews from the relay: check they act.'), 'it checks the Devs act');
  }
});

test('the Lead\'s brief', async (t) => {
  let R = await relay({ RELAY_WIP_LIMIT: '5' });
  const home = R.home, repo = makeRepo(home), file = path.join(home, '.office-world', 'lead.json');
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')).t;
  const start = async (extra) => (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
  const hook = async (s, event) => { await R.hook({ session_id: s.slice(0, 12), ...event }); await sleep(200); };
  const talk = async (s) => { await hook(s, { hook_event_name: 'UserPromptSubmit', title: '' }); await hook(s, { hook_event_name: 'Stop' }); };
  const terminal = async (id) => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === id);
  const told = (id, n) => until(async () => briefs(await R.screen(id)) === n, n + ' brief(s)');
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });

  const a = await start(), b = await start();
  await t.test('a session is not the Lead for being first, and hears nothing', async () => {
    await talk(a.sessionId);
    await sleep(2500);
    assert.strictEqual((await terminal(a.id)).lead, false);
    assert.strictEqual(briefs(await R.screen(a.id)), 0);
    assert.ok(!fs.existsSync(file));
  });
  await t.test('a session you make the Lead gets the brief and is saved', async () => {
    const r = await R.call('POST', '/terminals/lead', { terminal: a.id });
    assert.strictEqual(r.body.lead, true);
    assert.strictEqual(saved().sessionId, a.sessionId);
    await told(a.id, 1);
    const screen = await R.screen(a.id);
    assert.ok(screen.includes('node ' + JSON.stringify(path.join(ROOT, 'relay', 'ticket.js')) + ' list'), 'a path with a space still works');
    for (const job of ['take no ticket work', 'open pull requests', 'Pass decisions on', 'Devs get PR reviews from the relay', 'keep tickets moving', 'what is waiting on them', 'against the code and the pipeline', 'Never merge a pull request: merging stays with the person']) assert.ok(screen.includes(job), job);
    // It is typed in one burst, and Claude Code reads about 1024 bytes at a time (T-34), so the end has to arrive too.
    assert.ok(screen.includes('report in a few lines.]'), 'the whole brief arrived as one line');
    assert.strictEqual((await terminal(a.id)).work.role, 'lead');
  });
  await t.test('choosing it again does not tell it again', async () => {
    await R.call('POST', '/terminals/lead', { terminal: a.id });
    await sleep(2500);
    assert.strictEqual(briefs(await R.screen(a.id)), 1);
  });
  await t.test('a reviewer, a Get a review session and a task worker cannot become the Lead', async () => {
    const task = (await R.call('POST', '/tasks', { title: 'A task', repo })).body.task;
    const reviewer = await start({ role: 'reviewer', title: 'Review' });
    await talk(reviewer.sessionId);
    for (const id of [reviewer.id, task.owner.terminal]) {
      assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: id })).body.error, 'task');
      assert.strictEqual((await terminal(id)).lead, false);
    }
    assert.strictEqual(saved().sessionId, a.sessionId);
    assert.strictEqual(briefs(await R.screen(reviewer.id)), 0);
    assert.match(fs.readFileSync(path.join(ROOT, 'office', 'terminal.js'), 'utf8'), /async function addReviewer[^}]*role: 'reviewer'/, 'Get a review starts a reviewer');
    await R.call('POST', '/terminals/' + reviewer.id + '/stop', {});
  });
  await t.test('it waits for a turn or a question to end', async () => {
    await hook(b.sessionId, { hook_event_name: 'UserPromptSubmit', title: 'Busy' });
    await R.call('POST', '/terminals/lead', { terminal: b.id });
    await sleep(2500);
    assert.strictEqual(briefs(await R.screen(b.id)), 0, 'not during a turn');
    await hook(b.sessionId, { hook_event_name: 'Notification', message: 'Claude needs your permission' });
    await sleep(2000);
    assert.strictEqual(briefs(await R.screen(b.id)), 0, 'not during a question');
    await hook(b.sessionId, { hook_event_name: 'Stop' });
    await told(b.id, 1);
  });
  await t.test('a new Lead replaces the old one, and nobody who stopped being the Lead is told', async () => {
    const terms = (await R.call('GET', '/terminals')).body.terminals;
    assert.deepStrictEqual(terms.filter((x) => x.lead).map((x) => x.id), [b.id]);
    await hook(a.sessionId, { hook_event_name: 'UserPromptSubmit', title: '' });
    await R.call('POST', '/terminals/lead', { terminal: a.id });
    await sleep(500);
    await R.call('POST', '/terminals/lead', { terminal: b.id });
    await hook(a.sessionId, { hook_event_name: 'Stop' });
    await sleep(2500);
    assert.strictEqual(briefs(await R.screen(a.id)), 1, 'a was busy when it was chosen, and lost the job before it could be told');
    await told(b.id, 2);  // b was chosen again, so it hears the job again
  });
  const fresh = crypto.randomUUID();
  await t.test('/clear wipes the conversation, so it is told again, and the new id is saved', async () => {
    await R.hook({ hook_event_name: 'SessionStart', source: 'clear', session_id: fresh.slice(0, 12), full_session_id: fresh, terminal: b.id });
    await told(b.id, 3);
    await until(() => saved().sessionId === fresh, 'the new id to be saved, with no hook and nobody asking');
    await talk(fresh);
  });
  await t.test('compacting tells it again', async () => {
    await R.hook({ hook_event_name: 'SessionStart', source: 'compact', session_id: fresh.slice(0, 12), full_session_id: fresh, terminal: b.id });
    await told(b.id, 4);
  });
  await t.test('its new title reaches the file', async () => {
    await hook(fresh, { hook_event_name: 'UserPromptSubmit', title: 'Keeping things moving' });
    await hook(fresh, { hook_event_name: 'Stop' });
    assert.strictEqual(saved().title, 'Keeping things moving');
    assert.strictEqual((await terminal(b.id)).work.label, 'The Lead · Keeping things moving');
  });
  await t.test('a session with no conversation can be made the Lead, and the brief starts one', async () => {
    const c = await start();
    await R.call('POST', '/terminals/lead', { terminal: c.id });
    assert.strictEqual(saved().sessionId, fresh, 'nothing to come back to yet');
    await told(c.id, 1);
    await until(() => saved().sessionId === c.sessionId, 'the brief to save it');
    await R.call('POST', '/terminals/lead', { terminal: b.id });
    await hook(fresh, { hook_event_name: 'Stop' });
    assert.strictEqual(saved().sessionId, fresh);
    await R.call('POST', '/terminals/' + c.id + '/stop', {});
  });

  await R.kill();
  R = await relay({ RELAY_WIP_LIMIT: '5' }, home);
  await t.test('Bring back keeps the job and gets the brief', async () => {
    const offered = (await R.call('GET', '/terminals')).body.restore;
    assert.strictEqual(offered.sessionId, fresh);
    const elsewhere = await start();
    const back = await start({ cwd: offered.cwd, resume: offered.sessionId, lead: true });
    assert.strictEqual((await terminal(back.id)).lead, true);
    await hook(fresh, { hook_event_name: 'SessionStart', source: 'resume', full_session_id: fresh, terminal: back.id });
    await told(back.id, 1);
    assert.strictEqual((await terminal(elsewhere.id)).lead, false);
    assert.strictEqual(briefs(await R.screen(elsewhere.id)), 0);
    await hook(fresh, { hook_event_name: 'SessionStart', source: 'resume', full_session_id: fresh, terminal: back.id });
    await sleep(2500);
    assert.strictEqual(briefs(await R.screen(back.id)), 1, 'coming back reports itself, and that is not another brief');
    for (const x of [back, elsewhere]) await R.call('POST', '/terminals/' + x.id + '/stop', {});
    await until(async () => (await R.call('GET', '/terminals')).body.terminals.length === 0, 'them to stop');
  });
  await t.test('a task or a reviewer resuming the Lead\'s id does not take the job', async () => {
    const r = await start({ resume: fresh, role: 'reviewer', lead: true });
    assert.strictEqual((await terminal(r.id)).lead, false);
    await sleep(2500);
    assert.strictEqual(briefs(await R.screen(r.id)), 0);
  });
});

// The brief names ticket.js by its full path, so it grows with the checkout root. A review measured
// 1106 bytes from a root of 183 characters, past the about 1024 bytes Claude Code reads at a time (T-34).
// So a copy of the relay runs from a root of 250 characters, and the whole brief has to arrive.
test('the whole brief arrives from a checkout root of 250 characters', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-test-')));
  let root = path.join(home, 'checkout');
  while (root.length < 250) root = path.join(root, 'x'.repeat(Math.min(60, 249 - root.length)));
  assert.strictEqual(root.length, 250);
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'relay', 'office', 'shared', 'package.json'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(root, f));
  }
  // With merging on it is the longest: past 1024 bytes from here.
  const { leadBrief } = require('../lead-brief.js');
  assert.ok(Buffer.byteLength(leadBrief(path.join(root, 'relay'), { merge: true })) > 1024, 'the brief is long enough to be cut');
  const R = await relay({}, home, { root });
  t.after(R.stop);
  const s = (await R.call('POST', '/terminals', { cwd: makeRepo(home) })).body;
  // The fake sends no hooks, so the test says each turn ended, or the relay would hold the next brief.
  const turn = async () => { for (const hook_event_name of ['UserPromptSubmit', 'Stop']) { await R.hook({ session_id: s.sessionId.slice(0, 12), hook_event_name, title: '' }); await sleep(200); } };
  await turn();
  await R.call('POST', '/terminals/lead', { terminal: s.id });
  await until(async () => briefs(await R.screen(s.id)) === 1, 'the brief');
  await turn();
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: s.id, merge: true })).body.merge, true);
  await until(async () => briefs(await R.screen(s.id)) === 2, 'the brief with merging on');
  const told = (await R.screen(s.id)).split(BRIEF).slice(1);
  for (const brief of told) {
    assert.ok(brief.includes('node ' + JSON.stringify(path.join(root, 'relay', 'ticket.js')) + ' list'), 'it names ticket.js in full');
    assert.ok(brief.includes('report in a few lines.]'), 'the whole brief arrived as one line');
  }
  assert.ok(told[1].includes('no decision is left to the person.'), 'the second has merging on');
});

test('answering No, or using Resume, does not bring back the Lead', async (t) => {
  let R = await relay();
  const home = R.home, repo = makeRepo(home), file = path.join(home, '.office-world', 'lead.json');
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const id = crypto.randomUUID();
  await R.kill();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ t: { sessionId: id, cwd: repo, title: 'Seated by accident', board: true, savedAt: '2026-11-01T00:00:00.000Z' } }));
  R = await relay({}, home);
  await R.call('POST', '/terminals/lead', { asked: true });
  const s = (await R.call('POST', '/terminals', { cwd: repo, resume: id })).body;
  assert.strictEqual(s.lead, false);
  assert.strictEqual(s.board, false);
  await sleep(2500);
  assert.strictEqual(briefs(await R.screen(s.id)), 0);
});

test('the brief is never typed on a guess', async (t) => {
  const R = await relay({ RELAY_READY_LIMIT: '1500' });
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const hook = async (s, event) => { await R.hook({ session_id: s.slice(0, 12), ...event }); await sleep(200); };
  const start = async () => (await R.call('POST', '/terminals', { cwd: repo })).body;
  const term = async (id) => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === id);
  const prompt = { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' };
  const held = async (s) => {  // long past any idea of "it has gone quiet"
    await sleep(3500);
    assert.strictEqual(briefs(await R.screen(s.id)), 0);
    const now = await term(s.id);
    assert.strictEqual(now.owesBrief, true);
    assert.strictEqual(now.briefHeld, true, 'the page can say why');
  };
  const told = (id, n) => until(async () => briefs(await R.screen(id)) === n, n + ' brief(s)');

  for (const [order, tool] of [['a subagent', { agent_id: 'sub-1' }], ['the main thread', {}]]) {
    await t.test('a question, then a PreToolUse from ' + order + ': it stays out, however long the silence', async () => {
      const s = await start();
      await hook(s.sessionId, { hook_event_name: 'UserPromptSubmit', title: '' });
      await hook(s.sessionId, prompt);
      await hook(s.sessionId, { hook_event_name: 'PreToolUse', tool_name: 'Bash', ...tool });
      assert.strictEqual((await term(s.id)).state, 'working', 'the hook has moved the state off waiting, with the question maybe still up');
      await R.call('POST', '/terminals/lead', { terminal: s.id });
      await held(s);
      await hook(s.sessionId, { hook_event_name: 'Stop' });
      await told(s.id, 1);
      await R.call('POST', '/terminals/' + s.id + '/stop', {});
    });
  }
  await t.test('an interrupted turn holds it until the next prompt finishes', async () => {
    const s = await start();
    await hook(s.sessionId, { hook_event_name: 'UserPromptSubmit', title: '' });
    await R.call('POST', '/terminals/lead', { terminal: s.id });
    await held(s);
    // Past the ready limit it is still saved (relay/delivery.js): it never gives up while it is the Lead.
    assert.doesNotMatch(R.output(), /was not briefed/, 'it does not give up');
    await hook(s.sessionId, { hook_event_name: 'UserPromptSubmit', title: '' });
    await held(s);
    await hook(s.sessionId, { hook_event_name: 'Stop' });
    await told(s.id, 1);
    assert.strictEqual((await term(s.id)).briefHeld, false);
    await R.call('POST', '/terminals/' + s.id + '/stop', {});
  });
  await t.test('Esc at a question holds it, compacting does not free it, and /clear does', async () => {
    const s = await start();
    await hook(s.sessionId, { hook_event_name: 'UserPromptSubmit', title: '' });
    await hook(s.sessionId, prompt);
    await R.call('POST', '/terminals/lead', { terminal: s.id });
    await held(s);
    await R.hook({ hook_event_name: 'SessionStart', source: 'compact', session_id: s.sessionId.slice(0, 12), full_session_id: s.sessionId, terminal: s.id });
    await held(s);
    const fresh = crypto.randomUUID();
    await R.hook({ hook_event_name: 'SessionStart', source: 'clear', session_id: fresh.slice(0, 12), full_session_id: fresh, terminal: s.id });
    await told(s.id, 1);
    await R.call('POST', '/terminals/' + s.id + '/stop', {});
  });
  await t.test('with no hook reaching the relay, a session spoken to may be at a question, so it stays out', async () => {
    const s = await start();
    await R.call('POST', '/terminals/' + s.id + '/input', { data: 'do something\r' });
    await R.call('POST', '/terminals/lead', { terminal: s.id });
    await held(s);
    assert.strictEqual((await term(s.id)).hooksSilent, true);
    await hook(s.sessionId, { hook_event_name: 'Stop' });
    await told(s.id, 1);
    await R.call('POST', '/terminals/' + s.id + '/stop', {});
  });
  await t.test('a session nobody has spoken to has nothing open, so it needs no hook', async () => {
    const s = await start();
    await R.call('POST', '/terminals/lead', { terminal: s.id });
    await told(s.id, 1);
  });
});
