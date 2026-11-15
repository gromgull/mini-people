// Front close-ups of selected people, tiled; prints each one's fem/bust/hair.
//   node scripts/closeups.mjs "<extra query>" name [indices...]
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const [extra = '', name = 'closeups', ...idx] = process.argv.slice(2);
mkdirSync('screenshots/frames', { recursive: true });
const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 360, height: 480 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const base = `count=24&mode=stand&paused&nogui&t=1&look=camera&${extra}`;
await page.goto(`http://localhost:5199/debug.html?${base}`);
await page.waitForFunction(() => window.__mini?.ready);
const genes = await page.evaluate(() => window.__mini.people.map((p) => ({ fem: +p.genome.fem.toFixed(2), bust: +p.genome.bust.toFixed(2), hair: p.genome.hairStyle, skirt: p.genome.skirt, beard: p.genome.beard })));
const list = idx.length ? idx.map(Number) : genes.map((g, i) => i).filter((i) => genes[i].fem > 0.5).slice(0, 10);
const files = [];
for (const i of list) {
  console.log(i, JSON.stringify(genes[i]));
  await page.goto(`http://localhost:5199/debug.html?${base}&select=${i}&focus&zoom=${process.env.Z||5}&az=0&el=8`);
  await page.waitForFunction(() => window.__mini?.ready);
  const f = `screenshots/frames/${name}-${i}.png`;
  await page.screenshot({ path: f });
  files.push(f);
}
await browser.close();
await server.close();
execFileSync('montage', [...files, '-tile', '5x', '-geometry', '+2+2', '-background', '#222', `screenshots/${name}.png`]);
console.log(errors.length ? `✗ ${errors.join('\n')}` : '✓', `screenshots/${name}.png`);
