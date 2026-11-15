// Headless check of the village's woodcutting chain: runs it for a while in
// fixed steps and checks, every simulated second, that the world stays
// consistent and work keeps getting done.
//
//   node scripts/village-test.mjs [seconds=600] [seed=1] [rng=n] [more address arguments…]
//
// Runs are repeatable: Math.random is seeded (by rng=, else the village's
// seed) and started afresh just before the simulated day, so the same
// arguments give the same day every time. A different rng= is a different
// day in the same village.
//
// Invariants:
//   - every log and piece of firewood is in exactly one place, and the
//     containers agree with it (pile, stacks, sawhorse, whoever carries it);
//     every store's booked room and spoken-for things are exactly what
//     people hold against it, and nobody leaks a booking
//   - at most one tree is being felled; claimed trees are claimed by a lumberjack
//   - nothing dropped (after a trip) lies about for more than 45 s, and a
//     dropped log stays claimed only by whoever's coming back for it
//   - nobody stays in the same step for more than 90 s (waiting about,
//     sitting on a bench, playing, smoking, waiting for supper, at the dance and sleeping don't
//     count; nor does the regular)
//   - over a whole day (900 s from 08:00): suppers served, the lamp lit,
//     music and dancing on the green, everyone in bed, and everyone up
//     again in the morning
//   - positions are finite (the dog's too, and it stays about); over a
//     whole day the dog is with its owner, begs at supper and sleeps
//   - by the end, trees have been felled, logs sawn, firewood delivered, fish
//     caught, and (given time to dry) dried fish brought to the larder; apples
//     picked, (given time) cider made, and the regular served
import { open } from './harness.mjs';

// (any further arguments are added to the address: e.g. trip=40 for forty times the trips)
const [seconds = '600', seed = '1', ...rest] = process.argv.slice(2);
const rng = Number(rest.find((a) => a.startsWith('rng='))?.slice(4) ?? seed);
const extra = rest.filter((a) => !a.startsWith('rng='));
const { page, errors, url, ready, close } = await open({ viewport: { width: 320, height: 240 }, seeded: rng * 7919 + 1 });
await page.goto(url(['paused&nogui', `seed=${seed}`, ...extra].join('&'), 'index.html'));
await ready();

