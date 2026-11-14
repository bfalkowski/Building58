// The Games panel: the games in GAMES_REPO, a form to start a round, the round's seats while it runs,
// its score and reveal when it ends, and what each seat did (Steps), from the seat's own transcript. The
// relay runs the round (relay/games.js). This panel names no game: it shows what the relay sends, and
// a game's own words for itself and its numbers (about, metrics). Like the Tasks panel, it asks the
// relay every 2 seconds.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const section = $('games');
  if (!section) return;
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel'), key = params.get('key') || '';
  if (!channel) { section.hidden = true; return; }

  const list = $('game-list'), form = $('game-form'), pick = $('game-pick'), seatsIn = $('game-seats-n'), seedIn = $('game-seed');
  const watchIn = $('game-watch'), settingsIn = $('game-settings'), note = $('game-note');
  const roundBox = $('game-round'), seatRows = $('game-seats'), finishBtn = $('game-finish'), stopBtn = $('game-stop');
  const trustAll = $('game-trust-all'), trustNote = $('game-trust-note');
  const resultBox = $('game-result'), pastBox = $('game-past-box'), pastRows = $('game-past');
  const aboutBox = $('game-about'), doneNote = $('game-done');
  const stepsBox = $('game-steps'), stepRows = $('game-step-rows');

  const url = (p) => location.origin + '/channels/' + encodeURIComponent(channel) + p + '?key=' + encodeURIComponent(key);
  function api(p, body) {
    const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    return fetch(url(p), opt).then((r) => r.json()).catch(() => ({ ok: false, message: 'The relay did not answer.' }));
  }
  const say = (text, bad) => { note.textContent = text || ''; note.dataset.bad = bad ? '1' : ''; };
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const button = (text, fn) => { const b = el('button', text, 'btn'); b.type = 'button'; b.addEventListener('click', () => { b.blur(); fn(); }); return b; };
  const time = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

  // ---------- the games ----------
  let games = [], lastGames = '';
  function drawGames() {
    const text = JSON.stringify(games);
    if (text === lastGames) return;
    lastGames = text;
    list.textContent = '';
    if (!games.length) list.append(el('li', 'No games. Start the relay with GAMES_REPO set to a folder of games.', 'task-empty'));
    for (const g of games) {
      const li = el('li'); li.dataset.ok = g.ok ? '1' : '0';
      li.append(el('b', g.name || g.folder));
      const about = [g.folder, g.version && 'version ' + g.version, g.players && g.players.min + ' to ' + g.players.max + ' seats'].filter(Boolean).join(' · ');
      li.append(el('small', about));
      if (!g.ok) li.append(el('small', 'Cannot run: ' + (g.reason || 'the relay did not say why.')));
      list.append(li);
    }
    const before = pick.value;
    pick.textContent = '';
    for (const g of games.filter((x) => x.ok)) { const o = el('option', g.name || g.folder); o.value = g.folder; pick.append(o); }
    if (games.some((g) => g.ok && g.folder === before)) pick.value = before;
    fitSeats();
  }
  // The seat count stays inside the picked game's players.
  function fitSeats() {
    const g = games.find((x) => x.folder === pick.value);
    aboutBox.textContent = g && g.about ? g.about : '';
    aboutBox.hidden = !(g && g.about);
    form.querySelector('[type=submit]').disabled = !g || !!round;
    if (!g) return;
    seatsIn.min = g.players.min; seatsIn.max = g.players.max;
    const n = Number(seatsIn.value);
    if (!(n >= g.players.min && n <= g.players.max)) seatsIn.value = g.players.min;
  }
  pick.addEventListener('change', fitSeats);
  async function loadGames() {
    const r = await api('/games');
    if (r.ok) { games = r.games; drawGames(); }
  }

  // ---------- the round that runs ----------
  let round = null, lastRound = '';
  function seatPerson(terminal) {
    if (!window.run) return null;
    return window.run.state().workers.find((w) => w.session && w.session.terminal === terminal) || null;
  }
  function drawRound() {
    const text = JSON.stringify(round);
    if (text === lastRound) return;
    lastRound = text;
    roundBox.hidden = !round;
    fitSeats();
    if (!round) return;
    $('game-round-title').textContent = 'Round ' + round.id + ' · ' + nameOf(round.game);
    const about = $('game-round-about');
    // The relay counts each seat's tokens at API prices, plus what the game reports.
    const spend = '$' + Number(round.spentUsd || 0).toFixed(2) + (round.capUsd != null ? ' of $' + round.capUsd : '') + ' at API prices' + (round.unpriced && round.unpriced.length ? ' (no price for ' + round.unpriced.join(', ') + ')' : '');
    about.textContent = 'started ' + time(round.startedAt) + ' · watch ' + round.watch + ' · ' + spend + ' · ' + (round.isolation === 'sandbox' ? 'each seat in its own sandbox' : 'no boundary: seats can read your files');
    about.dataset.isolation = round.isolation;
    const waiting = round.seats.filter((s) => s.waiting === 'trust');
    trustAll.hidden = !waiting.length;
    trustNote.hidden = !waiting.length;
    // Every seat has worked and is idle now: the seats said they are done, so the person can finish.
    doneNote.hidden = !(round.seats.length && round.seats.every((s) => s.worked && (s.state === 'idle' || s.state === 'ended')));
    seatRows.textContent = '';
    for (const s of round.seats) {
      const li = el('li'); li.dataset.waiting = s.waiting || ''; li.dataset.state = s.state || ''; li.dataset.worked = s.worked ? '1' : '';
      const w = seatPerson(s.terminal);
      const doing = s.waiting ? '' : s.state === 'working' ? 'working' : s.worked && s.state === 'idle' ? 'done' : s.state === 'ended' ? 'ended' : 'starting';
      li.append(el('b', s.seat), el('small', [w && w.name, 'session ' + s.terminal, doing, s.tokens && tokens(s.tokens) + ', $' + Number(s.usd || 0).toFixed(2)].filter(Boolean).join(' · ')));
      if (s.waiting === 'trust') {
        li.append(el('small', 'Waiting on you: Claude Code asks whether to trust this seat\'s folder.'));
        li.append(button('Trust this seat\'s folder', () => trust([s])));
      }
      if (round.watch === 'all') {
        li.append(button('Show its screen', () => window.dispatchEvent(new CustomEvent('office:session', { detail: { terminal: s.terminal } }))));
        li.append(button('Steps', () => showSteps(round.id, s.seat)));
      }
      seatRows.append(li);
    }
  }
  // Claude Code's first choice is No, exit, so Enter alone would end the seat. Down, then Enter, picks
  // Yes. The relay takes these keys only while the seat shows that question. Under Watch none the
  // seat's screen stays closed, and this still works.
  const DOWN = '\u001b[B';
  async function trust(seats) {
    const bad = [];
    for (const s of seats) {
      const p = '/terminals/' + encodeURIComponent(s.terminal) + '/input';
      let r = await api(p, { data: DOWN });
      if (r.ok) { await new Promise((done) => setTimeout(done, 200)); r = await api(p, { data: '\r' }); }
      if (!r.ok) bad.push(s.seat + ': ' + r.message);
    }
    say(bad.length ? bad.join(' ') : 'Trusted the folder of ' + seats.map((s) => s.seat).join(', ') + '. Each brief goes in next.', bad.length > 0);
    lastRound = ''; refresh();
  }
  // Asks the relay first, so a seat answered since the last look is not sent the keys again.
  trustAll.addEventListener('click', async () => { await refresh(); if (round) trust(round.seats.filter((s) => s.waiting === 'trust')); });
  const nameOf = (folder) => { const g = games.find((x) => x.folder === folder); return g ? g.name || folder : folder; };

  // ---------- the score and the reveal ----------
  // Any value the relay sends: an object becomes rows of its keys, anything else is shown as text.
  // meanings: the game's own line for a key, shown under its value.
  function data(value, meanings) {
    if (value === null || value === undefined) return el('p', 'none', 'task-empty');
    if (typeof value !== 'object' || Array.isArray(value)) return el('pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'game-data');
    const dl = el('dl', undefined, 'game-data');
    for (const [k, v] of Object.entries(value)) {
      const dd = el('dd', v !== null && typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));
      if (meanings && typeof meanings[k] === 'string') dd.append(el('small', meanings[k]));
      dl.append(el('dt', k), dd);
    }
    return dl;
  }
  const metricsOf = (folder) => { const g = games.find((x) => x.folder === folder); return (g && g.metrics) || null; };
  const tokens = (t) => Math.round((t.input + t.cacheWrite + t.cacheRead) / 1000) + 'k in, ' + Math.round(t.output / 100) / 10 + 'k out';
  function showResult(r) {
    resultBox.hidden = false;
    $('game-result-title').textContent = 'Round ' + r.id + ' · ' + nameOf(r.game);
    $('game-result-about').textContent = r.state === 'done' ? 'done' : r.state;
    const score = $('game-score'), reveal = $('game-reveal');
    score.textContent = ''; reveal.textContent = '';
    const s = r.score;
    score.append(el('b', 'Score'));
    if (s && typeof s === 'object' && !Array.isArray(s) && ('metrics' in s || 'seats' in s)) {
      if ('metrics' in s) score.append(el('small', 'Metrics'), data(s.metrics, metricsOf(r.game)));
      if ('seats' in s) score.append(el('small', 'Seats'), data(s.seats));
      const rest = Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'metrics' && k !== 'seats'));
      if (Object.keys(rest).length) score.append(data(rest));
    } else score.append(data(s));
    reveal.append(el('b', 'Reveal'), data(r.reveal));
    if (r.seats && r.seats.length) reveal.append(el('b', 'What each seat did'), seatButtons(r.id, r.seats.map((x) => x.seat)));
  }
  const seatButtons = (id, seats) => { const d = el('div'); for (const seat of seats) d.append(button('Steps ' + seat, () => showSteps(id, seat)), ' '); return d; };

  // ---------- what a seat did ----------
  // One row per step, folded to its first line. The relay reads them from the seat's own transcript.
  const KIND = { brief: 'brief', prompt: 'prompt', says: 'says', runs: 'runs', result: 'got back' };
  let stepsOf = null;
  async function showSteps(id, seat) {
    stepsOf = id + '/' + seat;
    stepsBox.hidden = false;
    $('game-steps-title').textContent = 'Round ' + id + ' · seat ' + seat;
    $('game-steps-about').textContent = 'reading…';
    stepRows.textContent = '';
    const r = await api('/rounds/' + encodeURIComponent(id) + '/seats/' + encodeURIComponent(seat) + '/steps');
    if (stepsOf !== id + '/' + seat) return;
    if (!r.ok) { $('game-steps-about').textContent = r.message; return; }
    const cost = r.tokens ? tokens(r.tokens) + ' · $' + Number(r.usd || 0).toFixed(2) + ' at API prices' + (r.unpriced && r.unpriced.length ? ' (no price for ' + r.unpriced.join(', ') + ')' : '') : '';
    $('game-steps-about').textContent = r.found ? [r.steps.length + ' steps', cost, r.truncated && 'only the first part is shown'].filter(Boolean).join(' · ') : r.message;
    for (const st of r.steps) {
      const li = el('li'); li.dataset.kind = st.kind; if (st.error) li.dataset.error = '1';
      const d = el('details'), sum = el('summary');
      sum.append(el('b', (KIND[st.kind] || st.kind) + (st.tool ? ' ' + st.tool : '')), st.text.split('\n')[0].slice(0, 160));
      d.append(sum, el('pre', st.text));
      li.append(d); stepRows.append(li);
    }
  }
  $('game-steps-close').addEventListener('click', () => { stepsBox.hidden = true; stepsOf = null; });
  async function loadPast() {
    const r = await api('/rounds');
    if (!r.ok) return;
    pastBox.hidden = !r.rounds.length;
    pastRows.textContent = '';
    for (const p of r.rounds) {
      const li = el('li');
      const metrics = p.score && p.score.metrics;
      li.append(el('b', nameOf(p.game)), el('small', time(p.time) + ' · round ' + p.id + (p.spentUsd != null ? ' · $' + Number(p.spentUsd).toFixed(2) : '')), el('small', !p.score ? 'no score' : metrics ? Object.entries(metrics).map(([k, v]) => k + ' ' + v).join(', ') : JSON.stringify(p.score)));
      if (p.seatNames && p.seatNames.length) li.append(seatButtons(p.id, p.seatNames));
      pastRows.append(li);
    }
  }

  // ---------- asking the relay ----------
  async function refresh() {
    const r = await api('/rounds/current');
    if (!r.ok) return;
    const was = round;
    round = r.round;
    drawRound();
    if (was && !round) {
      // The round ended without this page's Finish: stopped, failed, or at its spend cap.
      if (!ended) say('The round ended. The relay\'s log says why.', false);
      ended = false;
      loadPast(); loadGames();
    }
  }
  let ended = false;  // this page ended the round, and says so itself
  finishBtn.addEventListener('click', async () => {
    if (!round) return;
    ended = true; finishBtn.disabled = true; stopBtn.disabled = true;
    say('Asking the game for its score…');
    const r = await api('/rounds/current/finish', {});
    finishBtn.disabled = false; stopBtn.disabled = false;
    if (!r.ok) say(r.message, true); else { say(''); showResult(r.round); }
    refresh(); loadPast();
  });
  stopBtn.addEventListener('click', async () => {
    if (!round) return;
    ended = true; stopBtn.disabled = true;
    const r = await api('/rounds/current/stop', {});
    stopBtn.disabled = false;
    say(r.ok ? 'Stopped. The round keeps no score.' : r.message, !r.ok);
    refresh(); loadPast();
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    let settings;
    if (settingsIn.value.trim()) {
      try { settings = JSON.parse(settingsIn.value); } catch (e) { say('The settings are not valid JSON.', true); return; }
    }
    const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    say('Starting the seats…');
    const body = { game: pick.value, seats: Number(seatsIn.value), watch: watchIn.value };
    if (seedIn.value.trim()) body.seed = seedIn.value.trim();
    if (settings !== undefined) body.settings = settings;
    const r = await api('/rounds', body);
    if (!r.ok) { say(r.message, true); fitSeats(); return; }
    resultBox.hidden = true;
    say('Started. A seat that waits on the trust question shows here.');
    round = r.round; drawRound();
  });

  loadGames(); loadPast(); refresh();
  setInterval(refresh, 2000);
  setInterval(() => { if (!round) loadGames(); }, 15000);
})();
