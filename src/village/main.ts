import * as THREE from 'three';
import { Houses, type Site } from '../houses';
import { Stage, lookFromQuery, num, q } from '../stage';
import { Crowd, type CrowdSettings } from '../crowd';
import { WALK_SPEED, defaultGait, newMotion } from '../gait';
import { Animator } from '../animate';
import { Actor } from '../actions';
import { Gaze } from '../gaze';
import GUI from 'lil-gui';
import { PARTS_LAYER } from '../skin';
import { mulberry32 } from '../rng';
import { SHAPE_GENES, randomGenome } from '../genome';
import { buildPerson } from '../body';
import { Forest } from './forest';
import { Basket, Bench, CiderMill, Crate, type Item, KegRack, LOG_L, LOG_R, type Log, Rack, Sawhorse, Spot, Stack, StepLadder, type Store, StreetLamp, Woodpile, makeApple, makeFish, makeKeg, makeLog, makeMeal, makeMug, setDry } from './things';
import { Orchard } from './orchard';
import { Pond } from '../pond';
import { type Chimney, Smoke } from '../smoke';
import { makePiece } from '../firewood';
import { type Obstacle, Walker } from './walk';
import { Fisher, Innkeeper, type Job, Lumberjack, Miller, NIGHT, Picker, Regular, SERVINGS, SUPPER, type Village, Woodworker, phaseAt } from './jobs';
import { InnTable } from './inn';
import { makeLayout } from './layout';

/**
 * The village: a little settlement where people do jobs that feed each
 * other. For now, the firewood chain: a lumberjack fells pines and carries
 * the logs to a woodpile; a woodworker saws them into firewood on a
 * sawhorse, stacks it in the yard, and carries armfuls to the inn, whose
 * kitchen fire burns through it.
 */

const look = lookFromQuery({ time: 8 });
// the village keeps its own clock, on simulation time (so fast-forward runs the day faster too)
look.dayCycle = false;
/** Real seconds per game hour at ×1 (?daymin: minutes per whole day). */
const SEC_PER_HOUR = (num('daymin', 12) * 60) / 24;
/** Evenings run at half speed, so supper has time to be cooked and served. */
const secPerHour = (h: number) => (h >= SUPPER - 0.5 && h < NIGHT + 0.5 ? 2 : 1) * SEC_PER_HOUR;
if (q.has('nogui')) document.getElementById('hint')?.remove();
const stage = new Stage(look);
const settings: CrowdSettings & { seed: number; paused: boolean; speed: number; panel: boolean } = {
  gait: { ...defaultGait },
  personality: 1,
  segments: num('segs', 8),
  eyes: true,
  merge: q.get('merge') !== '0',
  lookAt: 'auto',
  seed: num('seed', 1),
  paused: q.has('paused'),
  speed: num('speed', 1), // simulated seconds per real second
  panel: q.get('panel') !== '0', // who's doing what
};
const crowd = new Crowd(stage, settings);

// ---------------------------------------------------------------- the place

// where everything goes: the seed lays out the whole village (see layout.ts)
const L = makeLayout(settings.seed);
// the lumberjack's cabin (by the forest), the woodworker's, the fisher's (up from
// the pond), the inn (the innkeeper lives in, the regular has a room), the
// picker's and the miller's (past the mill), the other picker's (the far side of the orchard)
const SITES: Site[] = L.sites;
/** Which building each person lives in (index into SITES), by crowd index. */
const HOME = [0, 1, 2, 3, 4, 4, 3, 5];
const houses = new Houses(stage.toon, stage.outline, stage.shadowMat, L.seeds.houses, SITES);
stage.scene.add(houses.group);
// smoke: the inn's kitchen chimney while its fire has wood, thin wisps from the cabins
const smoke = new Smoke();
stage.scene.add(smoke.group);
let innChimney: Chimney | null = null;
for (const b of houses.buildings) {
  if (!b.chimney) continue;
  const c = smoke.add(b.chimney, b.kind === 'inn' ? 1.8 : 0.45, b.kind === 'inn' ? 1.15 : 0.8);
  if (b.kind === 'inn') innChimney = c;
}
const forest = new Forest(stage, L.forest.x, L.forest.z, L.forest.R, 26, L.seeds.forest);
stage.scene.add(forest.group);
// the orchard, and the cider mill between it and the yard
const orchard = new Orchard(stage, L.orchard.x, L.orchard.z, L.orchard.R, 5, L.seeds.orchard);
const mill = new CiderMill(stage, L.mill.x, L.mill.z, L.mill.yaw);
const millKegs = new KegRack(stage, 'mill kegs', L.millKegs.x, L.millKegs.z, L.millKegs.yaw);
// each picker's basket and step-ladder
const baskets = L.baskets.map((b) => new Basket(stage, b.x, b.z));
const ladders = L.ladders.map((l) => new StepLadder(stage, l.x, l.z, l.yaw));
// a good-sized pond, for the fisher
const pond = new Pond(stage.toon, stage.outline, L.pond.x, L.pond.z, L.pond.R, L.seeds.pond);
stage.scene.add(pond.group);

