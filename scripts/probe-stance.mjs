// Lateral foot spacing (root frame) while walking in parade, for a few people.
//   node scripts/probe-stance.mjs seed idx [idx...]
import { open } from './harness.mjs';
const [seed = '1', ...idx] = process.argv.slice(2);
const { page: pg, errors, url, ready, close } = await open();
for (const i of idx.map(Number)) {
  const ws = [];
  for (let t = 3; t < 4.2; t += 0.1) {
    await pg.goto(url(`seed=${seed}&count=24&paused&nogui&t=${t.toFixed(2)}`));
    await ready();
    ws.push(await pg.evaluate((i) => {
      const p = window.__mini.people[i];
      p.root.updateMatrixWorld(true);
      const a = p.joints.ankleL.getWorldPosition(p.joints.ankleL.position.clone());
      const c = p.joints.ankleR.getWorldPosition(a.clone());
      p.root.worldToLocal(a); p.root.worldToLocal(c);
      return Math.abs(a.x - c.x) / p.dims.height;
    }, i));
  }
  console.log(`#${i} feet apart / height: mean ${(ws.reduce((s, x) => s + x) / ws.length).toFixed(3)} max ${Math.max(...ws).toFixed(3)}`);
}
await close();
