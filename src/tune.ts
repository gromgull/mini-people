/**
 * Fiddle tunes in the old-time / reel mould: G major (the banjo's open
 * tuning), 4/4 in eighth notes,
 * AABB form. Each section is a 4-chord progression, one chord per bar; the
 * first time through it ends open (usually on V), the repeat closes on I.
 *
 * Three parts are written over the same chords so any number of fiddlers can
 * join in and harmonise:
 *   0 melody  – busy eighths, chord tones on the beat, passing tones between
 *   1 harmony – shadows the melody a third (or sixth) below, same rhythm
 *   2 bass    – roots and fifths on the low strings, a steady "boom-chuck"
 *
 * Everyone reads the same grid (slot = shared eighth-note count), so parts
 * always line up no matter when someone starts playing.
 *
 * A fourth part is for banjos, in strict old-time "bum-ditty": on every beat
 * pair the melody note (a quarter), a brush down across the chord (an
 * eighth), and the short fifth string's open G (an eighth).
 *
 * A fifth part is for the double bass: the chord's root and the fifth below
 * it, alternating on the beat.
 */

/** One eighth-note slot: a new note of `hold` eighths, or hold 0 = still sounding. */
export interface Slot {
  deg: number; // diatonic degree in G major, 0 = G3, 7 = G4
  hold: number;
  /** Struck together (a banjo's brush), low to high; `deg` is the lowest. */
  chord?: number[];
}

export interface Tune {
  /** chord roots per bar for the whole AABB form (16 bars); 0 = I … 5 = vi */
  chords: number[];
  /** parts[voice][slot], FORM_SLOTS long */
  parts: Slot[][];
}

export const SECTION_BARS = 4;
export const FORM_SLOTS = 4 * SECTION_BARS * 8; // A A B B, 8 eighths per bar
export const PHRASE_SLOTS = SECTION_BARS * 8;
export const VOICES = ['melody', 'harmony', 'bass'] as const;
/** The banjo's part (parts[BANJO]). */
export const BANJO = 3;
/** The double bass's part (parts[BASS]). */
export const BASS = 4;

const SCALE = [0, 2, 4, 5, 7, 9, 11];
const G3 = 196.0;
const mod7 = (d: number) => ((d % 7) + 7) % 7;
export const degToHz = (deg: number) => G3 * 2 ** ((12 * Math.floor(deg / 7) + SCALE[mod7(deg)]) / 12);

// I ii iii IV V vi  →  0 1 2 3 4 5
const I = 0, ii = 1, iii = 2, IV = 3, V = 4, vi = 5;
/** [first time, second time]: the repeat swaps in a closing cadence. */
const A_PROGS: [number[], number[]][] = [
  [[I, IV, I, V], [I, IV, V, I]],
  [[I, vi, ii, V], [I, vi, V, I]],
  [[I, IV, V, V], [I, IV, V, I]],
  [[I, V, IV, V], [I, V, IV, I]],
  [[I, iii, IV, V], [I, iii, V, I]],
];
const B_PROGS: [number[], number[]][] = [
  [[IV, I, ii, V], [IV, I, V, I]],
  [[vi, IV, I, V], [vi, IV, V, I]],
  [[IV, V, iii, vi], [IV, V, IV, I]],
  [[vi, ii, V, V], [vi, ii, V, I]],
  [[ii, V, I, vi], [ii, IV, V, I]],
];

// bar rhythms in eighths (each sums to 8); the last bar of a section is a cadence
const RHYTHMS = [
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [2, 1, 1, 2, 1, 1],
  [1, 1, 2, 1, 1, 2],
  [2, 1, 1, 1, 1, 2],
  [1, 1, 1, 1, 2, 2],
  [3, 1, 1, 1, 1, 1],
];
const CADENCE = [[2, 2, 4], [1, 1, 2, 4], [2, 1, 1, 4], [1, 1, 1, 1, 4]];
const BASS_PATS = [
  [[0, 2], [4, 2], [0, 2], [4, 2]], // root–fifth in quarters
  [[0, 3], [0, 1], [4, 2], [0, 2]], // dotted lilt
  [[0, 4], [4, 4]], // halves, for the slower feel
];

const isChordTone = (d: number, root: number) => [0, 2, 4].includes(mod7(d - root));

const MEL_LO = 7, MEL_HI = 16; // G4 … B5
const HAR_LO = 3, HAR_HI = 14; // C4 … D6
const BASS_LO = 0, BASS_HI = 7; // G3 (open string) … G4