// ---------------------------------------------------------------- people

type Role = 'lumberjack' | 'woodworker' | 'fisher' | 'innkeeper' | 'picker' | 'miller' | 'regular';
// (two pickers, to keep the mill busy)
const ROLES: Role[] = ['lumberjack', 'woodworker', 'fisher', 'innkeeper', 'picker', 'miller', 'regular', 'picker'];
/** What each plays in their spare time. */
const INSTRUMENT: Record<Role, 'fiddle' | 'banjo' | 'bass' | null> = { lumberjack: 'fiddle', woodworker: 'banjo', fisher: null, innkeeper: 'fiddle', picker: 'banjo', miller: 'bass', regular: null };
/** Who smokes a pipe. */
const PIPE: Record<Role, boolean> = { lumberjack: true, woodworker: false, fisher: true, innkeeper: false, picker: false, miller: true, regular: false };
const people = ROLES.map((_, i) => crowd.spawn(randomGenome(settings.seed * 100003 + 17 + i * 5), i));
const r = mulberry32(settings.seed * 31 + 7);
crowd.people = people;
crowd.motions = people.map(() => newMotion(r()));
crowd.anims = people.map((_, i) => new Animator(settings.seed * 977 + i));
crowd.actors = people.map((p) => new Actor(p, crowd.kit));
crowd.gazes = people.map((p, i) => new Gaze(p, i, mulberry32(settings.seed * 4243 + i)));
const iWood = ROLES.indexOf('woodworker');
for (const p of people) p.root.userData.height = p.dims.height;

