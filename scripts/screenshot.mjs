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
      ['crowd', 'mode=stand&seed=1&nogui'],
      ['crowd-gui', 'mode=stand&seed=1&select=0'],
      ['closeup', 'mode=stand&seed=1&zoom=3.5&px=1&count=12&nogui'],
      ['closeup-pixel', 'mode=stand&seed=1&zoom=3.5&px=3&count=12&nogui'],
      ['smooth-nooutline', 'mode=stand&seed=1&zoom=2&px=2&smooth=1&outline=0&count=20&nogui'],
      ['parade', 'seed=1&t=2&paused&nogui'],
      ['parade-follow', 'seed=2&t=3&paused&select=3&focus&zoom=3.5&nogui'],
      ['parade-stepped', 'seed=1&fps=10&t=1.5&nogui'],
      ['compare', 'mode=compare&seed=1&select=0&t=4&paused&nogui'],
      ['act-fall', 'mode=stand&count=12&seed=1&select=0&act=fall&actAt=0.3&t=1.2&paused&zoom=2.5&nogui'],
      ['act-hammer', 'mode=stand&count=12&seed=1&select=0&act=hammer&actAt=0.2&t=1.0&paused&focus&zoom=4&nogui'],
      ['act-carry', 'mode=parade&count=12&seed=1&select=0&act=carry&actAt=0.2&t=3&paused&focus&follow&zoom=4&nogui'],
      ['act-sit', 'mode=stand&count=12&seed=1&select=0&act=sit&actAt=0.2&t=3&paused&focus&zoom=4&az=40&nogui'],
      ['act-saw', 'mode=stand&count=12&seed=1&select=0&act=saw&actAt=0.2&t=2&paused&focus&zoom=4&az=-30&nogui'],
      ['act-talk', 'mode=wander&count=2&seed=4&select=0&act=talk&actAt=0.5&t=2.5&paused&focus&zoom=3&az=90&nogui'],
      ['act-auto', 'mode=stand&seed=2&auto&t=12&nogui'],
      ['parade-auto', 'seed=3&auto&t=10&nogui'],
      ['wander', 'mode=wander&seed=1&count=30&t=20&paused&nogui'],
      ['single', 'mode=single&seed=1&who=3&t=2&paused&nogui'],
      ['single-walk-carry', 'mode=single&walk&seed=1&who=3&act=carry&actAt=0.3&t=3.5&paused&nogui'],
      ['single-walk-wave', 'mode=single&walk&seed=5&act=wave&actAt=1&t=1.8&paused&nogui'],
      ['sky', 'mode=parade&el=8&az=120&t=3&paused&nogui'],
      ['act-chop', 'mode=single&seed=1&who=3&act=chop&actAt=0.1&zoom=2.5&el=20&px=2&t=2.1&paused&nogui'],
      ['act-chop-felled', 'mode=single&seed=1&who=3&act=chop&actAt=0.1&zoom=1.6&el=25&px=2&t=6.6&paused&nogui'],
      ['act-pick', 'mode=single&seed=4&act=pick&actAt=0.1&zoom=3&el=30&px=2&t=1.7&paused&nogui'],
      ['act-fish-reel', 'mode=single&seed=1&who=3&act=fish&actAt=0.1&zoom=2&el=20&az=60&px=2&t=7&paused&nogui'],
      ['act-fish-catch', 'mode=single&seed=1&who=3&act=fish&actAt=0.1&zoom=3&el=10&az=40&px=2&t=9.4&paused&nogui'],
      ['act-drink', 'mode=stand&count=1&seed=1&select=0&focus&zoom=4&el=12&az=25&act=drink&actAt=0.1&t=4.6&paused&nogui'],
      ['act-eat-apple', 'mode=single&seed=1&act=eat&meal=apple&actAt=0.1&zoom=3&el=15&az=35&t=4.0&paused&nogui'],
      ['act-eat-fish', 'mode=stand&count=1&seed=4&select=0&focus&zoom=4&el=12&az=-25&act=eat&meal=fish&actAt=0.1&t=5.4&paused&nogui'],
      ['wander-dine', 'mode=wander&seed=5&count=30&t=40&paused&nogui'],
      ['act-haul', 'mode=single&seed=1&who=3&act=haul&actAt=0.1&zoom=2.5&az=60&el=15&t=3&paused&nogui'],
      ['act-banjo', 'mode=single&seed=1&who=3&act=banjo&actAt=0.1&zoom=3&az=20&el=12&t=2.5&paused&nogui'],
      ['act-banjo-seated', 'mode=single&seed=4&act=banjo&actAt=0.1&sitplay&zoom=3&az=30&el=12&t=3&paused&nogui'],
      ['act-bass', 'mode=single&seed=1&who=3&act=bass&actAt=0.1&zoom=2.2&az=-40&el=12&t=3&paused&nogui'],
      ['act-pipe', 'mode=single&seed=1&who=3&act=pipe&actAt=0.1&zoom=2.6&az=-40&el=10&t=3.2&paused&nogui'],
      ['act-armful', 'mode=single&seed=1&who=3&act=armful&actAt=0.1&zoom=3&az=50&el=18&tx=0.6&tz=0.6&t=2.5&paused&nogui'],
      ['village', 'mode=wander&count=30&seed=1&nogui&zoom=0.42&tz=-8&el=45&time=17.5&daycycle=0&t=3&paused'],
      ['inn', 'mode=stand&count=1&seed=1&nogui&zoom=0.9&tx=-4&tz=-12&az=75&el=22&t=1&paused'],
      ['cabin', 'mode=stand&count=1&seed=1&nogui&zoom=1.1&tx=-0.5&tz=-19&az=30&el=30&t=1&paused'],
      ['wander-chores', 'mode=wander&seed=3&count=30&t=45&paused&nogui'],
      ['look-camera', 'mode=stand&count=12&seed=1&zoom=3.2&px=2&look=camera&t=2&paused&nogui'],
      ['stand-idle', 'mode=stand&seed=1&count=12&zoom=3&t=6&paused&nogui'],
    ];

mkdirSync('screenshots', { recursive: true });
const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
// seeded Math.random, so paused shots come out the same every run (and can be
// compared before/after a refactor)
await page.addInitScript(() => {
  let a = 12345;
  Math.random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
});
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

let failed = false;
for (const [name, query] of shots) {
  errors.length = 0;
  await page.goto(`http://localhost:5199/${process.env.PAGE ?? 'demo.html'}?${query}`);
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
