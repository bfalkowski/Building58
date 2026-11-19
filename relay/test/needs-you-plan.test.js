'use strict';
// What needs the person (relay/needs-you-plan.js), one kind of item at a time, from plain state.
const test = require('node:test');
const assert = require('node:assert');
const { listOf, KINDS } = require('../needs-you-plan.js');

const PR = 'https://github.com/o/r/pull/12';
const seat = (o) => Object.assign({ terminal: 'aaaaaaaaaaaa', who: 'Ada', role: 'Dev', live: 'idle', cause: null, message: null, screen: null, task: null, stuckWhy: null }, o);
const task = (o) => Object.assign({ id: 'k1', ticket: 'T-5', title: 'Fix it', state: 'building', pr: null, prOpen: null, owner: null, note: null, reviewRuns: false, handedOver: null, onlyYouMerge: null }, o);
const kinds = (items) => items.map((i) => i.kind);

test('nothing needs the person: the list is empty', () => {
  assert.deepStrictEqual(listOf({ seats: [], tasks: [] }), []);
  assert.deepStrictEqual(listOf({}), []);
  const working = seat({ live: 'working', task: 'k1' });
  assert.deepStrictEqual(listOf({ seats: [working], tasks: [task({ owner: working.terminal })] }), []);
});

test('a session that asks for permission: approve it, at its seat', () => {
  const [item, ...rest] = listOf({ seats: [seat({ role: 'Lead', live: 'waiting', message: 'Claude needs your permission to use Bash' })] });
  assert.deepStrictEqual(rest, []);
  assert.strictEqual(item.kind, 'permission');
  assert.strictEqual(item.who, 'Ada');
  assert.strictEqual(item.line, 'Approve or deny the request from Ada: Claude needs your permission to use Bash');
  assert.deepStrictEqual(item.link, { terminal: 'aaaaaaaaaaaa' });
});

test('a session that waits on an answer, or shows a question on its screen: answer it', () => {
  const asked = listOf({ seats: [seat({ live: 'waiting', message: 'Claude has a question' })] })[0];
  assert.strictEqual(asked.kind, 'question');
  assert.strictEqual(asked.line, 'Answer Ada: Claude has a question');
  const menu = listOf({ seats: [seat({ live: 'working', screen: 'menu' })] })[0];
  assert.strictEqual(menu.kind, 'question');
  assert.strictEqual(menu.line, 'Answer the question on the screen of Ada.');
  const trust = listOf({ seats: [seat({ live: 'idle', screen: 'trust' })] })[0];
  assert.strictEqual(trust.line, 'Answer the question on the screen of Ada: does it trust this folder?');
  assert.deepStrictEqual(listOf({ seats: [seat({ live: 'gone', screen: 'menu' })] }), [], 'an ended session asks nothing');
});

test('a session the relay told something that did not start: open it', () => {
  const [item] = listOf({ seats: [seat({ live: 'stuck', cause: 'told', stuckWhy: 'its prompt is still in its box' })] });
  assert.strictEqual(item.kind, 'stuck');
  assert.strictEqual(item.line, 'Open the session of Ada: the relay told it something and it did not start, its prompt is still in its box.');
  assert.deepStrictEqual(listOf({ seats: [seat({ live: 'stuck', cause: 'silent' })] }), [], 'a silent turn may still be thinking');
});

test('a saved message that has waited long for a running session: open that session, with why', () => {
  const wait = (o) => Object.assign({ terminal: 'aaaaaaaaaaaa', who: 'Ada', minutes: 17, why: 'its screen shows no prompt' }, o);
  const [item] = listOf({ seats: [seat({ role: 'Lead' })], waits: [wait()] });
  assert.strictEqual(item.kind, 'undelivered');
  assert.strictEqual(item.who, 'Ada');
  assert.strictEqual(item.line, 'Open the session of Ada: a message from the relay has waited 17 minutes for it and is not typed in, because its screen shows no prompt.');
  assert.deepStrictEqual(item.link, { terminal: 'aaaaaaaaaaaa' });
  assert.strictEqual(item.task, null, 'not on the Board');
  assert.deepStrictEqual(kinds(listOf({ waits: [wait(), wait({ minutes: 20 })] })), ['undelivered'], 'one item for one session');
  const asked = listOf({ seats: [seat({ live: 'waiting', message: 'Pick one' })], waits: [wait()] });
  assert.deepStrictEqual(kinds(asked), ['question'], 'a session with another item gives no second one');
});