// the woodworker's own sawhorse, made to their height, and the pile beside it
// furniture is one size for everyone: built to a villager of middling build
// (only ever measured, never drawn), and anyone fits themselves to it
const reference = (() => {
  const g = randomGenome(1);
  for (const k of SHAPE_GENES) g[k] = 0.5;
  return new Actor(buildPerson(g, stage.toon, stage.outline, { segments: 4, eyes: false }), crowd.kit);
})();
const horse = new Sawhorse(stage, L.horse.x, L.horse.z, L.horse.yaw, reference.sawFit({ r: LOG_R, len: LOG_L / 2.05 }));
const pile = new Woodpile(stage, L.pile.x, L.pile.z, L.pile.yaw);
// firewood: a stack in the yard for what's been sawn, and one by the inn's
// kitchen end (beside the chimney) that the inn burns from
const yard = new Stack(stage, 'yard', L.yard.x, L.yard.z, L.yard.yaw);
const innStack = (() => {
  const b = houses.buildings.find((h) => h.kind === 'inn')!;
  const at = new THREE.Vector3(b.half.x + 0.3, 0, 0.75).applyAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
  return new Stack(stage, 'inn', b.x + at.x, b.z + at.z, b.yaw + Math.PI / 2);
})();
// fish: a drying rack between the pond and the inn, and a larder crate by
// the inn's kitchen hatch
const rack = new Rack(stage, 'rack', L.rack.x, L.rack.z, L.rack.yaw);
// the inn's own kegs, out front to the right of the door
const innKegs = new KegRack(stage, 'inn kegs', L.innKegs.x, L.innKegs.z, L.innKegs.yaw, 3);
const larder = (() => {
  const b = houses.buildings.find((h) => h.kind === 'inn')!;
  const at = new THREE.Vector3(0.55, 0, -0.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
  return new Crate(stage, 'larder', b.pickup!.x + at.x, b.pickup!.z + at.z, b.yaw, 8);
})();

const items: Item[] = [];
let nextItemId = 0;
function newItem(kind: Item['kind']): Item {
  const mesh = { wood: () => makePiece(crowd.kit), fish: () => makeFish(stage), apple: () => makeApple(stage), keg: () => makeKeg(stage), mug: () => makeMug(stage), meal: () => makeMeal(stage) }[kind]();
  stage.scene.add(mesh);
  const it: Item = { id: nextItemId++, kind, place: { at: 'horse' }, mesh, dry: 0 };
  items.push(it);
  return it;
}
function removeItem(it: Item) {
  stage.scene.remove(it.mesh);
  items.splice(items.indexOf(it), 1);
}
/** Put every stored (or dropped) item's mesh where its place says (carried ones are the armful's), easing in any that just got there. */
function placeItems() {
  for (const it of items) {
    const pl = it.place;
    let pos: THREE.Vector3, quat: THREE.Quaternion;
    if (pl.at === 'stack') ({ pos, quat } = pl.stack.slotWorld(pl.slot));
    else if (pl.at === 'ground') ({ pos, quat } = pl);
    else continue;
    const tw = it.tween;
    if (tw) {
      // (one that starts later waits where it was: unclamped, the ease shoots off far past its ends)
      const k = Math.max(0, Math.min(1, (simTime - tw.t0) / tw.dur));
      const e = k * k * (3 - 2 * k);
      it.mesh.position.copy(tw.pos).lerp(pos, e);
      it.mesh.position.y += Math.sin(Math.PI * k) * 0.12;
      it.mesh.quaternion.copy(tw.quat).slerp(quat, e);
      if (k >= 1) it.tween = undefined;
    } else {
      it.mesh.position.copy(pos);
      it.mesh.quaternion.copy(quat);
    }
  }
}
// ?wood=n: start with some firewood in the yard; the inn starts with a little
// of everything (?innwood, ?fish: dried fish in the larder; ?rackfish: on the rack)
function stock(st: Store, n: number, kind: Item['kind'] = 'wood', dry = 0) {
  for (const i of st.free(n)) {
    const it = newItem(kind);
    it.dry = dry;
    if (kind === 'fish') setDry(it.mesh, dry >= 1);
    it.place = { at: 'stack', stack: st, slot: i };
    st.items[i] = it;
  }
}
stock(yard, num('wood', 0));
stock(innStack, num('innwood', 3));
stock(larder, num('fish', 2), 'fish', 1);
stock(rack, num('rackfish', 0), 'fish', 0.6);
stock(mill.hopper, num('apples', 0), 'apple');
stock(innKegs, num('kegs', 1), 'keg', SERVINGS);
/** Fish dry on the rack over this many seconds. */
const DRY_TIME = 120;

/** The inn's kitchen fire burns a piece every so often (game hours: the slow evening burns no faster per hour). */
const BURN_EVERY = 1.25;
let burnClock = 0;
// and a bench of their height to sit on between logs, looking over the yard
const bench = new Bench(stage, L.bench.x, L.bench.z, L.bench.yaw, reference.sitFit());
// the innkeeper's, out front of the inn left of the door; the fisher's, looking over the pond
const innBench = (() => {
  const b = houses.buildings.find((h) => h.kind === 'inn')!;
  const at = new THREE.Vector3(-1.7, 0, 2.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
  return new Bench(stage, b.x + at.x, b.z + at.z, b.yaw + 0.15, reference.sitFit());
})();
const pondBench = new Bench(stage, L.pondBench.x, L.pondBench.z, L.pondBench.yaw, reference.sitFit());
// the inn's table, out front to the right of the door, built to the regular
// (who sits at its near end facing out, the table in front of them)
const SEAT = L.tables[0];
const regularDine = reference.choreOf('dine');
const table = regularDine.worldFurniture();
// and a second one just like it in front, so everyone fits at supper
const tables = [
  new InnTable(stage, table.group, table.dims, SEAT.x, SEAT.z, SEAT.yaw, table.box, 0),
  (() => {
    const t2 = regularDine.worldFurniture();
    const T2 = L.tables[1];
    return new InnTable(stage, t2.group, t2.dims, T2.x, T2.z, T2.yaw, t2.box, 4);
  })(),
];
const seats = tables.flatMap((t) => t.seats);
// the street-lamp by the tables, which the innkeeper lights at dusk
const lamp = new StreetLamp(stage, L.lamp.x, L.lamp.z, L.lamp.yaw);
const fromSeat = (x: number, z: number) => new THREE.Vector3(x, 0, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), SEAT.yaw).add(new THREE.Vector3(SEAT.x, 0, SEAT.z));
const tankardSpot = (() => {
  const at = fromSeat(table.tankAt.x, table.tankAt.z).setY(table.tankAt.y);
  // the innkeeper puts it down from the table's free end, on the regular's right
  const stand = fromSeat(table.tankAt.x - 0.55, table.tankAt.z);
  return new Spot(stage, 'tankard', at, SEAT.yaw, { x: stand.x, z: stand.z, yaw: SEAT.yaw + Math.PI / 2 });
})();

const logs: Log[] = [];
let nextLogId = 0;
function newLog(): Log {
  const mesh = makeLog(stage);
  stage.scene.add(mesh);
  const log: Log = { id: nextLogId++, place: { at: 'ground', x: 0, z: 0, yaw: 0 }, mesh, claimedBy: -1 };
  logs.push(log);
  return log;
}
function removeLog(l: Log) {
  stage.scene.remove(l.mesh);
  logs.splice(logs.indexOf(l), 1);
}
// ?logs=n: start with some in the pile
for (let i = 0; i < Math.min(pile.slots.length, num('logs', 0)); i++) {
  const l = newLog();
  l.place = { at: 'pile', slot: i };
  pile.logs[i] = l;
}

const _v = new THREE.Vector3();
/** Put every log's mesh where its place says. */
function placeLogs() {
  for (const l of logs) {
    const m = l.mesh;
    const pl = l.place;
    if (pl.at === 'pile') {
      pile.slotWorld(pl.slot, m.position);
      m.rotation.set(0, pile.yaw, 0);
    } else if (pl.at === 'horse') {
      m.position.copy(horse.logAt);
      m.rotation.set(0, horse.yaw, 0);
    } else if (pl.at === 'ground') {
      m.position.set(pl.x, LOG_R, pl.z);
      m.rotation.set(0, pl.yaw, 0);
    }
  }
}

// ---------------------------------------------------------------- getting about

// everyone starts the day at their own door (the miller and the picker by the mill, the regular by the inn)
const doorOf = (i: number) => {
  const b = houses.buildings[HOME[i]];
  // (two living in one house come and go side by side)
  const twin = HOME.some((h, j) => j < i && h === HOME[i]) ? 0.45 : 0;
  const at = b.door.clone().add(new THREE.Vector3(Math.cos(b.yaw), 0, -Math.sin(b.yaw)).multiplyScalar(twin));
  return { x: at.x, z: at.z, yaw: b.doorFacing };
};
const homes = people.map((_, i) => doorOf(i));
const walkers = people.map((_, i) => new Walker(homes[i].x, homes[i].z, homes[i].yaw + Math.PI));
const houseObstacles: Obstacle[] = houses.buildings.map((b) => ({ kind: 'box', x: b.x, z: b.z, yaw: b.yaw, hx: b.half.x, hz: b.half.z }));
const pileObstacle: Obstacle = { kind: 'box', x: pile.x, z: pile.z, yaw: pile.yaw, hx: LOG_L / 2 + 0.04, hz: 0.22 };
const horseObstacle: Obstacle = (() => {
  const t = horse.fit.trestles;
  const mid = _v.set((t[0].x + t[1].x) / 2, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), horse.yaw);
  return { kind: 'box', x: horse.x + mid.x, z: horse.z + mid.z, yaw: horse.yaw, hx: Math.abs(t[0].x - t[1].x) / 2 + 0.08, hz: 0.2 };
})();
const benchObstacleOf = (b: Bench): Obstacle => {
  const back = _v.set(0, 0, -0.06).applyAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
  return { kind: 'box', x: b.x + back.x, z: b.z + back.z, yaw: b.yaw, hx: 0.55, hz: b.fit.depth / 2 + 0.06 };
};
const benchObstacle = benchObstacleOf(bench);
const innBenchObstacle = benchObstacleOf(innBench);
const pondBenchObstacle = benchObstacleOf(pondBench);
const pondObstacle: Obstacle = { kind: 'radial', x: pond.x, z: pond.z, r: (dx, dz) => pond.edge(dx, dz) + 0.08, maxR: pond.maxR + 0.1 };
const rackObstacle: Obstacle = { kind: 'box', x: rack.x, z: rack.z, yaw: rack.yaw, hx: 0.95, hz: 0.3 };
const larderObstacle: Obstacle = { kind: 'box', x: larder.x, z: larder.z, yaw: larder.yaw, hx: 0.27, hz: 0.2 };
const stackObstacles: Obstacle[] = [yard, innStack].map((st) => ({ kind: 'box', x: st.x, z: st.z, yaw: st.yaw, hx: 0.18, hz: 0.28 }));
const millObstacles: Obstacle[] = [
  ...tables.map((t) => t.obstacle),
  { kind: 'box', x: mill.x, z: mill.z, yaw: mill.yaw, hx: 0.3, hz: 0.27 },
  ...[millKegs, innKegs].map((k): Obstacle => ({ kind: 'box', x: k.x, z: k.z, yaw: k.yaw, hx: 0.17, hz: 0.25 })),
  ...orchard.trees.map((t): Obstacle => ({ kind: 'circle', x: t.x, z: t.z, r: 0.12 })),
];
const lampObstacle: Obstacle = { kind: 'circle', x: lamp.x, z: lamp.z, r: 0.1 };
const treeObstacles = new Map<number, Obstacle>();
/** Everything solid right now. */
function obstacles(): Obstacle[] {
  const out = [...houseObstacles, lampObstacle, pileObstacle, horseObstacle, benchObstacle, innBenchObstacle, pondBenchObstacle, pondObstacle, rackObstacle, larderObstacle, ...stackObstacles, ...millObstacles];
  for (const t of forest.trees) {
    if (t.state === 'felling') continue;
    let o = treeObstacles.get(t.id);
    if (!o) treeObstacles.set(t.id, (o = { kind: 'circle', x: t.x, z: t.z, r: 0 }));
    (o as { r: number }).r = forest.specs[t.variant].rt * t.k * 1.15 + (t.state === 'growing' ? 0.06 : 0.02);
    out.push(o);
  }
  return out;
}
const village: Village = {
  forest,
  pile,
  horse,
  logs,
  newLog,
  removeLog,
  treeObstacle: (t) => treeObstacles.get(t.id) ?? null,
  horseObstacle,
  benches: [
    { bench, obstacle: benchObstacle, owner: iWood },
    { bench: innBench, obstacle: innBenchObstacle, owner: ROLES.indexOf('innkeeper') },
    { bench: pondBench, obstacle: pondBenchObstacle, owner: ROLES.indexOf('fisher') },
  ],
  time: 0,
  yard,
  inn: innStack,
  pond,
  rack,
  larder,
  orchard,
  baskets,
  ladders,
  mill,
  millKegs,
  innKegs,
  dt: 0,
  hours: look.time,
  phase: phaseAt(look.time),
  tables,
  seats,
  hatch: (() => {
    const b = houses.buildings.find((h) => h.kind === 'inn')!;
    const p = b.pickup!;
    const into = new THREE.Vector3(-Math.sin(b.yaw), 0, -Math.cos(b.yaw)); // toward the inn
    return { stand: { x: p.x, z: p.z, yaw: b.doorFacing }, counter: p.clone().addScaledVector(into, 0.42).setY(0.97) };
  })(),
  mealServed: (seat) => {
    const meal = seat.plate.items[0];
    if (meal) {
      seat.plate.items[0] = null;
      removeItem(meal);
    }
    crowd.actors[seat.diner]?.choreOf('dine').serveMeal('fish');
    seat.state = 'served';
    village.stats.meals++;
  },
  cameHome: (i) => {
    litUntil[HOME[i]] = simTime + 1.5 * secPerHour(village.hours); // a lamp lit for an hour and a half
  },
  everyoneFed: () => jobs.every((j, k) => ROLES[k] === 'innkeeper' || j.asleep || j.ateToday),
  lamp,
  greenSpot: (i) => greenSpot(i),
  bandPlaying: () => crowd.actors.some((a) => a.kind === 'fiddle' || a.kind === 'banjo' || a.kind === 'bass'),
  chat: (i, j, seconds) => {
    // (only with someone who's there for it: not asleep, not walking off somewhere)
    if ([i, j].some((k) => jobs[k].asleep || (crowd.actors[k].kind !== 'dine' && crowd.motions[k].speed > 0.1))) return;
    chat(i, j, seconds);
  },
  tankardSpot,
  served: () => {
    const mug = tankardSpot.items[0];
    if (mug) {
      tankardSpot.items[0] = null;
      removeItem(mug);
    }
    crowd.actors[ROLES.indexOf('regular')].choreOf('dine').serve();
  },
  wantsRefill: () => {
    const a = crowd.actors[ROLES.indexOf('regular')];
    return a.kind === 'dine' && a.choreOf('dine').needsRefill;
  },
  items,
  newItem,
  removeItem,
  stats: { felled: 0, sawn: 0, delivered: 0, burned: 0, caught: 0, dried: 0, fishIn: 0, eaten: 0, picked: 0, milled: 0, kegs: 0, kegsIn: 0, poured: 0, drunk: 0, meals: 0, hungry: 0, slept: 0, evening: 0, lamps: 0 },
};
const pickers = ROLES.map((r, k) => (r === 'picker' ? k : -1)).filter((k) => k >= 0);
const jobs: Job[] = people.map((p, i) => {
  const pk = pickers.indexOf(i);
  const gear = pk >= 0 ? { basket: baskets[pk], ladder: ladders[pk] } : undefined;
  const w = { i, actor: crowd.actors[i], walker: walkers[i], root: p.root, instrument: INSTRUMENT[ROLES[i]], pipe: PIPE[ROLES[i]], home: homes[i], gear };
  const J = { lumberjack: Lumberjack, woodworker: Woodworker, fisher: Fisher, innkeeper: Innkeeper, picker: Picker, miller: Miller, regular: Regular }[ROLES[i]];
  return new J(w);
});