const problems = [];
const result = await page.evaluate(([secs, rng]) => {
  // (the frames drawn so far drew randoms too, however many there were: start again)
  window.__reseed(rng * 7919 + 1);
  const m = window.__mini;
  const bad = [];
  const since = new Map(); // job index → [step, since]
  const dogDid = new Set(); // what the dog got up to
  const lying = new Map(); // item → since when it's been on the ground
  const winds = new Set(); // how windy it got, in words
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
    // the sawhorse is claimed only by a woodworker in the middle of sawing a log
    const sawing = ['to pile', 'lifting', 'to sawhorse', 'loading', 'sawing', 'tripped', 'picking up'];
    if (d.horse.claimedBy >= 0 && !(d.jobs[d.horse.claimedBy]?.role === 'woodworker' && sawing.includes(d.jobs[d.horse.claimedBy].doing))) say(`the sawhorse is claimed by ${d.horse.claimedBy}, who's "${d.jobs[d.horse.claimedBy]?.doing}"`);
    if (d.horse.log && d.horse.claimedBy < 0) say('a log on the sawhorse that nobody has claimed');
    // items (firewood, fish) and the stores they're kept in
    const v = d.village;
    // nothing dropped stays dropped: whoever tripped picks it up again
    for (const pc of v.items) {
      if (pc.place.at !== 'ground') {
        lying.delete(pc);
        continue;
      }
      if (!lying.has(pc)) lying.set(pc, s);
      else if (s - lying.get(pc) > 45) {
        say(`a ${pc.kind} (${pc.id}) has been lying on the ground for ${s - lying.get(pc)}s`);
        lying.set(pc, s);
      }
    }
    for (const l of d.logs) {
      if (l.place.at === 'ground' && l.claimedBy >= 0 && d.jobs[l.claimedBy]?.doing !== 'tripped' && d.jobs[l.claimedBy]?.doing !== 'picking up' && d.jobs[l.claimedBy]?.doing !== 'to log')
        say(`log ${l.id} lies claimed by ${l.claimedBy}, who's "${d.jobs[l.claimedBy]?.doing}"`);
    }
    for (const pc of v.items) {
      const p = pc.place;
      if (p.at === 'stack' && p.stack.items[p.slot] !== pc) say(`piece ${pc.id} says ${p.stack.name} slot ${p.slot}, slot has ${p.stack.items[p.slot]?.id}`);
      if (p.at === 'carried' && !d.jobs[p.by]?.armful.includes(pc)) say(`piece ${pc.id} says carried by ${p.by}, who doesn't have it`);
    }
    for (const st of d.stores) {
      st.items.forEach((pc, i) => {
        if (!pc) return;
        if (!v.items.includes(pc)) say(`${st.name} slot ${i} holds a piece that no longer exists`);
        else if (!(pc.place.at === 'stack' && pc.place.stack === st && pc.place.slot === i) && !(pc.place.at === 'carried' && d.jobs[pc.place.by]?.doing === 'stacking')) say(`${st.name} slot ${i} holds piece ${pc.id}, which says ${pc.place.at}`);
      });
      if (st.incoming < 0 || st.reserved < 0 || st.reserved > st.count) say(`${st.name} stack books off: incoming ${st.incoming}, reserved ${st.reserved}, count ${st.count}`);
    }
    // bookings: every store's booked room and spoken-for things are exactly what people hold against it
    for (const st of [...d.stores, d.pile]) {
      for (const kind of ['incoming', 'reserved']) {
        const held = d.jobs.reduce((n, j) => n + j.bookings.filter((b) => b.store === st && b.kind === kind).reduce((m, b) => m + b.n, 0), 0);
        if (st[kind] !== held) say(`the ${st.name}'s ${kind} is ${st[kind]}, but people hold ${held}`);
      }
    }
    d.jobs.forEach((j) => {
      for (const l of j.leaked.splice(0)) say(`booking leak: ${l}`);
    });
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
    // the dog
    const dw = d.dog.walker;
    if (!Number.isFinite(dw.x) || !Number.isFinite(dw.z)) say('the dog at NaN');
    if (Math.hypot(dw.x, dw.z) > 40) say(`the dog wandered off to (${dw.x.toFixed(1)}, ${dw.z.toFixed(1)})`);
    dogDid.add(d.dog.doing);
    winds.add(d.village.wind.words);
    d.jobs.forEach((j, i) => {
      const [step, at] = since.get(i) ?? ['', 0];
      if (step !== j.doing) since.set(i, [j.doing, s]);
      else if (!d.linger.has(j.doing) && j.role !== 'regular' && s - at > 90) {
        const w = d.walkers[i], g = w.goal, a = d.actors[i];
        say(`${j.role} stuck in "${j.doing}" for ${s - at}s: at (${w.x.toFixed(2)}, ${w.z.toFixed(2)})${g ? ` heading for (${g.x.toFixed(2)}, ${g.z.toFixed(2)})${g.via ? ' via' : ''}${g.ignore ? ' ignoring one' : ''}` : ''}, speed ${d.motions[i].speed.toFixed(2)}, doing ${a.kind ?? 'nothing'}${Number.isFinite(j.trippedAt) ? `, tripped ${Math.round(m.time - j.trippedAt)}s ago` : ''}`);
        since.set(i, [j.doing, s]);
      }
    });
  }
  const d = m.debug();
  return { bad, dogDid: [...dogDid], asleep: d.jobs.filter((j) => j.asleep).length, hours: d.village.hours, stats: d.village.stats, wood: { yard: d.village.yard.count, inn: d.village.inn.count, rack: d.village.rack.count, larder: d.village.larder.count }, logs: d.logs.length, pile: d.pile.count, standing: d.forest.trees.filter((t) => t.state === 'standing').length, trees: d.forest.trees.length, kegs: d.village.items.filter((it) => it.kind === 'keg').length, kegsMax: d.kegsMax, day: d.village.day, winds: [...winds], fromTemplate: d.fromTemplate };
}, [Number(seconds), rng]);

