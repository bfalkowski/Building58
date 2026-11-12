// The title you give a session with /rename shows beside its person's name (docs/manual/how-it-works.html#named).
// The hook reads it from the transcript and sends it as customTitle. The relay keeps it for each session
// it runs, whatever its job, saves it with the session, and sends it with the session in GET /terminals.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');

const HOOK = path.join(__dirname, '..', 'office-hook.js');
const line = (r) => JSON.stringify(r) + '\n';
function transcript(...records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-title-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, line({ type: 'user', message: { content: 'hi' } }) + records.map(line).join(''));
  return file;
}
// summarize in a fresh node, since OFFICE_SHOW_TITLES is read once, as the hook loads.
function summarize(file, env) {
  const code = 'process.stdout.write(JSON.stringify(require(' + JSON.stringify(HOOK) + ').summarize({ hook_event_name: "Stop", session_id: "s", transcript_path: ' + JSON.stringify(file) + ' })))';
  return JSON.parse(execFileSync(process.execPath, ['-e', code], { env: { ...process.env, ...(env || {}) }, encoding: 'utf8' }));
}

test('the hook sends the /rename title as customTitle, and title as before', () => {
  const ai = { type: 'ai-title', aiTitle: 'Fix the login page', sessionId: 's' };
  const mine = { type: 'custom-title', customTitle: 'my   title', sessionId: 's' };
  assert.deepStrictEqual([summarize(transcript(ai, mine)).title, summarize(transcript(ai, mine)).customTitle], ['my title', 'my title']);
  // Claude Code's own title is no customTitle.
  const own = summarize(transcript(ai));
  assert.strictEqual(own.title, 'Fix the login page');
  assert.ok(!('customTitle' in own), JSON.stringify(own));
  // The newest record wins, and one with no title says it was taken away.
  assert.strictEqual(summarize(transcript(mine, { type: 'custom-title', customTitle: 'newer', sessionId: 's' })).customTitle, 'newer');
  assert.strictEqual(summarize(transcript(mine, { type: 'custom-title', customTitle: '', sessionId: 's' })).customTitle, '');
  // At most 60 characters, like title.
  assert.strictEqual(summarize(transcript({ type: 'custom-title', customTitle: 'x'.repeat(90) })).customTitle, 'x'.repeat(60));
});

test('OFFICE_SHOW_TITLES=0 keeps customTitle back too', () => {
  const out = summarize(transcript({ type: 'custom-title', customTitle: 'my title' }), { OFFICE_SHOW_TITLES: '0' });
  assert.ok(!('customTitle' in out) && !('title' in out), JSON.stringify(out));
});

const RESUME = { RELAY_RESUME: '1', RELAY_WIP_LIMIT: '5' };
const terminals = async (R) => (await R.call('GET', '/terminals')).body.terminals;
const named = async (R, id) => (await terminals(R)).find((x) => x.id === id).customTitle;
const hook = (R, sid, ev, extra) => R.hook(Object.assign({ hook_event_name: ev, session_id: sid.slice(0, 12) }, extra));

test('the relay keeps each session\'s customTitle, sends it, and brings it back after a restart', async (t) => {
  let R = await relay(RESUME);
  const home = R.home, repo = makeRepo(home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const plain = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const pm = (await R.call('POST', '/terminals', { cwd: repo, role: 'pm', title: 'PM: a radio' })).body;
  const reviewer = (await R.call('POST', '/terminals', { cwd: repo, role: 'reviewer', pr: 'https://github.com/o/r/pull/3', title: 'Review' })).body;
  const task = (await R.call('POST', '/tasks', { title: 'Add a radio', repo })).body.task;
  const worker = { id: task.owner.terminal, sessionId: task.owner.sessionId };
  await until(async () => (await R.screen(worker.id)).includes('GOT['), 'the task brief');
  for (const s of [plain, pm, reviewer, worker]) await hook(R, s.sessionId, 'UserPromptSubmit');
  await sleep(200);
  assert.strictEqual(await named(R, plain.id), null, 'no title until one is set');

  await hook(R, plain.sessionId, 'Stop', { title: 'Claude wrote this' });
  await sleep(150);
  assert.strictEqual(await named(R, plain.id), null, 'Claude Code\'s own title is not the person\'s');
  await hook(R, plain.sessionId, 'Stop', { title: 'my title', customTitle: 'my title' });
  await hook(R, pm.sessionId, 'Stop', { title: 'pm things', customTitle: 'pm things' });
  await hook(R, reviewer.sessionId, 'Stop', { customTitle: 'checking <b>PR 3</b>' });
  await hook(R, worker.sessionId, 'Stop', { title: 'radio', customTitle: 'radio work' });
  await until(async () => (await named(R, reviewer.id)) === 'checking <b>PR 3</b>', 'the reviewer\'s title');
  assert.strictEqual(await named(R, plain.id), 'my title');
  const p = (await terminals(R)).find((x) => x.id === pm.id);
  assert.deepStrictEqual([p.customTitle, p.title], ['pm things', 'PM: a radio'], 'the PM keeps its own title');
  assert.strictEqual(await named(R, worker.id), 'radio work', 'a task\'s worker too');

  await t.test('it survives a restart', async () => {
    // A worker whose brief is not marked delivered yet starts over after a restart, with a new session
    // (relay/tasks.js resume). Wait for the mark, so the worker comes back in its own conversation.
    await until(async () => (await R.call('GET', '/tasks')).body.tasks.find((x) => x.id === task.id).briefed === true, 'the brief marked delivered');
    await R.kill();
    R = await relay(RESUME, home);
    // Each session is on the list before its restore has finished, so wait for all four by their session ids.
    const ids = [plain, pm, reviewer, worker].map((s) => s.sessionId);
    const back = await until(async () => { const l = await terminals(R); return ids.every((id) => l.some((x) => x.sessionId === id)) && l; }, 'all four sessions back');
    const of = (s) => back.find((x) => x.sessionId === s.sessionId).customTitle;
    assert.deepStrictEqual([of(plain), of(pm), of(reviewer), of(worker)], ['my title', 'pm things', 'checking <b>PR 3</b>', 'radio work']);
  });
  await t.test('an empty customTitle takes it away, and none leaves it', async () => {
    const id = (await terminals(R)).find((x) => x.sessionId === plain.sessionId).id;
    await hook(R, plain.sessionId, 'Stop', {});
    await sleep(150);
    assert.strictEqual(await named(R, id), 'my title');
    await hook(R, plain.sessionId, 'Stop', { customTitle: '' });
    await until(async () => (await named(R, id)) === null, 'the title to go');
  });
});