// ---------------------------------------------------------------- the green

/**
 * Where each person stands on the green of an evening: the band in an arc
 * on the side toward the tables, facing in; everyone else in the middle,
 * spread out enough to dance.
 */
function greenSpot(i: number) {
  const G = L.green;
  const band = ROLES.map((r, k) => (INSTRUMENT[r] ? k : -1)).filter((k) => k >= 0);
  const k = band.indexOf(i);
  let a: number, r: number;
  if (k >= 0) {
    a = G.yaw + (k - (band.length - 1) / 2) * 0.5;
    r = G.R * 0.9;
  } else {
    const j = ROLES.map((r2, k2) => (INSTRUMENT[r2] ? -1 : k2)).filter((k2) => k2 >= 0).indexOf(i);
    a = G.yaw + Math.PI + (j - 0.5) * 1.4;
    r = 0.45 + 0.25 * (j % 2);
  }
  const x = G.x + Math.sin(a) * r, z = G.z + Math.cos(a) * r;
  // the band faces the middle; dancers face the band
  const facing = k >= 0 ? a + Math.PI : Math.atan2(G.x + Math.sin(G.yaw) * G.R - x, G.z + Math.cos(G.yaw) * G.R - z);
  return { x, z, yaw: facing };
}

// ---------------------------------------------------------------- talk
//
// Chatting: the innkeeper has a word as a plate goes down; diners at the same
// table talk while they wait; two people whose paths cross now and then stop
// for a word before going on.

