// The room radio: plays office/radio-songs.js with Web Audio, one after another, like an old
// record through a small speaker. Sound stays off until the viewer presses the button, and it
// keeps playing while the tab is in the background.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const songs = window.OFFICE_SONGS || [];
  const button = $('radio-btn'), nextBtn = $('radio-next'), nowPlaying = $('radio-now');
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !songs.length) { button.disabled = true; return; }

  // How sour the radio sounds. Each note of the scale is always off by the same amount, as on
  // an old instrument nobody has tuned, so chords beat against themselves. In cents, where 100
  // is a semitone: at 1 the worst note is 18 cents off, close to wrong but not quite.
  const SOUR = 1;
  const TUNING = [14, -11, 18, -7, 12, -16, 9, 17, -13, 6, -18, 11];
  // The warped record: a slow sway and a quick shiver in the pitch of everything at once.
  const WOW = { hz: 0.6, cents: 9 }, FLUTTER = { hz: 5.7, cents: 3 };
  const LEVEL = 0.7; // keeps the speaker's mid boost from clipping in the busiest songs
  // Seconds of notes to schedule ahead. A background tab's timers only fire about once a second.
  const lookahead = () => document.hidden ? 3 : 1;

  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const sour = (m) => TUNING[((m % 12) + 12) % 12] * SOUR;
  // seconds of delay swing that bend the pitch by this many cents at this rate
  const delaySwing = ({ hz: rate, cents }) => (Math.pow(2, cents / 1200) - 1) / (2 * Math.PI * rate);

  let c = null, mix = null, out = null, noise = null, vibes = null;
  let on = false, index = 0, disc = null, pos = 0, t0 = 0, ticker = null, sleeper = null;

  function loop(buffer, dest) { const s = c.createBufferSource(); s.buffer = buffer; s.loop = true; s.connect(dest); s.start(); }
  function lfo(rate, depth, param) {
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = rate; g.gain.value = depth; o.connect(g); g.connect(param); o.start();
  }

  function build() {
    c = new AC();
    mix = c.createGain(); mix.gain.value = 0.6;
    out = c.createGain(); out.gain.value = 0;

    // a small studio: a short tail of decaying noise
    const size = Math.floor(c.sampleRate * 1.3), ir = c.createBuffer(1, size, c.sampleRate), id = ir.getChannelData(0);
    for (let i = 0; i < size; i++) id[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / size, 3.2);
    const room = c.createConvolver(), wet = c.createGain(); room.buffer = ir; wet.gain.value = 0.16;

    // the turntable bends the pitch of the whole band together by moving a short delay
    const table = c.createDelay(0.1); table.delayTime.value = 0.02;
    lfo(WOW.hz, delaySwing(WOW), table.delayTime);
    lfo(FLUTTER.hz, delaySwing(FLUTTER), table.delayTime);

    // the small speaker
    const shaper = c.createWaveShaper(), curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) curve[i] = Math.tanh((i / 511.5 - 1) * 1.6);
    shaper.curve = curve;
    const low = c.createBiquadFilter(), mid = c.createBiquadFilter(), high = c.createBiquadFilter();
    low.type = 'highpass'; low.frequency.value = 180;
    mid.type = 'peaking'; mid.frequency.value = 1300; mid.gain.value = 5; mid.Q.value = 0.8;
    high.type = 'lowpass'; high.frequency.value = 3600;

    mix.connect(table); mix.connect(room); room.connect(wet); wet.connect(table);
    table.connect(shaper); shaper.connect(low); low.connect(mid); mid.connect(high); high.connect(out); out.connect(c.destination);

    // record crackle and hiss
    const cb = c.createBuffer(1, c.sampleRate * 4, c.sampleRate), cd = cb.getChannelData(0);
    for (let i = 0; i < cd.length; i++) cd[i] = (Math.random() * 2 - 1) * 0.012 + (Math.random() < 14 / c.sampleRate ? (Math.random() * 2 - 1) * 0.9 : 0);
    const hiss = c.createBiquadFilter(), hissGain = c.createGain();
    hiss.type = 'highpass'; hiss.frequency.value = 900; hissGain.gain.value = 0.3;
    loop(cb, hiss); hiss.connect(hissGain); hissGain.connect(low);

    noise = c.createBuffer(1, Math.floor(c.sampleRate * 0.3), c.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // every vibraphone bar shares one motor, so they all pulse together
    vibes = c.createGain(); vibes.gain.value = 0.72; vibes.connect(mix);
    lfo(4.6, 0.28, vibes.gain);

    // a phone call or another app can stop the audio; pick the song up where it stopped
    c.addEventListener('statechange', () => { if (on) { if (c.state === 'running') begin(); else wake(); } });
  }

  function env(g, t, attack, peak, end) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
  }
  function tone(type, m, t, stop, dest, cents, mul) {
    const o = c.createOscillator();
    o.type = type; o.frequency.value = hz(m) * (mul || 1); o.detune.value = sour(m) + (cents || 0);
    o.connect(dest); o.start(t); o.stop(stop);
    return o;
  }
  function burst(t, dur, dest, type, freq, q) {
    const s = c.createBufferSource(), f = c.createBiquadFilter();
    s.buffer = noise; f.type = type; f.frequency.value = freq; f.Q.value = q;
    s.connect(f); f.connect(dest); s.start(t); s.stop(t + dur);
  }
  function gainTo(dest) { const g = c.createGain(); g.connect(dest); return g; }
  // two strings a little apart, plus overtones that fade faster the higher they are
  function struck(e, t, to, end) {
    const body = gainTo(to), bright = gainTo(to);
    env(body, t, 0.005, e.g, end);
    env(bright, t, 0.003, e.g * 0.5, t + 0.75);
    tone('triangle', e.m, t, end, body, -3.5); tone('triangle', e.m, t, end, body, 3.5);
    tone('sine', e.m, t, t + 0.8, bright, 1.5, 2);
    tone('sine', e.m, t, t + 0.8, bright, -2, 3);
    const hammer = gainTo(to); env(hammer, t, 0.001, e.g * 0.1, t + 0.02);
    burst(t, 0.03, hammer, 'lowpass', 1700, 0.7);
  }
  function drum(attack, len, type, freq, q) {
    return (e, t, to) => { const g = gainTo(to); env(g, t, attack, e.g, t + len); burst(t, len + 0.02, g, type, freq, q); };
  }

  const VOICES = {
    // a bar is mostly one pure tone, with a bright fourth partial that dies quickly
    vibes(e, t, to) {
      const ring = Math.max(e.d + 0.5, e.m > 76 ? 1.4 : 2.2), end = t + ring, bar = gainTo(to);
      env(bar, t, 0.004, e.g, end);
      tone('sine', e.m, t, end, bar, -2.5); tone('sine', e.m, t, end, bar, 2.5);
      const shine = gainTo(to); env(shine, t, 0.002, e.g * 0.28, t + 0.55);
      tone('sine', e.m, t, t + 0.6, shine, 0, 4);
      const mallet = gainTo(to); env(mallet, t, 0.001, e.g * 0.18, t + 0.03);
      burst(t, 0.04, mallet, 'bandpass', 2400, 1.1);
    },
    // a sustained note rings on; the lower it is, the longer
    piano(e, t, to) { struck(e, t, to, t + Math.max(e.d + 0.25, 1.4 + Math.max(0, (72 - e.m) / 36) * 2.6)); },
    // the same strings, damped as soon as the key comes up
    keys(e, t, to) { struck(e, t, to, t + e.d + 0.18); },
    // two reedy voices with vibrato that arrives once the note has settled
    reed(e, t, to) { blown(e, t, to, 1500, 0.04, 0.16, 5.2, 13); },
    // a brighter, tighter muted horn
    horn(e, t, to) { blown(e, t, to, 2200, 0.018, 0.07, 5.8, 9); },
    pad(e, t, to) {
      const g = gainTo(to), end = t + e.d + 0.5;
      tone('sine', e.m, t, end, g, -4); tone('triangle', e.m, t, end, g, 4);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(e.g, t + 0.4);
      g.gain.setValueAtTime(e.g, t + e.d); g.gain.linearRampToValueAtTime(0, end);
    },
    // a plucked string: quick and bright at first, with a short warm tail
    guitar(e, t, to) {
      const end = t + Math.max(e.d + 0.3, 1), body = gainTo(to), pick = gainTo(to);
      env(body, t, 0.004, e.g, end);
      env(pick, t, 0.002, e.g * 0.4, t + 0.18);
      tone('triangle', e.m, t, end, body, -2); tone('sine', e.m, t, end, body, 2);
      tone('sawtooth', e.m, t, t + 0.2, pick);
    },
    bass(e, t, to) {
      const g = gainTo(to), end = t + e.d + 0.05;
      env(g, t, 0.01, e.g, end);
      tone('triangle', e.m, t, end, g);
    },
    chop(e, t, to) {
      const g = gainTo(to), end = t + 0.13;
      env(g, t, 0.003, e.g, end);
      tone('triangle', e.m, t, end, g);
    },
    brush: drum(0.03, 0.2, 'bandpass', 5000, 0.7),
    ride: drum(0.002, 0.28, 'bandpass', 3300, 2.2),
    hat: drum(0.002, 0.06, 'highpass', 2600, 0.7),
    snare: drum(0.002, 0.1, 'bandpass', 1900, 0.8),
    clave: drum(0.001, 0.05, 'bandpass', 2300, 9)
  };
  function blown(e, t, to, bright, attack, release, rate, depth) {
    const g = gainTo(to), f = c.createBiquadFilter(), wobble = c.createOscillator(), amount = c.createGain(), end = t + e.d + release + 0.02;
    f.type = 'lowpass'; f.frequency.value = bright; f.Q.value = 1.1; f.connect(g);
    wobble.frequency.value = rate; wobble.connect(amount);
    amount.gain.setValueAtTime(0, t); amount.gain.linearRampToValueAtTime(depth, t + Math.min(0.5, Math.max(0.05, e.d)));
    [-5, 5].forEach((cents) => amount.connect(tone('sawtooth', e.m, t, end, f, cents).detune));
    wobble.start(t); wobble.stop(end);
    const hold = Math.max(attack + 0.01, e.d - 0.03);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(e.g, t + attack);
    g.gain.setValueAtTime(e.g, t + hold); g.gain.linearRampToValueAtTime(0, t + e.d + release);
  }

  // A disc is one gain that all of a song's notes go through, so changing songs can silence
  // notes that are already scheduled. The vibraphone joins it through the motor's own gain.
  function putOn(i, delay) {
    takeOff();
    index = ((i % songs.length) + songs.length) % songs.length;
    disc = c.createGain(); disc.connect(mix);
    const motor = c.createGain(); motor.connect(vibes);
    disc.motor = motor;
    pos = 0; t0 = c.currentTime + delay;
    nowPlaying.textContent = songs[index].title;
    tick();
  }
  function takeOff() {
    if (!disc) return;
    const old = disc, now = c.currentTime;
    [old, old.motor].forEach((g) => { g.gain.setValueAtTime(g.gain.value, now); g.gain.linearRampToValueAtTime(0, now + 0.12); });
    setTimeout(() => { old.disconnect(); old.motor.disconnect(); }, 400);
    disc = null;
  }
  function tick() {
    if (!on || !disc || c.state !== 'running') return;
    const song = songs[index], now = c.currentTime;
    // if the timers stalled past the scheduled notes, the song waits rather than losing its place
    if (pos < song.ev.length && t0 + song.ev[pos].t < now) t0 = now + 0.05 - song.ev[pos].t;
    while (pos < song.ev.length && t0 + song.ev[pos].t < now + lookahead()) {
      const e = song.ev[pos++];
      VOICES[e.v](e, t0 + e.t, e.v === 'vibes' ? disc.motor : disc);
    }
    if (pos >= song.ev.length && now > t0 + song.len) putOn(index + 1, 1.2);
  }

  function show(playing) {
    button.setAttribute('aria-pressed', String(playing));
    nextBtn.hidden = !playing;
    nowPlaying.hidden = !playing;
  }
  function fail() {
    on = false;
    clearInterval(ticker); ticker = null;
    show(false);
    nowPlaying.textContent = 'The radio could not start';
    nowPlaying.hidden = false;
  }
  function wake() { return c.resume().catch(fail); }
  function turnOn() {
    try { if (!c) build(); } catch (e) { c = null; fail(); return; }
    on = true;
    clearTimeout(sleeper);
    show(true);
    if (!ticker) ticker = setInterval(tick, 250);
    wake().then(() => { if (on && c.state === 'running') begin(); });
  }
  function begin() {
    out.gain.setTargetAtTime(LEVEL, c.currentTime, 0.08);
    nowPlaying.textContent = songs[index].title;
    if (disc) tick(); else putOn(index, 0.2);
  }
  function turnOff() {
    on = false;
    show(false);
    clearInterval(ticker); ticker = null;
    clearTimeout(sleeper);
    out.gain.setTargetAtTime(0, c.currentTime, 0.05);
    sleeper = setTimeout(() => c.suspend(), 300);
  }
  button.addEventListener('click', () => { if (on) turnOff(); else turnOn(); });
  nextBtn.addEventListener('click', () => { if (on) { wake(); putOn(index + 1, 0.35); } });
  document.addEventListener('visibilitychange', tick); // fill the longer lookahead before timers slow down
})();
