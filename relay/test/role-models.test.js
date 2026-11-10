// Each role's model, set in Settings (relay/config.js, relay/skills.js): a new session for that role
// starts with --model, a plain session and a resumed one never do. The fake claude prints the command
// it was given, so the test reads it off the screen.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until } = require('./helpers.js');

// The line after the command is printed, so the command is whole.
const started = async (R, id) => until(async () => { const s = await R.screen(id); return s.includes('child session:') && s.match(/fake claude [^\r\n]*/)[0] + ' '; }, 'the command');
const terminals = async (R) => (await R.call('GET', '/terminals')).body.terminals;

test('a bad model is refused, and changes nothing', async (t) => {
  const R = await relay({});
  t.after(() => R.stop());
  for (const bad of ['-x', '--dangerously-skip-permissions', 'opus sonnet', 'a;b', 'm'.repeat(65), 5]) {
    const r = await R.call('POST', '/settings', { values: { pmModel: bad } });
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
    assert.strictEqual(r.body.error, 'bad_value');
  }
  const ok = await R.call('POST', '/settings', { values: { pmModel: 'claude-opus-4-6[1m]', leadModel: '' } });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  const pm = ok.body.settings.find((s) => s.name === 'pmModel');
  assert.deepStrictEqual([pm.value, pm.from, pm.kind, pm.group], ['claude-opus-4-6[1m]', 'page', 'text', 'Models and skills']);
  // Every model starts empty, so nothing changes until the person sets one.
  const r = await R.call('POST', '/settings', { reset: ['pmModel'] });
  for (const role of ['lead', 'dev', 'reviewer', 'pm', 'coo']) assert.strictEqual(r.body.settings.find((s) => s.name === role + 'Model').value, '', role);
});

test('a new PM and a new Dev start on their model, and a plain session on none', async (t) => {
  const R = await relay({ RELAY_WIP_LIMIT: '5' });
  t.after(() => R.stop());
  const repo = makeRepo(R.home);
  assert.strictEqual((await R.call('POST', '/settings', { values: { pmModel: 'sonnet', devModel: 'opus', leadModel: 'haiku', reviewerModel: 'haiku', cooModel: 'haiku' } })).status, 200);

  const pm = await R.call('POST', '/tickets/ask', { idea: 'A radio', repo });
  assert.strictEqual(pm.status, 201, JSON.stringify(pm.body));
  assert.match(await started(R, pm.body.terminal), / --model sonnet /);

  const task = (await R.call('POST', '/tasks', { title: 'Build it', repo })).body.task;
  assert.match(await started(R, task.owner.terminal), / --model opus /);

  const plain = (await R.call('POST', '/terminals', { cwd: repo })).body;
  assert.doesNotMatch(await started(R, plain.id), /--model/, 'a session with no role runs on the person\'s default');
});

// A session the relay brings back after a stop: one with a conversation resumes, one without starts anew.
async function broughtBack(t, settings, list) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
  const repo = makeRepo(home);
  fs.mkdirSync(path.join(home, '.office-world'), { recursive: true });
  fs.writeFileSync(path.join(home, '.office-world', 'settings.json'), JSON.stringify(settings));
  fs.writeFileSync(path.join(home, '.office-world', 'sessions.json'), JSON.stringify({ t: list.map((s) => Object.assign({ cwd: repo, cols: 100, rows: 30 }, s)) }));
  const R = await relay({ RELAY_RESUME: '1' }, home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  await until(async () => (await terminals(R)).length === list.length, 'every session back');
  return R;
}
const LEAD = '11111111-2222-4333-8444-555555555551', PM = '11111111-2222-4333-8444-555555555552', REVIEWER = '11111111-2222-4333-8444-555555555553';

test('a session brought back with its conversation keeps its model, and the Lead gets one only when it starts anew', async (t) => {
  const R = await broughtBack(t, { pmModel: 'sonnet', reviewerModel: 'opus' }, [
    { sessionId: LEAD, talked: false, lead: true },
    { sessionId: PM, talked: true, role: 'pm', title: 'PM: an idea' },
    { sessionId: REVIEWER, talked: false, role: 'reviewer', title: 'Review PR #7', pr: 'https://github.com/o/r/pull/7', reviewOf: 'https://github.com/o/r/pull/7' }
  ]);
  const all = await terminals(R);
  const lead = all.find((x) => x.lead), pm = all.find((x) => x.role === 'pm'), reviewer = all.find((x) => x.role === 'reviewer');
  assert.ok(lead, 'the Lead came back as the Lead');
  const leadCmd = await started(R, lead.id);
  assert.match(leadCmd, /--session-id /, 'it had no conversation, so it starts anew');
  assert.doesNotMatch(leadCmd, /--model/, 'no Lead model is set');
  const pmCmd = await started(R, pm.id);
  assert.match(pmCmd, new RegExp('--resume ' + PM));
  assert.doesNotMatch(pmCmd, /--model/, 'a resumed session keeps the model it had, even with the PM model set');
  assert.match(await started(R, reviewer.id), / --model opus /, 'a reviewer that starts anew gets the reviewer model');
});

test('a Lead the relay starts anew gets the Lead model', async (t) => {
  const R = await broughtBack(t, { leadModel: 'haiku' }, [{ sessionId: LEAD, talked: false, lead: true }]);
  const lead = (await terminals(R)).find((x) => x.lead);
  assert.ok(lead, 'the Lead came back as the Lead');
  assert.match(await started(R, lead.id), / --model haiku /);
});
