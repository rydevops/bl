// Generative ambient music. Pure note-event composer (no audio APIs) so it is testable in Node;
// the browser's audio engine turns these events into sound.
import { mulberry32 } from './rng.js';

/** Moods: tonal centre (MIDI), scale pitch classes, chord progressions (semitones above root). */
export const MOODS = {
  day: {
    root: 48, // C3
    bpm: 54,
    scale: [0, 2, 4, 7, 9], // C major pentatonic
    progressions: [
      [[0, 4, 7, 11], [9, 12, 16, 19], [5, 9, 12, 16], [7, 11, 14, 16]], // I vi IV V6
      [[0, 4, 7, 11], [5, 9, 12, 16], [9, 12, 16, 19], [7, 11, 14, 16]], // I IV vi V6
      [[0, 4, 7, 14], [7, 11, 14, 17], [9, 12, 16, 19], [5, 9, 12, 16]], // Iadd9 V vi IV
    ],
  },
  night: {
    root: 45, // A2
    bpm: 46,
    scale: [0, 3, 5, 7, 10], // A minor pentatonic (relative to A)
    progressions: [
      [[0, 3, 7, 10], [8, 12, 15, 19], [3, 7, 10, 14], [10, 14, 17, 20]], // i VI III VII-ish colours
      [[0, 3, 7, 14], [5, 8, 12, 15], [3, 7, 10, 14], [7, 10, 14, 17]],
    ],
  },
};

const BEATS_PER_BAR = 4;
export const BARS = 8;

/** Shift a pitch by octaves into [lo, hi]. */
export function fitRange(m, lo, hi) {
  while (m < lo) m += 12;
  while (m > hi) m -= 12;
  return m;
}

/**
 * Compose one phrase.
 * @returns {{duration:number, bpm:number, events:Array<{t:number,dur:number,midi:number,vel:number,voice:'pad'|'bass'|'lead'}>}}
 */
export function composePhrase(seed, mood = 'day') {
  const cfg = MOODS[mood] || MOODS.day;
  const rnd = mulberry32(seed);
  const beat = 60 / cfg.bpm;
  const bar = beat * BEATS_PER_BAR;
  const prog = cfg.progressions[Math.floor(rnd() * cfg.progressions.length)];
  const events = [];

  // Pitch classes that are "safe" for the melody: the key's pentatonic scale.
  const scalePCs = new Set(cfg.scale.map((s) => (cfg.root + s) % 12));
  const LEAD_LO = 67, LEAD_HI = 88;
  const pool = [];
  for (let m = LEAD_LO; m <= LEAD_HI; m++) if (scalePCs.has(m % 12)) pool.push(m);
  let cur = pool.findIndex((m) => m >= 72) || 0;

  for (let b = 0; b < BARS; b++) {
    const chord = prog[b % prog.length];
    const t0 = b * bar;
    const last = b === BARS - 1;
    const useChord = last ? prog[0] : chord;

    // pad: the chord, spread over the mid register, overlapping into the next bar
    useChord.forEach((semi, i) => {
      events.push({ t: t0 + i * 0.04, dur: bar + 1.6, midi: fitRange(cfg.root + semi + 12, 52 + i * 3, 70 + i * 2), vel: 0.15, voice: 'pad' });
    });

    // bass: root on the downbeat, sometimes the fifth later
    events.push({ t: t0, dur: beat * 2.5, midi: fitRange(cfg.root + useChord[0], 34, 46), vel: 0.3, voice: 'bass' });
    if (!last && rnd() < 0.5) events.push({ t: t0 + beat * 2, dur: beat * 1.6, midi: fitRange(cfg.root + useChord[0] + 7, 38, 50), vel: 0.18, voice: 'bass' });

    // lead: a few notes per bar, wandering stepwise through the scale
    if (rnd() < (last ? 1 : 0.82)) {
      const slots = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
      const count = last ? 1 : 2 + Math.floor(rnd() * 3);
      const chosen = [];
      let guard = 0;
      while (chosen.length < count && guard++ < 30) {
        const s = slots[Math.floor(rnd() * slots.length)];
        if (!chosen.includes(s) && chosen.every((c) => Math.abs(c - s) >= 1)) chosen.push(s);
      }
      chosen.sort((a, c) => a - c);
      chosen.forEach((s, i) => {
        if (last) {
          // resolve onto the tonic or fifth
          const target = fitRange(cfg.root + (rnd() < 0.6 ? 0 : 7) + 12, 72, 79);
          events.push({ t: t0 + beat * s, dur: beat * 3.5, midi: target, vel: 0.3, voice: 'lead' });
          return;
        }
        const r = rnd();
        const step = r < 0.34 ? 1 : r < 0.68 ? -1 : r < 0.8 ? 2 : r < 0.92 ? -2 : r < 0.96 ? 3 : -3;
        cur = Math.max(0, Math.min(pool.length - 1, cur + step));
        const nextT = i + 1 < chosen.length ? chosen[i + 1] : 4;
        const dur = Math.min((nextT - s) * beat * (1.4 + rnd()), beat * 3.2);
        events.push({ t: t0 + beat * s, dur: Math.max(dur, beat * 0.9), midi: pool[cur], vel: 0.26 + rnd() * 0.12, voice: 'lead' });
      });
    }
  }
  events.sort((a, c) => a.t - c.t || a.midi - c.midi);
  return { duration: BARS * bar + 5, bpm: cfg.bpm, events };
}

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
