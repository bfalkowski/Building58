// The radio's records, all original tunes in a 1940s style. This file is only the notes:
// office/radio.js plays them. An event is { t, d, v, m, g }: start and length in seconds, the
// voice, a MIDI note and a loudness.
window.OFFICE_SONGS = (() => {
  'use strict';

  function record(title, bpm, swing, write) {
    const spb = 60 / bpm, ev = [];
    // swing moves the off-beat eighth later; 0.5 leaves it straight
    const sw = (b) => { const i = Math.floor(b), f = b - i; return i + (f < 0.5 ? f / 0.5 * swing : swing + (f - 0.5) / 0.5 * (1 - swing)); };
    let shape = (b) => b;
    const at = (b) => shape(sw(b)) * spb;
    const add = (beat, len, v, m, g) => ev.push({ t: at(beat), d: at(beat + len) - at(beat), v, m, g });
    const chord = (beat, len, v, notes, g, roll) => notes.forEach((m, i) => add(beat + i * (roll || 0), len, v, m, g));
    write({ add, chord, tempoShape: (f) => { shape = f; } });
    ev.sort((a, b) => a.t - b.t);
    const last = ev.reduce((end, e) => Math.max(end, e.t + e.d), 0);
    return { title, ev, len: last + 3.5 };
  }

  // Two passes of a 16-bar tune: the vibraphone sings it, then a clarinet takes over with the
  // vibraphone rolling chords behind it.
  const ballad = record('Leave the Porch Light On', 66, 2 / 3, ({ add, chord }) => {
    const CH = { F: [53, 57, 60, 64], Dm: [50, 53, 57, 60], Gm: [55, 58, 62, 65], C7: [52, 55, 58, 60], Am: [57, 60, 64, 67],
      D7: [54, 57, 60, 62], F6: [53, 57, 60, 62], Bb: [50, 53, 57, 58], Bbm: [49, 53, 55, 58] };
    const ROOT = { F: 41, Dm: 38, Gm: 43, C7: 36, Am: 45, D7: 38, F6: 41, Bb: 46, Bbm: 46 };
    const BARS = [['F'], ['Dm'], ['Gm'], ['C7'], ['Am', 'D7'], ['Gm', 'C7'], ['F6'], ['Gm', 'C7'],
      ['Bb'], ['Bbm'], ['Am'], ['D7'], ['Gm'], ['C7'], ['F6', 'Dm'], ['Gm', 'C7']];
    const MEL = [
      [0, 0, 1.5, 69], [0, 1.5, 0.5, 67], [0, 2, 1, 69], [0, 3, 1, 72],
      [1, 0, 2, 74], [1, 2, 1, 72], [1, 3, 1, 69],
      [2, 0, 1.5, 70], [2, 1.5, 0.5, 69], [2, 2, 2, 67],
      [3, 0, 1, 67], [3, 1, 1, 64], [3, 2, 1, 67], [3, 3, 1, 70],
      [4, 0, 1, 69], [4, 1, 1, 72], [4, 2, 1.5, 74], [4, 3.5, 0.5, 72],
      [5, 0, 1, 70], [5, 1, 1, 74], [5, 2, 1, 72], [5, 3, 1, 70],
      [6, 0, 3, 69],
      [7, 2, 1, 67], [7, 3, 0.5, 69], [7, 3.5, 0.5, 70],
      [8, 0, 1.5, 74], [8, 1.5, 0.5, 72], [8, 2, 1, 74], [8, 3, 1, 77],
      [9, 0, 1.5, 77], [9, 1.5, 0.5, 73], [9, 2, 2, 72],
      [10, 0, 1, 72], [10, 1, 1, 76], [10, 2, 1, 72], [10, 3, 1, 69],
      [11, 0, 1, 66], [11, 1, 1, 69], [11, 2, 1.5, 72], [11, 3.5, 0.5, 74],
      [12, 0, 1.5, 74], [12, 1.5, 0.5, 70], [12, 2, 2, 67],
      [13, 0, 1, 70], [13, 1, 1, 69], [13, 2, 1, 67], [13, 3, 1, 64],
      [14, 0, 2, 65], [14, 2, 1, 69], [14, 3, 1, 74],
      [15, 0, 2, 72]
    ];
    [0, 1].forEach((pass) => {
      const start = pass * 64;
      BARS.forEach((chs, bar) => {
        const per = 4 / chs.length, b = start + bar * 4;
        chs.forEach((c, k) => {
          const b0 = b + k * per;
          chord(b0, per, 'pad', CH[c].slice(1).map((m) => m + 12), 0.03);
          add(b0, 2, 'bass', ROOT[c] + 12, 0.26);
          if (per === 4) add(b0 + 2, 2, 'bass', ROOT[c] + 19, 0.2);
          if (pass) chord(b0, per, 'vibes', CH[c].map((m) => m + 12), 0.11, 0.25);
        });
        chord(b + 1, 1, 'piano', CH[chs[0]], 0.035);
        chord(b + 3, 1, 'piano', CH[chs[chs.length - 1]], 0.035);
        [0, 1, 2, 3].forEach((q) => add(b + q, 0.5, 'brush', 0, q % 2 ? 0.06 : 0.025));
      });
      MEL.forEach(([bar, beat, len, m]) => add(start + bar * 4 + beat, len, pass ? 'reed' : 'vibes', m, pass ? 0.11 : 0.3));
    });
    add(128, 4, 'bass', 53, 0.26);
    chord(128, 4, 'pad', [69, 72, 74], 0.03);
    chord(128, 4, 'vibes', [65, 69, 72, 74, 77], 0.2, 0.3);
  });

  // A fast 12-bar blues, three times through: the horns play a riff, the vibraphone solos over
  // the band, then the riff returns and the band stops on one last chord.
  const swing = record('Fifth Floor Jump', 168, 0.62, ({ add, chord }) => {
    const BARS = ['Bb7', 'Eb7', 'Bb7', 'Bb7', 'Eb7', 'Eb7', 'Bb7', 'G7', 'Cm7', 'F7', 'Bb7', 'F7'];
    const CH = { Bb7: [58, 62, 65, 68], Eb7: [55, 58, 61, 63], G7: [59, 62, 65, 67], Cm7: [58, 60, 63, 67], F7: [57, 60, 63, 65] };
    const ROOT = { Bb7: 46, Eb7: 51, G7: 43, Cm7: 48, F7: 53 };
    const THIRD = { Bb7: 4, Eb7: 4, G7: 4, Cm7: 3, F7: 4 };
    const RIFF = [[0.5, 0.5, 77], [1, 0.5, 80], [1.5, 0.5, 77], [2, 1, 74], [3.5, 0.5, 73]];
    const HEAD = [
      RIFF,
      [[0, 1, 75], [1, 0.5, 73], [1.5, 0.5, 70], [2, 1.5, 73]],
      RIFF,
      [[0, 1, 74], [1, 0.5, 73], [1.5, 0.5, 70], [2, 1.5, 68]],
      RIFF.map(([b, l, m]) => [b, l, m + 5]),
      [[0, 1, 79], [1, 0.5, 77], [1.5, 0.5, 75], [2, 1.5, 73]],
      RIFF,
      [[0, 1, 74], [1, 0.5, 71], [1.5, 0.5, 74], [2, 1, 77], [3, 1, 74]],
      [[0, 1, 75], [1, 0.5, 72], [1.5, 0.5, 75], [2, 1, 79], [3, 1, 75]],
      [[0, 1, 75], [1, 0.5, 72], [1.5, 0.5, 69], [2, 1, 72], [3, 1, 75]],
      [[0, 1, 74], [1, 0.5, 77], [1.5, 0.5, 74], [2, 1, 70]],
      [[0, 0.5, 72], [0.5, 0.5, 75], [1, 1, 77]]
    ];
    const SOLO = [
      [[0, 0.5, 70], [0.5, 0.5, 74], [1, 0.5, 77], [1.5, 0.5, 80], [2, 1, 82], [3, 0.5, 80], [3.5, 0.5, 77]],
      [[0, 1, 79], [1, 0.5, 75], [1.5, 0.5, 73], [2, 0.5, 75], [2.5, 0.5, 79], [3, 1, 82]],
      [[0, 0.5, 82], [0.5, 0.5, 80], [1, 0.5, 77], [1.5, 0.5, 74], [2, 1, 73], [3, 1, 74]],
      [[0, 0.5, 70], [0.5, 0.5, 74], [1, 0.5, 77], [1.5, 0.5, 74], [2, 2, 80]],
      [[0, 0.5, 79], [0.5, 0.5, 82], [1, 0.5, 85], [1.5, 0.5, 82], [2, 1, 79], [3, 0.5, 75], [3.5, 0.5, 73]],
      [[0, 1, 75], [1, 0.5, 79], [1.5, 0.5, 82], [2, 1, 85], [3, 1, 82]],
      [[0, 0.5, 86], [0.5, 0.5, 82], [1, 0.5, 80], [1.5, 0.5, 77], [2, 1, 74], [3, 0.5, 71], [3.5, 0.5, 74]],
      [[0, 0.5, 77], [0.5, 0.5, 74], [1, 0.5, 71], [1.5, 0.5, 74], [2, 1, 79], [3, 1, 77]],
      [[0, 0.5, 75], [0.5, 0.5, 79], [1, 0.5, 82], [1.5, 0.5, 79], [2, 1, 75], [3, 1, 72]],
      [[0, 0.5, 75], [0.5, 0.5, 72], [1, 0.5, 69], [1.5, 0.5, 72], [2, 1, 77], [3, 1, 75]],
      [[0, 1, 74], [1, 0.5, 77], [1.5, 0.5, 80], [2, 1, 82], [3, 1, 77]],
      [[0, 0.5, 75], [0.5, 0.5, 72], [1, 1, 69], [2, 2, 72]]
    ];
    const horns = (b, beat, len, m, g) => { add(b + beat, len, 'horn', m, g); add(b + beat, len, 'reed', m - 12, g * 0.8); };
    [0, 1, 2].forEach((chorus) => {
      const last = chorus === 2;
      BARS.forEach((c, bar) => {
        const b = (chorus * 12 + bar) * 4;
        if (last && bar === 11) return;
        const next = BARS[(bar + 1) % 12], r = ROOT[c], nr = ROOT[next];
        [r, r + THIRD[c], r + 7, nr + (nr > r + 7 ? -1 : 1)].forEach((m, q) => add(b + q, 0.9, 'bass', m, 0.3));
        [0, 1, 2, 3].forEach((q) => chord(b + q, 0.25, 'chop', CH[c], 0.05));
        [0, 1, 1.5, 2, 3, 3.5].forEach((q) => add(b + q, 0.25, 'ride', 0, q % 1 ? 0.05 : 0.09));
        [1, 3].forEach((q) => add(b + q, 0.25, 'hat', 0, 0.09));
        if (chorus === 1) {
          SOLO[bar].forEach(([q, l, m]) => add(b + q, l, 'vibes', m, 0.34));
          chord(b, 4, 'pad', CH[c].map((m) => m + 12), 0.022);
        } else {
          HEAD[bar].forEach(([q, l, m]) => horns(b, q, l, m, last ? 0.12 : 0.1));
        }
        if (bar === 11) [2, 2.5, 3, 3.5].forEach((q) => add(b + q, 0.25, 'snare', 0, 0.09 + q * 0.015));
      });
    });
    const end = 35 * 4;
    add(end, 3, 'bass', 46, 0.34);
    chord(end, 3, 'horn', [65, 68, 70, 74], 0.08);
    chord(end, 3, 'reed', [58, 62], 0.08);
    chord(end, 3, 'vibes', [70, 74, 77, 82], 0.2, 0.08);
    add(end, 1, 'ride', 0, 0.16);
  });

  // Solo piano, slow, in three: a left hand that barely moves and a tune with plenty of space,
  // slowing down at the end.
  const piano = record('After the Last Train', 54, 0.5, ({ add, chord, tempoShape }) => {
    const ROOT = { Dm: 38, Bb: 46, Gm: 43, A7: 45, C7: 48, F: 41 };
    const SHELL = { Dm: [53, 57, 62], Bb: [53, 58, 62], Gm: [55, 58, 62], A7: [55, 61, 64], C7: [55, 58, 64], F: [53, 57, 60] };
    const A = [
      ['Dm', [[0, 1.5, 69], [1.5, 0.5, 70], [2, 1, 69]]],
      ['Dm', [[0, 2, 65], [2, 1, 62]]],
      ['Bb', [[0, 1.5, 65], [1.5, 0.5, 67], [2, 1, 65]]],
      ['Gm', [[0, 2, 62], [2, 1, 58]]],
      ['Gm', [[0, 1, 67], [1, 1, 70], [2, 1, 74]]],
      ['A7', [[0, 2, 73], [2, 1, 69]]]
    ];
    const BARS = A.concat([
      ['Dm', [[0, 3, 74]]],
      ['A7', [[0, 1, 67], [1, 1, 69], [2, 1, 73]]],
      ['Dm', [[0, 1.5, 74], [1.5, 0.5, 76], [2, 1, 77]]],
      ['Bb', [[0, 2, 74], [2, 1, 70]]],
      ['Gm', [[0, 1.5, 70], [1.5, 0.5, 72], [2, 1, 74]]],
      ['C7', [[0, 2, 72], [2, 1, 67]]],
      ['F', [[0, 1, 69], [1, 1, 72], [2, 1, 77]]],
      ['A7', [[0, 2, 76], [2, 1, 73]]],
      ['Dm', [[0, 1, 74], [1, 1, 69], [2, 1, 65]]],
      ['A7', [[0, 3, 64]]]
    ], A, [
      ['Gm', [[0, 1.5, 67], [1.5, 0.5, 65], [2, 1, 62]]],
      ['A7', [[0, 2, 61], [2, 1, 64]]]
    ]);
    const end = BARS.length * 3;
    tempoShape((b) => b < end - 6 ? b : end - 6 + (b - end + 6) * 1.45);
    BARS.forEach(([c, mel], bar) => {
      const b = bar * 3, soft = bar >= 16 ? 0.8 : 1;
      add(b, 3, 'piano', ROOT[c], 0.17 * soft);
      chord(b + 1, 1.8, 'piano', SHELL[c], 0.06 * soft);
      if (bar % 2) chord(b + 2, 0.9, 'piano', SHELL[c], 0.04 * soft);
      mel.forEach(([q, l, m]) => add(b + q, l, 'piano', m, 0.21 * soft));
    });
    add(end, 6, 'piano', 38, 0.15);
    chord(end, 6, 'piano', [50, 57, 62, 65, 69, 74], 0.1, 0.12);
  });

  // A slow croon over a guitar rolling in triplets: the guitar starts alone, a clarinet sings the
  // tune, the vibraphone takes the second verse, and they share the last one.
  const croon = record('Nobody Waiting Up', 63, 0.5, ({ add, chord }) => {
    const CH = { Eb: [51, 55, 58, 63], Cm: [48, 55, 60, 63], Fm: [53, 56, 60, 65], Bb7: [50, 56, 58, 65], Ab: [51, 56, 60, 63], Abm: [51, 56, 59, 63],
      C7: [52, 55, 58, 64], Eb7: [51, 55, 58, 61], F7: [51, 57, 60, 65], Eb6: [51, 55, 58, 60] };
    const ROOT = { Eb: 51, Cm: 48, Fm: 53, Bb7: 46, Ab: 56, Abm: 56, C7: 48, Eb7: 51, F7: 53, Eb6: 51 };
    const VERSE = [
      [['Eb', 'Cm'], [[0, 1, 67], [1, 1, 70], [2, 2, 72]]],
      [['Fm', 'Bb7'], [[0, 1, 68], [1, 1, 72], [2, 1, 70], [3, 1, 68]]],
      [['Eb', 'Eb7'], [[0, 2, 67], [2, 1, 70], [3, 1, 73]]],
      [['Ab', 'Abm'], [[0, 1, 72], [1, 1, 75], [2, 2, 71]]],
      [['Eb', 'C7'], [[0, 1, 70], [1, 1, 67], [2, 1, 70], [3, 1, 76]]],
      [['Fm', 'Bb7'], [[0, 2, 77], [2, 1, 74], [3, 1, 70]]]
    ];
    const FORM = [
      ['reed', VERSE.concat([[['Eb', 'Cm'], [[0, 3, 67]]], [['Fm', 'Bb7'], [[2, 1, 65], [3, 1, 70]]]])],
      ['vibes', VERSE.concat([[['Eb', 'Eb'], [[0, 4, 75]]], [['Eb7', 'Eb7'], [[2, 1, 70], [3, 1, 73]]]])],
      ['reed', [
        [['Ab', 'Ab'], [[0, 1, 72], [1, 1, 75], [2, 2, 77]]],
        [['Abm', 'Abm'], [[0, 1, 71], [1, 1, 75], [2, 2, 75]]],
        [['Eb', 'Eb'], [[0, 2, 70], [2, 1, 67], [3, 1, 70]]],
        [['C7', 'C7'], [[0, 2, 72], [2, 1, 76], [3, 1, 79]]],
        [['F7', 'F7'], [[0, 2, 81], [2, 1, 77], [3, 1, 75]]],
        [['F7', 'F7'], [[0, 1, 72], [1, 1, 69], [2, 2, 72]]],
        [['Fm', 'Fm'], [[0, 2, 68], [2, 1, 72], [3, 1, 77]]],
        [['Bb7', 'Bb7'], [[0, 2, 74], [2, 2, 70]]]
      ]],
      ['both', VERSE.concat([[['Eb', 'Ab'], [[0, 2, 75], [2, 1, 72], [3, 1, 70]]], [['Fm', 'Bb7'], [[0, 2, 68], [2, 2, 65]]]])]
    ];
    const LOUD = { reed: 0.1, vibes: 0.28 };
    const roll = (b, c, g) => {
      const n = CH[c];
      [[0, 1, 2], [3, 2, 1]].forEach((order, q) => order.forEach((i, k) => add(b + q + k / 3, 1 / 3, 'guitar', n[i] + 12, g)));
    };
    const bar = (b, chs, g) => chs.forEach((c, half) => {
      const at = b + half * 2;
      roll(at, c, g);
      add(at, 2, 'bass', ROOT[c], 0.22);
    });
    bar(0, ['Eb', 'Cm'], 0.13);
    bar(4, ['Fm', 'Bb7'], 0.13);
    let b = 8;
    FORM.forEach(([lead, bars]) => bars.forEach(([chs, mel]) => {
      bar(b, chs, 0.08);
      [1, 3].forEach((q) => add(b + q, 0.5, 'brush', 0, 0.035));
      mel.forEach(([q, l, m]) => {
        if (lead === 'both') { add(b + q, l, 'vibes', m, LOUD.vibes * 0.8); add(b + q, l, 'reed', m - 12, LOUD.reed); }
        else add(b + q, l, lead, m, LOUD[lead]);
      });
      b += 4;
    }));
    add(b, 4, 'bass', 51, 0.24);
    chord(b, 4, 'guitar', CH.Eb6.map((m) => m + 12), 0.12, 1 / 3);
    chord(b + 1, 3, 'vibes', [67, 70, 72, 75], 0.2, 1 / 3);
  });

  // Boogie-woogie, three times through a 12-bar blues: the left hand never stops. The right hand
  // has the riff, the horns stab behind block chords, then the riff returns an octave up.
  const boogie = record('Dime Store Boogie', 150, 0.64, ({ add, chord }) => {
    const BARS = ['G', 'G', 'G', 'G', 'C', 'C', 'G', 'G', 'D', 'C', 'G', 'D'];
    const ROOT = { G: 43, C: 48, D: 50 };
    const WALK = [0, 4, 7, 9, 10, 9, 7, 4];
    const STAB = { G: [65, 71, 74], C: [64, 70, 72], D: [66, 72, 74] };
    const UP = { G: 0, C: 5, D: 7 };
    const CLIMB = [[0.5, 0.5, 70], [1, 0.5, 71], [1.5, 0.5, 74], [2, 0.5, 77], [2.5, 1, 74]];
    const FALL = [[0, 0.5, 79], [0.5, 0.5, 77], [1, 0.5, 74], [1.5, 0.5, 71], [2, 1, 67]];
    const LAST = [[0, 0.5, 74], [0.5, 0.5, 78], [1, 0.5, 81], [1.5, 0.5, 84], [2, 1, 81]];
    const riff = (bar, c) => {
      if (bar === 11) return LAST;
      const line = bar === 10 || bar % 2 ? FALL : CLIMB, shift = bar === 10 ? 0 : UP[c];
      return line.map(([q, l, m]) => [q, l, m + shift]);
    };
    [0, 1, 2].forEach((chorus) => BARS.forEach((c, bar) => {
      const b = (chorus * 12 + bar) * 4;
      if (chorus === 2 && bar === 11) return;
      WALK.forEach((step, i) => add(b + i / 2, 0.5, 'keys', ROOT[c] + step, 0.14));
      [0, 1, 2, 3].forEach((q) => add(b + q, 0.25, 'ride', 0, 0.05));
      [1, 3].forEach((q) => add(b + q, 0.25, 'snare', 0, 0.06));
      add(b, 1, 'bass', ROOT[c], 0.2);
      add(b + 2, 1, 'bass', ROOT[c] + 7, 0.17);
      if (chorus === 1) {
        [0.5, 1.5, 2.5].forEach((q) => chord(b + q, 0.5, 'keys', STAB[c].map((m) => m + 12), 0.075));
        chord(b + 3, 0.75, 'horn', STAB[c], 0.06);
      } else {
        const up = chorus === 2 ? 12 : 0;
        riff(bar, c).forEach(([q, l, m]) => {
          add(b + q, l, 'piano', m + up, chorus === 2 ? 0.16 : 0.2);
          if (chorus === 2) add(b + q, l, 'horn', m, 0.06);
        });
      }
    }));
    const end = 35 * 4;
    add(end, 3, 'piano', 43, 0.22);
    add(end, 3, 'bass', 43, 0.28);
    chord(end, 3, 'piano', [71, 74, 77, 79], 0.14, 0.05);
    chord(end, 3, 'horn', STAB.G, 0.08);
    add(end, 1, 'ride', 0, 0.14);
  });

  // A rumba in A minor, straight rather than swung: claves and maracas over a bass in 3-3-2. The
  // clarinet has the first verse and the vibraphone the second.
  const rumba = record('Blue Awning', 104, 0.5, ({ add, chord }) => {
    const CH = { Am: [57, 60, 64], E7: [56, 59, 62, 64], Dm: [57, 62, 65], C: [55, 60, 64], G7: [55, 59, 65] };
    const ROOT = { Am: 45, E7: 52, Dm: 50, C: 48, G7: 43 };
    const VERSE = [
      ['Am', [[0, 1.5, 76], [1.5, 0.5, 77], [2, 1, 76], [3, 1, 72]]],
      ['Am', [[0, 1.5, 69], [1.5, 0.5, 71], [2, 2, 72]]],
      ['E7', [[0, 1.5, 71], [1.5, 0.5, 72], [2, 1, 71], [3, 1, 68]]],
      ['E7', [[0, 1.5, 64], [1.5, 0.5, 68], [2, 2, 71]]],
      ['Dm', [[0, 1.5, 74], [1.5, 0.5, 76], [2, 1, 77], [3, 1, 74]]],
      ['Am', [[0, 1.5, 72], [1.5, 0.5, 74], [2, 1, 76], [3, 1, 72]]],
      ['E7', [[0, 1, 71], [1, 1, 68], [2, 1, 71], [3, 1, 74]]],
      ['Am', [[0, 3, 69]]]
    ];
    const MIDDLE = [
      ['C', [[0, 1, 72], [1, 1, 76], [2, 2, 79]]],
      ['G7', [[0, 1.5, 77], [1.5, 0.5, 74], [2, 2, 71]]],
      ['C', [[0, 1, 72], [1, 1, 76], [2, 1, 79], [3, 1, 84]]],
      ['Am', [[0, 2, 81], [2, 1, 76], [3, 1, 72]]],
      ['Dm', [[0, 1, 74], [1, 1, 77], [2, 2, 81]]],
      ['G7', [[0, 1, 79], [1, 1, 77], [2, 1, 74], [3, 1, 71]]],
      ['C', [[0, 2, 72], [2, 2, 76]]],
      ['E7', [[0, 1, 71], [1, 1, 74], [2, 1, 76], [3, 1, 80]]]
    ];
    const FORM = [['reed', VERSE], ['vibes', VERSE], ['reed', MIDDLE], ['vibes', VERSE]];
    const LOUD = { reed: 0.11, vibes: 0.3 };
    let b = 0;
    FORM.forEach(([lead, bars]) => bars.forEach(([c, mel], i) => {
      const r = ROOT[c];
      [[0, r], [1.5, r + 7], [3, r]].forEach(([q, m]) => add(b + q, 1.2, 'bass', m, 0.26));
      [1, 2.5, 3.5].forEach((q) => chord(b + q, 0.25, 'chop', CH[c], 0.06));
      for (let q = 0; q < 4; q += 0.5) add(b + q, 0.25, 'hat', 0, q % 1 ? 0.03 : 0.055);
      (i % 2 ? [1, 2] : [0, 1.5, 3]).forEach((q) => add(b + q, 0.25, 'clave', 0, 0.3));
      mel.forEach(([q, l, m]) => add(b + q, l, lead, m, LOUD[lead]));
      b += 4;
    }));
    add(b, 3, 'bass', 45, 0.28);
    add(b, 3, 'reed', 69, 0.1);
    chord(b, 3, 'vibes', [57, 60, 64, 69], 0.2, 0.12);
    add(b, 0.25, 'clave', 0, 0.3);
  });

  return [ballad, swing, piano, croon, boogie, rumba];
})();
