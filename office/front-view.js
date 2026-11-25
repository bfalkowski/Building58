// Draws the front office (the Lead and PM seats, Today, Up next) and the workers row (one card for each
// ticket, its Dev beside the reviewer of its PR) from what office/front.js works out. It reads the Floor
// (office/desks.js sends office:floor), Needs you (office/needs-you.js sends office:needs), the Board
// (the office:tickets stream, or GET /tickets while it does not come) and the day's numbers (GET /metrics).
// Clicking a seat or a desk picks that session for the Claude Code panel (office:pick). A card or seat that
// waits on you, or is stuck, gets a steady light and a coloured edge, and pulses once when it first enters
// the state, never twice and never with reduced motion. See docs/manual/how-it-works.html#front-office.
(function () {
  'use strict';
  const F = window.OfficeFront;
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel');
  const $ = (id) => document.getElementById(id);
  const seatsEl = $('seats'), cardsEl = $('cards');
  if (!F || !channel || !seatsEl || !cardsEl) return;

  const base = location.origin + '/channels/' + encodeURIComponent(channel);
  let floor = { sessions: [], pm: null }, needs = [], board = null, metrics = null, selected = null, pushed = false, ready = false;
  const seen = { floor: false, needs: false, board: false };
  const known = new Map();
  const drawn = {};

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const link = (href, text, title) => {
    const a = el('a', 'lnk', text);
    a.href = href; a.target = '_blank'; a.rel = 'noopener';
    if (title) a.title = title;
    return a;
  };
  const slug = () => F.repoSlug([].concat(floor.sessions.map((r) => r.desk && r.desk.pr), ((board && board.tickets) || []).map((t) => t.task && t.task.pr)));
  const ticketLink = (id) => link(F.ticketHref(id, board && board.store, slug(), channel), id, 'Open ticket ' + id);
  window.OfficeLinks = { ticket: (id) => F.ticketHref(id, board && board.store, slug(), channel) };
  const prLink = (url, number) => link(url, 'PR ' + number, 'Open PR ' + number + ' on GitHub');
  const prUrlOf = (n) => { const s = slug(); return s ? 'https://github.com/' + s + '/pull/' + n : null; };

  const TOKEN = /\bPR #?(\d+)\b|\b[Tt]icket (\d+)\b|\b(T-\d+)\b/g;
  function words(text, into) {
    let at = 0, m;
    TOKEN.lastIndex = 0;
    const s = String(text || '');
    while ((m = TOKEN.exec(s))) {
      const pr = m[1] && prUrlOf(m[1]);
      if (m[1] && !pr) continue;
      into.append(s.slice(at, m.index));
      if (m[1]) into.append(prLink(pr, '#' + m[1]));
      else { into.append(m[2] ? 'ticket ' : ''); into.append(ticketLink(m[2] || m[3])); }
      at = m.index + m[0].length;
    }
    into.append(s.slice(at));
    return into;
  }
  function pick(terminal) {
    const w = window.run && window.run.state().workers.find((x) => x.session && x.session.terminal === terminal);
    if (w) window.dispatchEvent(new CustomEvent('office:pick', { detail: { who: w.id } }));
  }
  function pickButton(terminal, label, cls) {
    const b = el('button', cls || 'hit');
    b.type = 'button'; b.dataset.terminal = terminal || ''; b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(!!terminal && terminal === selected));
    b.addEventListener('click', () => pick(terminal));
    return b;
  }
  const lamp = (state) => { const l = el('span', 'lamp'); l.dataset.lamp = state; l.setAttribute('aria-hidden', 'true'); return l; };
  const dot = (state) => { const d = el('span', 'dot'); d.dataset.dot = state; d.setAttribute('aria-hidden', 'true'); return d; };

  function seatNode(seat) {
    const node = el('div', 'seat');
    node.dataset.seat = seat.kind; node.dataset.state = seat.state;
    if (seat.terminal) node.dataset.terminal = seat.terminal;
    const top = el('div', 'seat-top'), role = el('span', 'role');
    role.append(seat.state ? lamp(seat.state) : dot(seat.dot), seat.role);
    top.append(role, el('span', 'always', 'always on'));
    const who = el('div', 'who', seat.name || '');
    if (seat.rung) who.append(el('span', 'rung', ' · ' + seat.rung));
    const doing = words(seat.doing, el('div', 'doing'));
    const next = el('div', 'next');
    if (seat.reason) next.append(el('span', 'why', seat.reason.text + ' '));
    words(seat.next ? (seat.reason ? '' : 'Next: ') + seat.next : '', next);
    if (seat.proposal) next.append(' ' + seat.proposal);
    if (seat.sort) next.append(' ' + seat.sort);
    node.append(top, who, doing, next);
    const tired = seat.row && seat.row.tired;
    if (tired) {
      const t = el('div', 'tired', tired.icon + ' ' + tired.label[0].toUpperCase() + tired.label.slice(1) + ' \u00b7 context ' + tired.percent + '% used');
      t.dataset.level = tired.key;
      node.append(t);
    }
    if (seat.terminal) node.prepend(pickButton(seat.terminal, seat.role + ' ' + seat.name + ': ' + seat.doing, 'hit'));
    return node;
  }
  function namedOf(terminal) {
    const w = window.run && window.run.state().workers.find((x) => x.session && x.session.terminal === terminal);
    return window.OfficeSeats ? window.OfficeSeats.titleBeside(w && w.session && w.session.customTitle) : { text: '', full: '' };
  }
  function deskNode(row, kind) {
    const d = row.desk || {}, doing = d.doing || {};
    const b = el('div', 'desk');
    b.dataset.terminal = row.terminal;
    const dotState = doing.state === 'stuck' ? 'err' : doing.state === 'working' ? 'work' : doing.state === 'waiting' ? 'wait' : 'idle';
    const name = el('span', 'name'), named = namedOf(row.terminal);
    name.append(dot(dotState), el('b', '', row.name), ' ', el('span', 'kind', kind));
    if (named.text) { const em = el('em', 'named', named.text); em.title = named.full; name.append(em); }
    const what = el('span', 'ticket', row.role === 'reviewer' ? (d.prNumber ? 'PR ' + d.prNumber + ' · ' : '') + (d.review || '') : (row.title || ''));
    const state = el('span', 'state', [doing.words, d.column && d.column.label].filter(Boolean).join(' · '));
    b.append(pickButton(row.terminal, row.name + ', ' + kind + ': ' + (doing.words || ''), 'hit'), name, what, state);
    if (d.status) b.append(el('span', 'status', d.status.icon + ' ' + d.status.label));
    if (d.next) b.append(el('span', 'next', 'Next: ' + d.next.text));
    if (d.stop && d.stop.safe) {
      const stop = el('span', 'desk-stop'), btn = el('button', 'btn', 'Stop');
      btn.type = 'button'; btn.setAttribute('aria-label', 'Stop ' + row.name);
      btn.addEventListener('click', () => window.dispatchEvent(new CustomEvent('office:stop-desk', { detail: row.terminal })));
      stop.append('Safe to stop: ' + d.stop.reason + ' ', btn);
      b.append(stop);
    }
    return b;
  }
  function slotNode(card) {
    const s = card.slot;
    if (s.live) return deskNode(s.live, 'Reviewer');
    const e = el('div', 'desk empty', s.none);
    e.append(el('br'), s.hint);
    return e;
  }
  function cardNode(card) {
    const node = el('div', 'pair');
    node.dataset.card = card.key; node.dataset.state = card.state;
    const cap = el('div', 'pair-cap');
    if (card.reason) cap.append(lamp(card.reason.kind), el('span', 'why', card.reason.text), ' · ');
    if (card.ticket) cap.append('Ticket ', ticketLink(card.ticket));
    else cap.append(card.title);
    cap.append(' · PR ');
    if (card.pr) cap.append(link(card.pr, card.prNumber, 'Open PR ' + card.prNumber + ' on GitHub')); else cap.append('not started');
    if (card.stage && !(card.reason && card.reason.kind === 'wait' && card.stage === 'waits on you')) cap.append(' · ' + card.stage);
    const mid = el('div', 'link');
    mid.append(el('span', '', card.slot.word), el('span', 'line'), el('span', '', card.slot.live || card.rounds ? card.rounds + (card.rounds === 1 ? ' round' : ' rounds') : ''));
    if (!card.slot.live && !card.pr) mid.dataset.later = '1';
    node.append(cap, deskNode(card.dev, 'Dev'), mid, slotNode(card));
    return node;
  }
  function extraNode(x) {
    const node = el('div', 'pair single');
    node.dataset.card = x.key; node.dataset.state = x.state;
    const cap = el('div', 'pair-cap');
    if (x.reason) cap.append(lamp(x.reason.kind), el('span', 'why', x.reason.text), ' · ');
    cap.append(x.row.role === 'reviewer' ? 'Reviewer' : x.row.role);
    node.append(cap, deskNode(x.row, x.row.role));
    return node;
  }
  function freeNode() { return el('div', 'desk empty free', 'free desk'); }

  function pulse(node, key, state) {
    const was = known.get(key);
    known.set(key, state);
    if (!ready || !state || was === state) return;
    node.classList.add('pulse-once');
    node.addEventListener('animationend', () => node.classList.remove('pulse-once'), { once: true });
  }
  function put(host, nodes, signature, name) {
    if (drawn[name] === signature) return false;
    drawn[name] = signature;
    host.replaceChildren(...nodes);
    return true;
  }

  function drawSeats() {
    const rows = floor.sessions, pm = floor.pm ? Object.assign({ now: Date.now() }, floor.pm) : null;
    const seats = [F.seatOf('lead', rows, needs, board && board.tickets, null), F.seatOf('pm', rows, needs, board && board.tickets, pm)];
    const sig = JSON.stringify([seats.map((s) => [s.kind, s.name, s.state, s.dot, s.doing, s.next, s.proposal, s.rung, s.sort, s.reason && s.reason.text, s.terminal]), selected, board && board.store, slug(), Math.floor(Date.now() / 60000)]);
    const nodes = seats.map(seatNode);
    if (put(seatsEl, nodes, sig, 'seats')) seats.forEach((s, i) => pulse(nodes[i], 'seat:' + s.kind, s.state));
  }
  function drawToday() {
    const t = F.todayOf(metrics, needs.length, floor.sessions), line = $('today');
    line.hidden = false;
    const sig = JSON.stringify(t);
    if (drawn.today === sig) return;
    drawn.today = sig;
    line.replaceChildren(el('span', 'tl', 'Today'), (t.merged === null ? 'no numbers yet' : t.merged + ' merged') + (t.median ? ' · median ' + t.median + ' per ticket' : '') + ' · ',
      el('span', t.waiting ? 'you-n' : '', t.waiting + ' wait on you'), ' · ' + t.free + ' of ' + t.desks + ' desks free');
  }
  function approve(id, b) {
    b.disabled = true; b.textContent = 'Approving';
    fetch(base + '/tickets/' + encodeURIComponent(id) + '/proposal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) })
      .then((r) => r.json()).catch(() => null).then((r) => { b.textContent = r && r.ok ? 'Approved' : 'Not approved'; if (r && !r.ok) b.title = r.message || ''; });
  }
  function drawUpNext() {
    const sec = $('up-next');
    if (!board || !board.ok) { sec.hidden = true; return; }
    sec.hidden = false;
    const up = F.upNext(board.tickets, 5), rung = floor.pm ? floor.pm.trust : null;
    const sig = JSON.stringify([up, rung, board.store, slug()]);
    if (drawn.upnext === sig) return;
    drawn.upnext = sig;
    $('up-next-meta').textContent = (rung === null ? '' : 'PM trust ' + rung + ' · ') + 'order Autopilot takes them';
    const list = $('up-next-list');
    list.replaceChildren(...up.items.map((it) => {
      const li = el('li');
      li.dataset.ticket = it.id;
      if (it.verdict.you) li.className = 'you';
      if (it.verdict.why) li.title = 'PM: ' + it.verdict.why;
      const v = el('span', 'verdict ' + it.verdict.key, (it.verdict.mark ? it.verdict.mark + ' ' : '') + it.verdict.words);
      if (it.verdict.why) v.title = 'PM: ' + it.verdict.why;
      li.append(el('span', 'n', String(it.n)), ticketLink(it.id), el('span', 't', it.title), el('span', 'pri', it.priority), v);
      if (it.verdict.you) {
        const a = el('button', 'btn approve', 'Approve');
        a.type = 'button'; a.title = 'Approve the PM\'s proposal';
        a.addEventListener('click', () => approve(it.id, a));
        li.append(a);
      }
      return li;
    }));
    const more = $('up-next-more');
    more.replaceChildren();
    if (up.more) more.append(link('board.html?channel=' + encodeURIComponent(channel), '… ' + up.more + ' more in Ready'), ' · hover a verdict for the PM\'s reason');
    else if (!up.items.length) more.append('No ticket is ready to start.');
  }
  function drawWorkers() {
    const { cards, extras } = F.cardsOf(floor.sessions, needs);
    const workers = floor.sessions.filter((r) => !r.seat && r.role !== 'PM').length, free = Math.max(0, F.WORKER_DESKS - workers);
    const reviewers = floor.sessions.filter((r) => r.role === 'reviewer').length, ticketed = cards.filter((c) => c.ticket).length;
    $('workers-meta').textContent = workers + (workers === 1 ? ' worker' : ' workers') + ' on ' + ticketed + (ticketed === 1 ? ' ticket' : ' tickets') + ' · ' + reviewers + (reviewers === 1 ? ' reviewer' : ' reviewers') + ' · ' + free + (free === 1 ? ' desk' : ' desks') + ' free';
    const sig = JSON.stringify([cards.map((c) => [c.key, c.header, c.state, c.slot.live && c.slot.live.terminal, c.slot.none, c.slot.hint, c.rounds, c.dev.name, c.dev.desk.doing, c.dev.desk.status, c.slot.live && c.slot.live.desk.doing]), extras.map((x) => [x.key, x.header, x.state, x.row.name, x.row.desk.doing]), free, selected, board && board.store, slug(), floor.sessions.map((r) => namedOf(r.terminal).full)]);
    const nodes = [...cards.map(cardNode), ...extras.map(extraNode), ...Array.from({ length: free }, freeNode)];
    if (put(cardsEl, nodes, sig, 'cards')) {
      cards.forEach((c, i) => pulse(nodes[i], 'card:' + c.key, c.state));
      extras.forEach((x, i) => pulse(nodes[cards.length + i], 'card:' + x.key, x.state));
    }
  }
  function draw() {
    drawSeats(); drawToday(); drawUpNext(); drawWorkers();
    ready = seen.floor && seen.needs && seen.board;
  }

  window.addEventListener('office:floor', (ev) => { floor = ev.detail || floor; seen.floor = true; draw(); });
  window.addEventListener('office:needs', (ev) => { needs = (ev.detail && ev.detail.items) || []; seen.needs = true; draw(); });
  window.addEventListener('office:stream', (ev) => { pushed = !!(ev.detail && ev.detail.tickets); });
  window.addEventListener('office:tickets', (ev) => { if (ev.detail && ev.detail.ok) { pushed = true; board = ev.detail; seen.board = true; draw(); } });
  window.addEventListener('office:selected', (ev) => {
    const w = window.run && window.run.state().workers.find((x) => x.id === ev.detail);
    selected = (w && w.session && w.session.terminal) || null;
    drawn.seats = drawn.cards = null;
    draw();
  });

  const read = (p) => fetch(base + p).then((r) => r.json()).catch(() => null);
  async function readBoard() {
    if (pushed) return;
    const r = await read('/tickets');
    if (pushed) return;
    if (r && r.ok) board = r;
    seen.board = true;
    draw();
  }
  async function readMetrics() {
    const r = await read('/metrics?range=1d');
    if (r && r.ok) { metrics = r; draw(); }
  }
  readBoard(); readMetrics();
  setInterval(readBoard, 10000);
  setInterval(readMetrics, 60000);
  setInterval(() => { if (floor.pm) draw(); }, 30000);
})();
