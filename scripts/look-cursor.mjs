// Moves the mouse to a few spots with ?look=cursor and screenshots each.
//   node scripts/look-cursor.mjs
import { open } from './harness.mjs';
import { execFileSync } from 'node:child_process';
const { page, errors, url, ready, close } = await open({ viewport: { width: 900, height: 600 } });
await page.goto(url('mode=stand&count=9&seed=1&zoom=3&px=2&look=cursor&nogui'));
await ready();
const files = [];
for (const [i, [x, y]] of [[60, 300], [450, 40], [840, 300], [450, 560]].entries()) {
  await page.mouse.move(x, y, { steps: 5 });
  await page.waitForTimeout(1500);
  const f = `screenshots/frames/cursor-${i}.png`;
  await page.screenshot({ path: f });
  files.push(f);
}
await close();
execFileSync('montage', [...files, '-tile', '2x', '-geometry', '+2+2', '-background', '#222', 'screenshots/look-cursor.png']);
console.log(errors.length ? errors : '✓ no errors → screenshots/look-cursor.png');
