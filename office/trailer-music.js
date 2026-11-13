#!/usr/bin/env node
// The trailer's music: an original tune in a 1980s synth style, written here as notes and drawn
// sample by sample, so it has no licence but this repo's. node office/trailer-music.js out.wav
// writes it alone; office/record-trailer.js lays it under the film unless you give --audio.
//
// It follows the film (office/trailer.js) in bars of 2.2 seconds (109 beats a minute):
//   bars 0 to 6     the city and the sign: pads and a soft arpeggio
//   bars 6 to 20    work: drums and the pulsing bass come in
//   bars 20 to 26   the party: the lead tune on top
//   bars 26 to 28   "And whatever happens... look busy.": the band stops, one hit on "look busy"
//   bars 28 to 36   the manager and the time-lapse: everything back
//   bar 36 on       the freeze-frame: one last chord rings out
'use strict';
const fs = require('fs');

const RATE = 44100, BPM = 109.0909, BEAT = 60 / BPM, BAR = BEAT * 4;
// A minor: Am, F, C, G, as MIDI notes
const CHORDS = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
const ROOTS = [33, 29, 36, 31];
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// A tiny random number source, so the noise is the same every time.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1; }; }

function render(seconds) {
  const n = Math.ceil(seconds * RATE);
  const L = new Float32Array(n), R = new Float32Array(n), verb = new Float32Array(n), echo = new Float32Array(n);
  const noise = rng(58);
  const env = (t, a, d, len) => t < 0 ? 0 : t < a ? t / a : t < len ? 1 : Math.max(0, 1 - (t - len) / d);
  // A voice: a function of time since the note started, mixed in from start for len (plus release).
  function note(start, len, release, pan, send, echoSend, fn) {
    const s0 = Math.floor(start * RATE), s1 = Math.min(n, Math.ceil((start + len + release) * RATE));
    const pl = Math.cos((pan + 1) * Math.PI / 4), pr = Math.sin((pan + 1) * Math.PI / 4);
    for (let i = Math.max(0, s0); i < s1; i++) {
      const v = fn((i - s0) / RATE);
      L[i] += v * pl; R[i] += v * pr; verb[i] += v * send; echo[i] += v * echoSend;
    }
  }
  const saw = (p) => 2 * (p - Math.floor(p + 0.5));
  const square = (p) => (p - Math.floor(p)) < 0.5 ? 1 : -1;
  // a one-pole low-pass, made fresh for each note
  const lowpass = () => { let y = 0; return (x, cut) => { const k = 1 - Math.exp(-2 * Math.PI * cut / RATE); y += k * (x - y); return y; }; };

  const bars = Math.ceil(seconds / BAR);
  const has = (bar, from, to) => bar >= from && bar < to;
  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * BAR, ci = bar % 4, chord = CHORDS[ci], root = ROOTS[ci];
    const ending = bar >= 36;
    const breakBars = has(bar, 26, 28);
    // pads: three detuned saws per note, slow in and out
    if (!breakBars || bar === 26) {
      const len = ending ? 5.5 : BAR, rel = ending ? 1.2 : 0.4;
      for (const m of ending ? [57, 60, 64, 69] : chord) {
        const f = hz(m), lp = lowpass();
        note(t0, len, rel, (m % 3 - 1) * 0.4, 0.35, 0, (t) => {
          const e = env(t, 0.5, rel, len);
          const x = saw(f * 0.997 * t) + saw(f * t) + saw(f * 1.004 * t);
          return lp(x, 900 + 500 * Math.sin(t * 0.7)) * e * 0.045;
        });
      }
    }
    // arpeggio: sixteenths up the chord, with echo
    if (!breakBars && !ending) {
      const tones = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[1] + 24];
      for (let k = 0; k < 16; k++) {
        const m = tones[k % 4], f = hz(m), lp = lowpass(), loud = bar < 6 ? 0.018 : 0.026;
        note(t0 + k * BEAT / 4, BEAT / 5, 0.05, (k % 2 ? 0.5 : -0.5), 0.1, 0.35, (t) => lp(square(f * t), 2400) * env(t, 0.003, 0.05, BEAT / 5) * loud);
      }
    }
    // bass: pulsing octave eighths
    if ((has(bar, 6, 26) || has(bar, 28, 36)) && !ending) {
      for (let k = 0; k < 8; k++) {
        const f = hz(root + (k % 2 ? 12 : 0)), lp = lowpass();
        note(t0 + k * BEAT / 2, BEAT / 2.4, 0.03, 0, 0, 0, (t) => lp(saw(f * t) + 0.5 * square(f * 0.5 * t), 300 + 1600 * Math.exp(-t * 18)) * env(t, 0.004, 0.03, BEAT / 2.4) * 0.16);
      }
    }
    // drums
    if ((has(bar, 6, 26) || has(bar, 28, 36)) && !ending) {
      for (let b = 0; b < 4; b++) {
        const tb = t0 + b * BEAT;
        // kick
        note(tb, 0.35, 0, 0, 0, 0, (t) => Math.sin(2 * Math.PI * (45 * t + 90 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 7) * 0.5);
        // snare on 2 and 4, with a big gated room
        if (b % 2) {
          note(tb, 0.32, 0, 0, 0, 0, (t) => (noise() * 0.7 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 16) * 0.32);
          note(tb, 0.28, 0.02, 0, 0, 0, (t) => noise() * (t < 0.26 ? 0.11 : 0) * (1 - t * 1.4));
        }
        // hats on the eighths
        for (const h of [0, 0.5]) { let last = 0; note(tb + h * BEAT, 0.05, 0, 0.3, 0, 0, (t) => { const x = noise(), y = x - last; last = x; return y * Math.exp(-t * 90) * 0.09; }); }
      }
      if (bar % 4 === 3) for (let k = 0; k < 4; k++) note(t0 + 3 * BEAT + k * BEAT / 4, 0.2, 0, -0.2, 0.3, 0, (t) => Math.sin(2 * Math.PI * (160 - k * 20) * t) * Math.exp(-t * 14) * 0.25);  // tom fill
    }
    // the party's lead tune, two bars long, over and over
    if (has(bar, 20, 26) || has(bar, 32, 36)) {
      const tune = bar % 2 === 0 ? [[0, 1.5, 76], [1.5, 0.5, 74], [2, 1, 72], [3, 1, 74]] : [[0, 1.5, 72], [1.5, 0.5, 71], [2, 2, 69]];
      for (const [b, len, m] of tune) {
        const f = hz(m + (ci === 1 && m === 76 ? -3 : 0)), lp = lowpass();
        note(t0 + b * BEAT, len * BEAT * 0.95, 0.15, 0.1, 0.25, 0.4, (t) => {
          const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t * 3);
          return lp(saw(f * vib * t) + 0.6 * square(f * vib * 1.003 * t), 2600) * env(t, 0.02, 0.15, len * BEAT * 0.95) * 0.07;
        });
      }
    }
  }
  // "look busy.": one hit with a long tail
  note(27 * BAR, 0.6, 1.4, 0, 0.8, 0, (t) => (Math.sin(2 * Math.PI * 55 * t) * 0.6 + noise() * 0.3) * Math.exp(-t * 3) * 0.45);

  // echo: a dotted-eighth delay, and a simple room (Schroeder combs and allpasses)
  const dly = Math.round(BEAT * 0.75 * RATE);
  for (let i = dly; i < n; i++) echo[i] += echo[i - dly] * 0.38;
  for (let i = 0; i < n; i++) { L[i] += echo[i] * 0.5; R[i] += (i >= 331 ? echo[i - 331] : 0) * 0.5; }
  const room = (input, combs, allps) => {
    const out = new Float32Array(n);
    for (const d of combs) { const buf = new Float32Array(d); let j = 0, lp = 0; for (let i = 0; i < n; i++) { const y = buf[j]; lp = y * 0.7 + lp * 0.3; buf[j] = input[i] + lp * 0.84; out[i] += y; j = (j + 1) % d; } }
    for (const d of allps) { const buf = new Float32Array(d); let j = 0; for (let i = 0; i < n; i++) { const b = buf[j], y = -out[i] + b; buf[j] = out[i] + b * 0.5; out[i] = y; j = (j + 1) % d; } }
    return out;
  };
  const vl = room(verb, [1557, 1617, 1491, 1422], [225, 556]), vr = room(verb, [1580, 1640, 1514, 1445], [248, 579]);
  // mix, a soft limit, and a fade at the very end
  let peak = 0;
  for (let i = 0; i < n; i++) { L[i] += vl[i] * 0.12; R[i] += vr[i] * 0.12; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
  const gain = 0.9 / Math.max(peak, 1e-6), fade = Math.round(1.5 * RATE);
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const f = i > n - fade ? (n - i) / fade : 1;
    buf.writeInt16LE(Math.round(Math.tanh(L[i] * gain * 1.1) * f * 32000), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.tanh(R[i] * gain * 1.1) * f * 32000), 46 + i * 4);
  }
  return buf;
}

module.exports = { render, BAR };
if (require.main === module) {
  const out = process.argv[2] || 'trailer-music.wav';
  fs.writeFileSync(out, render(Number(process.argv[3]) || 84));
  console.log('wrote ' + out);
}
