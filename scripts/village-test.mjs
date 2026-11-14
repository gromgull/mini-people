// Headless check of the village's woodcutting chain: runs it for a while in
// fixed steps and checks, every simulated second, that the world stays
// consistent and work keeps getting done.
//
//   node scripts/village-test.mjs [seconds=600] [seed=1]
//
// Invariants:
//   - every log and piece of firewood is in exactly one place, and the
//     containers agree with it (pile, stacks, sawhorse, whoever carries it);
//     stacks' promised room and pieces add up
//   - at most one tree is being felled; claimed trees are claimed by a lumberjack
//   - nobody stays in the same step for more than 90 s (waiting about and
//     sitting on the bench don't count)
//   - positions are finite
//   - by the end, trees have been felled, logs sawn and firewood delivered
import { createServer } from 'vite';
import { chromium } from 'playwright';

const [seconds = '600', seed = '1'] = process.argv.slice(2);
const server = await createServer({ server: { port: 5197, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`http://localhost:5197/?paused&nogui&seed=${seed}`);
await page.waitForFunction(() => window.__mini?.ready, null, { timeout: 20000 });

const problems = [];
const result = await page.evaluate((secs) => {
  const m = window.__mini;
  const bad = [];
  const since = new Map(); // job index → [step, since]
  for (let s = 1; s <= secs; s++) {
    m.step(1);
    const d = m.debug();
    const t = Math.round(m.time);
    const say = (msg) => bad.length < 30 && bad.push(`t=${t}s ${msg}`);
    // logs and their containers
    for (const l of d.logs) {
      const p = l.place;
      if (p.at === 'pile' && d.pile.logs[p.slot] !== l) say(`log ${l.id} says pile slot ${p.slot}, slot has ${d.pile.logs[p.slot]?.id}`);
      if (p.at === 'horse' && d.horse.log !== l) say(`log ${l.id} says sawhorse, sawhorse has ${d.horse.log?.id}`);
      if (p.at === 'carried' && d.jobs[p.by]?.carrying !== l) say(`log ${l.id} says carried by ${p.by}, who carries ${d.jobs[p.by]?.carrying?.id}`);
      if (p.at === 'ground' && !(Number.isFinite(p.x) && Number.isFinite(p.z))) say(`log ${l.id} on the ground at NaN`);
    }
    d.pile.logs.forEach((l, i) => {
      if (!l) return;
      if (!d.logs.includes(l)) say(`pile slot ${i} holds a log that no longer exists`);
      // (a slot is reserved the moment a log starts being put down on it)
      else if (!(l.place.at === 'pile' && l.place.slot === i) && !(l.place.at === 'carried' && d.jobs[l.place.by]?.doing === 'dropping')) say(`pile slot ${i} holds log ${l.id}, which says ${JSON.stringify(l.place)}`);
    });
    if (d.horse.log && !d.logs.includes(d.horse.log)) say('the sawhorse holds a log that no longer exists');
    // firewood and its stacks
    const v = d.village;
    for (const pc of v.pieces) {
      const p = pc.place;
      if (p.at === 'stack' && p.stack.items[p.slot] !== pc) say(`piece ${pc.id} says ${p.stack.name} slot ${p.slot}, slot has ${p.stack.items[p.slot]?.id}`);
      if (p.at === 'carried' && !d.jobs[p.by]?.armful.includes(pc)) say(`piece ${pc.id} says carried by ${p.by}, who doesn't have it`);
    }
    for (const st of [v.yard, v.inn]) {
      st.items.forEach((pc, i) => {
        if (!pc) return;
        if (!v.pieces.includes(pc)) say(`${st.name} slot ${i} holds a piece that no longer exists`);
        else if (!(pc.place.at === 'stack' && pc.place.stack === st && pc.place.slot === i) && !(pc.place.at === 'carried' && d.jobs[pc.place.by]?.doing === 'stacking')) say(`${st.name} slot ${i} holds piece ${pc.id}, which says ${pc.place.at}`);
      });
      if (st.incoming < 0 || st.reserved < 0 || st.reserved > st.count) say(`${st.name} stack books off: incoming ${st.incoming}, reserved ${st.reserved}, count ${st.count}`);
    }
    d.jobs.forEach((j, i) => {
      if (j.carrying && !(j.carrying.place.at === 'carried' && j.carrying.place.by === i)) {
        // (handing over: put down on the sawhorse this very step)
        if (!(j.doing === 'loading' || j.doing === 'dropping')) say(`${j.role} carries log ${j.carrying.id}, which says ${JSON.stringify(j.carrying.place)}`);
      }
    });
    // trees
    const felling = d.forest.trees.filter((tr) => tr.state === 'felling');
    if (felling.length > 1) say(`${felling.length} trees being felled at once`);
    for (const tr of d.forest.trees) if (tr.claimedBy >= 0 && d.jobs[tr.claimedBy]?.role !== 'lumberjack') say(`tree ${tr.id} claimed by ${tr.claimedBy}`);
    // people
    d.walkers.forEach((w, i) => {
      if (!Number.isFinite(w.x) || !Number.isFinite(w.z)) say(`person ${i} at NaN`);
      if (Math.hypot(w.x, w.z) > 40) say(`person ${i} wandered off to (${w.x.toFixed(1)}, ${w.z.toFixed(1)})`);
    });
    d.jobs.forEach((j, i) => {
      const [step, at] = since.get(i) ?? ['', 0];
      if (step !== j.doing) since.set(i, [j.doing, s]);
      else if (j.doing !== 'idle' && j.doing !== 'sitting' && s - at > 90) {
        say(`${j.role} stuck in "${j.doing}" for ${s - at}s`);
        since.set(i, [j.doing, s]);
      }
    });
  }
  const d = m.debug();
  return { bad, stats: d.village.stats, wood: { yard: d.village.yard.count, inn: d.village.inn.count }, logs: d.logs.length, pile: d.pile.count, standing: d.forest.trees.filter((t) => t.state === 'standing').length, trees: d.forest.trees.length };
}, Number(seconds));

problems.push(...result.bad);
if (result.stats.felled < 1) problems.push('no tree was felled');
if (result.stats.sawn < 1) problems.push('no log was sawn');
if (result.stats.delivered < 1) problems.push('no firewood reached the inn');
problems.push(...errors);
console.log(`${seconds}s simulated (seed ${seed}): felled ${result.stats.felled}, sawn ${result.stats.sawn}, logs about ${result.logs}, pile ${result.pile}, trees standing ${result.standing}/${result.trees}`);
console.log(`  firewood: delivered ${result.stats.delivered}, burned ${result.stats.burned}, yard ${result.wood.yard}, inn ${result.wood.inn}`);
console.log(problems.length ? `✗ ${problems.length} problem(s):\n  ${problems.join('\n  ')}` : '✓ consistent throughout');
await browser.close();
await server.close();
process.exit(problems.length ? 1 : 0);
