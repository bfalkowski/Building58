#!/usr/bin/env node
// The trailer's music: an original tune in a mid-1980s synth-pop style, written here as notes and
// drawn sample by sample, so it has no licence but this repo's. node office/trailer-music.js out.wav
// writes it alone; office/record-trailer.js lays it under the film unless you give --audio.
//
// The sound of the time, not of any one song: a drum machine with a big gated snare, handclaps
// and a tambourine; a bass line that walks rather than pulses; a choir pad; bell-like electric
// piano; a bittersweet major key (D, A, Bm, G); and a lead tune you could sing.
//
// It follows the film (office/trailer.js) in bars of 2.2 seconds (109 beats a minute):
//   bars 0 to 6     the city and the sign: choir and bells only
//   bars 6 to 12    work: the drums and the bass come in
//   bars 12 to 20   the tune, softly, on a flute-like synth
//   bars 20 to 26   the party: the full lead, and handclaps
//   bars 26 to 28   "And whatever happens... look busy.": only the choir, one hit on "look busy"
//   bars 28 to 36   the manager, the time-lapse and the pull-back: everything, the tune again
//   bar 36 on       the freeze-frame: one big chord rings out
'use strict';
const fs = require('fs');

const RATE = 44100, BPM = 109.0909, BEAT = 60 / BPM, BAR = BEAT * 4, STEP = BEAT / 4;
// D major: D, A, Bm, G, as MIDI notes
const CHORDS = [[62, 66, 69], [61, 64, 69], [62, 66, 71], [62, 67, 71]];
const ROOTS = [38, 33, 35, 31];
// The bass walks: chord steps above the root (0 root, 7 fifth, 12 octave), one per eighth.
const WALK = [0, 0, 12, 0, 7, 0, 12, 7];
// The tune, eight bars: [beat, beats long, MIDI note]
const TUNE = [
  [[0, 1.5, 78], [1.5, 0.5, 76], [2, 1, 74], [3, 1, 69]],
  [[0, 1.5, 73], [1.5, 0.5, 74], [2, 2, 76]],
  [[0, 1, 78], [1, 0.5, 78], [1.5, 0.5, 76], [2, 1, 74], [3, 1, 71]],
  [[0, 1.5, 74], [1.5, 0.5, 76], [2, 1, 71], [3, 1, 69]],
  [[0, 1.5, 81], [1.5, 0.5, 78], [2, 1, 76], [3, 1, 74]],
  [[0, 1, 76], [1, 1, 73], [2, 2, 76]],
  [[0, 1.5, 78], [1.5, 0.5, 79], [2, 1, 78], [3, 1, 74]],
  [[0, 3, 76], [3, 1, 74]]
];
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// A tiny random number source, so the noise is the same every time.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1; }; }
// A band-pass filter (a biquad), for the choir's vowel and the tambourine's jingle.
function bandpass(f, q) {
  const w = 2 * Math.PI * f / RATE, a = Math.sin(w) / (2 * q), a0 = 1 + a;
  const b0 = a / a0, b2 = -a / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - a) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
const lowpass = () => { let y = 0; return (x, cut) => { const k = 1 - Math.exp(-2 * Math.PI * cut / RATE); y += k * (x - y); return y; }; };
const saw = (p) => 2 * (p - Math.floor(p + 0.5));
const square = (p) => (p - Math.floor(p)) < 0.5 ? 1 : -1;
const env = (t, a, r, len) => t < 0 ? 0 : t < a ? t / a : t < len ? 1 : Math.max(0, 1 - (t - len) / r);

