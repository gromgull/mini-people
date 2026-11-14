import { createServer } from 'vite';
import { chromium } from 'playwright';
const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await page.goto('http://localhost:5199/?paused&nogui');
await page.waitForFunction(() => window.__mini?.ready);
let last = '';
for (let k = 0; k < 240; k++) {
  const r = await page.evaluate(() => { window.__mini.step(1); const d = window.__mini.debug(); const v = d.village;
    return { t: window.__mini.time.toFixed(0), jobs: d.jobs.map((j) => j.doing).join(' / '), pile: `${d.pile.count}+${d.pile.incoming}`, logs: d.logs.map((l) => l.place.at[0]).join(''), stats: `felled ${v.stats.felled} sawn ${v.stats.sawn}` }; });
  const line = `${r.jobs.padEnd(30)} pile ${r.pile} logs[${r.logs}] ${r.stats}`;
  if (line !== last) console.log(r.t.padStart(4), line);
  last = line;
}
console.log(errs);
await browser.close(); await server.close();
