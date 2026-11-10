// The org chart behind the "Org chart" button: you at the top as the manager, everyone in the
// room under you, live. Clicking someone follows them and opens their session if it runs here,
// and Reorg rearranges the same people another way. Uses window.run and the office:pick event,
// and sends you to the Add worker folder field.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const run = window.run;
  if (!run) return;
  const R = window.OFFICE_ROSTER || {};
  const dlg = $('org'), scroller = dlg.querySelector('.org-scroll'), groupsEl = $('org-groups'), memo = $('org-memo'), stamp = $('org-stamp'), youStats = $('org-you-stats'), nextBtn = $('org-next');
  const reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const fmt = (s) => s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  // The COO and the security officer sit in Leadership while their session runs, at whichever desk it took.
  const isCoo = (w) => !!(w.session && w.session.work && ['coo', 'security'].includes(w.session.work.role));
  const stateOf = (w) => w.status === 'idle' ? (w.session ? 'ready' : 'free') : w.status;

  // ---------- the three ways to arrange people ----------
  const STATES = [['waiting', 'Needs you'], ['working', 'Working'], ['ready', 'Ready for a prompt'], ['free', 'Free']];
  const BENCH = 'The bench';
  const LAYOUTS = [
    { says: 'by job', groups: (people) => [
      ['Leadership', people.filter((w) => w.lead || isCoo(w))],
      ['Specialists', people.filter((w) => !w.lead && !isCoo(w) && !w.floater)],
      ['Hot desks', people.filter((w) => w.floater && !isCoo(w))]
    ] },
    { says: 'by project', groups: (people) => {
      const name = (w) => w.session ? w.session.project || 'Unnamed project' : w.status === 'idle' ? BENCH : 'No project';
      const names = [...new Set(people.map(name))].sort((a, b) => (a === BENCH) - (b === BENCH) || a.localeCompare(b));
      return names.map((n) => [n, people.filter((w) => name(w) === n)]);
    } },
    { says: 'by what they are doing', groups: (people) => STATES.map(([state, title]) => [title, people.filter((w) => stateOf(w) === state)]) }
  ];

  const REORGS_KEY = 'office.orgchart.reorgs';
  let reorgs = 0;
  try { reorgs = Math.max(0, parseInt(localStorage.getItem(REORGS_KEY), 10) || 0); } catch (e) { /* no storage */ }

  // ---------- a badge photo, drawn from the same look as the person in the scene ----------
  const SVG = 'http://www.w3.org/2000/svg';
  function shape(parent, tag, attrs) {
    const el = document.createElementNS(SVG, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    parent.appendChild(el);
    return el;
  }
  const CAP = 'M14.5 20a9.5 9.5 0 0 1 19 0c-3-3.5-6-4.5-9.5-4.5s-6.5 1-9.5 4.5z';
  function photo(look, backdrop) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 48 48'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'org-photo');
    const hair = look.hair || '#2a1d17', style = look.hairStyle || 'short', skin = look.skin || '#d6a27c';
    shape(svg, 'rect', { width: 48, height: 48, fill: backdrop });
    if (style === 'long') shape(svg, 'path', { d: 'M13 20a11 11 0 0 1 22 0v17h-6V20H19v17h-6z', fill: hair });
    if (style === 'bob') shape(svg, 'path', { d: 'M13 20a11 11 0 0 1 22 0v9h-6V20H19v9h-6z', fill: hair });
    shape(svg, 'path', { d: 'M7 48c0-10 7-15 17-15s17 5 17 15z', fill: look.shirt || '#556677' });
    if (look.tie) shape(svg, 'path', { d: 'M22 33h4l1.5 4-1.5 11h-4l-1.5-11z', fill: look.tie });
    shape(svg, 'rect', { x: 20.5, y: 26, width: 7, height: 8, rx: 3, fill: skin });
    shape(svg, 'circle', { cx: 24, cy: 20, r: 9.5, fill: skin });
    if (look.extra === 'beard') shape(svg, 'path', { d: 'M14.5 21c1 9 5 8.5 9.5 8.5s8.5.5 9.5-8.5c-2 3-5 3.5-9.5 3.5s-7.5-.5-9.5-3.5z', fill: hair });
    if (look.eyes !== false) [20.5, 27.5].forEach((cx) => shape(svg, 'circle', { cx, cy: 20, r: 1.1, fill: '#1c1714' }));
    if (style === 'beanie') shape(svg, 'path', { d: 'M14 18a10 10 0 0 1 20 0z', fill: look.beanie || '#c0392b' });
    else if (style === 'curly') [[16, 15], [20, 11.5], [25, 10.5], [30, 12.5], [32.5, 16]].forEach(([cx, cy]) => shape(svg, 'circle', { cx, cy, r: 3.6, fill: hair }));
    else if (style !== 'bald') shape(svg, 'path', { d: CAP, fill: hair, opacity: style === 'buzz' ? 0.7 : 1 });
    if (style === 'bun') shape(svg, 'circle', { cx: 24, cy: 8, r: 3.5, fill: hair });
    if (look.extra === 'glasses') {
      [20.5, 27.5].forEach((cx) => shape(svg, 'circle', { cx, cy: 20, r: 2.8, fill: 'none', stroke: '#1c1714', 'stroke-width': 0.9 }));
      shape(svg, 'path', { d: 'M23.3 20h1.4', stroke: '#1c1714', 'stroke-width': 0.9 });
    }
    if (look.extra === 'headphones') {
      shape(svg, 'path', { d: 'M13 20a11 11 0 0 1 22 0', fill: 'none', stroke: '#1c1714', 'stroke-width': 2 });
      [[11, 18], [34, 18]].forEach(([x, y]) => shape(svg, 'rect', { x, y, width: 3, height: 7, rx: 1.5, fill: '#1c1714' }));
    }
    return svg;
  }
  const looks = {};
  [R.lead].concat(R.workers || []).forEach((def) => { if (def) looks[def.id] = def.look || {}; });
  $('org-you-photo').replaceWith(photo({ skin: '#aab1bb', shirt: '#262a33', tie: '#b5523b', eyes: false }, '#e9dfc4'));

  // ---------- cards and columns, kept and moved so focus and animations survive a refresh ----------
  function close() { dlg.close(); }
  function openSession(who) {
    close();  // first, because closing hands focus back to the button and the terminal wants it
    window.dispatchEvent(new CustomEvent('office:pick', { detail: { who, keep: true } }));
  }
  const cards = new Map();
  function cardFor(w) {
    if (cards.has(w.id)) return cards.get(w.id);
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'org-card'; btn.style.setProperty('--c', w.color);
    btn.append(photo(looks[w.id] || {}, 'color-mix(in srgb, ' + w.color + ' 35%, #fffdf6)'));
    const text = document.createElement('span'); text.className = 'org-text';
    const line = (cls) => { const el = document.createElement('span'); el.className = cls; text.append(el); return el; };
    const name = line('org-name'); name.textContent = w.name;
    const role = line('org-role');
    const status = line('org-status'), detail = line('org-detail');
    const star = document.createElement('span'); star.className = 'org-star'; star.textContent = 'Employee of the month'; star.hidden = true;
    btn.append(text, star);
    btn.addEventListener('click', () => openSession(w.id));
    const card = { btn, name, role, status, detail, star };
    cards.set(w.id, card);
    return card;
  }
  const columns = new Map();
  function columnFor(key, title) {
    if (columns.has(key)) return columns.get(key);
    const el = document.createElement('section'); el.className = 'org-group';
    const h = document.createElement('h3'); h.textContent = title;
    const count = document.createElement('small');
    const list = document.createElement('div'); list.className = 'org-cards';
    h.append(count); el.append(h, list);
    const col = { el, list, count };
    columns.set(key, col);
    return col;
  }
  function setChildren(parent, wanted) {
    wanted.forEach((node, i) => { if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] || null); });
    while (parent.children.length > wanted.length) parent.lastChild.remove();
  }

  // the open desks: a real way to add a worker, when the panel can start one
  const hireCol = columnFor('open', 'Open headcount');
  hireCol.el.classList.add('org-hiring');
  const hireBtn = document.createElement('button');
  hireBtn.type = 'button'; hireBtn.className = 'org-card org-hire';
  hireBtn.addEventListener('click', () => {
    close();
    const folder = $('cc-cwd');
    folder.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    folder.focus({ preventScroll: true }); folder.select();
  });
  hireCol.list.append(hireBtn);

  // ---------- who gets the star: the most turns finished since this page opened ----------
  let finished = {};
  run.on('action', (e) => { if (e.action === 'reset') finished = {}; });
  run.on('worker.finished', (e) => {
    if (e.reason !== 'done' || e.source === 'viewer') return;  // Finish all earns nobody a star
    const f = finished[e.who] || (finished[e.who] = { turns: 0, seconds: 0 });
    f.turns++; f.seconds += e.seconds;
  });
  function employeeOfTheMonth(people) {
    let best = null;
    people.forEach((w) => {
      const f = finished[w.id]; if (!f) return;
      const b = best && finished[best];
      if (!b || f.turns > b.turns || (f.turns === b.turns && f.seconds > b.seconds)) best = w.id;
    });
    return best;
  }

  // ---------- drawing ----------
  function fillCard(w, s, star) {
    const c = cardFor(w), state = stateOf(w);
    c.btn.dataset.state = state;
    const role = (w.role || '') + (w.session && !w.session.terminal ? ' · other terminal' : '');
    if (c.name.textContent !== w.name) c.name.textContent = w.name;  // a session's name, or the desk's own
    if (c.role.textContent !== role) c.role.textContent = role;
    const waiting = s.waitingOnYou.find((x) => x.who === w.id);
    const status = state === 'waiting' ? 'Needs your OK' : state === 'working' ? 'Working · ' + fmt(w.task.seconds) : state === 'ready' ? 'Ready for a prompt' : 'Free';
    const detail = state === 'waiting' ? waiting.message : state === 'working' ? w.task.label : state === 'ready' ? w.session.title || w.session.project || w.session.id : w.doing;
    if (c.status.textContent !== status) c.status.textContent = status;
    if (c.detail.textContent !== detail) c.detail.textContent = detail;
    c.btn.title = detail + (w.session && w.session.project ? ' (' + w.session.project + ')' : '');
    c.star.hidden = !star;
  }
  // Slides cards from where they were to where they now are.
  function slide(change) {
    const before = new Map();
    cards.forEach((c) => { if (c.btn.isConnected) before.set(c.btn, c.btn.getBoundingClientRect()); });
    change();
    if (reduce) return;
    before.forEach((was, btn) => {
      if (!btn.isConnected) return;
      const now = btn.getBoundingClientRect(), dx = was.left - now.left, dy = was.top - now.top;
      if (dx || dy) btn.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    });
  }
  // Nothing moves under the pointer, so a click cannot land on the wrong person's session. The text still updates.
  function render(force) {
    const s = run.state();
    const people = s.workers.filter((w) => w.present);
    const star = employeeOfTheMonth(people);
    people.forEach((w) => fillCard(w, s, w.id === star));
    const waiting = s.waitingOnYou;
    youStats.textContent = plural(people.length, 'direct report') + ' · ' + s.busy + ' busy · ' + (waiting.length ? waiting.length + ' waiting on you' : 'nobody waiting on you');
    youStats.dataset.waiting = String(waiting.length > 0);
    $('org-clock').textContent = 'Effective ' + s.clock;
    if (!force && scroller.matches(':hover')) return;
    const open = s.workers.length - people.length;
    const wanted = LAYOUTS[reorgs % LAYOUTS.length].groups(people)
      .filter(([, members]) => members.length)
      .map(([title, members]) => {
        const col = columnFor(LAYOUTS[reorgs % LAYOUTS.length].says + '/' + title, title);
        col.count.textContent = members.length;
        // needs you first, as on the Floor list; otherwise roster order, so nobody jumps about
        const order = members.map((w) => [STATES.findIndex(([k]) => k === stateOf(w)), w]).sort((a, b) => a[0] - b[0]).map(([, w]) => w);
        return { col, buttons: order.map((w) => cardFor(w).btn) };
      });
    const active = document.activeElement;
    slide(() => {
      wanted.forEach(({ col, buttons }) => setChildren(col.list, buttons));
      setChildren(groupsEl, wanted.map(({ col }) => col.el).concat(open > 0 ? [hireCol.el] : []));
    });
    if (active && active !== document.activeElement) (active.isConnected ? active : $('org-reorg')).focus({ preventScroll: true });  // moving or removing a card drops its focus
    if (open > 0) {
      const canHire = !$('cc-cwd').disabled;
      hireCol.count.textContent = open;
      hireBtn.disabled = !canHire;
      hireBtn.textContent = canHire ? plural(open, 'empty desk') + '. Hire someone: Add worker.' : plural(open, 'empty desk') + '. Hiring is closed: see the note in the Claude Code panel.';
    }
    nextBtn.hidden = !waiting.length;
    if (waiting.length) { nextBtn.textContent = 'Go to ' + waiting[0].name; nextBtn.dataset.who = waiting[0].who; }
  }
  function writeMemo(heard) {
    memo.textContent = (reorgs ? 'Reorg #' + reorgs + ': everyone now sits ' + LAYOUTS[reorgs % LAYOUTS.length].says + '. Nothing else changes.' : 'Everyone reports to you. Press Reorg to arrange them another way.') + (heard ? ' ' + heard : '');
  }

  // ---------- the room hears about it ----------
  const QUIPS = ['Another reorg?', 'Who do I report to now?', 'Do I keep my desk?', 'Is this about the ping pong?', 'Love what we are doing here.', 'Should I update my badge?'];
  function grumble() {
    const here = run.state().workers.filter((w) => w.present);
    if (!here.length) return '';
    const who = here[Math.floor(Math.random() * here.length)], text = QUIPS[Math.floor(Math.random() * QUIPS.length)];
    run.do({ action: 'say', who: who.id, text, source: 'viewer' });
    return who.name + ': "' + text + '"';  // the sheet covers the scene, so the memo repeats it
  }

  // ---------- buttons ----------
  $('org-company').textContent = R.company || 'Building58';
  $('org-btn').addEventListener('click', () => { stamp.hidden = true; writeMemo(); render(true); dlg.showModal(); });
  $('org-close').addEventListener('click', close);
  nextBtn.addEventListener('click', () => openSession(nextBtn.dataset.who));
  // the backdrop, only when the press started there: a drag out of the sheet also clicks the dialog
  let pressedBackdrop = false;
  dlg.addEventListener('pointerdown', (ev) => { pressedBackdrop = ev.target === dlg; });
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg && pressedBackdrop) close(); });
  $('org-reorg').addEventListener('click', () => {
    reorgs++;
    try { localStorage.setItem(REORGS_KEY, String(reorgs)); } catch (e) { /* no storage */ }
    render(true); writeMemo(grumble());
    stamp.textContent = 'Reorganized #' + reorgs; stamp.hidden = false;
    if (!reduce) stamp.animate([{ transform: 'rotate(-9deg) scale(2.2)', opacity: 0 }, { transform: 'rotate(-9deg) scale(1)', opacity: 0.8 }], { duration: 200, easing: 'ease-in' });
  });
  setInterval(() => { if (dlg.open) render(); }, 1000);
})();