/** Until when each person has had enough talking for now. */
const chattedUntil = people.map(() => 0);
/** Pairs that have just passed each other (so they're not asked again straight away). */
const metUntil = new Map<number, number>();

function chat(i: number, j: number, seconds: number) {
  crowd.actors[i].chatWith(j, seconds);
  crowd.actors[j].chatWith(i, seconds);
  for (const k of [i, j]) {
    jobs[k].holdUntil = Math.max(jobs[k].holdUntil, simTime + seconds);
    chattedUntil[k] = simTime + seconds + 3 + Math.random() * 5;
  }
}

/** Free to strike up a chat at the table: sat, between mouthfuls, not already talking. */
function idleAtTable(i: number) {
  const a = crowd.actors[i];
  return a.kind === 'dine' && a.choreOf('dine').handsIdle && a.talkingTo < 0 && simTime >= chattedUntil[i];
}

/** Up for a word: about with empty hands, not busy at anything, not just stopped talking. */
function free(i: number) {
  const a = crowd.actors[i];
  const j = jobs[i];
  return !j.asleep && a.kind === null && !a.onSeat && !j.carrying && !j.armful.length && simTime >= chattedUntil[i] && simTime >= j.holdUntil;
}

function talk() {
  // at the tables: pair up whoever is sat there idle
  for (const t of tables) {
    const idle = t.seats.filter((s) => s.diner >= 0 && idleAtTable(s.diner)).map((s) => s.diner);
    if (idle.length < 2 || Math.random() > 0.02) continue;
    const a = idle.splice(Math.floor(Math.random() * idle.length), 1)[0];
    const b = idle[Math.floor(Math.random() * idle.length)];
    chat(a, b, 3 + Math.random() * 4);
  }
  // in passing: by day, two people meeting on their way (each pair only now and then)
  if (village.phase !== 'work') return;
  for (let i = 0; i < people.length; i++) {
    if (!free(i)) continue;
    for (let j = i + 1; j < people.length; j++) {
      // (one of them on their way past the other)
      if (!free(j) || Math.max(crowd.motions[i].speed, crowd.motions[j].speed) < 0.3) continue;
      const wi = walkers[i], wj = walkers[j];
      if (Math.hypot(wi.x - wj.x, wi.z - wj.z) > 1.8) continue;
      const key = i * 100 + j;
      if (simTime < (metUntil.get(key) ?? 0)) continue;
      metUntil.set(key, simTime + 45);
      if (Math.random() < 0.7) chat(i, j, 3.5 + Math.random() * 2);
    }
  }
}

