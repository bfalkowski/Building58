// The busy count beside the scene, the feed of what happened, and the controls under the scene. Which
// session is picked for the Claude Code panel is kept here (office:pick). The seats and the workers row
// are office/front-view.js. Uses the public API in window.run.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const run = window.run;
  const feed = $('feed'), busyEl = $('busy'), hudBusy = $('hud-busy');
  if (!run) {
    busyEl.textContent = 'unavailable';
    document.querySelectorAll('.toolbar button:not(#radio-btn, #radio-next), .toolbar select').forEach((b) => { b.disabled = true; });
    return;
  }
  const R = window.OFFICE_ROSTER || {};
  const roomName = R.company || 'Building58';
  const pageTitle = roomName === 'Building58' ? roomName : roomName + ' · Building58';
  $('title').textContent = roomName;
  $('hud-company').textContent = roomName;
  document.title = pageTitle;

  const fmt = (s) => s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  let selected = null;

  window.addEventListener('office:pick', (ev) => {
    const { who, keep } = ev.detail;
    selected = selected === who && !keep ? null : who;
    run.focus(selected);
    window.dispatchEvent(new CustomEvent('office:selected', { detail: selected }));
  });
  function render() {
    const s = run.state();
    const waiting = s.waitingOnYou.length;
    const text = s.busy + ' of ' + s.people + ' busy' + (waiting ? ', ' + waiting + ' waiting on you' : '');
    busyEl.textContent = text; hudBusy.textContent = text;
    document.title = (waiting ? '(' + waiting + ') ' : '') + pageTitle;
  }

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
      case 'manager.arrived': return ['The manager came out of his office. Everyone looks very busy', 'sys'];
      case 'manager.left': return ['The manager went back to his office', 'sys'];
      case 'lead.visit': return ['The Lead went to see the manager', 'sys'];
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

  $('finish').addEventListener('click', () => run.do({ action: 'done', all: true, source: 'viewer' }));
  const tagsBtn = $('tags-btn');
  tagsBtn.addEventListener('click', () => tagsBtn.setAttribute('aria-pressed', String(run.tags())));
  $('time').addEventListener('change', (ev) => run.time(ev.target.value));
  const decorBtn = $('decor-btn'), holidaySel = $('holiday');
  const showDecor = (s) => { decorBtn.setAttribute('aria-pressed', String(s.on)); holidaySel.value = s.preview || ''; };
  if (run.holiday) {
    showDecor(run.holiday());
    decorBtn.addEventListener('click', () => showDecor(run.holiday(run.holiday().on ? 'off' : 'on')));
    holidaySel.addEventListener('change', () => showDecor(run.holiday(holidaySel.value || 'auto')));
  }

  const partyBtn = $('party-btn');
  const partyOn = () => { const p = run.state().party; return p.on && !p.ending; };
  const showParty = () => { const on = partyOn(); partyBtn.setAttribute('aria-pressed', String(on)); partyBtn.textContent = on ? 'End the party' : 'Throw a party'; };
  partyBtn.addEventListener('click', () => run.do({ action: 'party', on: !partyOn(), source: 'viewer' }).then(showParty));
  ['party.started', 'party.ending', 'party.ended'].forEach((t) => run.on(t, showParty));
  showParty();

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
