// The buttons that ask an officer for a report, on the officers' cards of the org chart: Ask the COO,
// which reads how the room runs (relay/coo.js), and Ask security, which reads what access its sessions
// run with (relay/security.js). Each starts a session that saves a one-page report. The report shows on
// the Floor under the people, and the report button opens the last one again. A button on the org
// chart closes the chart first, so you see the report or the new session. Both propose only.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel'), key = params.get('key') || '';
  if (!channel) return;

  function officer(base, name, writing) {
    const askBtn = $(base + '-ask'), lastBtn = $(base + '-last'), section = $(base + '-report'), note = $(base + '-note'), text = $(base + '-text'), title = $(base + '-title');
    const floor = section.closest('.floor');
    const askWords = askBtn.textContent, dlg = askBtn.closest('dialog');
    const leave = () => { if (dlg && dlg.open) dlg.close(); };
    const when = (at) => new Date(at).toDateString() === new Date().toDateString() ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const url = (verb) => location.origin + '/channels/' + encodeURIComponent(channel) + '/officers/' + base + (verb ? '/' + verb : '') + '?key=' + encodeURIComponent(key);
    function api(verb, body) {
      const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
      return fetch(url(verb), opt).then((r) => r.text().then((t) => { try { return JSON.parse(t); } catch (e) { return { ok: false, message: 'The relay answered with a page, not JSON (' + r.status + '). On the public page your sign-in may have run out: reload it.' }; } }), () => ({ ok: false, message: 'The relay did not answer.' }));
    }
    let last = null, shownId = null, pressing = false;
    function open(on) {
      if (on) for (const other of floor.querySelectorAll('.officer-report')) if (other !== section) other.hidden = true;
      section.hidden = !on;
      floor.dataset.report = [...floor.querySelectorAll('.officer-report')].some((s) => !s.hidden) ? '1' : '';
    }
    function show(report) {
      title.textContent = name + ' report · ' + when(report.at);
      note.textContent = 'It proposes only. Each recommendation is yours to approve or leave.';
      text.textContent = report.text;
      shownId = report.id;
      open(true);
    }
    function draw(s) {
      if (!s || !s.ok) return;
      const was = last;
      last = s;
      askBtn.disabled = pressing || !!s.running;
      askBtn.textContent = s.running ? writing : askWords;
      lastBtn.disabled = !s.report;
      lastBtn.textContent = s.report ? 'Last ' + name + ' report, from ' + when(s.report.at) : 'No ' + name + ' report yet';
      if (s.report && was && (!was.report || was.report.id !== s.report.id) && s.report.id !== shownId) show(s.report);
    }
    askBtn.addEventListener('click', async () => {
      leave();
      pressing = true; draw(last);
      const r = await api('ask', {});
      pressing = false;
      if (!r.ok) { open(true); title.textContent = name + ' report'; note.textContent = r.message || 'It did not start.'; text.textContent = ''; draw(last); return; }
      draw(Object.assign({}, last, { running: r.terminal }));
      for (let i = 0; i < 10; i++) {
        const w = window.run && window.run.state().workers.find((p) => p.session && p.session.terminal === r.terminal);
        if (w) { window.dispatchEvent(new CustomEvent('office:pick', { detail: { who: w.id, keep: true } })); break; }
        // eslint-disable-next-line no-restricted-syntax -- polls this page's own state at most 10 times, only to follow the new person; no event says they appeared
        await new Promise((done) => setTimeout(done, 500));
      }
    });
    lastBtn.addEventListener('click', () => { if (last && last.report) { leave(); show(last.report); } });
    $(base + '-close').addEventListener('click', () => open(false));

    api().then((s) => {
      if (!s.ok) return;
      askBtn.hidden = false; lastBtn.hidden = false;
      draw(s);
      setInterval(() => api().then(draw), 3000);
    });
  }
  officer('coo', 'COO', 'The COO is writing');
  officer('security', 'Security', 'Security is writing');
})();
