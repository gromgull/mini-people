// Wander mode health: closest pairs over time (overlaps = walk-throughs).
//   node scripts/probe-wander.mjs [count=30] [seed=1]
import { open } from './harness.mjs';
const [count = '30', seed = '1'] = process.argv.slice(2);
const { page: pg, errors, url, ready, close } = await open();
let bad = 0, samples = 0;
for (let t = 2; t <= 60; t += 2) {
  await pg.goto(url(`mode=wander&count=${count}&seed=${seed}&t=${t}&paused&nogui`));
  await ready();
  const r = await pg.evaluate(() => {
    const P = window.__mini.people.map((p) => p.root.position);
    let min = 9, close = 0;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const d = Math.hypot(P[i].x - P[j].x, P[i].z - P[j].z);
      min = Math.min(min, d);
      if (d < 0.25) close++;
    }
    const R = Math.max(...P.map((p) => Math.hypot(p.x, p.z)));
    return { min, close, R };
  });
  samples++;
  bad += r.close;
  if (t % 10 === 0) console.log(`t=${t} min pair ${r.min.toFixed(2)} pairs<0.25: ${r.close} furthest ${r.R.toFixed(1)}`);
}
console.log(`overlapping pairs per sample: ${(bad / samples).toFixed(2)}`);
await close();
