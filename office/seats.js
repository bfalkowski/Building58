// What a session's job does to its title. A plain function, so the tests can run it. Also loaded by
// relay/test/seats.test.js with require. Who sits where is the relay's (relay/seats.js): the page
// draws the person GET /terminals gives each session.
(function () {
  'use strict';
  function noteWork(S, t, setTitle) {
    const lead = t.work && t.work.role === 'lead';
    if (t.task || (t.work && !lead)) S.tasked = true;
    S.work = t.work || null;
    if (t.work && t.work.label && !lead) setTitle(S, t.work.label);
    else if (t.title && (t.task || !S.title)) setTitle(S, t.title);
  }
  const SHOWN = 30;
  function titleBeside(title) {
    const full = String(title || '').replace(/\s+/g, ' ').trim(), chars = Array.from(full);
    if (!full) return { text: '', full: '' };
    return { text: ' · ' + (chars.length > SHOWN ? chars.slice(0, SHOWN - 1).join('').trimEnd() + '…' : full), full };
  }
  const api = { noteWork, titleBeside };
  if (typeof module !== 'undefined') module.exports = api; else window.OfficeSeats = api;
})();
