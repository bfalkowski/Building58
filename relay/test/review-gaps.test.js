// Three gaps in how review news reaches the Dev (relay/pr-comments.js), left from PR 37: a link told twice,
// a note on the PR still owed when the task is Done, and news saved for a session that Bring back replaced.
// relay/pr-comments.js and relay/delivery.js as they are, with a fake gh and a stand-in for relay/terminal.js
// that holds each typing until the test lets it finish, as in relay/test/review-typing.test.js.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { until } = require('./helpers.js');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-review-gaps-')));
const ghDir = path.join(home, 'gh');
fs.mkdirSync(ghDir);
Object.assign(process.env, {
  RELAY_TASKS_FILE: path.join(home, 'tasks.json'), RELAY_TICKET_HISTORY_FILE: path.join(home, 'ticket-history.json'), RELAY_DELIVERIES_FILE: path.join(home, 'deliveries.json'),
  RELAY_SETTINGS_FILE: path.join(home, 'settings.json'),
  GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_REVIEW_POLL_SECONDS: '0',
});
const PR = 'https://github.com/o/r/pull/7';
const link = (n) => PR + '#issuecomment-' + n;
const dev = (id, sessionId) => ({ id, sessionId, stopped: false });
const task = (id, terminal, sessionId, more) => Object.assign({ id, title: 'Has a PR', state: 'in_review', pr: PR, owner: { terminal, sessionId }, history: [], reviews: { seen: [], own: [], pending: null, owesPost: null, problem: null, watchingSince: new Date().toISOString() } }, more || {});
const owes = (links) => ({ seen: [], own: [], pending: null, owesPost: { links, count: links.length }, problem: null, watchingSince: new Date().toISOString() });
fs.writeFileSync(process.env.RELAY_TASKS_FILE, JSON.stringify({ test: [
  task('aaaaaa', 't1', 'session-one-0000'),
  task('bbbbbb', 't2', 'session-two-0000', { state: 'done', reviews: owes([link(20)]) }),
  task('cccccc', 't3', 'session-three-00', { pr: 'https://github.com/o/r/pull/8', reviews: owes(['https://github.com/o/r/pull/8#issuecomment-30']) }),
  task('dddddd', 't4', 'session-four-000'),
] }));
fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({}));

// t4, the session task dddddd started in, is gone: it is not in the list.
const sessions = [dev('t1', 'session-one-0000')];
const typing = [];
const entered = [];
const fake = {
  all: () => sessions, leadOf: () => null, notSafeToType: (t) => (t ? null : 'ended'), onWork: () => {}, onEnd: () => {}, find: () => null,
  typeIfSafe: (t, text, wanted, done) => typing.push({ t, text, finish: () => { if (!wanted()) { done('dropped'); return; } entered.push({ t, text }); done(null); } }),
};
require.cache[require.resolve('../terminal.js')] = { id: 'terminal', filename: require.resolve('../terminal.js'), loaded: true, exports: fake };
const tasks = require('../tasks.js');
const prComments = require('../pr-comments.js');
test.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const held = (id) => until(() => typing.find((x) => x.t.id === id), 'a typing to ' + id);
const take = (x) => { typing.splice(typing.indexOf(x), 1); x.finish(); };
const posted = () => { try { return fs.readFileSync(path.join(ghDir, 'posted.log'), 'utf8').split('\n---\n').filter(Boolean); } catch (e) { return []; } };
const byId = (id) => tasks.list('test').find((x) => x.id === id);

test('a link told twice counts once, so the count matches the links after the Dev\'s own comment comes out', async () => {
  const t = byId('aaaaaa');
  prComments.tell('test', t, PR, [link(1)]);
  const first = await held('t1');
  prComments.tell('test', t, PR, [link(1), link(2)]);  // link 1 again, as from a second caller
  assert.strictEqual(t.reviews.pending.count, 2, 'two links, two comments');
  assert.deepStrictEqual(t.reviews.pending.links, [link(1), link(2)]);
  prComments.noteHook('test', { hook_event_name: 'PostToolUse', session_id: 'session-one', posted: { url: link(1) } });
  assert.strictEqual(t.reviews.pending.count, 1);
  take(first);
  const second = await held('t1');
  assert.match(second.text, /: 1 new comment, at \S+#issuecomment-2\./);
  take(second);
  await until(() => t.reviews.pending === null, 'the news told');
  assert.ok(t.history.some((h) => /^Told the Dev about 1 new comment\./.test(h.note || '')), JSON.stringify(t.history));
});

test('a note on the PR still owed when the task is Done is posted once, and not kept', async () => {
  const t = byId('bbbbbb');
  await until(() => t.reviews.owesPost === null, 'the note posted');
  const notes = posted().filter((p) => p.includes('#issuecomment-20.'));
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0], /about 1 new comment: https:\/\/github\.com\/o\/r\/pull\/7#issuecomment-20\./);
  assert.ok(t.reviews.own.some((u) => /#issuecomment-\d+$/.test(u)), 'its link is the relay\'s own, so it is never news');
  const saved = JSON.parse(fs.readFileSync(process.env.RELAY_TASKS_FILE, 'utf8')).test.find((x) => x.id === 'bbbbbb');
  assert.strictEqual(saved.reviews.owesPost, null, 'gone from tasks.json');
});

test('a note that cannot be posted when the task is Done is dropped, with a note on the task', async () => {
  // Task cccccc owes a note on PR 8. gh fails, then the task goes to Done, so the relay gives the note up.
  fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ fail: 'HTTP 404: Not Found' }));
  const t = byId('cccccc');
  tasks.setState('test', t, 'done', 'you');
  try {
    await until(() => t.reviews.owesPost === null, 'the owed note dropped');
  } finally { fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({})); }
  assert.ok(t.history.some((h) => /Could not say on the PR that the Dev was told, and the task is done, so the relay stopped trying: HTTP 404/.test(h.note || '')), JSON.stringify(t.history));
  assert.strictEqual(posted().filter((p) => p.includes('pull/8')).length, 0);
});

test('news saved for a session that Bring back replaced goes to the new session', async () => {
  const t = byId('dddddd');
  prComments.tell('test', t, PR, [link(40)]);  // for t4, which is gone, so nothing is typed
  // Bring back starts over when the brief never went in (tasks.js resume), with a new terminal and session id.
  t.owner = { terminal: 't5', sessionId: 'session-five-000' };
  sessions.push(dev('t5', 'session-five-000'));
  const x = await held('t5');
  assert.match(x.text, /1 new comment, at \S+#issuecomment-40\./);
  take(x);
  await until(() => t.reviews.pending === null && t.reviews.owesPost === null && byId('aaaaaa').reviews.owesPost === null, 'the news told, and the notes on the PR');
});