/** Held for a chat: stand and turn to face whoever they're talking to. */
function faceTalker(i: number, dt: number) {
  const to = crowd.actors[i].talkingTo;
  if (to < 0) return;
  const w = walkers[i], o = walkers[to];
  const want = Math.atan2(o.x - w.x, o.z - w.z);
  let err = want - w.yaw;
  err = Math.atan2(Math.sin(err), Math.cos(err));
  const step = 3 * dt;
  w.yaw += Math.max(-step, Math.min(step, err));
}

// ---------------------------------------------------------------- loop

let simTime = 0;
/** Lamps: each house's are lit until then (simulation seconds). */
const litUntil = houses.buildings.map(() => 0);
function simulate(dt: number) {
  simTime += dt;
  village.time = simTime;
  village.dt = dt;
  village.hours = look.time = (village.hours + dt / secPerHour(village.hours)) % 24;
  village.phase = phaseAt(village.hours);
  crowd.beginStep(simTime, null, -1);
  const obs = obstacles();
  people.forEach((p, i) => {
    const pose = crowd.pre(i, dt, simTime);
    const w = walkers[i];
    const a = crowd.actors[i];
    const m = crowd.motions[i];
    jobs[i].tick(village);
    if (jobs[i].holdUntil > simTime && !a.busy) {
      // stopped for a word
      m.targetSpeed = 0;
      faceTalker(i, dt);
    } else m.targetSpeed = a.holdSpeed ? 0 : w.think(dt, obs, walkers, WALK_SPEED * crowd.styleOf(p).speedK);
    crowd.advance(i, dt);
    if (!a.rootLocked) {
      w.move(m.speed, dt, obs, walkers);
      const yaw = w.yaw + (pose?.spin ?? 0);
      const fwd = pose?.fwd ?? 0;
      p.root.position.set(w.x + Math.sin(yaw) * fwd, pose?.lift ?? 0, w.z + Math.cos(yaw) * fwd);
      p.root.rotation.y = yaw;
    }
    crowd.post(i, dt, simTime, pose);
  });
  crowd.endStep(dt);
  talk();
  forest.update(simTime);
  orchard.update(simTime);
  // (the kitchen fire's banked while the inn's shut for the night)
  if (!jobs[ROLES.indexOf('innkeeper')].asleep) burnClock += dt / secPerHour(village.hours);
  if (burnClock >= BURN_EVERY) {
    burnClock -= BURN_EVERY;
    const top = innStack.top(1)[0];
    if (top !== undefined && innStack.available > 0) {
      removeItem(innStack.items[top]!);
      innStack.items[top] = null;
      village.stats.burned++;
    }
  }
  // fish dry on the rack; guests eat dried fish from the larder
  for (const it of items) {
    if (it.kind !== 'fish' || it.place.at !== 'stack' || it.place.stack !== rack || it.dry >= 1) continue;
    it.dry = Math.min(1, it.dry + dt / DRY_TIME);
    if (it.dry >= 1) {
      setDry(it.mesh, true);
      village.stats.dried++;
    }
  }
  placeLogs();
  placeItems();
  // lamps: lit for a while when someone gets home after dark; the inn's while it's open
  const dark = village.hours >= 17.5 || village.hours < 6.5;
  const innOpen = !jobs[ROLES.indexOf('innkeeper')].asleep || seats.some((st) => st.state !== 'free');
  if (dark && innOpen) litUntil[HOME[ROLES.indexOf('innkeeper')]] = Math.max(litUntil[HOME[ROLES.indexOf('innkeeper')]], simTime + 0.75 * secPerHour(village.hours));
  litUntil.forEach((until, i) => {
    const on = dark && until > simTime;
    if (houses.isLit(i) !== on) houses.setLit(i, on);
  });
  // the kitchen fire smokes while there's firewood to burn
  if (innChimney) innChimney.rate = jobs[ROLES.indexOf('innkeeper')].asleep ? 0.12 : innStack.count > 0 ? 1.8 : 0.15;
  smoke.update(dt, stage.toon.uniforms.uTint.value);
}

