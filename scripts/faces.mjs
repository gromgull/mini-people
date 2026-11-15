// Grid of faces: each row is one person, each column forces a beard style.
//   node scripts/faces.mjs [indices=2,6,12,13] [seed=1]
import { open } from './harness.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const [ids = '2,6,12,13', seed = '1'] = process.argv.slice(2);
const GENE = process.env.GENE || 'beard'; // which genome field the columns sweep
const COLS = Number(process.env.COLS || 6);
mkdirSync('screenshots/frames', { recursive: true });
const { page: pg, errors, url, ready, close } = await open({ viewport: { width: 260, height: 260 } });
const files = [];
for (const i of ids.split(',').map(Number)) {
  await pg.goto(url(`seed=${seed}&count=24&mode=stand&paused&nogui&t=1&look=camera&select=${i}&focus&zoom=11&az=${process.env.AZ||25}&el=6&fy=0.86`));
  await ready();
  for (let style = 0; style < COLS; style++) {
    await pg.evaluate(([i, style, gene]) => {
      const m = window.__mini;
      m.people[i].genome[gene] = style;
      m.rebuild(i);
      // hide everyone else so the face is clear
      m.people.forEach((p, j) => (p.root.visible = j === i));
    }, [i, style, GENE]);
    await pg.waitForTimeout(150);
    const f = `screenshots/frames/face-${i}-${style}.png`;
    await pg.screenshot({ path: f });
    files.push(f);
  }
}
await close();
execFileSync('montage', [...files, '-tile', `${COLS}x`, '-geometry', '+2+2', '-background', '#222', 'screenshots/faces.png']);
console.log(errors.length ? `✗ ${errors.join('\n')}` : '✓ screenshots/faces.png');
