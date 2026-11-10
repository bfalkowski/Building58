// Which holiday the room decorates for, from a date. Plain functions with no network call, so the
// tests can run them. Also loaded by relay/test/holidays.test.js with require.
//
// Each holiday's decorations show from 14 days before it until the day after it. New Year's runs
// from Dec 26 to Jan 1 instead, so it follows Christmas, and Christmas ends on Dec 25. On any other
// day there are no decorations. The dates are the browser's local calendar days.
(function () {
  'use strict';
  const HOLIDAYS = [
    { key: 'newyear', name: 'New Year\'s' },
    { key: 'easter', name: 'Easter' },
    { key: 'july4', name: 'the Fourth of July' },
    { key: 'halloween', name: 'Halloween' },
    { key: 'thanksgiving', name: 'Thanksgiving' },
    { key: 'christmas', name: 'Christmas' }
  ];
  const KEYS = HOLIDAYS.map((h) => h.key);
  const DAY = 86400000;
  // A calendar day as a whole number, so adding days never meets a change of clocks.
  const dayNum = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / DAY);
  const ymd = (n) => { const t = new Date(n * DAY); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };

  // Easter Sunday in the Gregorian calendar (the anonymous computus, as in Meeus).
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return { y, m: month, d: day };
  }
  // The fourth Thursday of November.
  function thanksgiving(y) {
    const first = new Date(Date.UTC(y, 10, 1)).getUTCDay();  // 0 is Sunday, 4 is Thursday
    return { y, m: 11, d: 1 + ((4 - first + 7) % 7) + 21 };
  }
  // The holiday's own day in year y.
  function dayOf(key, y) {
    switch (key) {
      case 'newyear': return { y, m: 1, d: 1 };
      case 'easter': return easter(y);
      case 'july4': return { y, m: 7, d: 4 };
      case 'halloween': return { y, m: 10, d: 31 };
      case 'thanksgiving': return thanksgiving(y);
      case 'christmas': return { y, m: 12, d: 25 };
      default: return null;
    }
  }
  // The first and last day the decorations show, as day numbers, for the holiday in year y.
  function windowOf(key, y) {
    const h = dayOf(key, y), n = dayNum(h.y, h.m, h.d);
    if (key === 'newyear') return { from: dayNum(y - 1, 12, 26), to: n };
    if (key === 'christmas') return { from: n - 14, to: n };
    return { from: n - 14, to: n + 1 };
  }
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (o) => o.y + '-' + pad(o.m) + '-' + pad(o.d);

  // For a date (a Date, read in local time, or { y, m, d }): the next holiday whose decorations have
  // not come down yet, its day, and whether they are up today.
  //   { key, name, day: 'YYYY-MM-DD', year, showing, from, to }
  // year is the holiday's own year, so New Year's on Dec 26, 2026 is 2027.
  function holidayOn(date) {
    const t = date instanceof Date ? { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() } : date;
    const today = dayNum(t.y, t.m, t.d);
    let best = null;
    for (const y of [t.y, t.y + 1]) {
      for (const h of HOLIDAYS) {
        const w = windowOf(h.key, y);
        if (w.to < today || (best && w.to >= best.w.to)) continue;
        best = { h, y, w };
      }
    }
    const day = dayOf(best.h.key, best.y);
    return { key: best.h.key, name: best.h.name, day: iso(day), year: best.y, showing: today >= best.w.from, from: iso(ymd(best.w.from)), to: iso(ymd(best.w.to)) };
  }
  // What a person sees: their preview, if they picked one, wins. Otherwise the date's holiday while
  // the switch is on and the decorations are up. null means no decorations.
  function shown(date, on, preview) {
    if (KEYS.includes(preview)) {
      const now = holidayOn(date), y = now.key === preview ? now.year : (date instanceof Date ? date.getFullYear() : date.y) + (preview === 'newyear' ? 1 : 0);
      const h = HOLIDAYS.find((x) => x.key === preview);
      return { key: preview, name: h.name, year: y, preview: true };
    }
    if (!on) return null;
    const h = holidayOn(date);
    return h.showing ? { key: h.key, name: h.name, year: h.year, preview: false } : null;
  }
  const api = { HOLIDAYS, KEYS, easter, thanksgiving, dayOf, holidayOn, shown };
  if (typeof module !== 'undefined') module.exports = api; else window.OfficeHolidays = api;
})();
