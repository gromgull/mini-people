// Front close-ups of selected people, tiled; prints each one's fem/bust/hair.
//   node scripts/closeups.mjs "<extra query>" name [indices...]
import { open } from './harness.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const [extra = '', name = 'closeups', ...idx] = process.argv.slice(2);
mkdirSync('screenshots/frames', { recursive: true });
const { page, errors, url, ready, close } = await open({ viewport: { width: 360, height: 480 } });
const base = `count=24&mode=stand&paused&nogui&t=1&look=camera&${extra}`;
await page.goto(url(`${base}`));
await ready();
const genes = await page.evaluate(() => window.__mini.people.map((p) => ({ fem: +p.genome.fem.toFixed(2), bust: +p.genome.bust.toFixed(2), hair: p.genome.hairStyle, skirt: p.genome.skirt, beard: p.genome.beard })));
const list = idx.length ? idx.map(Number) : genes.map((g, i) => i).filter((i) => genes[i].fem > 0.5).slice(0, 10);
const files = [];
for (const i of list) {
  console.log(i, JSON.stringify(genes[i]));
  await page.goto(url(`${base}&select=${i}&focus&zoom=${process.env.Z||5}&az=0&el=8`));
  await ready();
  const f = `screenshots/frames/${name}-${i}.png`;
  await page.screenshot({ path: f });
  files.push(f);
}
await close();
execFileSync('montage', [...files, '-tile', '5x', '-geometry', '+2+2', '-background', '#222', `screenshots/${name}.png`]);
console.log(errors.length ? `✗ ${errors.join('\n')}` : '✓', `screenshots/${name}.png`);
