// Grid of faces: each row is one person, each column forces a beard style.
//   node scripts/faces.mjs [indices=2,6,12,13] [seed=1]
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const [ids = '2,6,12,13', seed = '1'] = process.argv.slice(2);
mkdirSync('screenshots/frames', { recursive: true });
const server = await createServer({ server: { port: 5193, strictPort: true }, logLevel: 'error' });
await server.listen();
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const pg = await b.newPage({ viewport: { width: 260, height: 260 } });
const errors = [];
pg.on('pageerror', (e) => errors.push(String(e)));
const files = [];
for (const i of ids.split(',').map(Number)) {
  await pg.goto(`http://localhost:5193/?seed=${seed}&count=24&mode=stand&paused&nogui&t=1&look=camera&select=${i}&focus&zoom=11&az=${process.env.AZ||25}&el=6&fy=0.86`);
  await pg.waitForFunction(() => window.__mini?.ready);
  for (let style = 0; style < 6; style++) {
    await pg.evaluate(([i, style]) => {
      const m = window.__mini;
      m.people[i].genome.beard = style;
      m.rebuild(i);
      // hide everyone else so the face is clear
      m.people.forEach((p, j) => (p.root.visible = j === i));
    }, [i, style]);
    await pg.waitForTimeout(150);
    const f = `screenshots/frames/face-${i}-${style}.png`;
    await pg.screenshot({ path: f });
    files.push(f);
  }
}
await b.close(); await server.close();
execFileSync('montage', [...files, '-tile', '6x', '-geometry', '+2+2', '-background', '#222', 'screenshots/faces.png']);
console.log(errors.length ? `✗ ${errors.join('\n')}` : '✓ screenshots/faces.png');
