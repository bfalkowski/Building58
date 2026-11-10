// The Huddle buttons on the Floor: one short report on everyone. The relay builds it (relay/huddles.js).
// The free report reads what is already known. Asking sends idle sessions a question, which spends
// tokens, so it is a separate button that says so.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const bar = $('huddle-bar'), freeBtn = $('huddle-free'), askBtn = $('huddle-ask'), leadBox = $('huddle-lead'), leadLabel = $('huddle-lead-label');
  const section = $('huddle-report'), headline = $('huddle-headline'), note = $('huddle-note'), rows = $('huddle-rows'), floor = section.closest('.floor');
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel'), key = params.get('key') || '';
  if (!channel) return;

  const url = location.origin + '/channels/' + encodeURIComponent(channel) + '/huddle?key=' + encodeURIComponent(key);
  function api(body) {
    const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    return fetch(url, opt).then((r) => r.json()).catch(() => ({ ok: false, message: 'The relay did not answer.' }));
  }
  try { leadBox.checked = localStorage.getItem('office.huddleLead') !== '0'; } catch (e) { /* no storage */ }
  leadBox.addEventListener('change', () => { try { localStorage.setItem('office.huddleLead', leadBox.checked ? '1' : '0'); } catch (e) { /* no storage */ } draw(last); });

  let last = null, closedId = null, pressing = false, drawn = '';
  const workers = () => (window.run ? window.run.state().workers : []);
  function open(on) { section.hidden = !on; floor.dataset.huddle = on ? '1' : ''; }

  function leadWords(s) {
    const n = s.leadNews;
    if (!n || n.state === 'off') return '';
    if (n.state === 'none') return 'No Lead to tell.';
    if (n.state === 'saved') return 'Saved for the Lead until it is idle.';
    if (n.state === 'delivered') return 'The Lead has it.';
    return 'Nothing could be typed into the Lead for an hour, so it did not get this. Text left in its prompt holds typing until Enter.';
  }
  function others() {
    const list = workers().filter((w) => w.present && w.session && !w.session.terminal);
    return list.length ? 'Not in this report, since they run in another terminal: ' + list.map((w) => w.name).join(', ') + '.' : '';
  }
  function row(r) {
    const li = document.createElement('li');
    li.dataset.status = r.status; li.dataset.needs = r.needs ? '1' : '';
    if (r.needs) { const b = document.createElement('b'); b.textContent = r.needs; li.append(b); }
    li.append(r.line);
    if (r.pr && r.pr.url) { const a = document.createElement('a'); a.href = r.pr.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'PR'; li.append(a); }
    return li;
  }
  function draw(s) {
    if (!s || !s.ok) return;
    last = s;
    const lead = !!s.lead && leadBox.checked;
    leadLabel.hidden = !s.lead;
    freeBtn.textContent = lead ? 'Huddle · free, plus one Lead turn' : 'Huddle · free';
    freeBtn.disabled = pressing || s.open;
    askBtn.disabled = pressing || s.open || !s.askable;
    const turns = s.askable + (lead ? 1 : 0);
    askBtn.textContent = s.open ? 'Asking' : s.askable ? 'Ask ' + s.askable + ' idle · spends ' + turns + (turns === 1 ? ' turn' : ' turns') + ' of tokens' + (lead ? ', one the Lead\'s' : '') : 'Ask idle · nobody idle';
    const report = s.report;
    if (!report) return;
    const waiting = !report.finished && s.open ? 'Waiting for ' + s.waitingFor + ' of ' + report.asked + ' to answer, for up to ' + report.answerSeconds + ' seconds. Working sessions are left alone.' : '';
    const text = [report.ghProblem ? 'gh failed, so PR and pipeline status is unknown: ' + report.ghProblem + '.' : '', waiting, report.finished ? leadWords(s) : '', others()].filter(Boolean).join(' ');
    const state = JSON.stringify([report, text]);
    if (state === drawn) return;
    drawn = state;
    $('huddle-title').textContent = 'Huddle · ' + new Date(report.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    headline.textContent = report.rows.length ? report.headline : 'Nobody is running.';
    note.textContent = text; note.hidden = !text; note.dataset.bad = report.ghProblem ? '1' : '';
    rows.textContent = '';
    report.rows.forEach((r) => rows.append(row(r)));
    if (report.id !== closedId) open(true);
  }
  async function press(ask) {
    pressing = true; draw(last);
    if (window.run) window.run.do({ action: 'huddle', source: 'viewer' });
    const names = {};
    for (const w of workers()) if (w.session && w.session.terminal) names[w.session.terminal] = w.name;
    const s = await api({ ask, lead: leadBox.checked, names });
    pressing = false;
    if (s.ok) { closedId = null; draw(s); return; }
    open(true);
    headline.textContent = s.message || 'The huddle did not start.';
    draw(last);
  }
  freeBtn.addEventListener('click', () => press(false));
  askBtn.addEventListener('click', () => press(true));
  $('huddle-close').addEventListener('click', () => { closedId = last && last.report ? last.report.id : null; open(false); });

  // The terminal has to be on, and only the page on this computer gets an answer.
  api().then((s) => {
    if (!s.ok) return;
    bar.hidden = false;
    closedId = s.report ? s.report.id : null;  // an old report does not jump open on a reload
    draw(s);
    setInterval(() => api().then(draw), 2000);
  });
})();
