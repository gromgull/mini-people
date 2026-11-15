// Render a paused walker at successive times and tile them into one image.
//   node scripts/filmstrip.mjs "<query>" [frames=10] [dt=0.1] [name=strip] [t0=0]
// The query should select + focus someone, e.g. "count=6&select=0&focus&zoom=6&az=90&el=8"
import { open } from './harness.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const [query = 'count=6&select=0&focus&zoom=6&az=90&el=8', frames = '10', dt = '0.1', name = 'strip', t0 = '0'] = process.argv.slice(2);
mkdirSync('screenshots/frames', { recursive: true });

// (seeded Math.random, so every frame, a fresh page load, plays out the same story)
const { page, errors, url, ready, close } = await open({ viewport: { width: 480, height: 600 }, seeded: true });
const files = [];
for (let i = 0; i < Number(frames); i++) {
  const t = (Number(t0) + i * Number(dt)).toFixed(3);
  await page.goto(url(`${query}&t=${t}&paused&nogui`, process.env.PAGE ?? 'debug.html'));
  await ready();
  const f = `screenshots/frames/${name}-${String(i).padStart(2, '0')}.png`;
  await page.screenshot({ path: f });
  files.push(f);
}
await close();

execFileSync('montage', [...files, '-tile', `${Math.min(5, files.length)}x`, '-geometry', '+2+2', '-background', '#222', `screenshots/${name}.png`]);
console.log(errors.length ? `✗ errors:\n  ${errors.join('\n  ')}` : '✓ no errors', `→ screenshots/${name}.png`);
process.exit(errors.length ? 1 : 0);
