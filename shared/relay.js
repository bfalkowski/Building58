// Connects the world to a relay so outside callers can send commands. Uses only window.run.
// Off unless the page is opened with ?channel=<name> (and ?relay=<url> if the
// relay is somewhere other than this page's own server). See docs/manual/relay.html.
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel');
  if (!channel || !window.run || !window.EventSource) return;
  const run = window.run;
  const base = (params.get('relay') || location.origin).replace(/\/+$/, '');
  const url = (p) => base + '/channels/' + encodeURIComponent(channel) + p;
  const badge = document.getElementById('relay-status');

  function status(text, state) {
    if (!badge) return;
    badge.hidden = false; badge.textContent = text; badge.dataset.state = state;
    badge.title = 'Relay ' + base + ', channel ' + channel;
  }
  function post(p, body) {
    return fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => { if (r.status === 401) status('Relay: wrong key', 'off'); return r; })
      .catch(() => null);
  }

  let buffer = run.events();
  run.on('*', (e) => { buffer.push(e); });
  setInterval(() => {
    if (!buffer.length) return;
    const batch = buffer; buffer = [];
    post('/events', { events: batch });
  }, 400);

  let pageId = null;
  function reportVisibility() {
    if (pageId != null) post('/pages/' + pageId, { visible: !document.hidden });
  }
  document.addEventListener('visibilitychange', reportVisibility);

  status('Relay: connecting', 'wait');
  const es = new EventSource(url('/stream') + (document.getElementById('board') ? '&board=1' : ''));
  const board = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
  es.addEventListener('hello', (m) => {
    status('Relay: ' + channel, 'on');
    let hello = {};
    try { hello = JSON.parse(m.data); } catch (e) { hello = {}; }
    pageId = hello.page == null ? null : hello.page;
    board('office:stream', { tickets: !!hello.tickets });
    reportVisibility();
  });
  es.addEventListener('error', () => { status('Relay: reconnecting', 'off'); board('office:stream', { tickets: false }); });
  es.addEventListener('tickets', (m) => {
    let r = null;
    try { r = JSON.parse(m.data); } catch (e) { return; }
    board('office:tickets', r);
  });
  es.addEventListener('command', async (m) => {
    let id = null, result;
    try {
      const msg = JSON.parse(m.data); id = msg.id;
      const cmd = Object.assign({}, msg.command);
      if (!cmd.source) cmd.source = 'relay';
      result = await run.do(cmd);
    } catch (err) {
      result = { ok: false, error: 'error', message: String((err && err.message) || err) };
    }
    if (id) post('/results', { id, result });
  });
})();
