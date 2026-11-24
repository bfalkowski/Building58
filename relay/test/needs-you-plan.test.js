'use strict';
// What needs the person (relay/needs-you-plan.js), one kind of item at a time, from plain state.
const test = require('node:test');
const assert = require('node:assert');
const { listOf, KINDS, writeLine } = require('../needs-you-plan.js');

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

test('a hand-over whose Dev says a finding is a bug offers Fix it, and no other hand-over does', () => {
  const held = 'Its Dev says a finding the review marked non-blocking is a bug: https://github.com/o/r/pull/12#issuecomment-1';
  const [bug] = listOf({ tasks: [task({ state: 'waiting_on_you', pr: PR, handedOver: held, devSaysBug: true })] });
  assert.deepStrictEqual(bug.link, { url: PR, fix: 'k1' });
  const [rounds] = listOf({ tasks: [task({ state: 'waiting_on_you', pr: PR, handedOver: 'Review 2 still asks for fixes.' })] });
  assert.deepStrictEqual(rounds.link, { url: PR });
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

// On 2026-11-19 Autopilot was off, and Needs you said Waiting for the review for #113 to #115 for hours,
// though each review was posted with its verdict at 03:28 to 03:34 UTC. The line kept the reason of an old
// stall hand-over. A review posted after the hand-over now gives the line its next step.
const STALL = 'Nothing moved it for 30 minutes (Waiting for the review.).';
const posted = (o) => Object.assign({ kind: 'fix', commit: '0fdd14b24cbd4e868a18fba5b3433b821399a5c7', url: PR + '#issuecomment-9', current: true }, o);

test('a posted fix verdict after the hand-over, with its Dev stopped: bring the Dev back to fix it', () => {
  const [item, ...rest] = listOf({ tasks: [task({ state: 'waiting_on_you', pr: PR, handedOver: STALL, reviewedSince: posted() })] });
  assert.deepStrictEqual(rest, []);
  assert.strictEqual(item.kind, 'handed-over');
  assert.strictEqual(item.line, 'Bring back the worker on T-5 to fix PR #12: the review of 0fdd14b says fix, and its session has ended. ' + PR + '#issuecomment-9');
  assert.deepStrictEqual(item.link, { ticket: 'T-5' });
  assert.doesNotMatch(item.line, /Waiting for the review/);
  const [pushed] = listOf({ tasks: [task({ state: 'waiting_on_you', pr: PR, handedOver: STALL, reviewedSince: posted({ current: false }) })] });
  assert.strictEqual(pushed.line, 'Get a review of PR #12 (T-5): the review of 0fdd14b says fix, but newer commits came after it.', 'the Dev pushed after the review, so a new review comes first');
});

test('a posted fix verdict after the hand-over, with its Dev running: move the card, the Dev fixes it', () => {
  const dev = seat({ task: 'k1' });
  const [item] = listOf({ seats: [dev], tasks: [task({ owner: dev.terminal, state: 'waiting_on_you', pr: PR, handedOver: STALL, reviewedSince: posted() })] });
  assert.strictEqual(item.kind, 'handed-over');
  assert.strictEqual(item.line, 'Move T-5 out of Waiting on you: the review of 0fdd14b on PR #12 says fix, and its Dev Ada is running to fix it. ' + PR + '#issuecomment-9');
  assert.deepStrictEqual(item.link, { ticket: 'T-5' });
});

test('a posted merge verdict after the hand-over: merge the PR, unless newer commits need a review', () => {
  const [item] = listOf({ tasks: [task({ state: 'waiting_on_you', pr: PR, handedOver: STALL, reviewedSince: posted({ kind: 'merge' }) })] });
  assert.strictEqual(item.kind, 'handed-over');
  assert.strictEqual(item.line, 'Merge PR #12 (T-5), or move its card: the review of 0fdd14b says merge. ' + PR + '#issuecomment-9');
  assert.deepStrictEqual(item.link, { url: PR });
  const [old] = listOf({ tasks: [task({ state: 'waiting_on_you', pr: PR, handedOver: STALL, reviewedSince: posted({ kind: 'merge', current: false }) })] });
  assert.strictEqual(old.line, 'Get a review of PR #12 (T-5): the review of 0fdd14b says merge, but newer commits came after it.');
  assert.deepStrictEqual(old.link, { url: PR });
});

test('with no review after the hand-over, the line keeps Autopilot\'s reason', () => {
  const [item] = listOf({ tasks: [task({ state: 'waiting_on_you', pr: PR, handedOver: STALL, reviewedSince: null })] });
  assert.strictEqual(item.line, 'Decide on PR #12 (T-5): ' + STALL);
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
  assert.deepStrictEqual(KINDS, ['relay', 'permission', 'question', 'desks', 'main', 'claude', 'ticket-write', 'ticket-key', 'merged', 'closed', 'merge', 'handed-over', 'review', 'waiting', 'stuck', 'undelivered', 'prompt', 'gone']);
});

// T-374: reviews waited for a desk, and every desk was held by a session the relay may not stop.
test('reviews wait for a desk and the relay may stop no session: one line names the wait, after the questions', () => {
  const desks = { prs: [PR, 'https://github.com/o/r/pull/9'], taken: 9 };
  const asker = seat({ live: 'waiting', message: 'Go on?' });
  const items = listOf({ seats: [asker], tasks: [task({ id: 'k2', ticket: 'T-6', state: 'in_review', pr: PR, prOpen: true, onlyYouMerge: 'only you' })], desks });
  assert.deepStrictEqual(kinds(items), ['question', 'desks', 'merge']);
  const item = items[1];
  assert.strictEqual(item.line, 'Stop a session to free a desk: the reviews of PR #12 and #9 wait for one. All 9 desks are taken, and the relay may stop none of them. ' +
    'It stops only a reviewer whose review is posted, or an idle Dev whose PR merged, whose task is Done, or whose PR waits on a review.');
  assert.deepStrictEqual([item.who, item.terminal, item.task, item.pr, item.link], ['the relay', null, null, PR, {}]);
  assert.match(listOf({ desks: { prs: [PR], taken: 9 } })[0].line, /^Stop a session to free a desk: the review of PR #12 waits for one\. /);
  assert.deepStrictEqual(listOf({ desks: { prs: [], taken: 9 } }), [], 'no review waits');
});

test('another relay on the room\'s state folder: stop it, with its Stop button, before anything else', () => {
  const asker = seat({ live: 'waiting', message: 'Claude needs your permission to use Bash' });
  const relays = [{ pid: 48435, file: '~/repo/Building58/relay/server.js', port: 8787, started: '2026-11-12T14:16:24.000Z', paused: true, worker: false }];
  const items = listOf({ seats: [asker], relays });
  assert.deepStrictEqual(kinds(items), ['relay', 'permission']);
  assert.deepStrictEqual(items[0], { kind: 'relay', who: 'relay 48435', terminal: null, task: null, ticket: null, pr: null,
    line: 'Stop the other relay, pid 48435: it runs ~/repo/Building58/relay/server.js on port 8787 since 2026-11-12 14:16 UTC. It uses this room\'s state folder, so it can erase what this relay saves. It is paused, and can wake up later.',
    link: { stop: 48435 } });
  const bare = listOf({ relays: [{ pid: 7, file: null, port: 8790, started: null, paused: false, worker: false }] })[0];
  assert.strictEqual(bare.line, 'Stop the other relay, pid 7: on port 8790. It uses this room\'s state folder, so it can erase what this relay saves. It has no relay process left to answer, only its supervisor.');
  assert.strictEqual(listOf({ relays: [{ pid: 'x\n1' }, { pid: 0 }, null] }).length, 0, 'only a real pid gets a line');
  assert.strictEqual(listOf({ relays: [{ pid: 9, file: 'a\nb', port: 1, worker: true }] })[0].line, 'Stop the other relay, pid 9: it runs a b on port 1. It uses this room\'s state folder, so it can erase what this relay saves.', 'a path is cleaned to one line');
});

test('text from a session is cleaned to one line', () => {
  const [item] = listOf({ seats: [seat({ who: 'A\nda', live: 'waiting', message: 'Claude needs your permission\n\u0007to use Bash' })] });
  assert.strictEqual(item.who, 'A da');
  assert.strictEqual(item.line, 'Approve or deny the request from A da: Claude needs your permission to use Bash');
});

test('a GitHub write that failed: one line for the issue, with GitHub\'s message and the next try, after the desks', () => {
  const writes = [{ id: '68', what: 'close issue #68', message: 'Resource not accessible\nby integration.', tries: 3, inMs: 239000 }];
  const items = listOf({ seats: [], tasks: [task({ id: 'k2', ticket: 'T-6', state: 'in_review', pr: PR, prOpen: true, onlyYouMerge: 'only you' })], desks: { prs: [PR], taken: 9 }, writes });
  assert.deepStrictEqual(kinds(items), ['desks', 'ticket-write', 'merge']);
  assert.deepStrictEqual(items[1], { kind: 'ticket-write', who: 'the relay', terminal: null, task: null, ticket: '68', pr: null,
    line: 'Fix what stops a GitHub write: the relay could not close issue #68. GitHub says: Resource not accessible by integration. It tries again in 4 minutes.',
    link: { ticket: '68' } });
  assert.strictEqual(writeLine({ what: 'move issue #3', message: 'Bad', inMs: 900 }), 'Fix what stops a GitHub write: the relay could not move issue #3. GitHub says: Bad. It tries again in 1 second.');
  assert.match(writeLine({ what: 'update issue #3', message: 'x', inMs: -5 }), /GitHub says: x\. Its wait is over, so the next write to it tries again\.$/, 'a wait that is over says so');
  assert.deepStrictEqual(listOf({ writes: [null, { id: 'x\n1' }] }), [], 'only a write with an issue gets a line');
});

test('a PR merged on GitHub gives a Done line, and one closed with no merge gives a line with no Done', () => {
  const [m] = listOf({ seats: [], tasks: [task({ state: 'in_review', pr: PR, prOpen: false, prMerged: true, handedOver: 'x' })] });
  assert.strictEqual(m.kind, 'merged');
  assert.strictEqual(m.line, 'PR #12 (T-5) merged on GitHub. Move its task to Done.');
  assert.deepStrictEqual(m.link, { url: PR, done: 'k1' });
  const [c] = listOf({ seats: [], tasks: [task({ state: 'waiting_on_you', pr: PR, prOpen: false, prClosed: true })] });
  assert.strictEqual(c.kind, 'closed');
  assert.deepStrictEqual(c.link, { url: PR });
  assert.deepStrictEqual(listOf({ seats: [], tasks: [task({ state: 'done', pr: PR, prMerged: true })] }), [], 'a Done task gives none');
});

test('notes signed with another key give one line that names the fix', () => {
  const unread = { count: 2, ids: ['4', '9'], line: '2 tickets have notes signed with another key: approvals and order are not read. Give this room the key.' };
  const items = listOf({ seats: [], tasks: [], unread });
  assert.deepStrictEqual(items, [{ kind: 'ticket-key', who: 'the relay', terminal: null, task: null, ticket: null, pr: null, line: unread.line, link: {} }]);
  assert.deepStrictEqual(listOf({ unread: { count: 0, ids: [], line: null } }), []);
});
