'use strict';
// A saved message that cannot go in because the session's screen shows no prompt, on a real relay with the fake
// claude: Needs you names it, and the relay makes the session draw its screen again, so the message goes in.
// FAKE_CLAUDE_NO_PROMPT stands in for a session the relay took back after a restart with only status-line
// output kept: it draws its prompt only when its terminal is resized, as an idle Claude Code does.
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until } = require('./helpers.js');

const POINTER = /GOT\[[^\]a-z]{0,8}The room chat board has/;

test('a saved message for a session with no prompt on its screen', async (t) => {
  const R = await relay({ FAKE_CLAUDE_NO_PROMPT: '1', RELAY_UNDELIVERED_MS: '1000', RELAY_REDRAW_AFTER_MS: '6000' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const repo = makeRepo(R.home);
  const s = await R.start({ cwd: repo });
  const who = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === s.id).who;
  const undelivered = async () => (await R.call('GET', '/needs-you')).body.items.filter((i) => i.kind === 'undelivered');

  await until(async () => (await R.screen(s.id)).includes('fake claude'), 'the session to start');
  const r = await R.call('POST', '/chat/office', { text: '@' + who + ' have a look' });
  assert.strictEqual(r.body.post.mention, who);

  await t.test('Needs you names it, with the reason the relay has', async () => {
    const item = await until(async () => (await undelivered()).find((i) => /no prompt/.test(i.line)), 'an undelivered item, once the screen settles');
    assert.strictEqual(item.terminal, s.id);
    assert.deepStrictEqual(item.link, { terminal: s.id });
    assert.match(item.line, new RegExp('^Open the session of ' + who + ': a message from the relay has waited 1 minute for it and is not typed in, because its screen shows no prompt\\.$'));
    assert.doesNotMatch(await R.screen(s.id), /REDRAWN/, 'no redraw before RELAY_REDRAW_AFTER_MS');
  });

  await t.test('the relay makes the session draw its screen again, and the message goes in', async () => {
    await until(async () => POINTER.test(await R.screen(s.id)), 'the message typed in');
    assert.strictEqual((await R.screen(s.id)).match(/REDRAWN/g).length, 2, 'one column wider, then back: two resizes, once');
    assert.deepStrictEqual(await undelivered(), [], 'the item goes once the message is in');
  });
});
