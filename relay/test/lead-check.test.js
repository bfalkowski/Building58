// The Lead's regular check (relay/lead-check.js): the relay types it into an idle Lead on its own
// timer, only while tasks are worked, and holds at most one for a busy Lead.
'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');

// A real minute is too long for a test, so the variable sets it to 4 seconds, a fifteenth of a minute.
const EVERY = 4000;
const CHECK = 'GOT[Lead check from the relay';
const count = (screen) => screen.split(CHECK).length - 1;

test('Settings shows the Lead check, in the Work group, 5 minutes unless set, and 0 turns it off', async (t) => {
  const R = await relay();
  t.after(() => R.stop());
  const find = async () => (await R.call('GET', '/settings')).body.settings.find((s) => s.name === 'leadCheckMinutes');
  const s = await find();
  assert.strictEqual(s.group, 'Work');
  assert.strictEqual(s.label, 'Lead check every');
  assert.strictEqual(s.unit, 'minutes');
  assert.strictEqual(s.def, 5);
  assert.strictEqual(s.min, 0);
  assert.strictEqual(s.env, 'RELAY_LEAD_CHECK_MS');
  assert.strictEqual((await R.call('POST', '/settings', { values: { leadCheckMinutes: 1 } })).status, 200);
  assert.strictEqual((await find()).value, 1);
  assert.strictEqual((await R.call('POST', '/settings', { values: { leadCheckMinutes: 0 } })).status, 200);
  assert.strictEqual((await find()).value, 0);
  assert.strictEqual((await R.call('POST', '/settings', { values: { leadCheckMinutes: -1 } })).status, 400);
});

test('the Lead gets the check on the relay\'s timer while a task is worked', async (t) => {
  const R = await relay({ RELAY_LEAD_CHECK_MS: String(EVERY) });
  t.after(() => R.stop());
  const repo = makeRepo(R.home);
  const sid = (x) => x.sessionId.slice(0, 12);
  const typed = async () => R.screen(lead.id);
  const saved = () => { try { return (JSON.parse(fs.readFileSync(path.join(R.home, '.office-world', 'deliveries.json'), 'utf8')).t || []).filter((d) => d.key === 'lead-check'); } catch (e) { return []; } };

  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid(lead) });
  await until(async () => (await R.call('POST', '/terminals/lead', { terminal: lead.id })).status === 200, 'the Lead to be made');
  await R.hook({ hook_event_name: 'Stop', session_id: sid(lead) });
  await until(async () => (await typed()).includes('GOT[You are the Lead'), 'the Lead\'s brief');

  await t.test('with no task worked, it gets no check', async () => {
    await sleep(EVERY * 2.5);
    assert.strictEqual(count(await typed()), 0);
    assert.strictEqual(saved().length, 0);
  });

  const task = (await R.call('POST', '/tasks', { title: 'Build a thing', repo })).body.task;
  assert.strictEqual(task.state, 'building');

  await t.test('with one building task, an idle Lead gets about one check each interval', async () => {
    await until(async () => count(await typed()) >= 1, 'the first check', 150);
    const from = count(await typed());
    await sleep(EVERY * 3);
    const got = count(await typed()) - from;
    assert.ok(got >= 2 && got <= 4, 'about 3 checks in 3 intervals, got ' + got);
    const screen = await typed();
    assert.match(screen, /relay's timer at \d\d:\d\d\. This grants nothing/);
    assert.match(screen, /Do not make your own scheduled check/);
  });

  await t.test('a busy Lead gets none until it is idle, then one, not several', async () => {
    await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: sid(lead) });
    await sleep(EVERY);  // anything typed just before the turn began shows by now
    const before = count(await typed());
    await sleep(EVERY * 3);
    assert.strictEqual(count(await typed()), before, 'nothing typed into a busy Lead');
    assert.strictEqual(saved().length, 1, 'one check waits, the later ones were dropped');
    await R.hook({ hook_event_name: 'Stop', session_id: sid(lead) });
    await until(async () => count(await typed()) === before + 1, 'the waiting check to go in');
    await until(() => saved().length === 0, 'the file to let it go');
    await sleep(1000);
    assert.strictEqual(count(await typed()), before + 1, 'one check, not several');
  });

  await t.test('it survives a /clear: the new conversation gets its brief, then checks', async () => {
    const was = count(await typed());
    const briefs = (await typed()).split('GOT[You are the Lead').length;
    await R.hook({ hook_event_name: 'SessionStart', session_id: 'b2c3d4e5f6a7', full_session_id: 'b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6', terminal: lead.id, source: 'clear' });
    await until(async () => (await typed()).split('GOT[You are the Lead').length > briefs, 'the brief after /clear');
    await until(async () => count(await typed()) > was, 'a check after /clear', 150);
  });

  await t.test('with every task done, it gets no check, and one still waiting is taken back', async () => {
    await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'b2c3d4e5-f6a' });
    await until(() => saved().length === 1, 'a check to wait for the busy Lead', 150);
    const typedBefore = count(await typed());
    // An hour between ticks, so only the move itself can take the waiting check back.
    assert.strictEqual((await R.call('POST', '/settings', { values: { leadCheckMinutes: 60 } })).status, 200);
    assert.strictEqual(saved().length, 1, 'a longer interval keeps the check that waits');
    assert.strictEqual((await R.call('POST', '/tasks/' + task.id + '/move', { to: 'done' })).status, 200);
    await until(() => saved().length === 0, 'the waiting check to be taken back at once', 20);
    assert.strictEqual(count(await typed()), typedBefore, 'taken back, not typed');
    await R.call('POST', '/settings', { reset: ['leadCheckMinutes'] });
    await R.hook({ hook_event_name: 'Stop', session_id: 'b2c3d4e5-f6a' });
    const before = count(await typed());
    await sleep(EVERY * 2.5);
    assert.strictEqual(count(await typed()), before);
    assert.strictEqual(saved().length, 0);
  });
});

