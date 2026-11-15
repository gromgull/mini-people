// Repro for "walking backwards after everyone trips": compare facing vs path heading.
//   node scripts/probe-trip.mjs [t=6]
import { open } from './harness.mjs';
const T = process.argv[2] ?? '6';
const { page, errors, url, ready, close } = await open({ viewport: { width: 400, height: 300 } });
for (const t of T.split(',')) {
  await page.goto(url(`count=24&seed=1&act=fall&actAll&actAt=0.5&t=${t}&paused&nogui`));
  await ready();
  const r = await page.evaluate(() => {
    const { offsets, actors, motions, baseTransform } = window.__mini.debug();
    return window.__mini.people.map((p, i) => {
      const b = baseTransform(i);
      const d = Math.atan2(Math.sin(p.root.rotation.y - b.yaw), Math.cos(p.root.rotation.y - b.yaw));
      return { i, busy: actors[i].kind, faceVsPath: +(d * 57.3).toFixed(0), offYaw: +(offsets[i].yaw * 57.3).toFixed(0), speed: +motions[i].speed.toFixed(2) };
    });
  });
  const bad = r.filter((x) => Math.abs(x.faceVsPath) > 45);
  const moonwalk = r.filter((x) => Math.abs(x.faceVsPath) > 60 && x.speed > 0.1);
  console.log(`t=${t}: walking while facing >60° off path: ${moonwalk.length}`);
  console.log(`t=${t}: ${bad.length}/${r.length} facing >45° off path; busy=${r.filter((x) => x.busy).length}`);
  for (const x of bad.slice(0, 8)) console.log('  ', JSON.stringify(x));
}
await close();