stage.controls.target.set(num('tx', -2), 0.5, num('tz', -1));
stage.camera.position.add(new THREE.Vector3(num('tx', -2), 0, num('tz', -1)));
if (!q.has('zoom')) {
  stage.camera.zoom = 0.62;
  stage.camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- watching it

const ROLE_ICON: Record<Role, string> = { lumberjack: '🪓', woodworker: '🪚', fisher: '🎣', innkeeper: '🍺', picker: '🍎', miller: '⚙', regular: '🍻' };
const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;left:8px;bottom:30px;padding:6px 9px;background:#000a;color:#e8f4d8;font:12px/1.45 ui-monospace,monospace;white-space:pre;pointer-events:none;border-radius:3px;';
document.body.appendChild(panel);
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
/** Who's doing what, what's in the pile, and the tallies. */
function updatePanel() {
  panel.style.display = settings.panel ? '' : 'none';
  if (!settings.panel) return;
  const rows = jobs.map((j, i) => `${i === follow ? '▸' : ' '} ${ROLE_ICON[ROLES[i]]} ${ROLES[i].padEnd(11)} ${j.doing}${j.carrying ? ' (carrying a log)' : j.armful.length ? ` (${{ wood: 'an armful of firewood', fish: 'an armful of fish', apple: 'apples', keg: 'a keg', mug: 'a tankard of cider', meal: 'a plate of supper' }[j.armful[0].kind]})` : ''}`);
  const loose = logs.filter((l) => l.place.at === 'ground').length;
  const standing = forest.trees.filter((t) => t.state === 'standing').length;
  panel.textContent = [
    ...rows,
    `woodpile ${pile.count}/${pile.slots.length}${pile.incoming ? ` (+${pile.incoming} coming)` : ''} · logs lying about ${loose}`,
    `trees standing ${standing}/${forest.trees.length} · felled ${village.stats.felled} · sawn ${village.stats.sawn}`,
    `firewood: yard ${yard.count}/${yard.slots.length} · inn ${innStack.count}/${innStack.slots.length}${innStack.incoming ? ` (+${innStack.incoming} coming)` : ''} · delivered ${village.stats.delivered} · burned ${village.stats.burned}`,
    `fish: caught ${village.stats.caught} · rack ${rack.count}/${rack.slots.length} (${rack.items.filter((it) => it && it.dry >= 1).length} dry) · larder ${larder.count}/${larder.slots.length}${larder.incoming ? ` (+${larder.incoming} coming)` : ''} · suppers served ${village.stats.meals}`,
    `cider: picked ${village.stats.picked} · baskets ${baskets.map((b) => b.count).join('+')} · hopper ${mill.hopper.count}/${mill.hopper.slots.length} · kegs made ${village.stats.kegs} · at the mill ${millKegs.count} · at the inn ${innKegs.count} (${innKegs.items.reduce((n, k) => n + (k ? k.dry : 0), 0)} tankards) · poured ${village.stats.poured} · sips ${village.stats.drunk}`,
    `${String(Math.floor(village.hours)).padStart(2, '0')}:${String(Math.floor((village.hours % 1) * 60)).padStart(2, '0')} ${{ work: 'working', supper: 'supper at the inn', night: 'night' }[village.phase]} · meals ${village.stats.meals} · time ${clock(simTime)} · speed ×${settings.speed}${settings.paused ? ' (paused)' : ''}`,
  ].join('\n');
}

const gui = new GUI({ title: 'Village' });
if (q.has('nogui')) gui.hide();
gui.add(settings, 'speed', { '×1': 1, '×4': 4, '×16': 16 }).name('speed');
gui.add(settings, 'paused');
gui.add(settings, 'panel').name("who's doing what");
gui.add(look, 'time', 0, 24, 0.05).name('time of day (h)').decimals(2).listen().onChange((h: number) => (village.hours = h));
gui.add(look, 'stats').name('show fps');
gui.add({ none: () => (follow = -1) }, 'none').name('stop following');

// click someone to follow them
const ray = new THREE.Raycaster();
ray.layers.enable(PARTS_LAYER);
let downAt: [number, number] | null = null;
stage.renderer.domElement.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
stage.renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  ray.setFromCamera(new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1), stage.camera);
  const hit = ray.intersectObjects(people.map((p) => p.root), true)[0];
  let o: THREE.Object3D | null = hit?.object ?? null;
  while (o && o.userData.index === undefined) o = o.parent;
  follow = o ? o.userData.index : -1;
});
window.addEventListener('keydown', (e) => {
  if (e.key === ' ') settings.paused = !settings.paused;
  if (e.key === 'f' || e.key === 'F') settings.speed = settings.speed === 1 ? 4 : settings.speed === 4 ? 16 : 1;
  if (e.key === 'Escape') follow = -1;
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
});

