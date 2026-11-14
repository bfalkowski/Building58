// The Claude Code panel under the office: terminals running `claude` on this computer, one
// per worker. The relay runs them (relay/terminal.js) and keeps them going while you look at
// another one. Clicking a person shows their session here. Reloading the page reconnects.
// Needs the page to be opened through the relay with ?channel= and ?key=.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const box = $('cc-term'), form = $('cc-form'), cwdIn = $('cc-cwd'), resumeIn = $('cc-resume'), startBtn = $('cc-start'), stopBtn = $('cc-stop');
  const status = $('cc-status'), note = $('cc-note'), title = $('cc-title');
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel'), key = params.get('key') || '';

  function say(text, state) { status.textContent = text; status.dataset.state = state || ''; }
  // For news the two-second refresh must not replace with "Running in ..." before you can read it.
  let heldUntil = 0;
  // What a press did. Shown in Settings too while it is open, since the dialog covers the panel.
  function tell(text, state) { heldUntil = Date.now() + 15000; say(text, state); const s = $('settings-said'); if (s && $('settings').open) { s.textContent = text; s.dataset.state = state || ''; } }
  function off(text) { note.textContent = text; note.hidden = false; startBtn.disabled = true; cwdIn.disabled = true; resumeIn.disabled = true; box.hidden = true; say('Off', 'off'); }
  if (!channel) { off('To run Claude Code here, open the room through the relay: RELAY_KEY=pick-a-key npm run office, then the link it prints.'); return; }
  if (!window.Terminal || !window.FitAddon) { off('The terminal library did not load, so the panel is off. Check the network and reload.'); return; }

  // Always this page's own server: the relay refuses terminal requests from anywhere else.
  const url = (p, area) => location.origin + '/channels/' + encodeURIComponent(channel) + (area || '/terminals') + p + '?key=' + encodeURIComponent(key);
  function api(p, body, area) {
    const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    return fetch(url(p, area), opt).then((r) => r.json().then((j) => Object.assign({ status: r.status }, j)), () => ({ ok: false, message: 'The relay did not answer.' }))
      .catch(() => ({ ok: false, message: 'The relay did not answer.' }));
  }
  const store = (area, k, v) => { try { if (v === undefined) return area.getItem(k); if (v === null) area.removeItem(k); else area.setItem(k, v); } catch (e) { /* no storage */ } return null; };
  cwdIn.value = store(localStorage, 'office.cwd') || '~';

  // The terminal stays dark in both page modes, on purpose: Claude Code picks its own colours for a dark
  // terminal, and a theme change would redraw a running session and its replay. See shared/theme.js.
  const term = new window.Terminal({
    fontFamily: '"Roboto Mono", ui-monospace, monospace', fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 5000,
    theme: { background: '#0c0f14', foreground: '#dbe7ee', cursor: '#e3b26a', selectionBackground: 'rgba(127, 216, 255, 0.25)',
      black: '#1b222c', red: '#f08c7e', green: '#8fd19e', yellow: '#f0c25e', blue: '#8fb0e3', magenta: '#c79be0', cyan: '#7fd8d0', white: '#dbe7ee',
      brightBlack: '#5c6773', brightRed: '#ffa69b', brightGreen: '#a9e4b6', brightYellow: '#ffd77f', brightBlue: '#a9c4ee', brightMagenta: '#dab4ef', brightCyan: '#9ae6df', brightWhite: '#ffffff' }
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(box);
  try { fit.fit(); } catch (e) { /* not laid out yet */ }

  // One stream at a time: browsers allow few connections per server, and the page needs one
  // for the relay. The other sessions keep running there, and their output replays on switching.
  let current = null, es = null, queue = Promise.resolve(), buf = '', timer = null, replaying = false;
  function flushKeys() {
    clearTimeout(timer); timer = null;
    if (!buf || !current) { buf = ''; return; }
    const data = buf, id = current.id; buf = '';
    queue = queue.then(() => api('/' + id + '/input', { data }));
  }
  // keystrokes go in order, in small batches. While old output replays, xterm answers the
  // questions in it (cursor position and so on), and those answers must not reach the session.
  term.onData((d) => {
    if (!current || !current.running || replaying) return;
    buf += d;
    if (!timer) timer = setTimeout(flushKeys, 8);
  });
  let sizeTimer = null;
  function refit() {
    try { fit.fit(); } catch (e) { return; }
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => { if (current && current.running && !current.stopping) api('/' + current.id + '/resize', { cols: term.cols, rows: term.rows }); }, 120);
  }
  if (window.ResizeObserver) new ResizeObserver(refit).observe(box); else window.addEventListener('resize', refit);

  const short = (id) => String(id || '').slice(0, 8);
  const home = (p) => String(p || '').replace(/^\/(Users|home)\/[^/]+/, '~');
  const workerOf = (id) => window.run ? window.run.state().workers.find((w) => w.session && w.session.terminal === id) : null;
  function show() {
    const t = current, running = !!(t && t.running);
    stopBtn.hidden = !running; if (typeof reviewBtn !== 'undefined') reviewBtn.hidden = !running;
    const w = t && workerOf(t.id);
    const named = window.OfficeSeats.titleBeside(w && w.session && w.session.customTitle);  // the title you gave it with /rename
    title.textContent = w ? 'Claude Code · ' + w.name + named.text : 'Claude Code';
    title.title = named.full ? w.name + ' · ' + named.full : '';
    // A seat in a round takes no keys but the answer to its trust question, so the screen says so.
    if (running && t.round) say('A seat in round ' + t.round + ': read-only, so watching never changes the play. To see everything it did, open Steps in Games.', 'on');
    else if (running && Date.now() >= heldUntil) say('Running in ' + home(t.cwd) + ' · session ' + short(t.sessionId), 'on');
  }
  function b64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function attach(id) {
    if (current && current.id === id && es) return;
    flushKeys();
    if (es) es.close();
    current = { id, running: false }; store(sessionStorage, 'office.terminal', id);
    const stream = es = new EventSource(url('/' + id + '/stream'));
    stream.addEventListener('hello', (m) => {
      const t = JSON.parse(m.data);
      term.reset(); current = t; replaying = t.replay > 0;  // the output that follows is the session so far
      store(sessionStorage, 'office.session', t.sessionId);  // a relay restart gives it a new id, but not a new session
      if (t.cwd && document.activeElement !== cwdIn) cwdIn.value = home(t.from || t.cwd);  // a new worker starts where this one did, not from their checkout
      show(); refit();
    });
    stream.addEventListener('out', (m) => {
      if (replaying) term.write(b64(JSON.parse(m.data)), () => { replaying = false; });
      else term.write(b64(JSON.parse(m.data)));
    });
    stream.addEventListener('exit', (m) => {
      const e = JSON.parse(m.data);
      stream.close(); if (es === stream) es = null;
      current = null; store(sessionStorage, 'office.terminal', null); show();
      say((e.stopped ? 'Stopped' : 'Ended' + (e.code ? ' (exit ' + e.code + ')' : '')) + '. Click a worker, or add one.', 'off');
      term.write('\r\n\x1b[2m[Claude Code ' + (e.stopped ? 'stopped' : 'ended') + ']\x1b[0m\r\n');
    });
    stream.addEventListener('error', () => {
      if (stream !== es) return;
      if (stream.readyState === EventSource.CLOSED) { es = null; current = null; show(); say('That session is gone. Click a worker, or add one.', 'off'); }
      else say('Reconnecting', 'wait');
    });
  }

  // ---------- reviews: another worker reads the work ----------
  const { PR_URL, prBrief, manualReview } = window.OfficeReviews;
  const READY_MS = 5000;  // how long `claude` takes to be ready for a typed prompt
  async function reviewerStarted(r) {
    if (!r.ok) { tell('Could not start a reviewer: ' + (r.message || 'the relay did not answer.'), 'off'); return false; }
    await sync();
    const w = workerOf(r.id), name = w ? w.name : 'A worker';
    tell(name + ' is starting a review. Click them to watch.', 'wait');
    return true;
  }
  // A review of a PR gets its own checkout of the PR's latest commit, and the relay types its brief.
  async function reviewPr(from, pr) {
    return reviewerStarted(await api('', { from, pr, prompt: prBrief(pr), cols: term.cols, rows: term.rows }, '/checkouts'));
  }
  // Any other review stays in the session's folder: it has to see the uncommitted work there.
  async function addReviewer(cwd, prompt) {
    const r = await api('', { cwd, title: 'Review', role: 'reviewer', cols: term.cols, rows: term.rows });  // the role keeps it from being made the Lead
    if (!await reviewerStarted(r)) return;
    await new Promise((done) => setTimeout(done, READY_MS));
    await api('/' + r.id + '/input', { data: prompt });
    await new Promise((done) => setTimeout(done, 300));
    await api('/' + r.id + '/input', { data: '\r' });
  }
  const reviewBtn = document.createElement('button');
  reviewBtn.type = 'button'; reviewBtn.className = 'btn'; reviewBtn.id = 'cc-review'; reviewBtn.hidden = true; reviewBtn.textContent = 'Get a review';
  // The PR a session opened, from its hook, for sessions the relay keeps no PR for: Add worker
  // sessions, and tasks with no ticket. Keyed by the hook's session id, the first 8 characters, so it
  // holds whether or not the session has a desk, and across a relay restart. Only while this page is open.
  const openedPr = new Map();  // session id -> PR link
  const sessionKey = (id) => String(id || '').slice(0, 8);
  // A task with no ticket has no work.pr in the session list, but the task itself has the PR.
  async function knownPrOf(t) {
    if (t.sessionId && openedPr.has(sessionKey(t.sessionId))) return openedPr.get(sessionKey(t.sessionId));
    if (!t.task) return null;
    const r = await api('/' + encodeURIComponent(t.task), undefined, '/tasks');
    return r.ok && r.task ? r.task.pr : null;
  }
  reviewBtn.addEventListener('click', async () => {
    if (!current || !current.running || reviewBtn.disabled) return;
    reviewBtn.disabled = true;  // one press, one reviewer
    try {
      const t = terms.find((x) => x.id === current.id) || current;  // the list has the session's PR, which can come after it started
      const plan = manualReview(t, t.work && t.work.pr ? null : await knownPrOf(t));
      if (plan.pr) await reviewPr(plan.from, plan.pr); else await addReviewer(plan.cwd, plan.prompt);
    } finally { reviewBtn.disabled = false; }
  });
  stopBtn.before(reviewBtn);
  // ---------- Settings: the switches for what runs without you, in a dialog of their own ----------
  // The button is in the room bar, since the switches are the whole room's. Beside it, one chip
  // per area says in a few words what is on, and opens Settings at that area.
  const settingsDlg = $('settings'), settingsBtn = document.createElement('button');
  settingsBtn.type = 'button'; settingsBtn.className = 'btn'; settingsBtn.id = 'cc-settings'; settingsBtn.textContent = 'Settings';
  settingsBtn.setAttribute('aria-haspopup', 'dialog');
  $('cc-update-off').after(settingsBtn);
  function openSettings(at) {
    $('settings-said').textContent = ''; settingsDlg.showModal(); sync();
    const head = at && $(at);
    if (head) head.closest('section').scrollIntoView({ block: 'start' });
  }
  settingsBtn.addEventListener('click', () => openSettings());
  $('settings-close').addEventListener('click', () => settingsDlg.close());
  let settingsPressed = false;  // a press that starts inside and lets go on the backdrop does not close it
  settingsDlg.addEventListener('pointerdown', (ev) => { settingsPressed = ev.target === settingsDlg; });
  settingsDlg.addEventListener('click', (ev) => { if (ev.target === settingsDlg && settingsPressed) settingsDlg.close(); });
  // One setting: its controls on a line, and what it does under them.
  function settingRow(into, controls, what) {
    const row = document.createElement('div'), line = document.createElement('div'), p = document.createElement('p');
    row.className = 'set-row'; p.className = 'set-what'; p.textContent = what;
    line.append(...controls); row.append(line, p); $(into).append(row);
    return { row, what: p };
  }
  const summary = { reviews: '', autopilot: '', lead: '', huddle: '' }, summaryOn = { reviews: false, autopilot: false, lead: false, huddle: false };
  const CHIPS = [['autopilot', 'set-ap-title', 'Autopilot'], ['lead', 'set-lead-title', 'The Lead'], ['reviews', 'set-reviews-title', 'Reviews'], ['huddle', 'set-huddle-title', 'Huddle']];
  const chips = CHIPS.map(([k, at, name]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ob-chip'; b.dataset.chip = k; b.hidden = true; b.title = 'Opens Settings at ' + name;
    b.setAttribute('aria-haspopup', 'dialog');
    b.addEventListener('click', () => openSettings(at));
    $('ob-chips').append(b);
    return b;
  });
  // The Huddle switch is this browser's (office/huddle.js). Its chip shows once huddle.js has read it, after the relay answered.
  const huddleBox = $('huddle-lead');
  huddleBox.addEventListener('change', () => {
    summary.huddle = huddleBox.checked ? 'Huddle: tells the Lead' : 'Huddle: Floor only';
    summaryOn.huddle = false;  // telling the Lead does nothing without you, so the chip is never outlined
    drawSummary();
  });
  function drawSummary() {
    chips.forEach((b) => { const k = b.dataset.chip; b.textContent = summary[k]; b.hidden = !summary[k]; b.dataset.on = summaryOn[k] ? '1' : ''; });
  }

  // ---------- trust level: the rungs of article 5 (docs/constitution.md), each a set of the switches below ----------
  // A level only sets the switches, the same ones you can press one by one. It grants nothing they do not.
  // Rung 1 (findings back to the Dev) is always on, and rung 5 (a monitor) is not built.
  const LEVELS = [
    { n: 0, name: 'You drive', want: { auto: true, again: false, board: false, stops: false, merge: false, starts: false, autopilot: false },
      what: 'The relay reviews each new PR one time and sends the findings to the Dev. You start, move and merge all work.' },
    { n: 1, name: 'Review loop', rung: 'rung 1, with its limit on rounds', want: { auto: true, again: true, board: false, stops: false, merge: false, starts: false, autopilot: false },
      what: 'After each push, a reviewer checks the new commits. The Dev fixes and the reviewer checks again, without you. Each PR gets a limited number of automatic reviews: 3, unless you change it under Limits and timings. You start, move and merge all work.' },
    { n: 2, name: 'The Lead keeps work moving', rung: 'rung 2', want: { auto: true, again: true, board: true, stops: true, merge: false, starts: false, autopilot: false },
      what: 'The Lead moves cards on the Board and accepts tickets from Triage. It also stops sessions that are safe to stop. You start and merge work.' },
    { n: 3, name: 'The Lead starts tickets', rung: 'rung 3, the start rung', want: { auto: true, again: true, board: true, stops: true, merge: false, starts: true, autopilot: false },
      what: 'The Lead also starts Ready tickets that you approved, one at a time. The two numbers in the Lead section set its limits. When it has used all its starts, that switch goes off and the level shows as custom. You merge work.' },
    { n: 4, name: 'The Lead merges', rung: 'rung 4, the merge rung', want: { auto: true, again: true, board: true, stops: true, merge: true, starts: true, autopilot: false },
      what: 'The Lead also merges a PR when it is ready: a review of the latest commit is posted, each blocking finding is fixed, all checks pass, it merges into main with no conflicts, and no decision is left for you. It never merges a change to CLAUDE.md or the constitution. You approve tickets and do the work it gives back to you.' },
    { n: 5, name: 'Autopilot', rung: 'rungs 3 and 4, run by the relay', want: { auto: true, again: true, board: true, stops: true, merge: false, starts: false, autopilot: true },
      what: 'The relay does the full loop itself. It starts each approved Ready ticket, reviews each push, sends findings to the Dev, and merges when the review says merge and all checks pass. It needs no Lead. Only the relay starts and merges work. A Lead keeps two rights: stop a session the Floor calls safe to stop, and move a task to Done once its PR has merged. You approve tickets and do the work it puts in Waiting on you.' }
  ];
  // Level 5 needs no Lead. With none, there is no one to let move the board, so that switch stays off.
  const wantOf = (L) => (L.n === 5 && !boardTerm ? Object.assign({}, L.want, { board: false }) : L.want);
  const trust = { reviews: null, autopilot: null, settings: null, pick: null, busy: false };
  const levelsBox = document.createElement('div'), levelsNote = document.createElement('p'), levelsApply = document.createElement('button');
  levelsBox.setAttribute('role', 'radiogroup'); levelsBox.setAttribute('aria-label', 'Trust level');
  levelsNote.className = 'set-what'; levelsApply.type = 'button'; levelsApply.className = 'btn'; levelsApply.id = 'set-level-apply';
  const levelInputs = LEVELS.map((L) => {
    const label = document.createElement('label'), input = document.createElement('input'), head = document.createElement('span'), p = document.createElement('p');
    label.className = 'set-level'; input.type = 'radio'; input.name = 'trust-level'; input.value = String(L.n);
    head.innerHTML = '<b></b> <small></small>'; head.querySelector('b').textContent = L.n + '. ' + L.name; head.querySelector('small').textContent = L.rung ? '(' + L.rung + ')' : '';
    p.className = 'set-what'; p.textContent = L.what;
    const text = document.createElement('span'); text.append(head, p);
    label.append(input, text); levelsBox.append(label);
    input.addEventListener('change', () => { trust.pick = L.n; drawLevels(); });
    return input;
  });
  const monitor = document.createElement('p'); monitor.className = 'set-what'; monitor.textContent = 'Rung 5 is not built yet. It is a monitor that watches what shipped and files tickets.';
  $('set-levels').append(levelsBox, monitor, levelsApply, levelsNote);
  // The switches as they are now, in the same terms as a level's want.
  function switchesNow() {
    if (!trust.reviews || !trust.autopilot || !trust.settings) return null;
    return { auto: trust.reviews.auto, again: trust.reviews.again, board: !!(boardTerm && boardTerm.board), stops: !!settingOf('leadStops'), merge: !!(boardTerm && boardTerm.merge), starts: !!(boardTerm && boardTerm.starts), autopilot: !!trust.autopilot.on };
  }
  const KEYS = ['auto', 'again', 'board', 'stops', 'merge', 'starts', 'autopilot'];
  const NAMES = { auto: 'Review PRs automatically', again: 'Review again after each push', board: 'Let the Lead move the board', stops: 'Let the Lead stop sessions', merge: 'Let the Lead merge', starts: 'Let the Lead start tickets', autopilot: 'Autopilot' };
  function levelNow(now) { const L = now && LEVELS.find((x) => KEYS.every((k) => wantOf(x)[k] === now[k])); return L ? L.n : null; }
  function drawLevels() {
    const now = switchesNow();
    if (!now) return;
    const at = levelNow(now), pick = trust.pick !== null ? trust.pick : at;
    levelInputs.forEach((input, i) => { input.checked = pick === i; input.disabled = trust.busy; input.closest('label').dataset.now = String(at === i); });
    const L = pick !== null ? LEVELS[pick] : null;
    const changes = L ? KEYS.filter((k) => wantOf(L)[k] !== now[k]) : [];
    const needsLead = changes.some((k) => ['board', 'merge', 'starts'].includes(k) && wantOf(L)[k]) && !boardTerm;
    levelsApply.hidden = !L || !changes.length;
    levelsApply.disabled = trust.busy || needsLead;
    if (L) levelsApply.textContent = trust.busy ? 'Setting level ' + L.n + '…' : 'Set level ' + L.n;
    const ons = changes.filter((k) => wantOf(L)[k]).map((k) => NAMES[k]), offs = changes.filter((k) => !wantOf(L)[k]).map((k) => NAMES[k]);
    levelsNote.textContent = (at === null ? 'Now: custom. The switches below do not match a level. ' : 'Now: level ' + at + ', ' + LEVELS[at].name + '. ')
      + (L && changes.length ? 'Set level ' + L.n + ' will' + (ons.length ? ' turn on ' + ons.join(', ') : '') + (ons.length && offs.length ? ', and' : '') + (offs.length ? ' turn off ' + offs.join(', ') : '') + '.'
        + (needsLead ? ' First make a session the Lead: open it in the Claude Code panel and press Make this the Lead.' : '')
        + (L.want.autopilot && !now.autopilot ? ' Autopilot will start ' + (apOnly.value.trim() ? 'only ' + apOnly.value.trim() : 'every Ready ticket that a person approved') + '.' : '') : '');
  }
  // ---------- limits and timings (relay/config.js): read where they are used, so a change needs no restart ----------
  // Drawn from the relay's own list. A box saves when you leave it or press Enter. Reset goes back to the
  // environment variable, or the default.
  const settingOf = (name) => { const x = trust.settings && trust.settings.find((v) => v.name === name); return x ? x.value : null; };
  const settingInputs = new Map();  // name -> { input, from, reset }
  let settingsDrawnFor = '';
  async function saveSettings(body) {
    const r = await api('', body, '/settings');
    if (!r.ok) tell('Could not change the setting: ' + (r.message || 'the relay did not answer.'), 'off');
    else if (r.changed.length) tell('Saved. The relay uses the new value now. No restart is necessary.', '');
    drawSettings(r.ok ? r : await api('', undefined, '/settings'));
  }
  // Which skills on a list are installed here. Only those go in the brief.
  function skillsText(x) {
    const list = x.skills || [], missing = list.filter((s) => !s.installed), manual = list.filter((s) => s.manual);
    return (list.length ? ' · ' + (missing.length ? 'not found: ' + missing.map((s) => s.name).join(', ') : 'all installed') : '') +
      (manual.length ? ' · read from its file: ' + manual.map((s) => s.name).join(', ') : '');
  }
  function fromText(x) { return x.from === 'page' ? 'set here' + (x.env ? ' (replaces ' + x.env + ')' : '') : x.from === 'env' ? 'from ' + x.env + ' at startup' : 'default'; }
  function settingControl(x) {
    const input = document.createElement('input'), label = document.createElement('label'), from = document.createElement('small'), reset = document.createElement('button');
    reset.type = 'button'; reset.className = 'btn set-reset'; reset.textContent = 'Reset';
    reset.addEventListener('click', () => saveSettings({ reset: [x.name] }));
    if (x.kind === 'bool') {
      input.type = 'checkbox'; input.style.flex = 'none';
      input.addEventListener('change', () => saveSettings({ values: { [x.name]: input.checked } }));
      label.append(input, ' ' + x.label);
    } else if (x.kind === 'text' || x.kind === 'skills') {  // a model, or a list of skills (relay/skills.js)
      input.type = 'text'; input.className = 'set-text'; input.spellcheck = false; input.autocomplete = 'off';
      input.placeholder = x.kind === 'text' ? 'your default' : 'none';
      if (x.kind === 'text') input.setAttribute('list', 'set-models');
      input.setAttribute('aria-label', x.label);
      const commit = () => { const v = input.value.trim(); if (v !== settingOf(x.name)) saveSettings({ values: { [x.name]: v } }); };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } });
      label.append(x.label + ' ', input);
    } else {
      input.type = 'number'; input.min = String(x.min); input.max = String(x.max); input.step = '1'; input.className = 'set-num';
      input.setAttribute('aria-label', x.label + ', in ' + x.unit);
      const commit = () => { const v = Number(input.value); if (input.value !== '' && v !== x.value) saveSettings({ values: { [x.name]: v } }); };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } });
      label.append(x.label + ' ', input, ' ' + x.unit);
    }
    from.className = 'set-from';
    settingInputs.set(x.name, { input, from, reset });
    return [label, from, reset];
  }
  function drawSettings(r) {
    if (!r || !r.ok) return;
    trust.settings = r.settings;
    // The rows are made once (and again only if the relay's list changes), then only their values are set.
    const shape = r.settings.map((x) => x.name).join();
    if (shape !== settingsDrawnFor) {
      settingsDrawnFor = shape; settingInputs.clear();
      const box = $('set-limits'); box.textContent = '';
      const models = document.createElement('datalist'); models.id = 'set-models';  // suggestions; a full model id works too
      for (const m of ['opus', 'sonnet', 'haiku']) { const o = document.createElement('option'); o.value = m; models.append(o); }
      box.append(models);
      $('set-lead-stops').textContent = '';
      let group = null;
      for (const x of r.settings) {
        if (x.name === 'leadStops' || x.name === 'leadOrder') { const row = document.createElement('div'); row.className = 'set-row'; const line = document.createElement('div'), p = document.createElement('p'); p.className = 'set-what'; p.textContent = x.what; line.append(...settingControl(x)); row.append(line, p); $('set-lead-stops').append(row); continue; }
        if (x.group !== group) { group = x.group; const h = document.createElement('h4'); h.textContent = group; box.append(h); }
        settingRow('set-limits', settingControl(x), x.what);
      }
    }
    for (const x of r.settings) {
      const c = settingInputs.get(x.name);
      if (!c) continue;
      if (x.kind === 'bool') c.input.checked = !!x.value;
      else if (document.activeElement !== c.input) c.input.value = String(x.value);
      c.from.textContent = fromText(x) + (x.kind === 'skills' ? skillsText(x) : x.kind === 'bool' || x.kind === 'text' ? '' : ' · ' + x.min + ' to ' + x.max + (x.from === 'default' ? '' : ' · default ' + x.def));
      c.reset.hidden = x.from !== 'page';
    }
    drawLevels();
  }
  const syncSettings = () => api('', undefined, '/settings').then(drawSettings);

  // Turns each switch that differs, the ones going off first, so two things never both start or merge.
  // It stops at the first refusal and says why. Each step is the same request as pressing that switch.
  levelsApply.addEventListener('click', async () => {
    const L = LEVELS[trust.pick !== null ? trust.pick : -1], now = switchesNow();
    if (!L || !now || trust.busy) return;
    trust.busy = true; drawLevels();
    const want = wantOf(L);
    const order = ['autopilot', 'starts', 'merge', 'stops', 'board', 'again', 'auto'], steps = [...order.filter((k) => now[k] && !want[k]), ...order.slice().reverse().filter((k) => !now[k] && want[k])];
    let failed = null;
    // The Lead as the page saw it when you pressed. A sync during the steps must not send a later grant to
    // a session another tab has made the Lead since: the relay refuses lead: true to anyone else.
    const leadId = boardTerm ? boardTerm.id : null;
    for (const k of steps) {
      const on = want[k];
      if (on && ['board', 'merge', 'starts'].includes(k) && !leadId) { failed = NAMES[k] + ': no session is the Lead.'; break; }
      const r = k === 'auto' || k === 'again' ? await api('', { [k]: on }, '/reviews')
        : k === 'autopilot' ? await api('', on ? { on: true, only: apOnly.value } : { on: false }, '/autopilot')
          : k === 'stops' ? await api('', { values: { leadStops: on } }, '/settings')
          : k === 'starts' ? await api('/lead', on ? { terminal: leadId, lead: true, starts: Number(startsPick.value), total: Number(totalPick.value) } : { starts: 0 })
            : await api('/lead', { terminal: leadId, lead: true, [k]: on });
      if (!r.ok) { failed = NAMES[k] + ': ' + (r.message || 'the relay did not answer.'); break; }
      if (k === 'board' && !on) boardHolder = null;  // you did this, so nothing needs explaining
      if (k === 'merge' && !on) mergeHolder = null;
      if (k === 'starts' && !on) startsHolder = null;
    }
    trust.busy = false; trust.pick = null;
    await sync();
    await Promise.all([syncReviews(), syncAutopilot(), syncSettings()]);  // sync starts these without waiting, and the check below needs them
    // Each step can be accepted and still not give the level, as when the WIP limit leaves no room to
    // start tickets. So it says the level is set only when the switches now match it.
    const got = levelNow(switchesNow());
    if (!failed && got !== L.n) failed = 'The relay took each step, but the switches now match ' + (got === null ? 'no level' : 'level ' + got) + '. Check the switches below.';
    tell(failed ? 'Level ' + L.n + ' is not fully set. ' + failed : 'Trust level ' + L.n + ', ' + L.name + ', is set.', failed ? 'off' : '');
  });

  // The relay starts the automatic reviews (relay/reviews.js), so they start with this page closed.
  // These two boxes are its switches, and the relay keeps them. They wait for its answer.
  const autoLabel = document.createElement('label'), autoBox = document.createElement('input');
  autoBox.type = 'checkbox'; autoBox.style.flex = 'none'; autoBox.disabled = true;
  autoBox.addEventListener('change', () => setReviews({ auto: autoBox.checked }));
  autoLabel.append(autoBox, ' Review PRs automatically');
  settingRow('set-reviews', [autoLabel], 'When a session opens a PR, the relay starts a reviewer. The reviewer reads the PR, posts its findings and leaves its desk. Off: no reviewer starts until you press Get a review. But if Review again after each push is on, a PR that had a review still gets follow-up reviews.');
  // A push to a reviewed PR brings a follow-up review, once the Dev's turn ends. Off until you tick it.
  const againLabel = document.createElement('label'), againBox = document.createElement('input');
  againBox.type = 'checkbox'; againBox.style.flex = 'none'; againBox.disabled = true;
  againBox.addEventListener('change', () => setReviews({ again: againBox.checked }));
  againLabel.append(againBox, ' Review again after each push');
  const againRow = settingRow('set-reviews', [againLabel], '');
  let reviewsSet = 0;  // a press still on its way, so a sync does not tick the box back
  async function setReviews(body) {
    reviewsSet++;
    const r = await api('', body, '/reviews');
    reviewsSet--;
    if (!r.ok) tell('Could not change the automatic reviews: ' + (r.message || 'the relay did not answer.'), 'off');
    drawReviews(r.ok ? r : await api('', undefined, '/reviews'));
  }
  // What the relay said about the reviews it started, shown once. What it said before this page opened is not news.
  let newsSeen = null;
  function drawReviews(r) {
    if (!r.ok) return;
    trust.reviews = r; drawLevels();
    autoBox.disabled = againBox.disabled = false;
    if (!reviewsSet) { autoBox.checked = r.auto; againBox.checked = r.again; }
    againRow.what.textContent = 'When a Dev pushes to a PR that had a review, the relay starts a follow-up review after the Dev\'s turn ends. It reviews only the new commits. Each PR gets at most ' + r.max + ' automatic reviews, the first one included, so the loop always stops. After that, press Get a review. Autopilot\'s PRs get follow-up reviews also when this is off.';
    summaryOn.reviews = r.auto || r.again;
    summary.reviews = 'Reviews: ' + (r.auto ? (r.again ? 'auto, again' : 'auto') : (r.again ? 'by hand, again' : 'by hand'));
    drawSummary();
    const ids = (r.news || []).map((n) => n.at + ' ' + n.seq), fresh = newsSeen ? (r.news || []).filter((n, i) => !newsSeen.has(ids[i])) : [];
    newsSeen = new Set(ids);
    const last = fresh[fresh.length - 1];
    if (!last) return;
    const w = last.terminal && workerOf(last.terminal);
    tell(w ? last.text.replace(/^A reviewer/, w.name) : last.text, last.state);
  }
  const syncReviews = () => api('', undefined, '/reviews').then(drawReviews);

  // ---------- Autopilot (relay/autopilot.js): Ready to merged with nobody pressing anything ----------
  // Off until you tick it. The box beside it limits it to the tickets you list, such as T-12, or none for all of Ready.
  const apLabel = document.createElement('label'), apBox = document.createElement('input'), apOnly = document.createElement('input'), apSays = document.createElement('span');
  apBox.type = 'checkbox'; apBox.style.flex = 'none'; apBox.disabled = true;
  apOnly.type = 'text'; apOnly.placeholder = 'only T-12, flaky (or all Ready)'; apOnly.size = 20; apOnly.setAttribute('aria-label', 'Autopilot starts only these tickets and labels');
  apSays.setAttribute('aria-live', 'polite');
  apLabel.append(apBox, ' Autopilot');
  const apRow = settingRow('set-autopilot', [apLabel], '');
  apSays.className = 'set-now';
  apRow.what.after(apSays);
  settingRow('set-autopilot', [apOnly], 'Type the tickets that Autopilot may start, like T-12, T-15, or labels, like flaky, or both. A label lets in every ticket that has it, also one you label while Autopilot runs. Leave it empty to let it start every Ready ticket that a person approved, in Board order. Type the list before you turn Autopilot on. You cannot change it while Autopilot is on. When you turn Autopilot off, the list is cleared.');
  let apSet = 0;
  apBox.addEventListener('change', async () => {
    apSet++;
    const r = await api('', apBox.checked ? { on: true, only: apOnly.value } : { on: false }, '/autopilot');
    apSet--;
    if (!r.ok) tell('Could not change Autopilot: ' + (r.message || 'the relay did not answer.'), 'off');
    else tell(r.on ? 'Autopilot is on' + (r.only ? ' for ' + r.only.join(', ') : ' for every Ready ticket a person approved') + '. It starts, reviews, merges and moves cards by itself.' : 'Autopilot is off. Work under way stays where it is.', r.on ? '' : 'off');
    drawAutopilot(r.ok ? r : await api('', undefined, '/autopilot'));
  });
  function drawAutopilot(r) {
    if (!r.ok) return;
    trust.autopilot = r; drawLevels();
    apBox.disabled = false;
    if (!apSet) { apBox.checked = r.on; if (document.activeElement !== apOnly) apOnly.value = (r.only || []).join(', '); }
    apOnly.disabled = r.on;
    const now = (r.prs || []).filter((p) => p.state !== 'done').map((p) => (p.ticket || p.pr.split('/').pop()) + ': ' + (p.why || p.act || ''));
    apSays.textContent = r.on ? ([...now, r.idle].filter(Boolean).join(' · ') || 'Starting the next ticket.') + ' · merged today: ' + r.mergedToday + ' of ' + r.maxMerges : '';
    apRow.what.textContent = 'The relay starts the next approved Ready ticket, one at a time. Each push to its PR gets a review, and the findings go to the Dev. When the review says merge and all checks pass, the relay merges the PR and starts the next ticket. After ' + r.maxRounds + ' review rounds that still ask for fixes, the task goes to Waiting on you. It merges at most ' + r.maxMerges + ' PRs a day. It never merges a change to CLAUDE.md or the constitution. It needs Review PRs automatically on. When you turn it off, work already started stays where it is.';
    summaryOn.autopilot = !!r.on;
    summary.autopilot = r.on ? 'Autopilot on' + (r.only && r.only.length ? ' for ' + r.only.join(', ') : '') : 'Autopilot off';
    drawSummary();
  }
  const syncAutopilot = () => api('', undefined, '/autopilot').then(drawAutopilot);
  if (window.run) window.run.on('hook', (e) => {
    if (e.prUrl && PR_URL.test(e.prUrl) && e.session) openedPr.set(sessionKey(e.session), e.prUrl);
  });

  // ---------- checkouts: what finished sessions left behind ----------
  const useFolderLabel = document.createElement('label'), useFolder = document.createElement('input');
  useFolder.type = 'checkbox'; useFolder.style.flex = 'none';
  useFolderLabel.title = 'In a git repo each worker gets their own checkout and branch. Tick this to work in the folder itself.';
  useFolderLabel.append(useFolder, ' Use this folder');
  startBtn.before(useFolderLabel);
  // What needs you about the whole room shows once, under the room bar, not in the session's panel.
  const notes = $('office-notes');
  const leftovers = document.createElement('div');
  notes.append(leftovers);
  let leftoversDrawn = '', lastLeftovers = [];
  const asking = new Map();  // checkout id -> the ignored files Clean up would delete
  function leftoverButton(text, fn) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = text; b.addEventListener('click', fn); return b; }
  async function cleanLeftover(c, ignored) {
    const r = await api('/' + c.id + '/clean', { ignored }, '/checkouts');
    asking.delete(c.id);
    if (r.error === 'ignored') asking.set(c.id, r.ignored);
    else tell(r.ok ? 'Removed ' + home(c.path) + '.' + (r.branches.length ? ' Still there: ' + r.branches.join(', ') + '.' : '') : r.message, r.ok ? '' : 'off');
    drawLeftovers(lastLeftovers);
    syncLeftovers();
  }
  function drawLeftovers(list) {
    lastLeftovers = list;
    const waiting = list.filter((c) => !c.running), text = JSON.stringify([waiting, [...asking]]);
    if (text === leftoversDrawn) return;
    leftoversDrawn = text;
    leftovers.textContent = '';
    for (const c of waiting) {
      const row = document.createElement('div'), label = document.createElement('span'), ignored = asking.get(c.id);
      row.className = 'cc-ask';
      if (ignored) {
        label.textContent = home(c.path) + ' holds files git ignores, and Clean up would delete them: ' + ignored.slice(0, 8).join(', ') + (ignored.length > 8 ? ' and ' + (ignored.length - 8) + ' more' : '');
        row.append(label, leftoverButton('Delete them too', () => cleanLeftover(c, ignored)), leftoverButton('Keep', () => { asking.delete(c.id); drawLeftovers(lastLeftovers); }));
      } else {
        label.textContent = 'Checkout with nobody in it: ' + home(c.path) + (c.branch ? ' on ' + c.branch : '') + (c.left ? '. ' + c.left : '');
        row.append(label, leftoverButton('Clean up', () => cleanLeftover(c)));
      }
      leftovers.append(row);
    }
  }
  // Sessions the relay could not bring back after a restart. Their conversations are still there:
  // Resume fills in the folder and the id, and Add worker starts it.
  const failedBox = document.createElement('div');
  leftovers.before(failedBox);
  let failedDrawn = '';
  function drawFailed(list) {
    const text = JSON.stringify(list || []);
    if (text === failedDrawn) return;
    failedDrawn = text; failedBox.textContent = '';
    for (const f of list || []) {
      const row = document.createElement('div'), label = document.createElement('span');
      row.className = 'cc-ask';
      label.textContent = 'Could not come back after the restart: ' + (f.title || home(f.cwd)) + ' · session ' + f.sessionId + ' in ' + home(f.cwd) + ' (' + f.why + '). The next start tries again.';
      // A task's worker comes back as the task, the way Bring back does. Anything else fills in Resume.
      const resume = f.task
        ? () => api('/' + f.task + '/resume', { cols: term.cols, rows: term.rows }, '/tasks').then((r) => {
          if (!r.ok) { tell(r.message, 'off'); return null; }
          return api('/failed', { sessionId: f.sessionId }).then((x) => { if (x.ok) drawFailed(x.failed); });
        })
        : () => { cwdIn.value = home(f.cwd); resumeIn.value = f.sessionId; startBtn.focus(); };
      row.append(label, leftoverButton(f.task ? 'Bring back' : 'Resume', resume),
        leftoverButton('Forget', () => api('/failed', { sessionId: f.sessionId }).then((r) => { if (r.ok) drawFailed(r.failed); })));
      failedBox.append(row);
    }
  }
  function syncLeftovers() { return api('', undefined, '/checkouts').then((r) => { if (r.ok) drawLeftovers(r.checkouts); }); }

  // ---------- reviewers who posted and gave their desk back (relay/terminal.js, reviewDone) ----------
  const finishedBox = document.createElement('div');
  leftovers.before(finishedBox);
  const names = new Map();  // terminal id -> the worker's name, kept after they leave
  const seen = new Set(JSON.parse(store(localStorage, 'office.finishedSeen') || '[]'));
  let finishedDrawn = '';
  const GITHUB = /^https:\/\/github\.com\//;
  function drawFinished(list) {
    const shown = (list || []).filter((f) => !seen.has(f.id + f.at)), text = JSON.stringify(shown);
    if (text === finishedDrawn) return;
    finishedDrawn = text;
    finishedBox.textContent = '';
    for (const f of shown) {
      const row = document.createElement('div'), label = document.createElement('span'), link = document.createElement('a');
      row.className = 'cc-ask';
      const what = f.kind === 'comment' ? 'their comment' : f.kind === 'approve' ? 'their approval' : f.kind === 'request-changes' ? 'the changes they asked for' : 'their review';
      label.textContent = (names.get(f.id) || 'A reviewer') + ' finished ' + (f.title || 'a review') + ', posted ' + what + ' and gave their desk back. ';
      link.textContent = f.url && f.url.includes('#issuecomment-') ? 'See the comment' : 'See the PR';
      if (GITHUB.test(f.url || '')) { link.href = f.url; link.target = '_blank'; link.rel = 'noopener'; label.append(link); }
      row.append(label, leftoverButton('OK', () => { seen.add(f.id + f.at); store(localStorage, 'office.finishedSeen', JSON.stringify([...seen].slice(-50))); drawFinished(list); }));
      finishedBox.append(row);
    }
  }

  // A warning under Add worker when the global hooks run office-hook.js from another checkout.
  // The relay sends only paths and a command with a placeholder for the key.
  function drawHookCheckout(c) {
    const box = $('cc-hooks-warn'), bad = !!(c && c.installed && !c.match && c.fix);
    box.hidden = !bad;
    if (!bad) return;
    $('cc-hooks-from').textContent = (c.from || []).join(', ');
    $('cc-hooks-fix').textContent = c.fix;
  }

  // ---------- seats: the relay's sessions, each at a desk ----------
  let terms = [];  // the relay's sessions at the last sync, with each one's work and PR
  function sync() {
    return api('').then((r) => {
      if (r.ok && r.enabled) {
        terms = r.terminals || [];
        syncLeftovers();
        for (const t of r.terminals) { const w = workerOf(t.id), name = t.who || (w && w.name); if (name) names.set(t.id, name); }
        drawFinished(r.finished);
        drawFailed(r.failed);
        syncReviews();
        syncAutopilot();
        syncSettings();
        drawHookCheckout(r.hookCheckout);
      }
      if (r.ok && r.enabled && window.run) return window.run.do({ action: 'sessions', list: r.terminals, source: 'terminal' }).then(() => { show(); drawLeadButtons(r); offerLead(r.restore); return r; });
      return r;
    });
  }

  // ---------- the Lead's session: you choose it, the relay saves it and offers it back after a restart ----------
  const leadBtn = document.createElement('button');
  leadBtn.type = 'button'; leadBtn.className = 'btn'; leadBtn.id = 'cc-make-lead'; leadBtn.hidden = true; leadBtn.textContent = 'Make this the Lead';
  stopBtn.before(leadBtn);
  let leadTerm = null;
  const leadWait = document.createElement('div');
  leadWait.className = 'cc-ask'; leadWait.id = 'cc-lead-wait'; leadWait.hidden = true;
  notes.append(leadWait);
  leadBtn.addEventListener('click', async () => {
    if (!leadTerm || !current || current.id !== leadTerm.id) return;  // you have just switched sessions, and it has not redrawn yet
    const r = await api('/lead', { terminal: leadTerm.id });
    tell(r.ok ? 'This session is now the Lead. It gets the Lead\'s brief as soon as it is idle.' : r.message, r.ok ? '' : 'off');
    await sync();
  });
  // Who may move the board is your say too, and a separate one from who the Lead is.
  const boardBtn = document.createElement('button');
  boardBtn.type = 'button'; boardBtn.className = 'btn'; boardBtn.id = 'cc-lead-board';
  settingRow('set-lead', [boardBtn], 'The Lead moves tasks and tickets on the Board, and accepts tickets from Triage. Off: the Lead reads the Board and tells you what to move.');
  let boardTerm = null, boardHolder = null;
  // Merging is a fourth say, the merge rung (docs/constitution.md, article 5). Off by default. It changes
  // only what the Lead's brief says, and the relay types the brief again when you turn it on or off.
  const mergeBtn = document.createElement('button');
  mergeBtn.type = 'button'; mergeBtn.className = 'btn'; mergeBtn.id = 'cc-lead-merge';
  settingRow('set-lead', [mergeBtn], 'The Lead merges a PR when all of these are true: a review of the latest commit is posted, each blocking finding is fixed, all checks pass, the PR merges into main with no conflicts, and no decision is left for you. This is the merge rung (constitution, article 5). The Lead never merges a change to CLAUDE.md or the constitution. Off: the Lead does not merge. When you change this, the Lead gets its brief again.');
  let mergeHolder = null;
  // Starting tickets is a third say: off until you choose how few tasks must be building for the Lead to
  // start one, and how many it may start in all. The relay refuses past either (relay/tickets.js), the
  // last start turns it off, and taking it back stops nothing running. Each start is announced here.
  const startsBox = document.createElement('span'); startsBox.id = 'cc-lead-starts';
  const startsBtn = document.createElement('button'); startsBtn.type = 'button'; startsBtn.className = 'btn';
  const startsPick = document.createElement('select'); startsPick.setAttribute('aria-label', 'The Lead starts a ticket only while fewer than this many tasks are building');
  const totalPick = document.createElement('select'); totalPick.setAttribute('aria-label', 'How many tickets the Lead may start in all before the permission turns off');
  for (const n of [1, 2, 3, 5, 10, 20]) { const o = document.createElement('option'); o.value = String(n); o.textContent = n === 1 ? '1 start in all' : n + ' starts in all'; totalPick.append(o); }
  totalPick.value = '3';
  startsBox.append(startsBtn, ' ', startsPick, ' ', totalPick);
  const startsRow = settingRow('set-lead', [startsBox], 'The Lead starts Ready tickets that you approved, one at a time. First number: it starts a ticket only while fewer tasks than this are building. Second number: how many tickets it may start in total. After its last start, this goes off. When you turn it off, work already started continues.');
  let startsHolder = null, startsMax = 0, lastStartSeen;
  function drawStarts(r) {
    const max = (r.wipLimit || 0) - 1;
    if (max !== startsMax) {
      startsMax = max; startsPick.textContent = '';
      for (let n = 1; n <= max; n++) { const o = document.createElement('option'); o.value = String(n); o.textContent = 'while fewer than ' + n + ' building'; startsPick.append(o); }
    }
    const holder = r.terminals.find((x) => x.starts && x.running) || null;
    startsRow.row.hidden = !boardTerm || max < 1;
    // Each start by the Lead, once. What it started before this page loaded is not news.
    const lead = r.terminals.find((x) => x.lead && x.running), last = lead && lead.lastStart;
    const lastKey = last ? last.at + last.ticket : null;
    if (lastStartSeen !== undefined && last && lastKey !== lastStartSeen) {
      tell('The Lead started ' + last.ticket + ' · ' + last.title + '. ' + (last.left ? last.left + (last.left === 1 ? ' start' : ' starts') + ' left.' : 'That was its last start, so it can no longer start tickets.'), last.left ? '' : 'off');
      if (!last.left) startsHolder = null;  // just said why
    } else if (startsHolder && !holder && r.terminals.some((x) => x.id === startsHolder && x.running)) tell('The Lead can no longer start tickets: another session was made the Lead, or it was taken back in another tab. Work it started keeps running.', 'off');
    lastStartSeen = lastKey;
    startsHolder = holder && holder.id;
    if (!boardTerm) return;
    startsBtn.textContent = boardTerm.starts ? 'Stop the Lead starting tickets' : 'Let the Lead start tickets';
    startsPick.disabled = totalPick.disabled = !!boardTerm.starts;
    if (boardTerm.starts) { startsPick.value = String(boardTerm.starts); startsBtn.title = boardTerm.startsLeft + ' starts left'; } else startsBtn.title = '';
  }
  startsBtn.addEventListener('click', async () => {
    if (!boardTerm) return;
    const r = await api('/lead', boardTerm.starts ? { starts: 0 } : { terminal: boardTerm.id, lead: true, starts: Number(startsPick.value), total: Number(totalPick.value) });
    if (r.ok && !r.starts) startsHolder = null;  // you did this, so nothing needs explaining
    tell(r.ok ? (r.starts ? 'The Lead can now start Ready tickets you approved, one at a time, while fewer than ' + r.starts + ' are building, ' + r.startsLeft + ' in all.' : 'The Lead can no longer start tickets. Work it started keeps running.') : r.message, r.ok ? '' : 'off');
    await sync();
  });
  function drawLeadButtons(r) {
    const on = current && r.terminals.find((x) => x.id === current.id && x.running);
    leadTerm = on && !on.task && !on.role && !on.lead ? on : null;
    leadBtn.hidden = !leadTerm;
    const holder = r.terminals.find((x) => x.board && x.running) || null;
    // The Lead's switches are in Settings, so they work whichever session the panel shows.
    boardTerm = r.terminals.find((x) => x.lead && x.running) || null;
    $('set-lead').hidden = !boardTerm;
    $('set-lead-who').textContent = boardTerm
      ? 'A session is the Lead. Each switch below is off until you turn it on. All of them go off when you make a different session the Lead.'
      : 'No session is the Lead. To choose one, open a session in the Claude Code panel and press Make this the Lead. Then come back here to set what it may do.';
    summaryOn.lead = !!(boardTerm && (boardTerm.board || boardTerm.merge || boardTerm.starts));
    summary.lead = boardTerm ? 'Lead: ' + ([boardTerm.board && 'board', boardTerm.merge && 'merge', boardTerm.starts && 'starts'].filter(Boolean).join(', ') || 'reads only') : 'no Lead';
    drawSummary();
    const held = r.terminals.find((x) => x.lead && x.running && x.briefHeld);
    leadWait.hidden = !held;
    if (held) leadWait.textContent = held.hooksSilent
      ? 'The Lead has not had its brief. No hooks reach this relay, so it cannot tell whether that session is at a question, and it will not type there. Run the room hooks, or give the Lead its job yourself.'
      : 'The Lead has not had its brief. It goes in once that session is idle. If its turn was interrupted, or you pressed Esc at a question, it stays out until you send any prompt and that prompt finishes, or until you run /clear.';
    // It ends without anyone pressing this button when another session is made the Lead, or from another tab.
    if (boardHolder && !holder && r.terminals.some((x) => x.id === boardHolder && x.running)) tell('The Lead can no longer move the board: another session was made the Lead, or it was taken back in another tab.', 'off');
    boardHolder = holder && holder.id;
    if (boardTerm) boardBtn.textContent = boardTerm.board ? 'Stop the Lead moving the board' : 'Let the Lead move the board';
    const merger = r.terminals.find((x) => x.merge && x.running) || null;
    if (mergeHolder && !merger && r.terminals.some((x) => x.id === mergeHolder && x.running)) tell('The Lead can no longer merge: another session was made the Lead, or it was taken back in another tab.', 'off');
    mergeHolder = merger && merger.id;
    if (boardTerm) mergeBtn.textContent = boardTerm.merge ? 'Stop the Lead merging' : 'Let the Lead merge';
    drawStarts(r);
    drawLevels();
    drawRefresh(r.terminals.find((x) => x.lead && x.running) || null);
  }
  // ---------- Refresh the Lead: handoff notes, /clear, and the notes read back ----------
  // The relay runs the steps (relay/terminal.js, relay/lead-refresh.js) and types each one only when
  // it is safe. This page asks for it, and shows how it is going.
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button'; refreshBtn.className = 'btn'; refreshBtn.id = 'cc-lead-refresh'; refreshBtn.textContent = 'Refresh the Lead';
  settingRow('set-lead', [refreshBtn], 'Use this when the Lead has run a long time and becomes slow or forgets things. The Lead writes notes about its work. Then the relay clears its conversation, and the Lead reads its notes again. It stays the Lead and keeps its permissions.');
  const REFRESH_SAYS = { notes: 'The Lead is writing its handoff notes.', clear: 'Notes written. The Lead\'s conversation is cleared, and it gets its brief again.' };
  let refreshSaid = null, refreshNoteSeen = null;
  function drawRefresh(lead) {
    const phase = lead ? lead.refresh : null;
    refreshBtn.disabled = false;
    refreshBtn.textContent = phase ? 'Stop the refresh' : 'Refresh the Lead';
    // How tired the Lead is (relay/lead-tired.js), so the person sees whether a refresh is due.
    const tired = lead && lead.tired;
    refreshBtn.title = tired ? 'The Lead has used ' + tired.percent + '% of its context: ' + tired.label + '.' : '';
    if (phase && phase !== refreshSaid) tell(REFRESH_SAYS[phase] || 'Refreshing the Lead.', 'wait');
    refreshSaid = phase;
    const note = lead && lead.refreshNote;
    if (note && note.at !== refreshNoteSeen) { if (refreshNoteSeen !== null || Date.now() - Date.parse(note.at) < 60000) tell(note.text, note.ok ? '' : 'off'); refreshNoteSeen = note.at; }
  }
  refreshBtn.addEventListener('click', async () => {
    const stopping = !!refreshSaid;
    refreshBtn.disabled = true;
    const r = await api('/lead', { refresh: !stopping });
    if (!r.ok) { refreshBtn.disabled = false; tell(r.message || 'The relay did not answer.', 'off'); return; }
    await sync();
  });
  boardBtn.addEventListener('click', async () => {
    if (!boardTerm) return;
    const r = await api('/lead', { terminal: boardTerm.id, lead: true, board: !boardTerm.board });
    if (r.ok && !r.board) boardHolder = null;  // you did this, so nothing needs explaining
    tell(r.ok ? (r.board ? 'The Lead can now move tasks and tickets.' : 'The Lead can no longer move the board.') : r.message, r.ok ? '' : 'off');
    await sync();
  });
  mergeBtn.addEventListener('click', async () => {
    if (!boardTerm) return;
    const r = await api('/lead', { terminal: boardTerm.id, lead: true, merge: !boardTerm.merge });
    if (r.ok && !r.merge) mergeHolder = null;  // you did this, so nothing needs explaining
    tell(r.ok ? (r.merge ? 'The Lead may now merge a PR that meets the merge rung\'s five conditions. It gets its brief again once it is idle.' : 'The Lead is told not to merge. It gets its brief again once it is idle.') : r.message, r.ok ? '' : 'off');
    await sync();
  });
  const RESUME_CHECK = 4000;
  const ask = document.createElement('div'), askText = document.createElement('span'), askYes = document.createElement('button'), askNo = document.createElement('button');
  ask.className = 'cc-ask'; ask.hidden = true;
  askYes.type = askNo.type = 'button'; askYes.className = 'btn primary'; askNo.className = 'btn';
  askYes.textContent = 'Bring back'; askNo.textContent = 'Not now';
  ask.append(askText, askYes, askNo);
  notes.append(ask);
  let offer = null;
  function offerLead(lead) {
    offer = lead || null;
    if (!askYes.disabled) ask.hidden = !offer;  // not while one is coming back
    if (offer && !askYes.disabled) askText.textContent = 'Bring back the Lead\'s last session? ' + (offer.title ? offer.title + ' · ' : '') + short(offer.sessionId) + ' in ' + home(offer.cwd);
  }
  askYes.addEventListener('click', async () => {
    if (!offer) return;
    askYes.disabled = true; say('Starting', 'wait');
    const r = await api('', { cwd: offer.cwd, resume: offer.sessionId, lead: true, cols: term.cols, rows: term.rows });
    if (!r.ok) { askYes.disabled = false; say(r.message || 'Could not bring it back.', 'off'); return; }
    ask.hidden = true;
    attach(r.id); term.focus();
    await sync();
    await new Promise((done) => setTimeout(done, RESUME_CHECK));  // claude exits at once if it cannot find the conversation
    askYes.disabled = false;
    const now = await api('');
    if (now.ok && now.terminals.some((t) => t.id === r.id && t.running)) { await api('/lead', { asked: true }); offerLead(null); await sync(); return; }
    ask.hidden = false;
    say('That session did not come back. Its conversation may be gone.', 'off');
  });
  askNo.addEventListener('click', () => { offerLead(null); api('/lead', { asked: true }); });

  // A session named elsewhere on the page, such as in a ticket's history (office/ticket-history.js): show it here,
  // and follow its person if it has one.
  window.addEventListener('office:session', (ev) => {
    const id = ev.detail && ev.detail.terminal;
    if (!terms.some((t) => t.id === id && t.running)) { say('That session is not running any more.', 'off'); return; }
    attach(id); term.focus();
    const w = workerOf(id);
    if (w) window.dispatchEvent(new CustomEvent('office:pick', { detail: { who: w.id, keep: true } }));
  });
  window.addEventListener('office:pick', (ev) => {
    const w = window.run.state().workers.find((p) => p.id === ev.detail.who);
    if (!w) return;
    if (w.session && w.session.terminal) { attach(w.session.terminal); term.focus(); return; }
    if (es) return;  // keep the session on screen; the status below is only for an empty panel
    say(w.session ? w.name + ' is on a session in another terminal, so it can only be watched here.' : w.name + ' is free. Add a worker to start a session.', '');
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    startBtn.disabled = true; say('Starting', 'wait');
    refit();
    const resume = resumeIn.value.trim(), size = { cols: term.cols, rows: term.rows };  // Resume has to stay in the folder the session ran in
    const r = await (resume || useFolder.checked ? api('', Object.assign({ cwd: cwdIn.value, resume: resume || undefined }, size)) : api('', Object.assign({ from: cwdIn.value }, size), '/checkouts'));
    startBtn.disabled = false;
    if (!r.ok) { say(r.message || 'Could not start Claude Code.', 'off'); return; }
    store(localStorage, 'office.cwd', cwdIn.value); resumeIn.value = '';
    attach(r.id); term.focus();
    await sync();
    const w = workerOf(r.id);
    if (w) window.dispatchEvent(new CustomEvent('office:pick', { detail: { who: w.id, keep: true } }));
  });
  // Once you press Stop, the panel sends the session no new size: the header gets shorter as its
  // buttons hide, and a resize could reach the relay after the session has gone.
  stopBtn.addEventListener('click', () => { if (current) { current.stopping = true; say('Stopping', 'wait'); api('/' + current.id + '/stop', {}); } });
  box.addEventListener('click', () => term.focus());

  // on load: seat the running sessions and reconnect to the one this tab was showing
  sync().then((r) => {
    if (r.status === 403) { off(r.message + ' Open the room at http://localhost.'); return; }
    if (r.status === 401) { off('This page\'s key is not the relay\'s key, so nothing on this page reaches the relay. See the note under the room bar.'); $('key-warn').hidden = false; return; }
    if (!r.ok) { off(r.message || 'The relay did not answer.'); return; }
    if (!r.enabled) { off(r.message); return; }
    note.hidden = true;
    if (r.cwd) cwdIn.value = home(r.cwd);  // the folder the relay runs in, until a session is on screen
    const running = r.terminals.filter((t) => t.running), saved = store(sessionStorage, 'office.terminal');
    const lastSession = store(sessionStorage, 'office.session');
    const open = running.find((t) => t.id === saved) || running.find((t) => lastSession && t.sessionId === lastSession) || running[running.length - 1];
    if (open) attach(open.id);
    else {
      say('Ready. Pick a folder and add a worker.', '');
      term.write('\x1b[2mPick a folder, then press Add worker. Each session gets its own person in the room above. Click a person to see their session here.\x1b[0m\r\n');
    }
    setInterval(sync, 2000);
  });
})();
