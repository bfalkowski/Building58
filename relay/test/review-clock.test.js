// When review news is from before the room watched a PR (relay/pr-comments.js), and who marks a card as
// moved back by the relay (relay/tasks.js moveBack). GitHub gives times in whole seconds on its own clock,
// and the watch starts on this computer's clock, with milliseconds. relay/pr-comments.js and relay/tasks.js
// as they are, with a fake gh and a stand-in for relay/terminal.js, and each check run by the test, so
// nothing here depends on how fast the machine is.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-review-clock-')));
const ghDir = path.join(home, 'gh');
fs.mkdirSync(ghDir);
Object.assign(process.env, {
  RELAY_TASKS_FILE: path.join(home, 'tasks.json'), RELAY_TICKET_HISTORY_FILE: path.join(home, 'ticket-history.json'), RELAY_DELIVERIES_FILE: path.join(home, 'deliveries.json'),
  RELAY_SETTINGS_FILE: path.join(home, 'settings.json'),
  GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_REVIEW_POLL_SECONDS: '0',
});
const pr = (n) => 'https://github.com/o/r/pull/' + n;
const fresh = (since) => ({ seen: [], own: [], pending: null, owesPost: null, problem: null, watchingSince: since });
const task = (id, n, more) => Object.assign({ id, title: 'Has a PR', state: 'in_review', pr: pr(n), owner: { terminal: 't-' + id, sessionId: 'session-' + id }, history: [] }, more || {});
// The watch began at 10:00:00.700 on this computer, as when the Dev's hook gave the task its PR.
const HOOK = '2026-11-03T10:00:00.700Z';
fs.writeFileSync(process.env.RELAY_TASKS_FILE, JSON.stringify({ test: [
  task('aaaaaa', 11, { reviews: fresh(HOOK) }),  // a review in the same second as the hook
  task('bbbbbb', 12, { reviews: fresh(HOOK) }),  // this Mac's clock runs 5 seconds fast
  task('cccccc', 13, { reviews: fresh(HOOK) }),  // a review from an hour before the hook, on a PR the Dev adopted
  task('dddddd', 14),                            // recorded before review news, so no reviews at all
  task('eeeeee', 15, { state: 'building' }),
  task('ffffff', 16),
  task('gggggg', 17, { pr: null }),               // its PR comes from the hook in the test
] }));
const comment = (n, id, at) => ({ id, html_url: pr(n) + '#issuecomment-' + id, body: 'Finding.', created_at: at });
const review = (n, id, at) => ({ id, html_url: pr(n) + '#pullrequestreview-' + id, body: 'Please fix.', state: 'CHANGES_REQUESTED', submitted_at: at });
const api = {
  'repos/o/r/issues/11/comments': [comment(11, 1101, '2026-11-03T10:00:00Z')],
  'repos/o/r/pulls/12/reviews': [review(12, 1201, '2026-11-03T09:59:56Z')],
  'repos/o/r/issues/13/comments': [comment(13, 1301, '2026-11-03T09:00:00Z')],
  'repos/o/r/issues/14/comments': [comment(14, 1401, '2020-01-01T00:00:00Z')],
  'repos/o/r/issues/17/comments': [comment(17, 1701, '2026-11-03T11:00:01Z')],
};
fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ api }));

const fake = {
  all: () => [], leadOf: () => null, notSafeToType: () => 'ended', onWork: () => {}, onEnd: () => {}, find: () => null, typeIfSafe: () => {},
};
require.cache[require.resolve('../terminal.js')] = { id: 'terminal', filename: require.resolve('../terminal.js'), loaded: true, exports: fake };
const tasks = require('../tasks.js');
const prComments = require('../pr-comments.js');
test.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const byId = (id) => tasks.list('test').find((x) => x.id === id);

test('review times from GitHub against the start of the watch', async (t) => {
  const started = Date.now();
  await prComments.poll();
  await t.test('a comment in the same whole second as the hook is new', () => {
    assert.strictEqual(byId('aaaaaa').reviews.pending.before, false, 'it moves the card');
  });
  await t.test('a review stamped seconds before the hook, by a clock that runs fast here, is new', () => {
    assert.strictEqual(byId('bbbbbb').reviews.pending.before, false, 'it moves the card');
  });
  await t.test('a comment from well before the hook is from before the watch', () => {
    assert.strictEqual(byId('cccccc').reviews.pending.before, true, 'it moves no card');
  });
  await t.test('a PR recorded before this code: the first check starts the watch, and older comments are from before', () => {
    const r = byId('dddddd').reviews;
    assert.ok(Date.parse(r.watchingSince) >= started, r.watchingSince);
    assert.strictEqual(r.pending.before, true);
    assert.deepStrictEqual(r.pending.links, [pr(14) + '#issuecomment-1401']);
  });
});

test('the watch starts when the hook gives the task its PR, not at the first check', async (t) => {
  // The clock is the test's, so the first check comes five minutes after the hook however fast the machine is.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-03T11:00:00.400Z') });
  const g = byId('gggggg');
  tasks.noteHook('test', { session_id: 'session-gggggg', pr_url: pr(17) });
  prComments.noteHook('test', { session_id: 'session-gggggg', pr_url: pr(17) });
  assert.strictEqual(g.reviews.watchingSince, '2026-11-03T11:00:00.400Z');
  t.mock.timers.tick(5 * 60 * 1000);
  await prComments.poll();
  assert.strictEqual(g.reviews.pending.before, false, 'a comment one second after the hook is new, and moves the card');
});

test('only the relay\'s own move back marks a card, and only when it adds to Building', () => {
  const a = byId('aaaaaa'), e = byId('eeeeee'), f = byId('ffffff');
  tasks.moveBack('test', a, 'News.');
  assert.strictEqual(a.state, 'changes_requested');
  assert.strictEqual(a.movedBackByRelay, true, 'from In review: it was not counted, and still is not');
  tasks.moveBack('test', e, 'News.');
  assert.strictEqual(e.state, 'changes_requested');
  assert.ok(!e.movedBackByRelay, 'from Building: it was counted, so it still counts');
  tasks.setState('test', f, 'changes_requested', 'relay', 'Signed relay, but not the relay\'s move back.');
  assert.ok(!f.movedBackByRelay, 'a move signed relay is not a move back');
  tasks.setState('test', a, 'building', 'Lead');
  assert.ok(!a.movedBackByRelay, 'the next move of the card clears it, the Lead\'s too');
});
