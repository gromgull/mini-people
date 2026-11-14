// Render a paused walker at successive times and tile them into one image.
//   node scripts/filmstrip.mjs "<query>" [frames=10] [dt=0.1] [name=strip] [t0=0]
// The query should select + focus someone, e.g. "count=6&select=0&focus&zoom=6&az=90&el=8"
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const [query = 'count=6&select=0&focus&zoom=6&az=90&el=8', frames = '10', dt = '0.1', name = 'strip', t0 = '0'] = process.argv.slice(2);
mkdirSync('screenshots/frames', { recursive: true });

const server = await createServer({ server: { port: 5198, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 600 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const files = [];
for (let i = 0; i < Number(frames); i++) {
  const t = (Number(t0) + i * Number(dt)).toFixed(3);
  await page.goto(`http://localhost:5198/${process.env.PAGE ?? 'demo.html'}?${query}&t=${t}&paused&nogui`);
  await page.waitForFunction(() => window.__mini?.ready, null, { timeout: 20000 });
  const f = `screenshots/frames/${name}-${String(i).padStart(2, '0')}.png`;
  await page.screenshot({ path: f });
  files.push(f);
}
await browser.close();
await server.close();

execFileSync('montage', [...files, '-tile', `${Math.min(5, files.length)}x`, '-geometry', '+2+2', '-background', '#222', `screenshots/${name}.png`]);
console.log(errors.length ? `✗ errors:\n  ${errors.join('\n  ')}` : '✓ no errors', `→ screenshots/${name}.png`);
process.exit(errors.length ? 1 : 0);
