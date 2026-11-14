// Print generated tunes (chords + every part, bar by bar: melody, harmony,
// fiddle bass, banjo with + for a brush, double bass) and count clashing
// intervals between the fiddle parts.
//   node scripts/tune-sheet.mjs
import { createServer } from 'vite';
const server = await createServer({ logLevel: 'error', server: { middlewareMode: true } });
const T = await server.ssrLoadModule('/src/tune.ts');
const { mulberry32 } = await server.ssrLoadModule('/src/rng.ts');
const NAMES = ['G', 'A', 'B', 'C', 'D', 'E', 'F#'];
const RN = ['I', 'ii', 'iii', 'IV', 'V', 'vi'];
const nm = (d) => NAMES[((d % 7) + 7) % 7] + (3 + Math.floor((semis(d) + 7) / 12)); // degree 0 = G3
const semis = (d) => 12 * Math.floor(d / 7) + [0, 2, 4, 5, 7, 9, 11][((d % 7) + 7) % 7];
let worst = 0;
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  const t = T.makeTune(mulberry32(seed));
  let bad = 0, strong = 0;
  for (let s = 0; s < T.FORM_SLOTS; s++) {
    const p = t.parts.slice(0, 3).map((v) => { let k = s; while (v[k].hold === 0) k--; return v[k].deg; });
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
      const iv = Math.abs(semis(p[a]) - semis(p[b])) % 12;
      if ([1, 2, 6, 10, 11].includes(iv)) { bad++; if (s % 2 === 0) strong++; }
      if (p[a] === p[b] && a === 0 && b === 1) bad++;
    }
  }
  worst = Math.max(worst, strong);
  if (seed <= 2) {
    console.log(`seed ${seed}: A ${t.chords.slice(0, 4).map((c) => RN[c]).join(' ')} | ${t.chords.slice(4, 8).map((c) => RN[c]).join(' ')}   B ${t.chords.slice(8, 12).map((c) => RN[c]).join(' ')} | ${t.chords.slice(12).map((c) => RN[c]).join(' ')}`);
    for (let bar = 0; bar < 16; bar++) {
      const row = t.parts.map((v) => v.slice(bar * 8, bar * 8 + 8).map((n) => (n.hold ? (n.chord ? '+' : '') + nm(n.deg).padEnd(n.chord ? 3 : 4) : ' -  ')).join(''));
      console.log(`${String(bar + 1).padStart(2)} ${RN[t.chords[bar]].padEnd(4)} ${row.join(' │ ')}`);
    }
  }
  console.log(`seed ${seed}: dissonant slot-pairs ${bad}/${T.FORM_SLOTS * 3}, on the beat ${strong}`);
}
await server.close();