/** ?follow=i: keep person i in the middle of the view. */
let follow = q.has('follow') ? num('follow', 0) : -1;
function focusOn(i: number, k: number) {
  const p = people[i];
  if (!p) return;
  const c = stage.controls;
  const off = stage.camera.position.clone().sub(c.target);
  c.target.lerp(new THREE.Vector3(p.root.position.x, p.dims.height * 0.5, p.root.position.z), k);
  stage.camera.position.copy(c.target).add(off);
}

let frames = 0;
function frame(start: number) {
  const dt = stage.delta();
  crowd.frameTick();
  if (!settings.paused) {
    // fast-forward in whole steps no longer than 1/30 s, so jobs and physics behave the same at any speed
    const total = dt * settings.speed;
    const n = Math.max(1, Math.ceil(total / (1 / 30)));
    for (let k = 0; k < n; k++) simulate(total / n);
  }
  crowd.sweep();
  if (follow >= 0) focusOn(follow, frames === 0 ? 1 : 1 - Math.exp(-dt * 4));
  stage.controls.update();
  stage.updateLight(dt, settings.paused);
  crowd.orientShadows();
  forest.orientShadows();
  orchard.orientShadows(stage);
  houses.updateShadows(stage.lightWorld, look.shadowLength);
  pond.update(simTime);
  stage.updateEnvironment(dt, 14);
  stage.render(start, people.length);
  if (frames % 6 === 0) updatePanel();
  if (++frames === 2) (window as any).__mini = { ready: true, renderer: stage.renderer, camera: stage.camera, people, debug: () => ({ actors: crowd.actors, motions: crowd.motions, walkers, logs, pile, horse, forest, jobs, village }), follow: (i: number) => (follow = i), step: (sec: number) => { for (let i = 0, n = Math.round(sec * 30); i < n; i++) simulate(1 / 30); }, get time() { return simTime; } };
}

stage.resize();
for (let i = 0, n = Math.round(num('t', 0) * 60); i < n; i++) simulate(1 / 60);
simulate(0);
stage.run(frame);