test('a Dev that stopped with no PR: prompt it', () => {
  const dev = seat({ task: 'k1' });
  const [item] = listOf({ seats: [dev], tasks: [task({ owner: dev.terminal })] });
  assert.strictEqual(item.kind, 'prompt');
  assert.strictEqual(item.ticket, 'T-5');
  assert.strictEqual(item.line, 'Prompt Ada: it stopped on T-5 with no PR.');
  assert.deepStrictEqual(item.link, { terminal: dev.terminal });
  assert.strictEqual(listOf({ seats: [dev], tasks: [task({ owner: dev.terminal, state: 'changes_requested' })] })[0].kind, 'prompt');
  assert.deepStrictEqual(listOf({ seats: [dev], tasks: [task({ owner: dev.terminal, pr: PR })] }), [], 'one with a PR waits on its review');
  assert.deepStrictEqual(listOf({ seats: [seat({ task: 'k1', live: 'job' })], tasks: [task({ owner: dev.terminal })] }), [], 'one with a command still running is busy');
  assert.deepStrictEqual(listOf({ seats: [seat({ task: 'k1', role: 'reviewer' })], tasks: [task({ owner: dev.terminal })] }), [], 'only a Dev');
  assert.strictEqual(listOf({ seats: [seat({ task: 'k1', spoke: false })], tasks: [task({ owner: dev.terminal })] })[0].line, 'Prompt Ada: it has not started on T-5.', 'its brief never went in');
  assert.deepStrictEqual(listOf({ seats: [seat({ task: 'k1', spoke: false, fresh: true })], tasks: [task({ owner: dev.terminal })] }), [], 'one that just started gets its brief first');
  assert.deepStrictEqual(listOf({ seats: [seat({ task: 'k1', continuing: true })], tasks: [task({ owner: dev.terminal })] }), [], 'the relay still has a continue prompt for it after a restart');
});

test('a task whose session ended before a PR: bring it back', () => {
  const [item] = listOf({ tasks: [task()] });
  assert.strictEqual(item.kind, 'gone');
  assert.strictEqual(item.who, 'Worker on T-5');
  assert.strictEqual(item.line, 'Bring back the worker on T-5, or move its card: its session ended with no PR.');
  assert.deepStrictEqual(item.link, { ticket: 'T-5' });
  assert.deepStrictEqual(listOf({ tasks: [task({ pr: PR, state: 'in_review' })] }), [], 'a Dev may leave once its PR is open');
  assert.deepStrictEqual(listOf({ tasks: [task({ state: 'done' })] }), []);
});

test('a PR Autopilot handed over stays a decision after review news moves its task out of Waiting on you', () => {
  const held = 'Its Dev says a finding is a bug: https://github.com/o/r/pull/12#issuecomment-1';
  const [item] = listOf({ tasks: [task({ state: 'changes_requested', pr: PR, handedOver: held })] });
  assert.strictEqual(item.kind, 'handed-over');
  assert.strictEqual(item.line, 'Decide on PR #12 (T-5): ' + held);
});

test('a PR Autopilot handed over: decide on it, with its reason', () => {
  const dev = seat({ task: 'k1' });
  const [item] = listOf({ seats: [dev], tasks: [task({ owner: dev.terminal, state: 'waiting_on_you', pr: PR, handedOver: 'Its Dev says a finding is a bug: https://github.com/o/r/pull/12#issuecomment-1' })] });
  assert.strictEqual(item.kind, 'handed-over');
  assert.strictEqual(item.who, 'Ada');
  assert.strictEqual(item.line, 'Decide on PR #12 (T-5): Its Dev says a finding is a bug: https://github.com/o/r/pull/12#issuecomment-1');
  assert.deepStrictEqual(item.link, { url: PR });
  assert.strictEqual(item.pr, PR);
});

test('a PR whose automatic review could not start: get a review, with the reason (T-350)', () => {
  const why = 'Could not fetch https://github.com/o/r/pull/12: fatal: bad object refs/heads/x The broken ref is the file /r/.git/refs/heads/x.';
  const [item] = listOf({ tasks: [task({ state: 'in_review', pr: PR, prOpen: true, reviewFailed: why })] });
  assert.strictEqual(item.kind, 'review');
  assert.strictEqual(item.line, 'Get a review of PR #12 (T-5): its automatic review could not start, and the relay stopped trying. ' + why);
  assert.deepStrictEqual(item.link, { url: PR });
  const dev = seat({ task: 'k1' });
  assert.deepStrictEqual(listOf({ seats: [dev], tasks: [task({ owner: dev.terminal, state: 'waiting_on_you', pr: PR, reviewFailed: why })] })[0].link, { terminal: dev.terminal }, 'Get a review is on its Dev\'s session');
  assert.deepStrictEqual(listOf({ tasks: [task({ state: 'in_review', pr: PR, reviewFailed: why, reviewRuns: true })] }), [], 'a review of it runs now');
  assert.deepStrictEqual(listOf({ tasks: [task({ state: 'in_review', pr: PR, prOpen: false, reviewFailed: why })] }), [], 'not once it merged or closed');
});