test('a check left waiting by the last relay is taken back at startup when it is off', async (t) => {
  const R = await relay({ RELAY_LEAD_CHECK_MS: String(EVERY) });
  const repo = makeRepo(R.home);
  const file = path.join(R.home, '.office-world', 'deliveries.json');
  const saved = () => { try { return (JSON.parse(fs.readFileSync(file, 'utf8')).t || []).filter((d) => d.key === 'lead-check'); } catch (e) { return []; } };
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12) });
  await until(async () => (await R.call('POST', '/terminals/lead', { terminal: lead.id })).status === 200, 'the Lead to be made');
  await R.call('POST', '/tasks', { title: 'Build a thing', repo });
  await until(() => saved().length === 1, 'a check to wait for the busy Lead', 150);
  await R.kill();
  assert.strictEqual(saved().length, 1, 'the check is kept through the restart');
  const again = await relay({ RELAY_LEAD_CHECK_MS: '0' }, R.home);
  t.after(async () => { await again.kill(); await again.remove(); });
  await until(() => saved().length === 0, 'the new relay to take it back', 50);
});

test('the prompt says a part of a minute in seconds', () => {
  const { spawnSync } = require('child_process');
  const say = (ms) => spawnSync(process.execPath, ['-e', 'process.stdout.write(require("./relay/lead-check.js").every())'],
    { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, RELAY_LEAD_CHECK_MS: ms, RELAY_SETTINGS_FILE: path.join(require('os').tmpdir(), 'none-' + process.pid + '.json') }, encoding: 'utf8' }).stdout;
  assert.strictEqual(say('4000'), '4 seconds');
  assert.strictEqual(say('60000'), '1 minute');
  assert.strictEqual(say('90000'), '1.5 minutes');
  assert.strictEqual(say('300000'), '5 minutes');
});