function render(seconds) {
  const n = Math.ceil(seconds * RATE);
  const L = new Float32Array(n), R = new Float32Array(n), verb = new Float32Array(n), echo = new Float32Array(n);
  const noise = rng(58);
  // A voice: a function of time since the note started, mixed in from start for len (plus release).
  function note(start, len, release, pan, send, echoSend, fn) {
    const s0 = Math.floor(start * RATE), s1 = Math.min(n, Math.ceil((start + len + release) * RATE));
    const pl = Math.cos((pan + 1) * Math.PI / 4), pr = Math.sin((pan + 1) * Math.PI / 4);
    for (let i = Math.max(0, s0); i < s1; i++) {
      const v = fn((i - s0) / RATE);
      L[i] += v * pl; R[i] += v * pr; verb[i] += v * send; echo[i] += v * echoSend;
    }
  }
  // The choir: detuned saws through the formants of "ah".
  function choir(start, len, release, m, loud, pan) {
    const f = hz(m), F = [bandpass(730, 6), bandpass(1090, 7), bandpass(2440, 9)];
    note(start, len, release, pan, 0.6, 0, (t) => {
      const vib = 1 + 0.003 * Math.sin(2 * Math.PI * 4.8 * t + m);
      const x = saw(f * vib * t) + saw(f * 1.006 * vib * t) + saw(f * 0.994 * t);
      return (F[0](x) + 0.6 * F[1](x) + 0.25 * F[2](x)) * env(t, 0.6, release, len) * loud;
    });
  }
  // The electric piano: a bell-like tone from frequency modulation, as on the synths of the time.
  function bell(start, len, m, loud, pan) {
    const f = hz(m);
    note(start, len, 1.2, pan, 0.35, 0.3, (t) => {
      const mod = Math.sin(2 * Math.PI * f * t) * 2.2 * Math.exp(-t * 6) + Math.sin(2 * Math.PI * f * 14 * t) * 0.6 * Math.exp(-t * 30);
      return Math.sin(2 * Math.PI * f * t + mod) * Math.exp(-t * 2.4) * env(t, 0.002, 1.2, len) * loud;
    });
  }
  // The lead: two detuned pulses with a slow start and a vibrato that comes in late, or a softer flute.
  function lead(start, len, m, loud, soft) {
    const f = hz(m), lp = lowpass();
    note(start, len, 0.25, 0.08, 0.35, 0.45, (t) => {
      const vib = 1 + 0.006 * Math.sin(2 * Math.PI * 5.2 * t) * Math.min(1, Math.max(0, t - 0.2) * 3);
      const x = soft ? Math.sin(2 * Math.PI * f * vib * t) + 0.25 * Math.sin(4 * Math.PI * f * vib * t) + noise() * 0.04
        : square(f * vib * t) * 0.6 + saw(f * 1.004 * vib * t) * 0.6;
      return lp(x, soft ? 3000 : 2200) * env(t, soft ? 0.06 : 0.03, 0.25, len) * loud;
    });
  }

  const bars = Math.ceil(seconds / BAR);
  const has = (bar, from, to) => bar >= from && bar < to;
  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * BAR, ci = bar % 4, chord = CHORDS[ci], root = ROOTS[ci];
    const ending = bar >= 36, breakBars = has(bar, 26, 28), band = (has(bar, 6, 26) || has(bar, 28, 36)) && !ending;
    // choir pad, all the way through, and the big last chord
    if (!ending) chord.forEach((m, k) => choir(t0, BAR, 0.5, m - 12 + (k === 0 ? 12 : 0), breakBars ? 0.06 : 0.045, k - 1));
    else [50, 57, 62, 66, 69, 74].forEach((m, k) => choir(t0, 5, 1.5, m, 0.05, (k % 3) - 1));
    // bells: a slow figure in the intro, chords on the off-beats with the band
    if (has(bar, 0, 6)) [0, 1, 2, 1].forEach((k, j) => bell(t0 + j * BEAT, BEAT * 1.5, chord[k] + 12, 0.07, j % 2 ? 0.4 : -0.4));
    if (band) for (const s of [2, 6, 10, 14]) chord.forEach((m) => bell(t0 + s * STEP, STEP * 1.5, m + 12, 0.035, 0.3));
    if (ending) [62, 66, 69, 74, 78].forEach((m, k) => bell(t0 + k * 0.06, 3, m + 12, 0.06, (k % 2) - 0.5));
    // the walking bass
    if (band) {
      WALK.forEach((step, k) => {
        const next = ROOTS[(ci + 1) % 4], m = k === 7 && Math.abs(next - root) > 2 ? next + (next > root ? -1 : 1) : root + step, f = hz(m), lp = lowpass();
        note(t0 + k * BEAT / 2, BEAT / 2 * 0.85, 0.04, 0, 0, 0, (t) => lp(saw(f * t) * 0.7 + square(f * t) * 0.3, 380 + 1400 * Math.exp(-t * 14)) * env(t, 0.004, 0.04, BEAT / 2 * 0.85) * 0.2);
      });
    }
    // the drum machine
    if (band) {
      for (let s = 0; s < 16; s++) {
        const ts = t0 + s * STEP;
        if (s === 0 || s === 8 || s === 10) note(ts, 0.35, 0, 0, 0, 0, (t) => Math.sin(2 * Math.PI * (48 * t + 70 * (1 - Math.exp(-t * 28)) / 28)) * Math.exp(-t * 8) * 0.5);
        if (s === 4 || s === 12) {
          // the gated snare: a hit, then a burst of room that stops dead
          note(ts, 0.3, 0, 0, 0.25, 0, (t) => (noise() * 0.75 + Math.sin(2 * Math.PI * 185 * t) * 0.45) * Math.exp(-t * 18) * 0.34);
          const lp = lowpass();
          note(ts, 0.3, 0.015, 0, 0, 0, (t) => lp(noise(), 5000) * (t < 0.28 ? 0.15 : 0) * (1 - t * 1.2));
          // handclaps at the party and after
          if (has(bar, 20, 26) || has(bar, 28, 36)) for (const d of [0, 0.011, 0.023]) { const bp = bandpass(1300, 1.5); note(ts + d, 0.12, 0, 0.2, 0.3, 0, (t) => bp(noise()) * Math.exp(-t * 35) * 0.5); }
        }
        if (s % 2 === 0) { let last = 0; note(ts, 0.04, 0, -0.3, 0, 0, (t) => { const x = noise(), y = x - last; last = x; return y * Math.exp(-t * 110) * 0.07; }); }
        if (s % 4 === 2) { const bp = bandpass(7000, 2); note(ts, 0.1, 0, 0.45, 0.05, 0, (t) => bp(noise()) * Math.exp(-t * 28) * 0.22); }  // tambourine
      }
      if (bar % 4 === 3) for (let k = 0; k < 4; k++) note(t0 + 12 * STEP + k * STEP, 0.3, 0, 0.6 - k * 0.4, 0.4, 0, (t) => Math.sin(2 * Math.PI * (150 - k * 22) * t * (1 - t * 0.3)) * Math.exp(-t * 9) * 0.3);  // tom fill
    }
    // the tune: softly from bar 12, full at the party and after
    if (has(bar, 12, 26) || has(bar, 28, 36)) {
      const soft = has(bar, 12, 20);
      for (const [b, len, m] of TUNE[(bar - 12) % 8]) lead(t0 + b * BEAT, len * BEAT * 0.94, m + (soft ? 12 : 0), soft ? 0.05 : 0.075, soft);
    }
  }
  // "look busy.": one hit with a long tail
  note(27 * BAR, 0.6, 1.6, 0, 0.9, 0, (t) => (Math.sin(2 * Math.PI * 55 * t) * 0.6 + noise() * 0.3) * Math.exp(-t * 3) * 0.45);
  // the last chord gets a snare in a huge room
  note(36 * BAR, 0.3, 0, 0, 1.2, 0, (t) => noise() * Math.exp(-t * 14) * 0.4);

  // echo: a dotted-eighth delay, and a room (Schroeder combs and allpasses)
  const dly = Math.round(BEAT * 0.75 * RATE);
  for (let i = dly; i < n; i++) echo[i] += echo[i - dly] * 0.4;
  for (let i = 0; i < n; i++) { L[i] += echo[i] * 0.45; R[i] += (i >= 331 ? echo[i - 331] : 0) * 0.45; }
  const room = (input, combs, allps) => {
    const out = new Float32Array(n);
    for (const d of combs) { const buf = new Float32Array(d); let j = 0, lp = 0; for (let i = 0; i < n; i++) { const y = buf[j]; lp = y * 0.6 + lp * 0.4; buf[j] = input[i] + lp * 0.87; out[i] += y; j = (j + 1) % d; } }
    for (const d of allps) { const buf = new Float32Array(d); let j = 0; for (let i = 0; i < n; i++) { const b = buf[j], y = -out[i] + b; buf[j] = out[i] + b * 0.5; out[i] = y; j = (j + 1) % d; } }
    return out;
  };
  const vl = room(verb, [1557, 1617, 1491, 1422], [225, 556]), vr = room(verb, [1580, 1640, 1514, 1445], [248, 579]);
  // mix, a soft limit, and a fade at the very end
  let peak = 0;
  for (let i = 0; i < n; i++) { L[i] += vl[i] * 0.16; R[i] += vr[i] * 0.16; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
  const gain = 0.9 / Math.max(peak, 1e-6), fade = Math.round(1.5 * RATE);
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const f = i > n - fade ? (n - i) / fade : 1;
    buf.writeInt16LE(Math.round(Math.tanh(L[i] * gain * 1.15) * f * 32000), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.tanh(R[i] * gain * 1.15) * f * 32000), 46 + i * 4);
  }
  return buf;
}

module.exports = { render, BAR };
if (require.main === module) {
  const out = process.argv[2] || 'trailer-music.wav';
  fs.writeFileSync(out, render(Number(process.argv[3]) || 84));
  console.log('wrote ' + out);
}
