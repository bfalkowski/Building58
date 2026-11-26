'use strict';
// Claude Code's own prompts (relay/known-prompts.js) on a real relay with the fake claude: the room answers a
// known prompt with its safe choice, logs a news-behind-menu jam, and delivers the message held behind it. A
// menu it does not know is never answered: it shows in Needs you, with its words, once it has been open
// RELAY_MENU_WAIT_MS (5 minutes by default). Seen on 2026-11-25: four Devs sat for an hour behind
// "Teach auto mode about your environment?", and nobody could see why.
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');
const known = require('../known-prompts.js');

const POINTER = /GOT\[[^\]a-z]{0,8}The room chat board has/;
const SCREEN = 'Teachautomodeaboutyourenvironment?❯1.Yes2.Notnow3.Don\'tshowagain';

test('a known prompt is found by its text, and the last one on screen wins', () => {
  assert.strictEqual(known.identify(SCREEN).id, 'auto-mode-environment');
  assert.strictEqual(known.identify(SCREEN).keys[0], '3', 'Don\'t show again, never Yes');
  assert.strictEqual(known.identify('HowisClaudedoingthissession?(optional)1:Bad2:Fine3:Good0:Dismiss').keys[0], '0');
  assert.strictEqual(known.identify(SCREEN + 'HowisClaudedoingthissession?').id, 'feedback-survey');
  assert.strictEqual(known.identify('Whichdatabaseshouldwemigratefirst?❯1.Orders2.Customers'), null);
  for (const k of known.KNOWN) assert.ok(!k.keys.includes('1') && !k.keys.includes('\r'), k.id + ' never picks the first choice or presses Enter');
});

test('the words and choices of a menu are read from the text of a screen', () => {
  const tail = 'old output\r\nWhich database first?\r\n\u276f 1. Orders\r\n  2. Customers\r\n  3. Both\r\nEnter to confirm \u00b7 Esc to cancel';
  assert.deepStrictEqual(known.menuText(tail), { text: 'Which database first?', choices: ['1. Orders', '2. Customers', '3. Both'] });
  assert.deepStrictEqual(known.menuText('Overwrite it?\r\nEnter to confirm').choices, []);
});

test('Claude Code\'s own prompt is answered, a jam is logged, and the held news goes in', async (t) => {
  const R = await relay({ FAKE_CLAUDE_MENU: 'known' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const s = await R.start({ cwd: makeRepo(R.home) });
  const who = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === s.id).who;
  await until(async () => (await R.screen(s.id)).includes('Teach auto mode'), 'the prompt on screen');
  const r = await R.call('POST', '/chat/office', { text: '@' + who + ' have a look' });
  assert.strictEqual(r.body.post.mention, who);
  assert.doesNotMatch(await R.screen(s.id), /GOT\[/, 'nothing typed behind the menu');
  await until(async () => (await R.screen(s.id)).includes('MENU-ANSWER[3]'), 'the safe choice');
  await until(async () => POINTER.test(await R.screen(s.id)), 'the held message typed in');
  const jams = (await R.call('GET', '/jams')).body.jams.filter((j) => j.kind === 'news-behind-menu');
  assert.strictEqual(jams.length, 1);
  assert.strictEqual(jams[0].by, 'the relay');
  assert.match(jams[0].fix, /Teach auto mode about your environment\?.*Don't show again/);
});

test('a menu the room does not know is not answered, and shows in Needs you with its words after the wait', async (t) => {
  const R = await relay({ FAKE_CLAUDE_MENU: 'unknown', RELAY_MENU_WAIT_MS: '4000' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const s = await R.start({ cwd: makeRepo(R.home) });
  const who = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === s.id).who;
  const items = async () => (await R.call('GET', '/needs-you')).body.items.filter((i) => i.kind === 'question');
  await until(async () => (await R.screen(s.id)).includes('Which database'), 'the menu on screen');
  await R.call('POST', '/chat/office', { text: '@' + who + ' have a look' });
  await sleep(2500);
  assert.deepStrictEqual(await items(), [], 'not yet: a menu may be closed in a moment');
  const item = await until(async () => (await items())[0], 'the menu in Needs you');
  assert.strictEqual(item.terminal, s.id);
  assert.match(item.line, /^Answer the question on the screen of .+: Which database should the Dev migrate first\? Choices: 1\. Orders \| 2\. Customers \| 3\. Both$/);
  const screen = await R.screen(s.id);
  assert.doesNotMatch(screen, /MENU-ANSWER|GOT\[/, 'no key sent, nothing typed');
  const row = (await R.call('GET', '/floor')).body.sessions.find((x) => x.terminal === s.id);
  assert.strictEqual(row.menu.text, 'Which database should the Dev migrate first?');
  assert.deepStrictEqual(row.menu.choices, ['1. Orders', '2. Customers', '3. Both']);
  assert.strictEqual((await R.call('GET', '/jams')).body.jams.filter((j) => j.kind === 'news-behind-menu').length, 0, 'no jam for a menu the room did not close');
});