export function makeTune(rnd: () => number): Tune {
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const A = pick(A_PROGS);
  const B = pick(B_PROGS);
  const chords = [...A[0], ...A[1], ...B[0], ...B[1]];

  // ---- melody: write each section once, then rewrite only the bars whose chord changes on the repeat
  const melody: Slot[] = [];
  let prev = 11 + Math.floor(rnd() * 3); // around D5
  let dir = rnd() < 0.5 ? 1 : -1;

  const bar = (root: number, rhythm: number[], last: boolean, home: boolean): Slot[] => {
    const out: Slot[] = [];
    let pos = 0;
    rhythm.forEach((len, k) => {
      let d: number;
      const final = last && k === rhythm.length - 1;
      if (final) {
        // land: the tonic on the closing cadence, else the chord's nearest root/third
        const want = home ? [0] : [0, 2];
        d = nearest(prev, (x) => want.includes(mod7(x - root)), MEL_LO, MEL_HI);
      } else if (pos % 2 === 0) {
        // on the beat: a chord tone, mostly by step, sometimes a skip across the chord
        if (rnd() < 0.25) dir = -dir;
        const reach = rnd() < 0.7 ? 2 : 4;
        const cands: number[] = [];
        for (let x = prev - reach; x <= prev + reach; x++) if (x >= MEL_LO && x <= MEL_HI && isChordTone(x, root)) cands.push(x);
        const along = cands.filter((x) => Math.sign(x - prev) === dir);
        d = along.length ? pick(along) : cands.length ? pick(cands) : nearest(prev, (x) => isChordTone(x, root), MEL_LO, MEL_HI);
      } else {
        // off the beat: a passing / neighbour step
        d = prev + (rnd() < 0.8 ? dir : -dir);
        if (d < MEL_LO || d > MEL_HI) {
          dir = -dir;
          d = prev + dir;
        }
      }
      if (d <= MEL_LO + 1) dir = 1;
      if (d >= MEL_HI - 1) dir = -1;
      out.push({ deg: d, hold: len });
      for (let j = 1; j < len; j++) out.push({ deg: d, hold: 0 });
      prev = d;
      pos += len;
    });
    return out;
  };

  const section = ([first, second]: [number[], number[]]) => {
    // a little motif: bars 1 and 3 share a rhythm
    const r1 = pick(RHYTHMS), r2 = pick(RHYTHMS);
    const rhythms = [r1, r2, r1, pick(CADENCE)];
    const start = prev;
    const a = first.map((root, b) => bar(root, rhythms[b], b === 3, false));
    const b: Slot[][] = [];
    prev = start;
    second.forEach((root, k) => {
      if (root === first[k] && k < 3) {
        b.push(a[k]);
        // carry on from the copied bar's last note
        for (let j = a[k].length - 1; j >= 0; j--) if (a[k][j].hold > 0) { prev = a[k][j].deg; break; }
      } else b.push(bar(root, k === 3 ? pick(CADENCE) : rhythms[k], k === 3, k === 3 && root === I));
    });
    melody.push(...a.flat(), ...b.flat());
  };
  section(A);
  prev = Math.min(prev + 2, MEL_HI); // the B part sits a little higher
  section(B);

  // ---- harmony: a third or a sixth below the melody (whichever moves least),
  // staying on chord tones wherever the melody is on one
  let hPrev = melody[0].deg - 2;
  const harmony: Slot[] = melody.map((m, s) => {
    if (m.hold === 0) return { deg: hPrev, hold: 0 };
    const root = chords[Math.floor(s / 8)];
    let cands = [m.deg - 2, m.deg - 5];
    if (isChordTone(m.deg, root)) cands = cands.filter((d) => isChordTone(d, root));
    cands = cands.flatMap((d) => [d, d - 7, d + 7]).filter((d) => d >= HAR_LO && d <= HAR_HI && d < m.deg);
    if (!cands.length) cands = [m.deg - 2];
    hPrev = cands.reduce((a, b) => (Math.abs(b - hPrev) < Math.abs(a - hPrev) ? b : a));
    return { deg: hPrev, hold: m.hold };
  });

  // ---- bass: roots and fifths, one pattern for A and one for B
  const bass: Slot[] = [];
  const patA = pick(BASS_PATS), patB = pick(BASS_PATS);
  chords.forEach((root, b) => {
    const pat = b < 8 ? patA : patB;
    const r = root <= BASS_HI ? root : root - 7; // the root, low
    for (const [step, len] of pat) {
      let d = r + step;
      if (d > BASS_HI) d -= 7;
      if (d < BASS_LO) d += 7;
      bass.push({ deg: d, hold: len });
      for (let j = 1; j < len; j++) bass.push({ deg: d, hold: 0 });
    }
  });

  // ---- banjo: bum-ditty. On each beat pair: the melody note an octave down
  // (bum), a brush across the chord (dit), the open fifth string (ty)
  const DRONE = 7; // G4, the short fifth string
  const sounding = (s: number) => {
    for (let j = s; j >= 0; j--) if (melody[j].hold > 0) return melody[j].deg;
    return melody[0].deg;
  };
  const banjo: Slot[] = [];
  chords.forEach((root, b) => {
    for (let q = 0; q < 2; q++) {
      const s0 = b * 8 + q * 4;
      let m = sounding(s0) - 7;
      while (m < -3) m += 7;
      banjo.push({ deg: m, hold: 2 }, { deg: m, hold: 0 });
      const ch = banjoChord(root);
      banjo.push({ deg: ch[0], hold: 1, chord: ch });
      banjo.push({ deg: DRONE, hold: 1 });
    }
  });

  // ---- double bass: root on the beat, then the fifth below it, and again
  const dbass: Slot[] = [];
  chords.forEach((root) => {
    const r = root - 7; // G2 … E3
    for (const d of [r, r - 3, r, r - 3]) dbass.push({ deg: d, hold: 2 }, { deg: d, hold: 0 });
  });

  return { chords, parts: [melody, harmony, bass, banjo, dbass] };
}

