// The buttons on the Floor that ask an officer for a report: Ask the COO, which reads how the room runs
// (relay/coo.js), and Ask security, which reads what access its sessions run with (relay/security.js).
// Each starts a session that saves a one-page report. The report shows here, and the report button
// opens the last one again. Both propose only.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel'), key = params.get('key') || '';
  if (!channel) return;

  // base is the relay route and the start of each element's id. name is how the page says who it is.
  function officer(base, name, writing) {
    const askBtn = $(base + '-ask'), lastBtn = $(base + '-last'), section = $(base + '-report'), note = $(base + '-note'), text = $(base + '-text'), title = $(base + '-title');
    const floor = section.closest('.floor');
    const askWords = askBtn.textContent;
    const url = (verb) => location.origin + '/channels/' + encodeURIComponent(channel) + '/' + base + (verb ? '/' + verb : '') + '?key=' + encodeURIComponent(key);
    function api(verb, body) {
      const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
      return fetch(url(verb), opt).then((r) => r.json()).catch(() => ({ ok: false, message: 'The relay did not answer.' }));
    }
    let last = null, shownId = null, pressing = false;
    // One report shows at a time: opening one closes the other.
    function open(on) {
      if (on) for (const other of floor.querySelectorAll('.officer-report')) if (other !== section) other.hidden = true;
      section.hidden = !on;
      floor.dataset.report = [...floor.querySelectorAll('.officer-report')].some((s) => !s.hidden) ? '1' : '';
    }
    // The report is the session's own text, shown as text: nothing in it runs or links.
    function show(report) {
      title.textContent = name + ' report · ' + new Date(report.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
      lastBtn.hidden = !s.report;
      // A new report opens by itself, but only one that arrived while this page was open.
      if (s.report && was && (!was.report || was.report.id !== s.report.id) && s.report.id !== shownId) show(s.report);
    }
    askBtn.addEventListener('click', async () => {
      pressing = true; draw(last);
      const r = await api('ask', {});
      pressing = false;
      if (!r.ok) { open(true); title.textContent = name + ' report'; note.textContent = r.message || 'It did not start.'; text.textContent = ''; draw(last); return; }
      draw(Object.assign({}, last, { running: r.terminal }));
      for (let i = 0; i < 10; i++) {  // the session gets a person within a moment; show it
        const w = window.run && window.run.state().workers.find((p) => p.session && p.session.terminal === r.terminal);
        if (w) { window.dispatchEvent(new CustomEvent('office:pick', { detail: { who: w.id, keep: true } })); break; }
        await new Promise((done) => setTimeout(done, 500));
      }
    });
    lastBtn.addEventListener('click', () => { if (last && last.report) show(last.report); });
    $(base + '-close').addEventListener('click', () => open(false));

    // The terminal has to be on, and only the page on this computer gets an answer.
    api().then((s) => {
      if (!s.ok) { askBtn.hidden = true; return; }
      draw(s);
      setInterval(() => api().then(draw), 3000);
    });
  }
  officer('coo', 'COO', 'The COO is writing');
  officer('security', 'Security', 'Security is writing');
})();
