// The trailer: ?trailer in the address plays a short film of the room, like a game trailer. It is
// staged, not real work: the camera flies a shot list, people are told where to go, and title cards
// come and go. Close-ups of faces and monitors, the city out of the window, the party with snapshots,
// and the manager walking through.
// Everything moves by the page's clock, never by CSS animations, so node office/record-trailer.js can
// step the clock one frame at a time and make a smooth video on any computer.
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  if (!params.has('trailer') || !window.run || !window.run.direct) return;
  const run = window.run;
  const html = document.documentElement;
  html.classList.add('trailer');
  window.dispatchEvent(new Event('resize'));

  const clamp01 = (k) => Math.max(0, Math.min(1, k));
  const smooth = (k) => { k = clamp01(k); return k * k * k * (k * (k * 6 - 15) + 10); };
  const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const scale = (a, s) => a.map((v) => v * s);
  const at = (name, fallback) => { const w = run.where(name); return w ? w.at : fallback; };
  const turn = (f, a) => [f[0] * Math.cos(a) + f[2] * Math.sin(a), 0, -f[0] * Math.sin(a) + f[2] * Math.cos(a)];

  const dolly = (p0, t0, p1, t1) => (k) => ({ pos: mix(p0, p1, k), target: mix(t0, t1 || t0, k) });
  function face(id, o) {
    o = Object.assign({ side: 0.6, d0: 1.1, d1: 0.8, up: 0.04 }, o);
    let last = null;
    return (k) => {
      const w = run.where(id) || last; if (!w) return null; last = w;
      const s = run.where('screen:' + id), near = s && Math.hypot(s.at[0] - w.at[0], s.at[2] - w.at[2]) < 1.2;
      const dir = turn(near ? scale(s.facing, -1) : w.facing, o.side), head = add(w.at, [0, -0.03, 0]);
      return { pos: add(add(head, scale(dir, o.d0 + (o.d1 - o.d0) * k)), [0, o.up, 0]), target: head };
    };
  }
  function screen(id, o) {
    o = Object.assign({ side: 0.55, d0: 0.95, d1: 0.7 }, o);
    return (k) => {
      const s = run.where('screen:' + id); if (!s) return null;
      const dir = turn(s.facing, o.side);
      return { pos: add(add(s.at, scale(dir, o.d0 + (o.d1 - o.d0) * k)), [0, 0.03, 0]), target: s.at };
    };
  }
  function orbit(name, o) {
    o = Object.assign({ r: 2, h: 1, a0: 0, a1: 0.6, lift: 0 }, o);
    return (k) => {
      const c = at(name, [0, 0, 0]), a = o.a0 + (o.a1 - o.a0) * k;
      return { pos: [c[0] + Math.sin(a) * o.r, c[1] + o.h, c[2] + Math.cos(a) * o.r], target: add(c, [0, o.lift, 0]) };
    };
  }
  function track(id, p0, p1) {
    let last = [0, 1, 0];
    return (k) => { const w = run.where(id); if (w) last = w.at; return { pos: mix(p0, p1, k), target: last }; };
  }
  function shoulder(id, o) {
    o = Object.assign({ back: 1.4, side: 0.4, up: 0.15, ahead: 3, drift: 0.25 }, o);
    let last = null;
    return (k) => {
      const w = run.where(id) || last; if (!w) return null; last = w;
      const f = w.facing, r = [f[2], 0, -f[0]];
      const pos = add(add(add(w.at, scale(f, -(o.back - o.drift * k))), scale(r, o.side)), [0, o.up, 0]);
      return { pos, target: add(add(w.at, scale(f, o.ahead)), [0, -0.1, 0]) };
    };
  }

  const layer = document.createElement('div'); layer.id = 'trailer';
  layer.innerHTML = '<div class="tr-black"></div><div class="tr-flash"></div><div class="tr-bar tr-top"></div><div class="tr-bar tr-bottom"></div>' +
    '<div class="tr-card"><div class="tr-big"></div><div class="tr-small"></div></div>';
  document.body.appendChild(layer);
  const $ = (s) => layer.querySelector(s);
  const black = $('.tr-black'), flash = $('.tr-flash'), card = $('.tr-card'), big = $('.tr-big'), small = $('.tr-small');
  const stage = document.getElementById('stage');
  const caption = document.createElement('div'); caption.className = 'tr-caption'; stage.appendChild(caption);

  const SHOTS = [];
  const shot = (dur, move, o) => SHOTS.push(Object.assign({ dur, move, fov: 34, ease: true }, o));
  const hold = (dur) => shot(dur, null);

  hold(3.2);
  shot(6, dolly([-5.4, 1.65, -0.3], [-8.4, 2.25, -0.5], [-6.35, 1.75, -0.2], [-8.4, 2.2, -0.2]), { fov: 40 });
  shot(4, dolly([0.6, 2.75, -2.2], [-0.95, 3.15, -4.97], [-2.4, 2.9, -2.6], [-0.95, 3.15, -4.97]), { fov: 32 });
  hold(1.8);
  shot(3.4, face('lead', { side: 0.7 }), { fov: 30, key: 1.6 });
  shot(2.6, screen('priya'), { fov: 30 });
  shot(2.8, face('marcus', { side: -0.6 }), { fov: 30, key: 1.6 });
  shot(2.6, screen('theo', { side: -0.55 }), { fov: 30 });
  shot(3.4, dolly([2.6, 3.4, 5.4], [-1.2, 0.9, -1.2], [1.2, 2.6, 4.0], [-1.0, 0.9, -1.2]), { fov: 36 });
  hold(1.8);
  shot(3.2, orbit('espresso', { r: 1.7, h: 0.45, a0: 1.25, a1: 0.95, lift: 0.25 }), { fov: 34, key: 1.2 });
  shot(4, shoulder('sam'), { fov: 36 });
  shot(4, dolly([2.4, 1.7, 6.4], [-0.6, 0.8, 3.4], [1.4, 1.35, 5.7], [-0.6, 0.85, 3.4]), { fov: 38 });
  hold(1.8);
  shot(3.4, orbit('cake', { r: 3.2, h: 2.1, a0: -0.5, a1: 0.1, lift: 0.5 }), { fov: 40 });
  shot(3.2, orbit('cake', { r: 3.2, h: 1.3, a0: 0.8, a1: 1.0, lift: 0.6 }), { fov: 40 });
  shot(3.2, orbit('cake', { r: 3.4, h: 1.4, a0: 2.6, a1: 2.4, lift: 0.6 }), { fov: 40 });
  shot(2.6, orbit('cake', { r: 0.9, h: 0.25, a0: 0.2, a1: 0.5, lift: 0.05 }), { fov: 30 });
  hold(3.6);
  shot(5, track('manager', [1.2, 1.9, 3.6], [0.4, 1.75, 2.6]), { fov: 34 });
  shot(6.5, dolly([10.5, 7.6, 10.6], [-0.2, 0.6, -0.2], [7.4, 6.8, 13], [-0.2, 0.6, -0.2]), { fov: 34 });
  shot(7, dolly([4.8, 4.2, 7.2], [-1.4, 1.4, -3], [11, 9, 14.5], [-0.2, 0.6, -0.2]), { fov: 34 });
  hold(4);

  let t0 = 0; SHOTS.forEach((s) => { s.at = t0; t0 += s.dur; });
  const LENGTH = t0;

  const CARDS = [
    [0.4, 2.6, 'In a city that never logs off', '', true],
    [4.2, 4.4, 'one room runs on Claude Code', ''],
    [13.2, 1.6, 'Work hard.', '', true],
    [29.8, 1.6, 'Take breaks.', '', true],
    [42.8, 1.6, 'Ship it.', '', true],
    [57.0, 1.6, 'And whatever happens...', '', true],
    [58.9, 1.5, 'look busy.', '', true],
    [79.0, 3.8, 'BUILDING58', 'Every Claude Code session gets a desk.<br>github.com/bfalkowski/Building58', true]
  ];
  const SNAPS = [
    [46.6, 1.4, 'PR #16 merged!', -3],
    [49.8, 1.4, '84 tests green', 2.5],
    [53.0, 1.4, 'Friday cake', -1.5]
  ];
  const workers = ['lead', 'priya', 'marcus', 'theo', 'ines'];
  const lines = {
    lead: [['Reading the board', 'read'], ['Three PRs ready to merge', 'tool']],
    priya: [['Read relay/server.js', 'read'], ['Edit relay/server.js', 'edit'], ['npm test: 84 passed', 'bash']],
    marcus: [['Write relay/test/party.test.js', 'edit'], ['npm test', 'bash']],
    theo: [['gh pr create', 'bash'], ['PR #16 opened', 'tool']],
    ines: [['Read docs/manual/how-it-works.html', 'read']]
  };
  const speed = (value) => () => run.speed({ value });
  const CUES = [
    [0, () => { run.tags(false); run.time('night'); run.cast(); run.speed({ value: 8 });
      workers.forEach((who) => run.work({ who, label: who === 'lead' ? 'Ship the room' : 'PR' }));
      for (const who in lines) lines[who].forEach(([text, kind]) => run.activity({ who, text, kind })); }],
    [1, () => { run.idle({ who: 'sam', do: 'window' }); run.idle({ who: 'june', do: 'couch' }); }],
    [3.2, speed(1)],
    [15.4, () => run.say({ who: 'lead', text: 'Let\'s ship it.' })],
    [19.5, () => run.activity({ who: 'priya', text: 'All tests pass', kind: 'bash' })],
    [29.8, () => {
      run.speed({ value: 8 });
      run.state().workers.filter((w) => w.doing === 'Playing ping pong').forEach((w) => run.idle({ who: w.id, do: 'desk' }));
      run.idle({ who: 'sam', do: 'window' });
    }],
    [29.9, () => run.idle({ who: 'kai', do: 'pingpong' })],
    [31.4, () => run.idle({ who: 'noor', do: 'coffee' })],
    [31.6, speed(1)],
    [42.8, () => { run.done({ all: true }); run.party({ on: true, seconds: 60 }); run.speed({ value: 8 }); }],
    [44.6, speed(1)],
    [48.4, () => run.say({ who: 'june', text: 'Cake!' })],
    [55.2, () => run.party({ on: false })],
    [57.0, speed(3)],
    [57.2, () => run.manager()],
    [58.6, () => { run.speed({ value: 1 }); workers.forEach((who) => run.work({ who, label: 'Looking busy' })); }],
    [65.8, () => { run.speed({ value: 8 }); run.time('day'); }],
    [68, () => run.time('evening')],
    [69.7, () => { run.time('night'); run.managerGone(); }],
    [72.1, speed(1)]
  ];

  let start = null, fired = 0, last = null, taken = false;
  function fade(t, a, d, edge) { return Math.min(smooth((t - a) / edge), smooth((a + d - t) / edge)); }
  function fire(cue) { try { cue(); return true; } catch (e) { return false; } }
  function tick(now) {
    requestAnimationFrame(tick);
    if (start === null) start = now;
    const t = window.trailer.clock != null ? window.trailer.clock : (now - start) / 1000;
    if (window.trailer.clock != null && !taken) { taken = true; fired = 0; }
    if (window.trailer.clock != null) run.clock(t);
    while (fired < CUES.length && CUES[fired][0] <= t) { fire(CUES[fired][1]); fired++; }
    const s = SHOTS.find((x) => t >= x.at && t < x.at + x.dur) || SHOTS[SHOTS.length - 1];
    if (s.move && !stage.classList.contains('tr-snap')) {
      const k = s.ease ? smooth((t - s.at) / s.dur) : clamp01((t - s.at) / s.dur);
      const c = s.move(k) || last;
      if (c) { last = c; run.direct({ pos: c.pos, target: c.target, fov: s.fov, key: s.key || 0 }); }
    }
    let shown = null, opacity = 0, dark = 0;
    for (const [a, d, b, sm, isBlack] of CARDS) {
      if (t < a - 0.3 || t > a + d + 0.3) continue;
      shown = [b, sm]; opacity = fade(t, a, d, 0.35);
      if (isBlack) dark = Math.max(dark, fade(t, a - 0.3, d + 0.6, 0.3));
    }
    if (shown && big.innerHTML !== shown[0]) { big.innerHTML = shown[0]; small.innerHTML = shown[1]; }
    card.style.opacity = opacity.toFixed(3);
    dark = Math.max(dark, 1 - smooth((t - 3.2) / 1.2), smooth((t - (LENGTH - 0.8)) / 0.7));
    black.style.opacity = dark.toFixed(3);
    let snap = null;
    for (const x of SNAPS) if (t >= x[0] && t < x[0] + x[1]) snap = x;
    const f = SNAPS.reduce((m, x) => t >= x[0] && t < x[0] + 0.25 ? Math.max(m, 1 - (t - x[0]) / 0.25) : m, 0);
    flash.style.opacity = f.toFixed(3);
    if (snap) {
      if (!stage.classList.contains('tr-snap')) { stage.classList.add('tr-snap'); run.speed({ value: 0 }); caption.textContent = snap[2]; }
      const k = smooth((t - snap[0]) / 0.3);
      stage.style.transform = 'rotate(' + (snap[3] * k).toFixed(2) + 'deg) scale(' + (1 - 0.2 * k).toFixed(4) + ')';
      caption.style.opacity = k.toFixed(3);
    } else if (stage.classList.contains('tr-snap')) {
      stage.classList.remove('tr-snap'); stage.style.transform = ''; caption.style.opacity = '0'; run.speed({ value: 1 });
    }
    html.dataset.trailer = t >= LENGTH ? 'done' : 'playing';
    window.trailer.t = t; window.trailer.shot = SHOTS.indexOf(s);
  }
  window.trailer = { length: LENGTH, shots: SHOTS.length };
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  async function begin() {
    await run.ready();
    const L = window.OfficeLook;
    if (L && L.state.look === 'baked') {
      for (const time of ['day', 'evening', 'night']) {
        run.time(time);
        for (let i = 0; i < 1200 && L.state.status !== 'live' && L.state.time !== time; i++) await frame();
      }
      for (let i = 0; i < 1200 && L.state.fx === 'loading'; i++) await frame();
    }
    requestAnimationFrame(tick);
  }
  html.dataset.trailer = 'waiting';
  begin();
})();
