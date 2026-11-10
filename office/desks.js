// What each desk on the Floor says, from the relay (GET /floor, relay/desk.js): its ticket's column,
// its PR with CI and review, the next step and who owns it, and Safe to stop. office/panel.js draws
// it on each person's row, and how tired the Lead is (relay/lead-tired.js). This file asks the relay and does the stops: a desk's Stop, and Stop all
// safe at the top of the Floor. The relay checks each desk again before it stops it.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel'), key = params.get('key') || '';
  const allBtn = $('stop-safe'), note = $('stop-note');
  if (!channel || !allBtn) return;
  const at = (p) => location.origin + '/channels/' + encodeURIComponent(channel) + p + '?key=' + encodeURIComponent(key);
  let desks = {}, busy = false;
  function say(text, bad) { note.textContent = text || ''; note.hidden = !text; note.dataset.bad = bad ? '1' : ''; }
  function publish() {
    window.OFFICE_DESKS = desks;
    window.dispatchEvent(new CustomEvent('office:desks', { detail: desks }));
    const safe = Object.values(desks).filter((d) => d.stop && d.stop.safe).length;
    allBtn.hidden = !safe;
    allBtn.textContent = 'Stop all safe · ' + safe;
  }
  async function poll() {
    try {
      const r = await fetch(at('/floor')).then((x) => x.json());
      if (!r || !r.ok) return;
      const next = {};
      for (const s of r.sessions) if (s.desk) next[s.terminal] = Object.assign({ name: s.name, lead: s.role === 'Lead', tired: s.tired || null }, s.desk);
      desks = next;
      publish();
    } catch (e) { /* the relay is away: keep the last desks */ }
  }
  async function stop(body, what) {
    if (busy) return;
    busy = true;
    say('Stopping ' + what, false);
    try {
      const r = await fetch(at('/floor/stop'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
      if (r.ok) say(r.stopped.length ? 'Stopped ' + r.stopped.map((x) => x.name).join(', ') + '.' : 'Nobody was safe to stop.', false);
      else say(r.message || 'Not stopped.', true);
    } catch (e) { say('The relay did not answer.', true); }
    busy = false;
    poll();
  }
  allBtn.addEventListener('click', () => stop({ all: true }, 'every desk that is safe to stop'));
  window.addEventListener('office:stop-desk', (ev) => { const d = desks[ev.detail]; if (d) stop({ who: ev.detail }, d.name); });
  poll(); setInterval(poll, 3000);
})();
