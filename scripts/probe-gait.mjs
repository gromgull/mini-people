// Numeric gait check: knee angles + ankle heights of person 0 over time.
// A good walk: stance knee < ~15°, swing knee ~60–75°, planted ankle y == footH.
//   node scripts/probe-gait.mjs
import { open } from './harness.mjs';
const { page, errors, url, ready, close } = await open({ viewport: { width: 400, height: 300 } });
for (const t of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
  await page.goto(url(`count=6&t=${t}&paused&nogui`));
  await ready();
  const r = await page.evaluate(() => {
    const p = window.__mini.people[0];
    const J = p.joints;
    p.root.updateMatrixWorld(true);
    const ang = (q) => (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI).toFixed(0);
    const wp = (o) => { const v = o.getWorldPosition(o.position.clone()); return v; };
    const aL = wp(J.ankleL), aR = wp(J.ankleR), pel = wp(J.pelvis);
    return { legLen: p.dims.legLen.toFixed(3), footH: p.dims.footH.toFixed(3), pelvisY: pel.y.toFixed(3),
      kneeL: ang(J.kneeL.quaternion), kneeR: ang(J.kneeR.quaternion), ankLy: aL.y.toFixed(3), ankRy: aR.y.toFixed(3), legsGene: p.genome.legs.toFixed(2) };
  });
  console.log(t, JSON.stringify(r));
}
await close();
