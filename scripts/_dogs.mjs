// node scripts/_dogs.mjs name "<query>"   (demo page, 1000x600)
import { createServer } from 'vite';
import { chromium } from 'playwright';
const [name, query] = process.argv.slice(2);
const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
page.on('pageerror', (e) => console.log('ERR', String(e)));
page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text()));
await page.goto(`http://localhost:5199/demo.html?${query}&paused&nogui`);
await page.waitForFunction(() => window.__mini?.ready, null, { timeout: 20000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `screenshots/${name}.png` });
await browser.close(); await server.close();