problems.push(...result.bad);
if (result.fromTemplate) problems.push(`no layout fitted for seed ${seed}: this is the template village`);
if (result.stats.felled < 1) problems.push('no tree was felled');
if (result.stats.sawn < 1) problems.push('no log was sawn');
if (result.stats.delivered < 1) problems.push('no firewood reached the inn');
if (result.stats.caught < 1) problems.push('no fish were caught');
if (Number(seconds) >= 400 && result.stats.fishIn < 1) problems.push('no dried fish reached the larder');
if (result.stats.picked < 1) problems.push('no apples were picked');
if (Number(seconds) >= 400 && result.stats.kegs < 1) problems.push('no cider was made');
if (result.stats.poured < 1) problems.push('nobody was served cider');
if (result.stats.kegsBack < 1) problems.push('the cooper fetched no empty keg back from the inn');
if (result.stats.hooped < 1) problems.push('the cooper hooped no keg');
// (kegs: only ever reused, made by the cooper, or on their way: never made from nothing, never more than allowed)
if (result.kegs > result.kegsMax) problems.push(`${result.kegs} kegs in the village, more than ${result.kegsMax}`);
if (result.kegs !== result.stats.kegsMade + 2) problems.push(`${result.kegs} kegs, but 2 to start with and ${result.stats.kegsMade} made`);
if (Number(seconds) >= 900) {
  // a whole day: supper, bed, and up again
  if (result.day !== 2) problems.push(`it's day ${result.day} after a day and a night (should be 2)`);
  if (result.stats.meals < 4) problems.push(`only ${result.stats.meals} suppers served`);
  if (result.stats.slept < 8) problems.push(`only ${result.stats.slept} went to bed`);
  for (const s of ['with its owner', 'begging', 'asleep']) if (!result.dogDid.includes(s)) problems.push(`the dog was never ${s}`);
  if (result.stats.lamps < 1) problems.push('nobody lit the lamp');
  if (result.stats.evening < 6) problems.push(`only ${result.stats.evening} tunes and dances on the green`);
  if (result.asleep > 0) problems.push(`${result.asleep} still asleep in the morning`);
}
problems.push(...errors);
console.log(`${seconds}s simulated (seed ${seed}, rng ${rng}): felled ${result.stats.felled}, sawn ${result.stats.sawn}, logs about ${result.logs}, pile ${result.pile}, trees standing ${result.standing}/${result.trees}`);
console.log(`  firewood: delivered ${result.stats.delivered}, burned ${result.stats.burned}, yard ${result.wood.yard}, inn ${result.wood.inn}`);
console.log(`  evening: suppers ${result.stats.meals}, went hungry ${result.stats.hungry}, tunes and dances ${result.stats.evening}, lamp lit ${result.stats.lamps}, went to bed ${result.stats.slept}; it's ${Math.floor(result.hours)}:${String(Math.floor((result.hours % 1) * 60)).padStart(2, '0')}`);
console.log(`  cider: picked ${result.stats.picked}, milled ${result.stats.milled}, kegs ${result.stats.kegs}, to the inn ${result.stats.kegsIn}, poured ${result.stats.poured}, sips ${result.stats.drunk}`);
console.log(`  day ${result.day} now; the wind was ${result.winds.join(', ')}`);
console.log(`  trips: ${result.stats.trips}, picked up again ${result.stats.pickedUp}`);
console.log(`  cooper: shaved ${result.stats.shaved}, kegs made ${result.stats.kegsMade}, brought back ${result.stats.kegsBack}, hooped ${result.stats.hooped}; ${result.kegs} kegs in all`);
console.log(`  fish: caught ${result.stats.caught}, dried ${result.stats.dried}, to the larder ${result.stats.fishIn}, eaten ${result.stats.eaten}, rack ${result.wood.rack}, larder ${result.wood.larder}`);
console.log(problems.length ? `✗ ${problems.length} problem(s):\n  ${problems.join('\n  ')}` : '✓ consistent throughout');
await close();
process.exit(problems.length ? 1 : 0);
