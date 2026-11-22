// The room opened with no relay: no ?channel= in its address, as from a plain web server or a copy
// of the page on a website. The room still plays, but every control that needs the relay would do
// nothing. So the page says so once under the room bar, points to Run a demo, and turns off each
// control marked data-needs-relay in office/index.html, with "Needs a relay" beside it.
// See docs/manual/running.html#no-relay.
(function () {
  'use strict';
  if (new URLSearchParams(location.search).get('channel')) return;
  const $ = (id) => document.getElementById(id);
  const tag = () => Object.assign(document.createElement('span'), { className: 'needs-relay', textContent: 'Needs a relay' });
  document.documentElement.dataset.relay = 'none';
  for (const el of document.querySelectorAll('[data-needs-relay]')) {
    el.title = 'Needs a relay';
    if (el.tagName === 'DETAILS') {
      el.open = false;
      el.classList.add('no-relay');
      const summary = el.querySelector('summary');
      summary.append(tag());
      summary.addEventListener('click', (e) => e.preventDefault());
      continue;
    }
    el.disabled = true;
    if (el.tagName === 'BUTTON') el.after(tag());
  }
  const note = $('no-relay'), demo = $('demo');
  if (!note) return;
  note.hidden = false;
  $('no-relay-demo').addEventListener('click', () => { if (demo && demo.getAttribute('aria-pressed') !== 'true') demo.click(); });
})();
