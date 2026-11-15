// Moves the mouse to a few spots with ?look=cursor and screenshots each.
//   node scripts/look-cursor.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
const server = await createServer({ server: { port: 5195, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5195/debug.html?mode=stand&count=9&seed=1&zoom=3&px=2&look=cursor&nogui');
await page.waitForFunction(() => window.__mini?.ready);
const files = [];
for (const [i, [x, y]] of [[60, 300], [450, 40], [840, 300], [450, 560]].entries()) {
  await page.mouse.move(x, y, { steps: 5 });
  await page.waitForTimeout(1500);
  const f = `screenshots/frames/cursor-${i}.png`;
  await page.screenshot({ path: f });
  files.push(f);
}
await browser.close(); await server.close();
execFileSync('montage', [...files, '-tile', '2x', '-geometry', '+2+2', '-background', '#222', 'screenshots/look-cursor.png']);
console.log(errors.length ? errors : '✓ no errors → screenshots/look-cursor.png');
