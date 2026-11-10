// The room's choice of holiday, from office/holidays.js. Nothing here runs a browser.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { easter, thanksgiving, holidayOn, shown, KEYS } = require('../../office/holidays.js');

const on = (s) => { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; };
const day = (o) => o.y + '-' + String(o.m).padStart(2, '0') + '-' + String(o.d).padStart(2, '0');
// What the room shows on a day with the switch on: a holiday's key, or null.
const showing = (s) => { const h = shown(on(s), true, ''); return h && h.key; };

test('Easter follows the Gregorian computus', () => {
  const known = { 2008: '03-23', 2019: '04-21', 2024: '03-31', 2025: '04-20', 2026: '04-05', 2027: '03-28', 2028: '04-16', 2038: '04-25', 2285: '03-22' };
  for (const [y, md] of Object.entries(known)) assert.strictEqual(day(easter(Number(y))), y + '-' + md, 'Easter ' + y);
});

test('Thanksgiving is the fourth Thursday of November', () => {
  const known = { 2024: 28, 2025: 27, 2026: 26, 2027: 25, 2028: 23, 2029: 22, 2030: 28 };
  for (const [y, d] of Object.entries(known)) assert.strictEqual(day(thanksgiving(Number(y))), y + '-11-' + d, 'Thanksgiving ' + y);
});

test('a day out of every window names the next holiday, with no decorations', () => {
  assert.deepStrictEqual(holidayOn(on('2026-11-03')), { key: 'thanksgiving', name: 'Thanksgiving', day: '2026-11-26', year: 2026, showing: false, from: '2026-11-12', to: '2026-11-27' });
  assert.strictEqual(holidayOn(on('2027-02-10')).day, '2027-03-28', 'Easter 2027');
  assert.strictEqual(holidayOn(on('2026-08-15')).key, 'halloween');
  for (const s of ['2026-11-03', '2027-02-10', '2026-08-15', '2026-07-06', '2026-01-02', '2026-04-07', '2026-10-16', '2026-11-02', '2026-11-28', '2026-12-10']) {
    assert.strictEqual(showing(s), null, s);
  }
});

test('each window opens 14 days before its holiday and closes the day after', () => {
  const edges = [
    // [the day before it opens, the first day, the last day, the day after it closes, holiday]
    ['2027-03-13', '2027-03-14', '2027-03-29', '2027-03-30', 'easter'],
    ['2026-03-21', '2026-03-22', '2026-04-06', '2026-04-07', 'easter'],
    ['2028-04-01', '2028-04-02', '2028-04-17', '2028-04-18', 'easter'],
    ['2026-06-19', '2026-06-20', '2026-07-05', '2026-07-06', 'july4'],
    ['2027-06-19', '2027-06-20', '2027-07-05', '2027-07-06', 'july4'],
    ['2026-10-16', '2026-10-17', '2026-11-01', '2026-11-02', 'halloween'],
    ['2026-11-11', '2026-11-12', '2026-11-27', '2026-11-28', 'thanksgiving'],
    ['2027-11-10', '2027-11-11', '2027-11-26', '2027-11-27', 'thanksgiving'],
    ['2028-11-08', '2028-11-09', '2028-11-24', '2028-11-25', 'thanksgiving']
  ];
  for (const [before, first, last, after, key] of edges) {
    assert.strictEqual(showing(before), null, before);
    assert.strictEqual(showing(first), key, first);
    assert.strictEqual(showing(last), key, last);
    assert.strictEqual(showing(after), null, after);
  }
});

test('Christmas runs Dec 11 to 25, and New Year\'s follows it from Dec 26 to Jan 1', () => {
  for (const y of [2026, 2027, 2030]) {
    assert.strictEqual(showing(y + '-12-10'), null);
    assert.strictEqual(showing(y + '-12-11'), 'christmas');
    assert.strictEqual(showing(y + '-12-25'), 'christmas');
    assert.strictEqual(showing(y + '-12-26'), 'newyear');
    assert.strictEqual(showing((y + 1) + '-01-01'), 'newyear');
    assert.strictEqual(showing((y + 1) + '-01-02'), null);
  }
  assert.strictEqual(holidayOn(on('2026-12-26')).year, 2027, 'the banner names the new year');
  assert.strictEqual(holidayOn(on('2027-01-01')).year, 2027);
  assert.strictEqual(holidayOn(on('2027-01-02')).key, 'easter');
});

test('a Date is read in local time', () => {
  assert.strictEqual(holidayOn(new Date(2026, 9, 31, 23, 59)).key, 'halloween');
  assert.strictEqual(shown(new Date(2026, 11, 26, 0, 1), true, '').key, 'newyear');
});

test('the switch turns the decorations off, and a preview shows any holiday on any day', () => {
  assert.strictEqual(shown(on('2026-12-20'), false, ''), null);
  assert.strictEqual(shown(on('2026-12-20'), true, 'nonsense').key, 'christmas', 'an unknown preview is no preview');
  for (const key of KEYS) {
    for (const s of ['2026-08-15', '2026-12-20']) {
      for (const sw of [true, false]) assert.deepStrictEqual([shown(on(s), sw, key).key, shown(on(s), sw, key).preview], [key, true]);
    }
  }
  assert.strictEqual(shown(on('2026-08-15'), true, 'newyear').year, 2027, 'a preview of New Year\'s names the coming year');
});
