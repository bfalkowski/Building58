// What a session's job does to its title. A plain function, so the tests can run it. Also loaded by
// relay/test/seats.test.js with require. Who sits where is the relay's (relay/seats.js): the page
// draws the person GET /terminals gives each session.
(function () {
  'use strict';
  // A ticket's label replaces the session's title for as long as the session lasts. Being the Lead can
  // end while the session goes on, so that label is only read from the relay and never kept as the title.
  function noteWork(S, t, setTitle) {
    const lead = t.work && t.work.role === 'lead';
    if (t.task || (t.work && !lead)) S.tasked = true;
    S.work = t.work || null;
    if (t.work && t.work.label && !lead) setTitle(S, t.work.label);
    else if (t.title && (t.task || !S.title)) setTitle(S, t.title);
  }
  const api = { noteWork };
  if (typeof module !== 'undefined') module.exports = api; else window.OfficeSeats = api;
})();
