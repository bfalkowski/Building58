'use strict';
// 2026-11-25, ticket 225: Autopilot nudged a Dev to open a PR, the Dev answered there was nothing to open,
// and the task went to the person as stalled. The nudge now points the Dev at ticket.js not-needed, and a
// Dev that says the work is on main with a commit is not counted as stalled.
const test = require('node:test');
const assert = require('node:assert');
const { nudgeText, noPrWhy } = require('../nudge.js');
const { onMainCommit } = require('../on-main.js');
const { summarize } = require('../office-hook.js');

const now = Date.parse('2026-11-25T12:00:00Z');
const task = { id: 'task-1', ticket: 'T-225' };
const idleDev = (commit) => ({ state: 'idle', lastActAt: now - 60 * 60000, onMain: commit || null });

test('the nudge names ticket.js not-needed with the ticket and the commit', () => {
  const text = nudgeText(task);
  assert.match(text, /ticket\.js not-needed T-225 --commit <sha> --why/);
  assert.match(text, /already on main|on main/);
  assert.match(text, /open the PR/);
});

test('a task with no ticket gets the nudge without the command', () => {
  assert.doesNotMatch(nudgeText({ id: 'task-2' }), /not-needed/);
});

test('a Dev that says its work is on main with a commit is found', () => {
  assert.strictEqual(onMainCommit('Nothing to open: the work is already on main in commit 7db2737.'), '7db2737');
  assert.strictEqual(onMainCommit('Already on origin/main, see 7DB2737ab.'), '7db2737ab');
});

test('a Dev that gives no commit, or does not say main, is not found', () => {
  assert.strictEqual(onMainCommit('Nothing to open, it is already on main.'), null);
  assert.strictEqual(onMainCommit('I fixed it in 7db2737 and will open the PR.'), null);
  assert.strictEqual(onMainCommit('Plain numbers like 12345678 on main do not count.'), null);
  assert.strictEqual(onMainCommit(undefined), null);
});

test('the hand-over reason says it is not a stall and names the command', () => {
  const why = noPrWhy('office', {}, task, idleDev('7db2737'), now);
  assert.strictEqual(why, 'its Dev says the work is already on main in commit 7db2737, so this is not a stall: it can close the ticket with ticket.js not-needed T-225 --commit 7db2737 --why');
});

test('the hook sends only the commit of such a claim, never the words', () => {
  const stop = (last_assistant_message) => summarize({ hook_event_name: 'Stop', session_id: 'abc', last_assistant_message });
  const out = stop('Nothing to open. The work is on main in 7db2737, secret words here.');
  assert.strictEqual(out.on_main, '7db2737');
  assert.ok(!JSON.stringify(out).includes('secret'));
  assert.strictEqual(stop('Done, PR opened.').on_main, undefined);
});
