// The Games panel: the games in GAMES_REPO, a form to start a round, the round's seats while it runs,
// and its score and reveal when it ends. The relay runs the round (relay/games.js). This panel names
// no game: it shows what the relay sends. Like the Tasks panel, it asks the relay every 2 seconds.
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
    // The relay counts only what the game reports, not yet what each seat's session costs.
    const spend = !round.spentUsd && round.capUsd == null ? 'spend not counted yet' : 'spent $' + Number(round.spentUsd || 0).toFixed(2) + (round.capUsd != null ? ' of $' + round.capUsd : '');
    about.textContent = 'started ' + time(round.startedAt) + ' · watch ' + round.watch + ' · ' + spend + ' · ' + (round.isolation === 'sandbox' ? 'each seat in its own sandbox' : 'no boundary: seats can read your files');
    about.dataset.isolation = round.isolation;
    const waiting = round.seats.filter((s) => s.waiting === 'trust');
    trustAll.hidden = !waiting.length;
    trustNote.hidden = !waiting.length;
    seatRows.textContent = '';
    for (const s of round.seats) {
      const li = el('li'); li.dataset.waiting = s.waiting || '';
      const w = seatPerson(s.terminal);
      li.append(el('b', s.seat), el('small', (w ? w.name + ' · ' : '') + 'session ' + s.terminal));
      if (s.waiting === 'trust') {
        li.append(el('small', 'Waiting on you: Claude Code asks whether to trust this seat\'s folder.'));
        li.append(button('Trust this seat\'s folder', () => trust([s])));
      }
      if (round.watch === 'all') li.append(button('Show its screen', () => window.dispatchEvent(new CustomEvent('office:session', { detail: { terminal: s.terminal } }))));
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
      // eslint-disable-next-line no-restricted-syntax -- keys sent together read as a paste, so Down and Enter need a gap; the relay takes them only while the question shows
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
  function data(value) {
    if (value === null || value === undefined) return el('p', 'none', 'task-empty');
    if (typeof value !== 'object' || Array.isArray(value)) return el('pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'game-data');
    const dl = el('dl', undefined, 'game-data');
    for (const [k, v] of Object.entries(value)) dl.append(el('dt', k), el('dd', v !== null && typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)));
    return dl;
  }
  function showResult(r) {
    resultBox.hidden = false;
    $('game-result-title').textContent = 'Round ' + r.id + ' · ' + nameOf(r.game);
    $('game-result-about').textContent = r.state === 'done' ? 'done' : r.state;
    const score = $('game-score'), reveal = $('game-reveal');
    score.textContent = ''; reveal.textContent = '';
    const s = r.score;
    score.append(el('b', 'Score'));
    if (s && typeof s === 'object' && !Array.isArray(s) && ('metrics' in s || 'seats' in s)) {
      if ('metrics' in s) score.append(el('small', 'Metrics'), data(s.metrics));
      if ('seats' in s) score.append(el('small', 'Seats'), data(s.seats));
      const rest = Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'metrics' && k !== 'seats'));
      if (Object.keys(rest).length) score.append(data(rest));
    } else score.append(data(s));
    reveal.append(el('b', 'Reveal'), data(r.reveal));
  }
  async function loadPast() {
    const r = await api('/rounds');
    if (!r.ok) return;
    pastBox.hidden = !r.rounds.length;
    pastRows.textContent = '';
    for (const p of r.rounds) {
      const li = el('li');
      const metrics = p.score && p.score.metrics;
      li.append(el('b', nameOf(p.game)), el('small', time(p.time) + ' · round ' + p.id), el('small', !p.score ? 'no score' : metrics ? Object.entries(metrics).map(([k, v]) => k + ' ' + v).join(', ') : JSON.stringify(p.score)));
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
