// What the front office and the workers row say (office/front.js), as plain functions: which card waits on
// you, what its header line says, how a reviewer is paired with its Dev, and what Up next lists.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'office', 'front.js'), 'utf8'), sandbox);
const F = sandbox.window.OfficeFront;

const PR = 'https://github.com/acme/widgets/pull/9';
const desk = (over) => Object.assign({ pr: null, prNumber: null, column: { id: 'building' }, rounds: 0, doing: { state: 'working', words: 'working' }, status: null }, over);
const dev = (d, over) => Object.assign({ terminal: 'd1', name: 'Bea', role: 'Dev', seat: null, ticket: '5', title: 'Notes', desk: desk(d) }, over);
const rev = (d) => ({ terminal: 'r1', name: 'Farah', role: 'reviewer', seat: null, desk: desk(Object.assign({ pr: PR, prNumber: '#9', reviewing: { dev: { terminal: 'd1' } } }, d)) });

test('a Dev with no PR has a card that says PR not started, and no reviewer yet', () => {
  const { cards } = F.cardsOf([dev()], []);
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].header, 'Ticket 5 · PR not started · building');
  assert.strictEqual(cards[0].slot.none, 'no reviewer yet');
  assert.strictEqual(cards[0].state, '');
});

test('the reviewer of its PR is in the same card, and the stage follows the review', () => {
  const rows = [dev({ pr: PR, prNumber: '#9', column: { id: 'in_review' }, rounds: 1 }), rev()];
  const { cards, extras } = F.cardsOf(rows, []);
  assert.strictEqual(cards[0].header, 'Ticket 5 · PR #9 · in review');
  assert.strictEqual(cards[0].slot.live.name, 'Farah');
  assert.strictEqual(extras.length, 0, 'the reviewer is not drawn twice');
  const fix = F.cardsOf([dev({ pr: PR, prNumber: '#9', column: { id: 'changes_requested' }, rounds: 2, status: { key: 'fix' } })], []).cards[0];
  assert.strictEqual(fix.stage, 'changes requested, round 3 next');
  assert.deepStrictEqual([fix.slot.none, fix.slot.hint], ['reviewer left its desk', 'last verdict: fix']);
  const merged = F.cardsOf([dev({ pr: PR, prNumber: '#9', column: { id: 'done' }, status: { key: 'merged' } })], []).cards[0];
  assert.strictEqual(merged.stage, 'merged');
  assert.strictEqual(merged.slot.hint, 'last verdict: merge');
});

