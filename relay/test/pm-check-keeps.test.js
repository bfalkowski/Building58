// T-497: the PM check keeps each ticket's answer while Autopilot looks at other tickets, reads advice already
// saved on the ticket, and says "did not answer" only when no answer exists.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

process.env.RELAY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-check-keeps-'));
process.env.RELAY_PM_CHECK_MS = '60000';
const terminal = require('../terminal.js');
const delivery = require('../delivery.js');
const history = require('../ticket-history.js');
const pmCheck = require('../pm-check.js');

const CH = 'room';
const PM = { id: 'pm1', role: 'pm', startedAt: '2026-11-25T10:00:00Z', sessionId: 's1' };
const ticket = (id) => ({ id, createdAt: '2026-11-25T09:00:00Z', title: 'Ticket ' + id, status: 'ready', body: 'Do it.' });
const A = ticket('225'), B = ticket('472');
const all = [A, B];

function setup(t) {
  const saved = [], dropped = [];
  const real = { all: terminal.all, save: delivery.save, drop: delivery.drop };
  terminal.all = () => [PM];
  delivery.save = (channel, d) => { saved.push(d.key); };
  delivery.drop = (channel, key) => { dropped.push(key); };
  pmCheck.forget();
  t.after(() => { Object.assign(terminal, { all: real.all }); Object.assign(delivery, { save: real.save, drop: real.drop }); pmCheck.forget(); });
  return { saved, dropped };
}
const advise = (tk, answer) => {
  history.add(CH, tk, { stage: 'pm-advice', by: 'PM', answer: answer.answer, of: answer.of, why: answer.why, rung: 1 });
  pmCheck.answered(CH, tk.id, answer, 'advised');
};

test('an answer stays while Autopilot looks at another ticket, and the ticket starts on it with no second check', (t) => {
  const { saved } = setup(t);
  assert.ok(pmCheck.consult(CH, A, all).wait);
  assert.deepStrictEqual(saved, ['pm-check 225']);
  advise(A, { answer: 'start', of: null, why: 'Fine.' });
  assert.ok(pmCheck.consult(CH, B, all).wait, 'B is asked');
  assert.deepStrictEqual(saved, ['pm-check 225', 'pm-check 472']);
  const again = pmCheck.consult(CH, A, all);
  assert.deepStrictEqual(again, { go: true, said: null });
  assert.deepStrictEqual(saved, ['pm-check 225', 'pm-check 472'], 'no second check of 225');
});

test('advice saved on the ticket before the check is used, and no check is typed', (t) => {
  const { saved } = setup(t);
  history.add(CH, B, { stage: 'pm-advice', by: 'PM', answer: 'start', why: 'Fine.', rung: 1 });
  assert.deepStrictEqual(pmCheck.consult(CH, B, all), { go: true, said: null });
  assert.deepStrictEqual(saved, []);
});

test('advice from before an edit or a move is not used, so the PM is asked again', (t) => {
  const { saved } = setup(t);
  const C = ticket('300');
  history.add(CH, C, { stage: 'pm-advice', by: 'PM', answer: 'start', why: 'Fine.', rung: 1 });
  history.add(CH, C, { stage: 'edited', by: 'you', what: ['body'] });
  assert.ok(pmCheck.consult(CH, C, all).wait);
  assert.deepStrictEqual(saved, ['pm-check 300']);
});

test('an answered ticket never logs "did not answer", even after the time is up', (t) => {
  setup(t);
  const D = ticket('400');
  const real = Date.now;
  t.after(() => { Date.now = real; });
  pmCheck.consult(CH, D, all);
  advise(D, { answer: 'start', of: null, why: 'Fine.' });
  Date.now = () => real() + 3600 * 1000;
  assert.strictEqual(pmCheck.consult(CH, D, all).said, null);
  const E = ticket('401');
  Date.now = real;
  pmCheck.consult(CH, E, all);
  Date.now = () => real() + 3600 * 1000;
  assert.match(pmCheck.consult(CH, E, all).said, /did not answer the check of 401/);
});

test('an answer given to the check is dropped when the ticket is edited, so the PM is asked again', (t) => {
  const { saved } = setup(t);
  const F = ticket('500');
  pmCheck.consult(CH, F, all);
  advise(F, { answer: 'start', of: null, why: 'Fine.' });
  const later = new Date(Date.now() + 5).toISOString();
  history.add(CH, F, { stage: 'edited', by: 'you', what: ['body'], at: later });
  assert.ok(pmCheck.consult(CH, F, all).wait);
  assert.strictEqual(saved.filter((k) => k === 'pm-check 500').length, 2, 'the check is typed again');
});

test('a "first" answer is used once: the next look at the ticket asks the PM again', (t) => {
  const { saved } = setup(t);
  const G = ticket('600'), H = ticket('601');
  const pair = [G, H];
  const trust = require('../pm-trust.js'), level = trust.level;
  trust.level = () => trust.HOLD;
  t.after(() => { trust.level = level; });
  pmCheck.consult(CH, G, pair);
  advise(G, { answer: 'first', of: '601', why: 'It fixes a stall.' });
  const first = pmCheck.consult(CH, G, pair);
  assert.strictEqual(first.first, '601');
  assert.deepStrictEqual(saved, ['pm-check 600']);
  const again = pmCheck.consult(CH, G, pair);
  assert.ok(again.wait, 'asked again, not redirected again');
  assert.deepStrictEqual(saved, ['pm-check 600', 'pm-check 600']);
});

test('advice followed by a proposal, and a hold answer at the hold rung, are not reused', (t) => {
  const { saved } = setup(t);
  const I = ticket('700'), J = ticket('701');
  history.add(CH, I, { stage: 'pm-advice', by: 'PM', answer: 'start', why: 'Fine.', rung: 1 });
  history.add(CH, I, { stage: 'proposal', by: 'PM', action: 'close', ids: [] });
  assert.ok(pmCheck.consult(CH, I, all).wait);
  assert.deepStrictEqual(saved, ['pm-check 700']);
  history.add(CH, J, { stage: 'pm-advice', by: 'PM', answer: 'duplicate', of: '225', why: 'Same.', rung: 2 });
  const trust = require('../pm-trust.js'), level = trust.level;
  trust.level = () => trust.HOLD;
  t.after(() => { trust.level = level; });
  assert.ok(pmCheck.consult(CH, J, all).wait);
  assert.deepStrictEqual(saved, ['pm-check 700', 'pm-check 701']);
});
