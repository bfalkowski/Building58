// The manager's notes on the room page: every few seconds it reads what the manager's watch found
// (GET /manager, relay/manager-watch.js) and sends each new note to the room's managerNote action, which puts it
// in Activity and walks the manager to the desk it is about. A page that opens late says only notes from the last
// few minutes, so an old problem does not send him out again.
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel'), key = params.get('key') || '';
  if (!channel) return;
  const url = location.origin + '/channels/' + encodeURIComponent(channel) + '/manager?key=' + encodeURIComponent(key);
  const RECENT_MS = 5 * 60 * 1000;
  let seen = null;

  async function read() {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }
  async function poll() {
    const got = await read();
    if (!got || !Array.isArray(got.notes) || !window.run) return;
    const fresh = got.notes.filter((n) => Number.isInteger(n.seq) && (seen === null ? Date.now() - Date.parse(n.at) < RECENT_MS : n.seq > seen));
    seen = got.notes.reduce((m, n) => Math.max(m, Number.isInteger(n.seq) ? n.seq : 0), seen || 0);
    for (const n of fresh) {
      const filed = n.filed ? ' Filed as ' + n.filed + '.' : '';
      await window.run.do({ action: 'managerNote', text: n.reason + filed, say: n.say, terminal: n.terminal, ticket: n.ticket, source: 'relay' });
    }
  }
  poll(); setInterval(poll, 3000);
})();
