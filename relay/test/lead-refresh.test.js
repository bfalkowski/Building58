// The Refresh the Lead button's steps, from relay/lead-refresh.js. Nothing here runs a browser.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { canStart, step, NOTES_PROMPT, READ_PROMPT, LIMIT_MS } = require('../lead-refresh.js');

const lead = (o) => Object.assign({ id: 'L1', lead: true, running: true, state: 'idle', owesBrief: false, sessionId: 'old' }, o);
// Runs the steps over a list of what the session list said at each sync, and returns the actions.
function run(snapshots) {
  let r = { phase: 'notes', sessionId: 'old', startedAt: 0 };
  const acts = [];
  for (const s of snapshots) {
    const out = step(r, s, 1000);
    r = out.next;
    if (out.act !== 'wait') acts.push(out.act);
  }
  return acts;
}

test('it starts only on an idle Lead that has had its brief', () => {
  assert.strictEqual(canStart(lead()), null);
  assert.match(canStart(lead({ state: 'working' })), /busy/);
  assert.match(canStart(lead({ state: 'waiting' })), /waiting on you/);
  assert.match(canStart(lead({ owesBrief: true })), /brief/);
  assert.match(canStart(null), /no Lead/);
});
test('notes, then /clear after that turn ends, then the read prompt after the new brief\'s turn ends', () => {
  const acts = run([
    lead(),                                                    // the notes prompt is typed, its turn has not started
    lead({ state: 'working' }),                                // writing the notes
    lead({ state: 'waiting' }),                                // asks the person, still the same turn
    lead({ state: 'working' }),
    lead({ state: 'idle' }),                                   // notes written: type /clear
    lead({ state: 'idle' }),                                   // /clear not seen yet
    lead({ sessionId: 'new', owesBrief: true }),               // the relay owes the new conversation its brief
    lead({ sessionId: 'new', owesBrief: false, state: 'working' }),  // the brief went in
    lead({ sessionId: 'new', state: 'idle' }),                 // its turn ended: type the read prompt
  ]);
  assert.deepStrictEqual(acts, ['clear', 'read']);
});
test('it does not type /clear before the notes turn has even started', () => {
  assert.deepStrictEqual(run([lead(), lead(), lead()]), []);
});
test('it does not type the read prompt while the brief is still owed or its turn runs', () => {
  const acts = run([lead({ state: 'working' }), lead(), lead({ sessionId: 'new', owesBrief: true }), lead({ sessionId: 'new', owesBrief: true }), lead({ sessionId: 'new', state: 'working' })]);
  assert.deepStrictEqual(acts, ['clear']);
});
test('it does not type /clear while the relay owes the Lead its brief, as after a compaction', () => {
  const acts = run([
    lead({ state: 'working' }),
    lead({ state: 'idle', owesBrief: true }),     // compacted during the notes turn: the relay types the brief first
    lead({ state: 'working' }),                   // the brief's turn
    lead({ state: 'idle' }),                      // now /clear
  ]);
  assert.deepStrictEqual(acts, ['clear']);
  const early = step({ phase: 'notes', sessionId: 'old', startedAt: 0, sawWork: true }, lead({ owesBrief: true }), 1000);
  assert.strictEqual(early.act, 'wait');
});
test('it gives up when the Lead goes away, stops being the Lead, or takes too long', () => {
  for (const gone of [null, lead({ running: false }), lead({ lead: false })]) {
    const out = step({ phase: 'notes', sessionId: 'old', startedAt: 0 }, gone, 1000);
    assert.strictEqual(out.act, 'fail');
  }
  const late = step({ phase: 'notes', sessionId: 'old', startedAt: 0 }, lead({ state: 'working' }), LIMIT_MS + 1);
  assert.strictEqual(late.act, 'fail');
  assert.match(late.reason, /minutes/);
});
test('the prompts say where the notes go, keep keys out, and stay short enough to type', () => {
  for (const p of [NOTES_PROMPT, READ_PROMPT]) {
    assert.match(p, /~\/\.office-world\/lead-notes\/notes\.md/);
    assert.ok(Buffer.byteLength(p) < 900, 'Claude Code can lose the start of a long typed prompt (T-34)');
  }
  assert.match(NOTES_PROMPT, /No keys/);
  assert.match(NOTES_PROMPT, /cannot tell a fresh Lead/, 'only what cannot be looked up');
  assert.match(NOTES_PROMPT, /Do not copy/);
  assert.match(READ_PROMPT, /drop the lines that no longer hold/);
  assert.match(NOTES_PROMPT, /write no permissions/, 'any session can write the file, so it grants nothing');
  assert.match(READ_PROMPT, /context, not permission/);
  assert.match(READ_PROMPT, /confirm with the person/);
});