test('a reviewer whose Dev is not on the floor stays a card of its own', () => {
  const { cards, extras } = F.cardsOf([rev()], []);
  assert.strictEqual(cards.length, 0);
  assert.strictEqual(extras.length, 1);
  assert.match(extras[0].header, /^Reviewer of PR #9$/);
});

test('a card waits on you only when Needs you names it, with the reason first, and is stuck when its desk says so', () => {
  const rows = [dev({ pr: PR, prNumber: '#9', column: { id: 'in_review' } })];
  assert.strictEqual(F.cardsOf(rows, []).cards[0].state, '');
  const waits = F.cardsOf(rows, [{ kind: 'merge', terminal: 'd1', line: 'Merge PR 9 yourself.' }]).cards[0];
  assert.strictEqual(waits.state, 'wait');
  assert.strictEqual(waits.header, 'Waits on you: merge · Ticket 5 · PR #9');
  const other = F.cardsOf(rows, [{ kind: 'merge', terminal: 'someone-else', line: 'x' }]).cards[0];
  assert.strictEqual(other.state, '', 'an item for another session does not light this card');
  const stuck = F.cardsOf([dev({ doing: { state: 'stuck', words: 'stuck: told 27 min ago, did not start' } })], []).cards[0];
  assert.strictEqual(stuck.state, 'stuck');
  assert.strictEqual(stuck.header, 'Stuck: told 27 min ago, did not start · Ticket 5 · PR not started · building');
});

test('the PM seat shows its rung, next sort and a waiting proposal, and waits on you only when Needs you says so', () => {
  const pm = { terminal: 'p1', name: 'Priya', role: 'PM', seat: 'pm', desk: desk({ doing: { state: 'idle', words: 'idle 3 min' }, next: { text: 'Waiting on you: talk', owner: 'you' } }) };
  const tickets = [{ id: '215', status: 'ready', proposal: { action: 'close', ids: ['214'], why: 'same' } }];
  const seat = F.seatOf('pm', [pm], [], tickets, { trust: 2, trustName: 'Hold and propose', sortHours: 4, nextSortAt: new Date(1000 + 220 * 60000).toISOString(), now: 1000 });
  assert.strictEqual(seat.rung, 'trust: 2 Hold and propose');
  assert.strictEqual(seat.sort, 'Next sort in 3 h 40 min.');
  assert.strictEqual(seat.state, '', 'a proposal alone is not a wait');
  assert.strictEqual(seat.proposal, 'Proposal: close 215?');
  const named = F.seatOf('pm', [pm], [{ kind: 'question', terminal: 'p1', line: 'x' }], [], null);
  assert.strictEqual(named.reason.text, 'Waits on you: a question');
  assert.strictEqual(F.seatOf('pm', [], [], [], null).row, null, 'a PM that is not running still has its seat');
});

test('Up next lists the next 5 Ready tickets in Autopilot\'s order with the PM\'s latest verdict', () => {
  const t = (id, extra) => Object.assign({ id, title: 'T ' + id, status: 'ready', repo: '/r', approved: true, waitingFor: [], task: null, priority: 'normal', history: [] }, extra);
  const board = [
    t('1', { history: [{ stage: 'pm-advice', answer: 'duplicate', why: 'old', of: '9' }, { stage: 'pm-advice', answer: 'start', why: 'new' }] }),
    t('2', { waitingFor: ['1'] }), t('3', { approved: false }), t('4', { heldBack: 'On hold.' }),
    t('5', { heldBack: 'Waits.', proposal: { action: 'close', ids: ['6'], why: 'dup' } }),
    t('6', { history: [{ stage: 'pm-advice', answer: 'first', why: 'w', of: '7' }] }), t('7'), t('8'), t('9'), t('10'),
    { id: '11', title: 'building', status: 'started' }
  ];
  const up = F.upNext(board, 5);
  assert.deepStrictEqual([...up.items.map((i) => i.id)], ['1', '5', '6', '7', '8']);
  assert.deepStrictEqual([...up.items.map((i) => i.verdict.words)], ['start', 'close 6 proposed, waits on you', 'after 7', 'not checked yet', 'not checked yet']);
  assert.strictEqual(up.items[0].verdict.why, 'new', 'the latest verdict wins');
  assert.strictEqual(up.items[1].verdict.you, true);
  assert.strictEqual(up.more, 5, 'the rest of Ready, held back ones too');
});

test('Today uses the numbers the COO counts, and free desks are 7 minus the workers', () => {
  const rows = [{ seat: 'lead' }, { seat: 'pm' }, { seat: null }, { seat: null }, { seat: null, role: 'PM' }];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(F.todayOf({ numbers: { merged: 5, medianMinutes: 290 } }, 2, rows))), { merged: 5, median: '4 h 50 min', waiting: 2, free: 5, desks: 7 });
  assert.strictEqual(F.todayOf(null, 0, []).merged, null);
});

test('a ticket opens on the Board, or on GitHub for the GitHub store, and a PR on GitHub', () => {
  assert.strictEqual(F.ticketHref('T-5', 'local', null, 'room'), 'board.html?channel=room&ticket=T-5');
  assert.strictEqual(F.ticketHref('12', 'github', 'acme/widgets', 'room'), 'https://github.com/acme/widgets/issues/12');
  assert.strictEqual(F.ticketHref('12', 'github', null, 'room'), 'board.html?channel=room&ticket=12');
  assert.strictEqual(F.repoSlug([null, PR]), 'acme/widgets');
});
