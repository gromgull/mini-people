// Lateral foot spacing (root frame) while walking in parade, for a few people.
//   node scripts/probe-stance.mjs seed idx [idx...]
import { createServer } from 'vite';
import { chromium } from 'playwright';
const [seed = '1', ...idx] = process.argv.slice(2);
const server = await createServer({ server: { port: 5196, strictPort: true }, logLevel: 'error' });
await server.listen();
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const pg = await b.newPage();
for (const i of idx.map(Number)) {
  const ws = [];
  for (let t = 3; t < 4.2; t += 0.1) {
    await pg.goto(`http://localhost:5196/debug.html?seed=${seed}&count=24&paused&nogui&t=${t.toFixed(2)}`);
    await pg.waitForFunction(() => window.__mini?.ready);
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
await b.close(); await server.close();