/** The open-G banjo's four long strings (D3 G3 B3 D4), as degrees. */
const STRINGS = [-3, 0, 2, 4];
const semitones = (d: number) => 12 * Math.floor(d / 7) + SCALE[mod7(d)];

/**
 * A chord as you'd fret it on the banjo's four long strings: each string
 * plays a chord tone within its first five frets, and of all the ways to
 * do that, the one that sounds all three of the chord's notes with the
 * least fretting (and no two strings on the same note, if it can help it). (So G is all open strings, C is E3 G3 C4 E4, D is
 * D3 A3 D4 F#4.) Low to high, as the brush strikes them.
 */
export function banjoChord(root: number) {
  const cands = STRINGS.map((o) => {
    const out: number[] = [];
    for (let d = o; semitones(d) - semitones(o) <= 5; d++) if ([0, 2, 4].includes(mod7(d - root))) out.push(d);
    return out;
  });
  let best: number[] = [], bestScore = -Infinity;
  const pick = (k: number, chosen: number[]) => {
    if (k === STRINGS.length) {
      const tones = new Set(chosen.map((d) => mod7(d - root)));
      const frets = chosen.reduce((n, d, i) => n + semitones(d) - semitones(STRINGS[i]), 0);
      const doubled = chosen.length - new Set(chosen).size; // (two strings on the same note sounds thin)
      const score = tones.size * 100 - frets - 4 * doubled;
      if (score > bestScore) [best, bestScore] = [chosen, score];
      return;
    }
    for (const d of cands[k]) pick(k + 1, [...chosen, d]);
  };
  pick(0, []);
  return best;
}

/** The degree closest to `from` (within lo…hi) that passes `ok`. */
function nearest(from: number, ok: (d: number) => boolean, lo: number, hi: number) {
  for (let r = 0; r < 14; r++) {
    for (const d of [from - r, from + r]) if (d >= lo && d <= hi && ok(d)) return d;
  }
  return from;
}

/**
 * The tune everyone plays. A fresh one is written whenever someone starts
 * fiddling while nobody else is, so the square hears a new tune now and then.
 */
let current = makeTune(Math.random);
const playing = [0, 0, 0, 0, 0]; // fiddlers per part, then banjos, then basses

export const tune = () => current;
export function setTune(t: Tune) {
  current = t;
}

/**
 * Join in: a fiddle takes the first free part (melody first), a banjo plays
 * the banjo part, a double bass the bass part. Returns the part index. Starting while nobody else plays
 * strikes up a new tune.
 */
export function joinBand(instrument: 'fiddle' | 'banjo' | 'bass' = 'fiddle'): number {
  if (playing.every((n) => n === 0)) current = makeTune(Math.random);
  if (instrument === 'banjo' || instrument === 'bass') {
    const v = instrument === 'banjo' ? BANJO : BASS;
    playing[v]++;
    return v;
  }
  const fid = playing.slice(0, BANJO);
  let v = fid.findIndex((n) => n === 0);
  if (v < 0) v = fid.indexOf(Math.min(...fid));
  playing[v]++;
  return v;
}

export function leaveBand(v: number) {
  if (v >= 0) playing[v] = Math.max(0, playing[v] - 1);
}
