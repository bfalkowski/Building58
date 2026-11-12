// The floor board beside the scene: who is busy, on what, for how long, and a feed of what
// happened. Also the controls under the scene. Uses the public API in window.run, and what each
// desk says from office/desks.js (the office:desks event).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const run = window.run;
  const list = $('people'), feed = $('feed'), busyEl = $('busy'), hudBusy = $('hud-busy');
  if (!run) {
    busyEl.textContent = 'unavailable';
    document.querySelectorAll('.toolbar button:not(#radio-btn, #radio-next), .toolbar select').forEach((b) => { b.disabled = true; });
    return;
  }
  const R = window.OFFICE_ROSTER || {};
  const roomName = R.company || 'Building58';
  // The room's own name, then Building58 when it has another (office/roster.js, ?name=).
  const pageTitle = roomName === 'Building58' ? roomName : roomName + ' · Building58';
  $('title').textContent = roomName;
  $('hud-company').textContent = roomName;
  document.title = pageTitle;

  const fmt = (s) => s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  let selected = null;

  // ---------- the people list ----------
  const rows = {};
  function row(w) {
    if (rows[w.id]) return rows[w.id];
    const li = document.createElement('li');
    // The person's button lies behind the text, since the ticket's number is a button of its own and one cannot hold the other.
    li.innerHTML = '<button type="button" class="person" aria-pressed="false"></button><i></i><span class="who"><b></b><small><span></span><button type="button" class="ticket" hidden></button><span></span></small></span><time></time><span class="doing"></span>' +
      '<span class="desk" hidden><span class="desk-tired" hidden><span aria-hidden="true"></span><span></span></span><span class="desk-status" hidden><span aria-hidden="true"></span><span></span></span><span class="desk-pair" hidden></span><span class="desk-now"></span><a class="desk-pr" target="_blank" rel="noopener" hidden></a><span class="desk-state"></span><span class="desk-next"></span><span class="desk-stop" hidden><span></span><button type="button" class="btn">Stop</button></span></span>';
    li.style.setProperty('--c', w.color);
    const b = li.querySelector('.person'), link = li.querySelector('.ticket'), [before, after] = li.querySelectorAll('small > span');
    link.addEventListener('click', () => { if (link.ticket) window.dispatchEvent(new CustomEvent('office:ticket', { detail: link.ticket })); });
    b.addEventListener('click', () => window.dispatchEvent(new CustomEvent('office:pick', { detail: { who: w.id } })));
    li.querySelector('b').textContent = w.name;
    const q = (sel) => li.querySelector(sel);
    const r = { id: w.id, li, btn: b, name: li.querySelector('b'), link, before, after, time: q('time'), doing: q('.doing'), desk: q('.desk'), status: q('.desk-status'), statusIcon: q('.desk-status > span'), statusLabel: q('.desk-status > span + span'), pair: q('.desk-pair'), now: q('.desk-now'), pr: q('.desk-pr'), state: q('.desk-state'), next: q('.desk-next'), stop: q('.desk-stop'), stopWhy: q('.desk-stop > span'), stopBtn: q('.desk-stop button'), tired: q('.desk-tired'), tiredIcon: q('.desk-tired > span'), tiredLabel: q('.desk-tired > span + span') };
    r.stopBtn.addEventListener('click', () => { if (r.terminal) window.dispatchEvent(new CustomEvent('office:stop-desk', { detail: r.terminal })); });
    rows[w.id] = r; return r;
  }
  const put = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  // What the row says after the name: a ticket's number first, as a button to it on the Board.
  function fillWork(r, w) {
    // A PR past its automatic reviews (relay/reviews.js) says so, since its next review is the person's.
    const work = w.session && w.session.work, elsewhere = (w.session && !w.session.terminal ? ' · other terminal' : '') + (work && work.reviewWaits ? ' · PR waits on your review' : '');
    const text = !w.session ? 'free' : (work && work.label) || w.session.title || w.session.project || w.session.id;
    const at = work && work.ticket ? text.indexOf(work.ticket) : -1;
    const ticketed = at >= 0;
    put(r.before, ticketed ? text.slice(0, at) : text + elsewhere);
    put(r.link, ticketed ? work.ticket : '');
    put(r.after, ticketed ? text.slice(at + work.ticket.length) + (work.pr ? ' · PR #' + work.pr.split('/').pop() : '') + elsewhere : '');
    r.link.hidden = !ticketed;
    r.link.ticket = ticketed ? { id: work.ticket, at: work.ticketAt } : null;
    r.link.title = ticketed ? 'Show ' + work.ticket + ' on the Board' : '';
    return r.before.textContent + r.link.textContent + r.after.textContent;
  }
  // What the desk says (relay/desk.js): what it is doing, the column, the PR with CI and review, the
  // next step and who owns it, and Safe to stop with a Stop button. Only a session the room started has one.
  let desks = window.OFFICE_DESKS || {};
  window.addEventListener('office:desks', (ev) => { desks = ev.detail || {}; render(); });
  // Who reviews whom: a reviewer drawn under its Dev names the PR and that Dev, a reviewer on its own
  // names only the PR, and a Dev names who reviews its PR (relay/desk.js, pairReviewers).
  function pairText(d, under) {
    if (d.reviewing) return 'reviewing PR ' + d.reviewing.prNumber + (under && d.reviewing.dev ? ' for ' + d.reviewing.dev.name : '');
    const by = (d.reviewedBy || []).map((x) => x.name);
    return by.length ? 'reviewed by ' + (by.length > 1 ? by.slice(0, -1).join(', ') + ' and ' + by[by.length - 1] : by[0]) : '';
  }
  function fillDesk(r, w, under) {
    const d = w.session && w.session.terminal ? desks[w.session.terminal] : null;
    r.terminal = d ? w.session.terminal : null;
    r.desk.hidden = !d;
    if (!d) return '';
    r.li.dataset.next = d.next && /^Waiting on you/.test(d.next.text) ? 'you' : '';  // amber only for a step that waits on you
    // How tired the Lead is: how full its context is (relay/lead-tired.js). The percentage is on hover.
    const tired = d.lead ? d.tired : null;
    r.tired.hidden = !d.lead;
    r.tired.dataset.level = tired ? tired.key : '';
    put(r.tiredIcon, tired ? tired.icon : '?');
    put(r.tiredLabel, tired ? tired.label[0].toUpperCase() + tired.label.slice(1) : 'Context use not known yet');
    const tiredSays = tired ? 'Context ' + tired.percent + '% used since its last /clear or refresh: ' + tired.label : 'Its status line has not said how full its context is yet';
    if (r.tired.title !== tiredSays) r.tired.title = tiredSays;
    // A Dev's status icon, with its label beside it, so it reads without knowing the icons.
    r.status.hidden = !d.status;
    r.status.dataset.status = d.status ? d.status.key : '';
    put(r.statusIcon, d.status ? d.status.icon : '');
    put(r.statusLabel, d.status ? d.status.label : '');
    put(r.pair, pairText(d, under));
    r.pair.hidden = !r.pair.textContent;
    put(r.now, [d.doing.words, d.column && d.column.label].filter(Boolean).join(' · '));
    put(r.pr, d.prNumber ? 'PR ' + d.prNumber : '');
    r.pr.hidden = !d.pr;
    if (d.pr && r.pr.getAttribute('href') !== d.pr) r.pr.setAttribute('href', d.pr);
    put(r.state, [d.ciWords, d.review].filter(Boolean).join(' · '));
    put(r.next, d.next ? 'Next: ' + d.next.text + (d.next.owner === 'you' || /^(Done|Waiting on you)/.test(d.next.text) ? '' : ' (' + d.next.owner + ')') : '');
    r.stop.hidden = !d.stop.safe;
    put(r.stopWhy, d.stop.safe ? 'Safe to stop: ' + d.stop.reason : '');
    r.stopBtn.setAttribute('aria-label', 'Stop ' + w.name);
    return ' ' + [d.lead ? tiredSays : '', d.status ? 'Status: ' + d.status.label : '', r.pair.textContent, r.now.textContent, r.pr.textContent, r.state.textContent, r.next.textContent, r.stopWhy.textContent].filter(Boolean).join('. ');
  }
  // a person, from the scene, this list or the terminal: follow them. Clicking again stops following.
  window.addEventListener('office:pick', (ev) => {
    const { who, keep } = ev.detail;
    selected = selected === who && !keep ? null : who;
    run.focus(selected);
    Object.values(rows).forEach((r) => r.btn.setAttribute('aria-pressed', String(r.id === selected)));
  });
  // needs you, then working, then ready for a prompt, then free
  const rank = (w) => ({ waiting: 0, working: 1 })[w.status] ?? (w.session ? 2 : 3);
  function render() {
    const s = run.state();
    Object.values(rows).forEach((r) => { if (!s.workers.some((w) => w.id === r.id && w.present)) r.li.remove(); });
    const sorted = s.workers.filter((w) => w.present).sort((a, b) => rank(a) - rank(b) || (b.task ? b.task.seconds : 0) - (a.task ? a.task.seconds : 0));
    // Each reviewer goes right under the Dev whose PR it reviews, when that Dev is on the list too.
    const termOf = (w) => (w.session && w.session.terminal) || null;
    const here = new Set(sorted.map(termOf).filter(Boolean));
    const devOf = (w) => { const d = termOf(w) && desks[termOf(w)], dev = d && d.reviewing && d.reviewing.dev; return dev && dev.terminal !== termOf(w) && here.has(dev.terminal) ? dev.terminal : null; };
    const people = [];
    sorted.filter((w) => !devOf(w)).forEach((w) => { people.push(w); if (termOf(w)) people.push(...sorted.filter((x) => devOf(x) === termOf(w))); });
    people.forEach((w, i) => {
      const r = row(w), under = !!devOf(w);
      if (list.children[i] !== r.li) list.insertBefore(r.li, list.children[i] || null);
      r.li.dataset.state = w.status;
      r.li.dataset.under = under ? '1' : '';
      put(r.name, w.name);  // the name the relay gave the session at this desk, or the desk's own
      const said = fillWork(r, w), ticketed = w.session && w.session.work && w.session.work.ticket;
      r.time.textContent = w.task ? fmt(w.task.seconds) : '';
      const doing = w.status === 'waiting' ? w.doing : w.task ? (ticketed ? w.task.last || 'Working' : w.task.label + (w.task.last ? '  ' + w.task.last : '')) : w.session ? (ticketed ? 'Ready for a prompt' : 'Ready for a prompt · ' + (w.session.title || w.doing)) : w.doing;
      put(r.doing, doing);
      const desk = fillDesk(r, w, under);
      r.btn.title = w.name + (w.session ? ', session ' + w.session.id : '') + (w.recent.length ? '. Recent: ' + w.recent.map((h) => h.label + ' (' + fmt(h.seconds) + ')').join(', ') : '');
      r.btn.setAttribute('aria-label', w.name + ': ' + said + '. ' + doing + '.' + desk);
    });
    const waiting = s.waitingOnYou.length;
    const text = s.busy + ' of ' + s.people + ' busy' + (waiting ? ', ' + waiting + ' waiting on you' : '');
    busyEl.textContent = text; hudBusy.textContent = text;
    document.title = (waiting ? '(' + waiting + ') ' : '') + pageTitle;
  }

  // ---------- the feed ----------
  let count = 0;
  function add(text, cls, clock) {
    const li = document.createElement('li'); if (cls) li.className = cls;
    const t = document.createElement('span'); t.className = 't'; t.textContent = (clock || '').replace(' ', '');
    const m = document.createElement('span'); m.textContent = text;
    li.append(t, m); feed.prepend(li); count++;
    while (feed.children.length > 120) feed.lastChild.remove();
    $('feed-count').textContent = count + ' events';
  }
  const nameOf = (id) => { const w = run.state().workers.find((x) => x.id === id); return w ? w.name : id; };
  function message(e) {
    switch (e.type) {
      case 'worker.assigned': return [e.name + ' started ' + e.label];
      case 'worker.finished': return [e.name + (e.reason === 'handed off' ? ' handed off ' : e.reason === 'quiet' ? ' stopped (no activity) ' : ' finished ') + e.label + ' in ' + fmt(e.seconds), 'sys'];
      case 'lead.waiting': return [nameOf(e.who) + ' needs you: ' + e.message];
      case 'lead.unblocked': return [nameOf(e.who) + ' unblocked', 'sys'];
      case 'hook':
        if (e.prUrl) return ['PR opened: ' + e.prUrl];
        if (e.event === 'UserPromptSubmit') return ['New prompt in session ' + (e.session || '')];
        if (e.event === 'Stop') return ['Turn finished in session ' + (e.session || ''), 'sys'];
        if (e.event === 'SessionStart') return ['Session ' + (e.session || '') + ' started', 'sys'];
        if (e.event === 'SessionEnd') return ['Session ' + (e.session || '') + ' ended', 'sys'];
        return null;
      case 'result': return e.ok ? null : [e.action + ': ' + e.result.message, 'err'];
      case 'office.live': return ['The room is open', 'sys'];
      case 'manager.arrived': return ['The manager walked in. Everyone looks very busy', 'sys'];
      case 'manager.left': return ['The manager left', 'sys'];
      case 'party.started': return ['Party! Hats on, and there is cake on the coffee table', 'sys'];
      case 'party.ended': return ['The party is over. Hats off, back to the desks', 'sys'];
      default: return null;
    }
  }
  run.events().forEach((e) => { const m = message(e); if (m) add(m[0], m[1], e.clock); });
  run.on('*', (e) => {
    const m = message(e); if (m) add(m[0], m[1], e.clock);
    if (e.type.startsWith('worker.') || e.type.startsWith('lead.') || e.type === 'hook') render();
  });
  render(); setInterval(render, 1000);

  // ---------- controls ----------
  $('finish').addEventListener('click', () => run.do({ action: 'done', all: true, source: 'viewer' }));
  const tagsBtn = $('tags-btn');
  tagsBtn.addEventListener('click', () => tagsBtn.setAttribute('aria-pressed', String(run.tags())));
  $('time').addEventListener('change', (ev) => run.time(ev.target.value));
  // Holiday decorations: the switch is kept in this browser, the preview lasts until the page closes.
  const decorBtn = $('decor-btn'), holidaySel = $('holiday');
  const showDecor = (s) => { decorBtn.setAttribute('aria-pressed', String(s.on)); holidaySel.value = s.preview || ''; };
  if (run.holiday) {
    showDecor(run.holiday());
    decorBtn.addEventListener('click', () => showDecor(run.holiday(run.holiday().on ? 'off' : 'on')));
    holidaySel.addEventListener('change', () => showDecor(run.holiday(holidaySel.value || 'auto')));
  }

  // A party is only a view: hats, a cake, and the free people round it. Pressed again, it ends.
  const partyBtn = $('party-btn');
  const partyOn = () => { const p = run.state().party; return p.on && !p.ending; };
  const showParty = () => { const on = partyOn(); partyBtn.setAttribute('aria-pressed', String(on)); partyBtn.textContent = on ? 'End the party' : 'Throw a party'; };
  partyBtn.addEventListener('click', () => run.do({ action: 'party', on: !partyOn(), source: 'viewer' }).then(showParty));
  ['party.started', 'party.ending', 'party.ended'].forEach((t) => run.on(t, showParty));
  showParty();

  // the demo plays pretend sessions through the same hook action the real hook uses
  const demoBtn = $('demo');
  let demoTimers = [];
  function stopDemo() { demoTimers.forEach(clearTimeout); demoTimers = []; demoBtn.textContent = 'Run a demo'; demoBtn.setAttribute('aria-pressed', 'false'); }
  demoBtn.addEventListener('click', () => {
    if (demoTimers.length) { stopDemo(); run.do({ action: 'reset', source: 'viewer' }); return; }
    if (!window.OFFICE_DEMO) return;
    const steps = window.OFFICE_DEMO();
    demoBtn.textContent = 'Stop the demo'; demoBtn.setAttribute('aria-pressed', 'true');
    steps.forEach(([at, payload], i) => {
      demoTimers.push(setTimeout(() => {
        run.do({ action: 'hook', event: payload, source: 'demo' });
        if (i === steps.length - 1) stopDemo();
      }, at * 1000));
    });
  });
})();
