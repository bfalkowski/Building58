// News that arrives while the relay is typing older news to the Dev: relay/pr-comments.js and
// relay/delivery.js as they are, with a stand-in for relay/terminal.js that holds each typing until
// the test lets it finish. A typing finishes the way terminal.typeIfSafe does: Enter only if the
// delivery is still wanted, otherwise the text is taken back out.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { sleep, until } = require('./helpers.js');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-review-typing-')));
const ghDir = path.join(home, 'gh');
fs.mkdirSync(ghDir);
Object.assign(process.env, {
  RELAY_TASKS_FILE: path.join(home, 'tasks.json'), RELAY_TICKET_HISTORY_FILE: path.join(home, 'ticket-history.json'), RELAY_DELIVERIES_FILE: path.join(home, 'deliveries.json'),
  RELAY_SETTINGS_FILE: path.join(home, 'settings.json'),  // not the person's: a value set on their page would win over these
  GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_REVIEW_POLL_SECONDS: '0',
});
const PR = 'https://github.com/o/r/pull/7';
const link = (n) => PR + '#issuecomment-' + n;
const dev = (id, sessionId) => ({ id, sessionId, stopped: false });
const task = (id, terminal, sessionId) => ({ id, title: 'Has a PR', state: 'in_review', pr: PR, owner: { terminal, sessionId }, history: [], reviews: { seen: [], own: [], pending: null, owesPost: null, problem: null, watchingSince: new Date().toISOString() } });
fs.writeFileSync(process.env.RELAY_TASKS_FILE, JSON.stringify({ test: [task('aaaaaa', 't1', 'session-one-0000'), task('bbbbbb', 't2', 'session-two-0000')] }));

const sessions = [dev('t1', 'session-one-0000'), dev('t2', 'session-two-0000')];
const typing = [];     // { t, text, finish } held until the test calls finish
const entered = [];    // { t, text } that the Dev got: Enter was pressed on them
const fake = {
  all: () => sessions, leadOf: () => null, notSafeToType: (t) => (t ? null : 'ended'), onWork: () => {}, onEnd: () => {}, find: () => null,
  typeIfSafe: (t, text, wanted, done) => typing.push({ t, text, finish: () => { if (!wanted()) { done('dropped'); return; } entered.push({ t, text }); done(null); } }),
};
require.cache[require.resolve('../terminal.js')] = { id: 'terminal', filename: require.resolve('../terminal.js'), loaded: true, exports: fake };
const tasks = require('../tasks.js');
const prComments = require('../pr-comments.js');
// A gh call still running when the tests end can write calls.log as the folder goes, so removing it tries again.
test.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const held = (id) => until(() => typing.find((x) => x.t.id === id), 'a typing to ' + id);
const take = (x) => { typing.splice(typing.indexOf(x), 1); x.finish(); };
const count = (id, l) => entered.filter((e) => e.t.id === id).reduce((n, e) => n + e.text.split(l).length - 1, 0);

test('news that comes while older news is being typed reaches the Dev with each link once', async () => {
  const t = tasks.list('test').find((x) => x.id === 'aaaaaa');
  prComments.tell('test', t, PR, [link(1)]);
  const first = await held('t1');
  assert.match(first.text, /1 new comment, at .*#issuecomment-1\./);
  prComments.tell('test', t, PR, [link(2)]);  // while the first is typed, before its Enter
  take(first);                                // it is no longer wanted, so it is taken back out
  const second = await held('t1');
  assert.match(second.text, /2 new comments, at .*#issuecomment-1 .*#issuecomment-2\./);
  take(second);
  await sleep(1500);  // three more passes of the delivery pump
  assert.strictEqual(typing.filter((x) => x.t.id === 't1').length, 0, 'nothing more is typed');
  assert.strictEqual(entered.filter((e) => e.t.id === 't1').length, 1, 'one message');
  assert.strictEqual(count('t1', link(1)), 1);
  assert.strictEqual(count('t1', link(2)), 1);
  assert.strictEqual(t.reviews.pending, null);
  assert.strictEqual(t.state, 'changes_requested');
});

test('the Dev\'s own comment, reported while news is being typed, is taken out of it', async () => {
  const t = tasks.list('test').find((x) => x.id === 'bbbbbb');
  prComments.tell('test', t, PR, [link(3), link(4)]);
  const first = await held('t2');
  assert.match(first.text, /2 new comments, at .*#issuecomment-3 .*#issuecomment-4\./, 'the hook comes while this is typed');
  prComments.noteHook('test', { hook_event_name: 'PostToolUse', session_id: 'session-two', posted: { url: link(4) } });
  take(first);
  const second = await held('t2');
  take(second);
  await sleep(1500);
  assert.strictEqual(entered.filter((e) => e.t.id === 't2').length, 1, 'one message');
  assert.strictEqual(count('t2', link(3)), 1);
  assert.strictEqual(count('t2', link(4)), 0);
});
