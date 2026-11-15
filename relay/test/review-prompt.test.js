'use strict';
// Get a review on a session with no PR starts a reviewer in that session's folder (T-278). The page
// used to wait 5 seconds, type the brief, wait 300 ms and press Enter. A claude that took longer to
// start lost the brief. Now the page sends the brief with the start, and the relay types it once the
// session shows its prompt (delivery.promptOnce in relay/delivery.js), as for a review of a PR.
// The fake claude here takes 3 seconds to draw its prompt and says EARLY[...] for keys typed before.
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until } = require('./helpers.js');

const BRIEF = 'Review the work in this folder for T-278.';

test('a reviewer started with a prompt gets it once claude is ready, however slow it starts', async (t) => {
  const R = await relay({ FAKE_CLAUDE_SLOW_START: '3' }), repo = makeRepo(R.home);
  t.after(R.stop);
  const r = await R.call('POST', '/terminals', { cwd: repo, title: 'Review', role: 'reviewer', prompt: BRIEF });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const reviewer = r.body;
  await until(async () => (await R.screen(reviewer.id)).includes('GOT[' + BRIEF + ']'), 'the brief typed and sent', 200);
  const screen = await R.screen(reviewer.id);
  assert.ok(!screen.includes('EARLY['), 'nothing typed before claude was ready: ' + screen);
  assert.strictEqual(screen.split('GOT[' + BRIEF + ']').length - 1, 1, 'typed once');
  // It is in once a hook says a turn began, as for every first prompt.
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: reviewer.sessionId.slice(0, 12) });
  const row = await until(async () => (await R.call('GET', '/floor')).body.sessions.find((x) => x.terminal === reviewer.id && /^working/.test(x.state)), 'its turn to begin');
  assert.strictEqual(row.stuck, null);
});

test('a start with a prompt that is too long is refused, and starts nothing', async (t) => {
  const R = await relay({}), repo = makeRepo(R.home);
  t.after(R.stop);
  const r = await R.call('POST', '/terminals', { cwd: repo, role: 'reviewer', prompt: 'x'.repeat(8001) });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'bad_prompt');
  assert.deepStrictEqual((await R.call('GET', '/terminals')).body.terminals, []);
});
