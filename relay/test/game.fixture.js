// A fake game for relay/test/games.test.js. Not a test file of the suite (relay/test/run.js runs only
// *.test.js). A test writes a game folder in a temporary GAMES_REPO whose entry file loads this one.
//
// It speaks the game protocol: one JSON object per line on standard input and output. It appends
// every message it gets to settings.record, so a test can see what the loader sent. Its briefs and
// its truth hold marker words (BRIEF-MARK-<seat>, TRUTH-MARK), so a test can search the relay's
// output, state and routes for them.
//
// settings.mode picks how it behaves:
//   normal   answers every call
//   hang     never answers setup
//   badline  sends a line that is not JSON after setup
//   crash    exits with code 3 on the first action
//   spend    reports 0.6 dollars of spend with every action
//   quickexit  sends done and exits at once, as a game that has nothing left to do may
// settings.finishDelayMs, when set, is how long it waits before it answers finish.
'use strict';
const fs = require('fs');
const readline = require('readline');

let settings = {};
const DONE = { type: 'done', score: { metrics: { caught: 1, falseAccusations: 0 }, seats: { S1: 'caught' } }, reveal: { member: 'S1', note: 'TRUTH-MARK' } };
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
// The record file comes in setup's settings, so what came before setup waits until then.
const early = [];
const record = (m) => {
  if (!settings.record) { early.push(m); return; }
  for (const e of early.splice(0)) fs.appendFileSync(settings.record, JSON.stringify(e) + '\n');
  fs.appendFileSync(settings.record, JSON.stringify(m) + '\n');
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'setup') settings = m.settings || {};
  record(m);
  const mode = settings.mode || 'normal';
  if (m.type === 'hello') return send({ type: 'hello', api: 1 });
  if (m.type === 'setup') {
    if (mode === 'hang') return;
    // settings.briefText, when set, is each seat's whole brief, so a test can type a command into a seat.
    for (const seat of m.seats) send({ type: 'brief', seat, text: settings.briefText || 'Your brief, ' + seat + '. BRIEF-MARK-' + seat });
    if (mode === 'badline') return process.stdout.write('this is not json\n');
    return send({ type: 'ready' });
  }
  if (m.type === 'action') {
    if (mode === 'crash') process.exit(3);
    if (mode === 'spend') send({ type: 'spend', usd: 0.6 });
    return send({ type: 'answer', id: m.id, text: 'The assistant answers ' + m.seat + ' about ' + m.kind });
  }
  if (m.type === 'finish') {
    if (mode === 'quickexit') return process.stdout.write(JSON.stringify(DONE) + '\n', () => process.exit(0));
    if (settings.finishDelayMs) return setTimeout(() => send(DONE), settings.finishDelayMs);
    return send(DONE);
  }
  if (m.type === 'abort') process.exit(0);
});