test('a task in Waiting on you: look at it, with the note that put it there', () => {
  const [item] = listOf({ tasks: [task({ state: 'waiting_on_you', pr: PR, note: 'Its pipeline failed twice.' })] });
  assert.strictEqual(item.kind, 'waiting');
  assert.strictEqual(item.line, 'Look at T-5: its task is in Waiting on you. Its pipeline failed twice.');
  assert.deepStrictEqual(item.link, { url: PR });
  assert.strictEqual(listOf({ tasks: [task({ state: 'waiting_on_you' })] })[0].line, 'Look at T-5: its task is in Waiting on you.');
  assert.deepStrictEqual(listOf({ tasks: [task({ state: 'waiting_on_you', pr: PR, reviewRuns: true })] }), [], 'a review of it runs, so the next move is not yours yet');
  const dev = seat({ task: 'k1', live: 'working' });
  assert.deepStrictEqual(listOf({ seats: [dev], tasks: [task({ owner: dev.terminal, state: 'waiting_on_you' })] }), [], 'its Dev is at work again');
  assert.deepStrictEqual(listOf({ tasks: [task({ state: 'waiting_on_you', pr: PR, pipelineWaits: true })] }), [], 'its pipeline runs or fails, so the next move is not yours yet');
  assert.strictEqual(listOf({ tasks: [task({ state: 'waiting_on_you', pr: PR, pipelineWaits: true, handedOver: 'It changes CLAUDE.md.' })] })[0].kind, 'handed-over', 'Autopilot handed it over all the same');
});

test('a PR only the person may merge: merge it', () => {
  const [item] = listOf({ tasks: [task({ state: 'in_review', pr: PR, prOpen: true, onlyYouMerge: 'It changes CLAUDE.md, which only you merge.' })] });
  assert.strictEqual(item.kind, 'merge');
  assert.strictEqual(item.line, 'Merge PR #12 (T-5) yourself: It changes CLAUDE.md, which only you merge.');
  assert.deepStrictEqual(item.link, { url: PR });
  assert.deepStrictEqual(listOf({ tasks: [task({ state: 'in_review', pr: PR, prOpen: false, onlyYouMerge: 'x' })] }), [], 'not once it merged or closed');
});

test('no item twice for the same cause', () => {
  const dev = seat({ task: 'k1', live: 'waiting', message: 'Claude needs your permission to use Bash' });
  const parked = task({ owner: dev.terminal, state: 'waiting_on_you', pr: PR, handedOver: 'Its Dev Ada waits on you for 20 minutes.' });
  assert.deepStrictEqual(kinds(listOf({ seats: [dev], tasks: [parked] })), ['permission'], 'answering the Dev is the one move');
  const both = task({ state: 'waiting_on_you', pr: PR, handedOver: 'CI failed.', onlyYouMerge: 'It changes CLAUDE.md.', note: 'Autopilot: CI failed.' });
  assert.deepStrictEqual(kinds(listOf({ tasks: [both] })), ['handed-over'], 'one item for one task');
  const twice = listOf({ seats: [seat({ live: 'waiting', message: 'Claude needs your permission to use Bash', screen: 'menu' })] });
  assert.deepStrictEqual(kinds(twice), ['permission'], 'one item for one session');
  const two = listOf({ seats: [seat(), seat({ terminal: 'bbbbbbbbbbbb', who: 'Bo', live: 'waiting', message: 'Claude needs your permission to use Bash' })], tasks: [task({ id: 'k2', ticket: 'T-6', state: 'waiting_on_you' })] });
  assert.deepStrictEqual(kinds(two), ['permission', 'waiting'], 'different causes each have their item');
});

test('the most urgent kind comes first, and every kind has a rule', () => {
  const dev = seat({ task: 'k1' }), asker = seat({ terminal: 'bbbbbbbbbbbb', who: 'Bo', live: 'waiting', message: 'Claude needs your permission to use Bash' });
  const items = listOf({ seats: [dev, asker], tasks: [task({ owner: dev.terminal }), task({ id: 'k2', ticket: 'T-6', state: 'in_review', pr: PR, prOpen: true, onlyYouMerge: 'only you' })] });
  assert.deepStrictEqual(kinds(items), ['permission', 'merge', 'prompt']);
  assert.deepStrictEqual(KINDS, ['permission', 'question', 'merge', 'handed-over', 'review', 'waiting', 'stuck', 'undelivered', 'prompt', 'gone']);
});

test('text from a session is cleaned to one line', () => {
  const [item] = listOf({ seats: [seat({ who: 'A\nda', live: 'waiting', message: 'Claude needs your permission\n\u0007to use Bash' })] });
  assert.strictEqual(item.who, 'A da');
  assert.strictEqual(item.line, 'Approve or deny the request from A da: Claude needs your permission to use Bash');
});
