// Headless smoke test: boots the Vite dev server, opens the demo in Chromium
// (SwiftShader WebGL), fails on console/page errors, and saves screenshots.
//
//   npm run shot                         → default set of shots
//   npm run shot -- "seed=7&zoom=3" name → one custom shot
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const shots = process.argv[2]
  ? [[process.argv[3] ?? 'custom', process.argv[2]]]
  : [
      ['crowd', 'seed=1&nogui'],
      ['crowd-gui', 'seed=1&select=0'],
      ['closeup', 'seed=1&zoom=3.5&px=1&count=12&nogui'],
      ['closeup-pixel', 'seed=1&zoom=3.5&px=3&count=12&nogui'],
      ['smooth-nooutline', 'seed=1&zoom=2&px=2&smooth=1&outline=0&count=20&nogui'],
    ];

mkdirSync('screenshots', { recursive: true });
const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

let failed = false;
for (const [name, query] of shots) {
  errors.length = 0;
  await page.goto(`http://localhost:5199/?${query}`);
  try {
    await page.waitForFunction(() => window.__mini?.ready, null, { timeout: 20000 });
  } catch {
    errors.push('timed out waiting for __mini.ready');
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: `screenshots/${name}.png` });
  console.log(`${errors.length ? '✗' : '✓'} ${name}  (?${query})`);
  for (const e of errors) console.log('   ', e);
  failed ||= errors.length > 0;
}

await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
