import * as THREE from 'three';
import { Houses, type Site } from '../houses';
import { Stage, lookFromQuery, num, q } from '../stage';
import { Crowd, type CrowdSettings } from '../crowd';
import { WALK_SPEED, defaultGait, newMotion } from '../gait';
import { Animator } from '../animate';
import { Actor, kindIs } from '../actions';
import { Gaze } from '../gaze';
import GUI from 'lil-gui';
import { PARTS_LAYER } from '../skin';
import { mulberry32 } from '../rng';
import { SHAPE_GENES, randomGenome } from '../genome';
import { buildPerson } from '../body';
import { Forest } from './forest';
import { Basket, Bench, CiderMill, Crate, Flag, HoopBlock, type Item, KegRack, ShavingHorse, LOG_L, LOG_R, type Log, Rack, Sawhorse, Spot, Stack, StepLadder, type Store, StreetLamp, Woodpile, makeApple, makeFish, makeKeg, makeLog, BreadOven, BreadShelf, makeFlour, makeLoaf, makeMeal, makeMug, makeSheaf, SackRack, setDry, Stook, ThreshingFloor, Trough } from './things';
import { Wind } from './wind';
import { Field } from './field';
import { Windmill } from './windmill';
import { ROWS } from '../palette';
import { Orchard } from './orchard';
import { Pond } from '../pond';
import { type Chimney, Smoke } from '../smoke';
import { makePiece } from '../firewood';
import { nearest, type Obstacle, Walker } from './walk';
import { Baker, Cooper, Farmer, Fisher, Innkeeper, type Job, KEGS_MAX, Lumberjack, CiderMaker, NIGHT, Picker, Regular, SERVINGS, SUPPER, type Village, Woodworker, phaseAt, LINGER, STOOD_ABOUT, type StepKind } from './jobs';
import { InnTable } from './inn';
import { makeLayout } from './layout';
import { type AppHooks, runApp } from '../app';
import { VillageDog } from './dog';
import { buildDog, randomCat, randomDog } from '../quadruped';
import { type CatSpot, VillageCat } from './cat';

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
// a village of your own: with no ?seed, draw one at random and put it in the
// address, so a reload, a bookmark or a shared link brings back the same village
if (!q.has('seed')) {
  q.set('seed', String(1 + Math.floor(Math.random() * 999999)));
  history.replaceState(history.state, '', `${location.pathname}?${q}${location.hash}`);
}
const settings: CrowdSettings & { seed: number; paused: boolean; speed: number; panel: boolean } = {
  gait: { ...defaultGait },
  personality: 1,
  lookAt: 'auto',
  seed: num('seed', 1),
  paused: q.has('paused'),
  speed: num('speed', 1), // simulated seconds per real second
  panel: q.get('panel') === '1', // who's doing what (off unless asked for)
};
const crowd = new Crowd(stage, settings);

// ---------------------------------------------------------------- the place

// where everything goes: the seed lays out the whole village (see layout.ts)
const L = makeLayout(settings.seed);
// and the land round about, its hills and mountains, from the same seed
stage.backdrop.build(settings.seed);
// the lumberjack's cabin (by the forest), the woodworker's, the fisher's (up from
// the pond), the inn (the innkeeper lives in, the regular has a room), the
// picker's and the cider maker's (past the cider mill), the other picker's (the far side of the orchard)
const SITES: Site[] = L.sites;

type Role = 'lumberjack' | 'woodworker' | 'fisher' | 'innkeeper' | 'picker' | 'cidermaker' | 'regular' | 'cooper' | 'farmer' | 'baker';
/**
 * Who lives here: each one's job, which building is their home (index into
 * SITES), which picker's basket and ladder are theirs, and what they're
 * called on the panel. (Their place in this list is who they are: the
 * seed's genomes, instruments and the dog's owner go by it.)
 */
const VILLAGERS: { role: Role; home: number; name: string; gear?: number }[] = [
  { role: 'lumberjack', home: 0, name: 'lumberjack' },
  { role: 'woodworker', home: 1, name: 'woodworker' },
  { role: 'fisher', home: 2, name: 'fisher' },
  { role: 'innkeeper', home: 3, name: 'innkeeper' }, // (the innkeeper lives in, and the regular has a room)
  { role: 'picker', home: 4, name: 'picker', gear: 0 },
  { role: 'cidermaker', home: 4, name: 'cider maker' },
  { role: 'regular', home: 3, name: 'regular' },
  { role: 'picker', home: 5, name: 'picker 2', gear: 1 }, // (two pickers, to keep the mill busy)
  { role: 'cooper', home: 1, name: 'cooper' }, // (lives with the woodworker)
  { role: 'woodworker', home: 0, name: 'woodworker 2' }, // (lodges with the lumberjack: one woodworker couldn't saw all the logs)
  { role: 'farmer', home: 6, name: 'farmer' }, // (in the cabin by the field)
  { role: 'baker', home: 7, name: 'baker' }, // (in the cabin by the bakery)
  { role: 'lumberjack', home: 2, name: 'lumberjack 2' }, // (lodges with the fisher: three users of firewood now)
  { role: 'innkeeper', home: 3, name: 'innkeeper 2' }, // (lives in: one couldn't serve twelve at supper and still play)
];
const ROLES = VILLAGERS.map((v) => v.role);
/** Which building each person lives in (index into SITES). */
const HOME = VILLAGERS.map((v) => v.home);
/** The ones the village has to ask after. */
const INNKEEPER = ROLES.indexOf('innkeeper');
const REGULAR = ROLES.indexOf('regular');
const WOODWORKER = ROLES.indexOf('woodworker');
const FISHER = ROLES.indexOf('fisher');
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
// (the bakery's oven gets its chimney once it's built: see below)
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

type Instrument = 'fiddle' | 'banjo' | 'bass';
/**
 * Who plays what in their spare time, and who smokes a pipe: the seed's
 * deal, not the job's. Always a band: one double bass (never two), one or
 * two fiddles, one or two banjos; the rest dance. (Their own random stream,
 * so the village and its people look the same as before for a seed.)
 */
const { INSTRUMENT, PIPE } = (() => {
  const r = mulberry32(settings.seed * 6007 + 29);
  const band: Instrument[] = ['bass', 'fiddle', 'banjo'];
  if (r() < 0.5) band.push('fiddle');
  if (r() < 0.5) band.push('banjo');
  const who = ROLES.map((_, i) => i);
  for (let i = who.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [who[i], who[j]] = [who[j], who[i]];
  }
  const INSTRUMENT: (Instrument | null)[] = ROLES.map(() => null);
  band.forEach((inst, k) => (INSTRUMENT[who[k]] = inst));
  const PIPE = ROLES.map(() => r() < 0.4);
  return { INSTRUMENT, PIPE };
})();
const people = ROLES.map((_, i) => crowd.spawn(randomGenome(settings.seed * 100003 + 17 + i * 5), i));
const r = mulberry32(settings.seed * 31 + 7);
crowd.people = people;
crowd.motions = people.map(() => newMotion(r()));
crowd.anims = people.map((_, i) => new Animator(settings.seed * 977 + i));
crowd.actors = people.map((p) => new Actor(p, crowd.kit));
crowd.gazes = people.map((p, i) => new Gaze(p, i, mulberry32(settings.seed * 4243 + i)));
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
// the inn's bread basket, on the other side of the hatch from the larder
const innBread = (() => {
  const b = houses.buildings.find((h) => h.kind === 'inn')!;
  const at = new THREE.Vector3(-0.55, 0, -0.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
  return new Crate(stage, 'bread basket', b.pickup!.x + at.x, b.pickup!.z + at.z, b.yaw, 8);
})();
// the bakery: the oven (its mouth toward the bakery's +z), the trough and the shelf either side in front, the flour and the firewood behind
const bakery = (() => {
  const B = L.bakery;
  const at = (x: number, z: number) => new THREE.Vector3(x, 0, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), B.yaw).add(new THREE.Vector3(B.x, 0, B.z));
  const tr = at(-1.15, 0.75), sh = at(1.15, 0.75), fl = at(-1.1, -0.45), wd = at(1.1, -0.45);
  return {
    oven: new BreadOven(stage, B.x, B.z, B.yaw),
    trough: new Trough(stage, tr.x, tr.z, B.yaw),
    shelf: new BreadShelf(stage, 'bread shelf', sh.x, sh.z, B.yaw),
    flour: new SackRack(stage, 'flour bin', fl.x, fl.z, B.yaw + Math.PI / 2, 2),
    wood: new Stack(stage, 'oven wood', wd.x, wd.z, B.yaw + Math.PI / 2, 1, 4),
  };
})();
const ovenSmoke = smoke.add(bakery.oven.chimney, 0, 1.1);

const items: Item[] = [];
let nextItemId = 0;
function newItem(kind: Item['kind']): Item {
  const mesh = { wood: () => makePiece(crowd.kit), fish: () => makeFish(stage), apple: () => makeApple(stage), keg: () => makeKeg(stage), mug: () => makeMug(stage), meal: () => makeMeal(stage), sheaf: () => makeSheaf(stage), flour: () => makeFlour(stage), bread: () => makeLoaf(stage) }[kind]();
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
stock(larder, num('fish', 3), 'fish', 1); // (one each for the first few suppers: nine mouths)
// the bakery starts with flour for two batches and wood for one firing (so there's bread whatever the wind)
stock(bakery.flour, num('flour', 2), 'flour');
stock(bakery.wood, num('ovenwood', 2));
stock(rack, num('rackfish', 0), 'fish', 0.6);
stock(mill.hopper, num('apples', 0), 'apple');
stock(innKegs, num('kegs', 1), 'keg', SERVINGS);
// and one the inn's drunk dry, waiting for the cooper to fetch back
stock(innKegs, num('emptykegs', 1), 'keg', 0);
/** Fish dry on the rack over this many seconds. */
const DRY_TIME = 120;

/** The inn's kitchen fire burns a piece every so often (game hours: the slow evening burns no faster per hour). */
const BURN_EVERY = 1.25;
let burnClock = 0;
// the cooperage, between the woodworker's and the yard (its local +z toward the yard):
// the shaving horse and the block side by side, firewood for staves and the empty kegs behind
const cooperage = (() => {
  const C = L.cooperage;
  const at = (x: number, z: number) => new THREE.Vector3(x, 0, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), C.yaw).add(new THREE.Vector3(C.x, 0, C.z));
  const h = at(-0.8, 0.15), b = at(0.75, 0.2), st = at(-0.7, -0.85), k = at(0.7, -0.85);
  const shaving = new ShavingHorse(stage, h.x, h.z, C.yaw + Math.PI / 2, reference.sitFit());
  const mid = at(-0.8 + 0.2, 0.15); // (the plank runs along local x from the seat)
  return {
    horse: shaving,
    horseObstacle: { kind: 'box', x: mid.x, z: mid.z, yaw: shaving.yaw, hx: 0.12, hz: 0.45 } as Obstacle,
    block: new HoopBlock(stage, 'block', b.x, b.z, C.yaw),
    staves: new Stack(stage, 'staves', st.x, st.z, C.yaw, 1, 3),
    empties: new KegRack(stage, 'cooper kegs', k.x, k.z, C.yaw + Math.PI / 2, 3),
  };
})();
// where a keg stands under the cider mill's spout to fill
const spout = (() => {
  const sp = mill.spout();
  return new Spot(stage, 'spout', sp.pos, mill.yaw, mill.frontSpot());
})();
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
  ...[1, 2].map((k) => {
    const t2 = regularDine.worldFurniture();
    const T = L.tables[k];
    return new InnTable(stage, t2.group, t2.dims, T.x, T.z, T.yaw, t2.box, 4 * k);
  }),
];
// the wheat field (strips along its yaw) and the stook by it
const field = new Field(stage, L.field.x, L.field.z, L.field.yaw, 6, 5, 4.8, L.seeds.orchard + 11);
const stook = new Stook(stage, 'stook', L.stook.x, L.stook.z, L.stook.yaw);
// with sheaves in it from yesterday's mowing (the mill only grinds in working hours: something to thresh first thing)
stock(stook, num('sheaves', 4), 'sheaf');
// the windmill, with its threshing floor and sack rack on the ground beside it (they don't turn with it)
const windmill = new Windmill(stage, L.windmill.x, L.windmill.z, L.windmill.yaw);
const nearMill = (x: number, z: number) => new THREE.Vector3(x, 0, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), L.windmill.yaw).add(new THREE.Vector3(L.windmill.x, 0, L.windmill.z));
const floorAt = nearMill(-1.75, -1.1), sacksAt = nearMill(1.7, -1.2);
const threshingFloor = new ThreshingFloor(stage, 'threshing floor', floorAt.x, floorAt.z, L.windmill.yaw + Math.PI);
const sackRack = new SackRack(stage, 'sacks', sacksAt.x, sacksAt.z, L.windmill.yaw + Math.PI);
// the wind, and two flags by the inn to show it
const wind = new Wind(settings.seed, q.has('wind') ? num('wind', 0.5) : null);
const flags = L.flags.map((f, k) => new Flag(stage, f.x, f.z, k ? [ROWS.cloud[0], ROWS.cloud[0]] : [ROWS.shirt[0], ROWS.shirt[0]])); // (a red one and a white one)
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

// everyone starts the day at their own door (the cider maker and the picker by the mill, the regular by the inn)
const doorOf = (i: number) => {
  const b = houses.buildings[HOME[i]];
  // (two living in one house come and go side by side)
  const twin = HOME.some((h, j) => j < i && h === HOME[i]) ? 0.45 : 0;
  const at = b.door.clone().add(new THREE.Vector3(Math.cos(b.yaw), 0, -Math.sin(b.yaw)).multiplyScalar(twin));
  return { x: at.x, z: at.z, yaw: b.doorFacing };
};
const homes = people.map((_, i) => doorOf(i));
const walkers = people.map((_, i) => new Walker(homes[i].x, homes[i].z, homes[i].yaw + Math.PI));

// ---------------------------------------------------------------- the dog

// one dog, the seed's own, belonging to one of the villagers (starting at their door)
const DOG_OWNER = Math.floor(mulberry32(settings.seed * 4801 + 3)() * people.length);
const dog = (() => {
  const body = buildDog(randomDog(settings.seed), stage.toon, stage.outline, { skin: stage.skinMats });
  const c = stage.makeCaster(body.dims.bodyLen * 0.9, body.height);
  body.root.add(c.pivot);
  body.root.userData.shadow = c;
  stage.scene.add(body.root);
  const h = homes[DOG_OWNER];
  return new VillageDog(body, h.x + Math.cos(h.yaw) * 0.6, h.z - Math.sin(h.yaw) * 0.6, h.yaw);
})();
/** The dog's footfalls: a person's step, as light as it gets. */
const DOG_PAWS = { f0: 300, formant: 1.6, rate: 1, weight: 0 };
/** The village cat: nobody's; it sleeps by the inn's door (the side the dog doesn't). */
const catBed = (() => {
  const h = homes[INNKEEPER];
  return { x: h.x - Math.cos(h.yaw) * 0.7 + Math.sin(h.yaw) * 0.3, z: h.z + Math.sin(h.yaw) * 0.7 + Math.cos(h.yaw) * 0.3, yaw: h.yaw };
})();
const cat = (() => {
  const body = buildDog(randomCat(settings.seed), stage.toon, stage.outline, { skin: stage.skinMats });
  const c = stage.makeCaster(body.dims.bodyLen * 0.8, body.height);
  body.root.add(c.pivot);
  body.root.userData.shadow = c;
  stage.scene.add(body.root);
  return new VillageCat(body, catBed.x, catBed.z, catBed.yaw);
})();
const CAT_PAWS = { f0: 340, formant: 1.7, rate: 1, weight: 0 };
/** Its favourite spots: where it sits, grooms, loafs and naps; where it stalks (the pond's edge, the fish rack); the oven when it's warm. */
const catSpots: CatSpot[] = (() => {
  const toward = (x: number, z: number, d: number) => {
    const l = Math.hypot(x, z) || 1;
    return { x: x - (x / l) * d, z: z - (z / l) * d };
  };
  return [
    { x: L.pile.x, z: L.pile.z },
    { x: L.green.x, z: L.green.z },
    { x: L.bench.x, z: L.bench.z },
    { x: L.pondBench.x, z: L.pondBench.z },
    { x: L.stook.x, z: L.stook.z },
    { ...toward(L.pond.x, L.pond.z, L.pond.R + 0.5), hunt: true },
    { x: L.rack.x, z: L.rack.z, hunt: true },
    { x: L.bakery.x, z: L.bakery.z, warm: () => bakery.oven.heat > 0.3 },
  ];
})();
/** Everyone's walkers, the dog's and the cat's too: so they keep out of each other's way. */
const allWalkers = [...walkers, dog.walker, cat.walker];
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
const cooperObstacles: Obstacle[] = [
  cooperage.horseObstacle,
  { kind: 'circle', x: cooperage.block.x, z: cooperage.block.z, r: 0.17 },
  { kind: 'circle', x: stook.x, z: stook.z, r: 0.22 },
  { kind: 'circle', x: windmill.x, z: windmill.z, r: 0.85 },
  { kind: 'box', x: bakery.oven.x, z: bakery.oven.z, yaw: bakery.oven.yaw, hx: 0.55, hz: 0.52 },
  { kind: 'box', x: bakery.trough.x, z: bakery.trough.z, yaw: bakery.trough.yaw, hx: 0.36, hz: 0.22 },
  ...[bakery.shelf, bakery.flour, bakery.wood, innBread].map((st): Obstacle => ({ kind: 'box', x: st.x, z: st.z, yaw: st.yaw, hx: 0.3, hz: 0.2 })),
  { kind: 'box', x: threshingFloor.x, z: threshingFloor.z, yaw: threshingFloor.yaw, hx: 0.5, hz: 0.48 },
  { kind: 'box', x: sackRack.x, z: sackRack.z, yaw: sackRack.yaw, hx: 0.38, hz: 0.27 },
  { kind: 'box', x: cooperage.staves.x, z: cooperage.staves.z, yaw: cooperage.staves.yaw, hx: 0.18, hz: 0.2 },
  { kind: 'box', x: cooperage.empties.x, z: cooperage.empties.z, yaw: cooperage.empties.yaw, hx: 0.17, hz: 0.25 },
];
const treeObstacles = new Map<number, Obstacle>();
/** Everything solid right now. */
function obstacles(): Obstacle[] {
  const out = [...houseObstacles, lampObstacle, pileObstacle, horseObstacle, benchObstacle, innBenchObstacle, pondBenchObstacle, pondObstacle, rackObstacle, larderObstacle, ...stackObstacles, ...millObstacles, ...cooperObstacles];
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
    { bench, obstacle: benchObstacle, owner: WOODWORKER },
    { bench: innBench, obstacle: innBenchObstacle, owner: INNKEEPER },
    { bench: pondBench, obstacle: pondBenchObstacle, owner: FISHER },
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
  spout,
  cooperage,
  field,
  stook,
  windmill,
  floor: threshingFloor,
  sacks: sackRack,
  bakery,
  innBread,
  dt: 0,
  hours: look.time,
  phase: phaseAt(look.time),
  day: 1,
  wind,
  tables,
  seats,
  // (the first table's first place: the tankard's spot was laid out in front of it)
  regularSeat: seats[0],
  hatch: (() => {
    const b = houses.buildings.find((h) => h.kind === 'inn')!;
    const p = b.pickup!;
    const into = new THREE.Vector3(-Math.sin(b.yaw), 0, -Math.cos(b.yaw)); // toward the inn
    return { stand: { x: p.x, z: p.z, yaw: b.doorFacing }, counter: p.clone().addScaledVector(into, 0.42).setY(0.97) };
  })(),
  mealServed: (seat) => {
    const meal = seat.plate.items[0];
    // (a plate from the kitchen, or a loaf the baker's brought round from the basket)
    const food = meal?.kind === 'bread' ? 'bread' : (meal?.food ?? 'fish');
    if (meal) {
      seat.plate.items[0] = null;
      removeItem(meal);
    }
    // (whoever it was for gave up and went home before it came: it's cleared away, the seat stays as it is)
    if (seat.state !== 'seated' || seat.diner < 0) return;
    crowd.actors[seat.diner]?.choreOf('dine').serveMeal(food);
    seat.state = 'served';
    village.stats.meals++;
    if (food === 'fish') village.stats.eaten++;
    else village.stats.breadEaten++;
  },
  cameHome: (i) => {
    litUntil[HOME[i]] = simTime + 1.5 * secPerHour(village.hours); // a lamp lit for an hour and a half
  },
  everyoneFed: () => jobs.every((j, k) => ROLES[k] === 'innkeeper' || j.asleep || j.ateToday),
  lamp,
  greenSpot: (i) => greenSpot(i),
  bandPlaying: () => crowd.actors.some((a) => kindIs(a.kind, 'music')),
  chatOnGreen: (i) => chatAround(i, Infinity, WAITING_ON_GREEN),
  chatNear: (i, near) => chatAround(i, near, STOOD_ABOUT),
  sight: (i) => sight(i),
  chat: (i, j, seconds) => {
    // (only with someone who's there for it: not asleep, not walking off somewhere)
    if ([i, j].some((k) => jobs[k].asleep || (!kindIs(crowd.actors[k].kind, 'meal') && crowd.motions[k].speed > 0.1))) return;
    chat(i, j, seconds);
  },
  tankardSpot,
  served: () => {
    const mug = tankardSpot.items[0];
    if (mug) {
      tankardSpot.items[0] = null;
      removeItem(mug);
    }
    crowd.actors[REGULAR].choreOf('dine').serve();
  },
  wantsRefill: () => {
    const a = crowd.actors[REGULAR];
    return kindIs(a.kind, 'meal') && a.choreOf('dine').needsRefill;
  },
  items,
  newItem,
  removeItem,
  stats: { felled: 0, sawn: 0, delivered: 0, burned: 0, caught: 0, dried: 0, fishIn: 0, eaten: 0, breadEaten: 0, picked: 0, milled: 0, kegs: 0, kegsIn: 0, poured: 0, drunk: 0, shaved: 0, kegsMade: 0, kegsBack: 0, hooped: 0, mown: 0, sheaves: 0, threshed: 0, flour: 0, sailing: 0, baked: 0, breadIn: 0, trips: 0, pickedUp: 0, meals: 0, hungry: 0, slept: 0, evening: 0, lamps: 0 },
};
const jobs: Job[] = people.map((p, i) => {
  const pk = VILLAGERS[i].gear;
  const gear = pk !== undefined ? { basket: baskets[pk], ladder: ladders[pk] } : undefined;
  const w = { i, actor: crowd.actors[i], walker: walkers[i], root: p.root, instrument: INSTRUMENT[i], pipe: PIPE[i], home: homes[i], gear };
  const J = { lumberjack: Lumberjack, woodworker: Woodworker, fisher: Fisher, innkeeper: Innkeeper, picker: Picker, cidermaker: CiderMaker, regular: Regular, cooper: Cooper, farmer: Farmer, baker: Baker }[ROLES[i]];
  return new J(w);
});
// (the second innkeeper serves; the first sees to the lamp)
jobs.forEach((j, k) => ROLES[k] === 'innkeeper' && k !== INNKEEPER && ((j as Innkeeper).keepsLamp = false));

// ---------------------------------------------------------------- the green

/**
 * Where each person stands on the green of an evening: the band in an arc
 * on the side toward the tables, facing in; everyone else in the middle,
 * spread out enough to dance.
 */
function greenSpot(i: number) {
  const G = L.green;
  const band = ROLES.map((_, k) => (INSTRUMENT[k] ? k : -1)).filter((k) => k >= 0);
  const k = band.indexOf(i);
  let a: number, r: number;
  if (k >= 0) {
    a = G.yaw + (k - (band.length - 1) / 2) * 0.5;
    r = G.R * 0.9;
  } else {
    // (however many there are, spread round the middle)
    const dancers = ROLES.map((_, k2) => (INSTRUMENT[k2] ? -1 : k2)).filter((k2) => k2 >= 0);
    const j = dancers.indexOf(i);
    a = G.yaw + Math.PI + (j * Math.PI * 2) / dancers.length;
    r = dancers.length > 1 ? 0.6 + 0.15 * (j % 2) : 0;
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
  return kindIs(a.kind, 'meal') && a.choreOf('dine').handsIdle && a.talkingTo < 0 && simTime >= chattedUntil[i];
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

/** On the green waiting for the music (a chat there can be with anyone else on it). */
const WAITING_ON_GREEN = new Set<StepKind>(['at the dance']);
/** Steps where someone's stood (or sat) about with nothing on, and would stop for a word. */

/**
 * A chat with someone who's free for one: in one of these steps, stood about
 * (or smoking), not already talking, not just done talking, within `near`
 * metres; the nearest of them.
 */
function chatAround(i: number, near: number, steps: ReadonlySet<StepKind>) {
  const free = (k: number) => {
    const a = crowd.actors[k];
    return steps.has(jobs[k].doing) && (a.kind === null || a.kind === 'pipe') && a.talkingTo < 0 && simTime >= chattedUntil[k];
  };
  if (!free(i)) return;
  const me = walkers[i];
  let best = -1, bestD = near;
  for (let k = 0; k < people.length; k++) {
    if (k === i || !free(k)) continue;
    const d = Math.hypot(walkers[k].x - me.x, walkers[k].z - me.z);
    if (d < bestD) [best, bestD] = [k, d];
  }
  if (best >= 0) chat(i, best, 3 + Math.random() * 4);
}

// ---------------------------------------------------------------- the sights

/**
 * Places to stroll to and stand looking at of an idle moment: the pond's
 * shore, the orchard's and the forest's edges, the mill, the woodyard, the
 * drying rack, the green. (Where they stand: how far out from its middle.)
 */
const SIGHTS = [
  { x: L.pond.x, z: L.pond.z, r: pond.maxR + 0.7 },
  { x: L.orchard.x, z: L.orchard.z, r: L.orchard.R + 0.7 },
  { x: L.forest.x, z: L.forest.z, r: L.forest.R + 0.9 },
  { x: L.mill.x, z: L.mill.z, r: 1.6 },
  { x: L.horse.x, z: L.horse.z, r: 1.8 },
  { x: L.rack.x, z: L.rack.z, r: 1.4 },
  { x: L.green.x, z: L.green.z, r: L.green.R * 0.6 },
];

/** One of the sights to go and look at (not the one they're at): on the near side of it, facing it. */
function sight(i: number) {
  const me = walkers[i];
  const spots = SIGHTS.map((g) => {
    const a = Math.atan2(me.x - g.x, me.z - g.z) + (Math.random() - 0.5) * 1.4;
    const x = g.x + Math.sin(a) * g.r, z = g.z + Math.cos(a) * g.r;
    return { x, z, yaw: Math.atan2(g.x - x, g.z - z) };
  }).filter((p) => Math.hypot(p.x - me.x, p.z - me.z) > 5);
  return spots[Math.floor(Math.random() * spots.length)] ?? { x: me.x, z: me.z, yaw: me.yaw };
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
/**
 * Run the world on n steps of dt, then draw the stores' contents (once:
 * nothing in a step reads the items' and logs' meshes, only their places).
 */
function simulateSteps(n: number, dt: number) {
  for (let i = 0; i < n; i++) simulate(dt);
  placeLogs();
  placeItems();
}

/**
 * Now and then someone walking along trips and goes flat: about once in
 * TRIP_EVERY seconds of brisk walking (×1/?trip=). Empty-handed, or with a log
 * or an armful on the way somewhere (then it all goes down, to be picked up
 * again: see Job.recoverStep). Not with the ladder or the basket, and not
 * mid-way through picking something up or putting it down.
 */
const TRIP_EVERY = 1200 / num('trip', 1);
function canTrip(i: number) {
  const a = crowd.actors[i];
  const j = jobs[i];
  if (j.asleep || a.onSeat || crowd.motions[i].speed < WALK_SPEED * 0.6) return false;
  if (a.kind === null) return !j.carrying && !j.armful.length;
  if (a.kind === 'haul') return !!j.carrying && (j.doing === 'to pile' || j.doing === 'to sawhorse');
  if (a.kind === 'armful') return j.armful.length > 0 && j.doing === 'delivering';
  return false;
}
/** Down (the fall has the body) last step: once it lets go, they walk on from wherever they got up. */
const wasDown = VILLAGERS.map(() => false);

function simulate(dt: number) {
  simTime += dt;
  village.time = simTime;
  village.dt = dt;
  const was = village.hours;
  village.hours = look.time = (village.hours + dt / secPerHour(village.hours)) % 24;
  if (village.hours < was) village.day++;
  wind.update(village.day, village.hours, simTime);
  field.update(Field.clock(village.day, village.hours));
  // the windmill: turned by the wind; a sack of flour now and then, if there's grain, and room on the rack
  const turns = windmill.turns;
  if (windmill.update(dt, wind.strength, wind.toward, sackRack.room > 0, village.phase === 'work')) {
    const slot = sackRack.free(1)[0];
    const sack = newItem('flour');
    const p = sackRack.slotWorld(slot);
    sack.place = { at: 'stack', stack: sackRack, slot };
    sack.tween = { pos: new THREE.Vector3(windmill.x, 1.3, windmill.z), quat: p.quat.clone(), t0: simTime, dur: 0.8 };
    sackRack.items[slot] = sack;
    village.stats.flour++;
  }
  if (windmill.turning) village.stats.sailing += dt;
  // a gentle creak from the windshaft each time the sails come round
  if (windmill.turns !== turns) {
    const w = crowd.whereAt(windmill.group, 3);
    if (w && crowd.sound.live) crowd.sound.creak({ ...w, gain: w.gain * 0.45 });
  }
  bakery.oven.update(dt);
  ovenSmoke.rate = bakery.oven.smoke;
  village.phase = phaseAt(village.hours);
  crowd.beginStep(simTime, null, -1);
  const obs = obstacles();
  // (whoever's asleep is indoors: in nobody's way, though their walker waits at the door)
  const about = allWalkers.filter((_, k) => k >= jobs.length || !jobs[k].asleep);
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
    } else m.targetSpeed = a.holdSpeed ? 0 : w.think(dt, obs, about, WALK_SPEED * crowd.styleOf(p).speedK);
    if (canTrip(i) && Math.random() < dt / TRIP_EVERY) {
      a.start('fall'); // (no push: a trip, pitching forward at their own pace)
      village.stats.trips++;
      jobs[i].trippedAt = simTime;
    }
    crowd.advance(i, dt);
    if (a.rootLocked) wasDown[i] = true;
    else if (wasDown[i]) {
      wasDown[i] = false;
      w.moveTo(p.root.position.x, p.root.position.z, p.root.rotation.y);
    }
    if (!a.rootLocked) {
      w.move(m.speed, dt, obs, about);
      const yaw = w.yaw + (pose?.spin ?? 0);
      const fwd = pose?.fwd ?? 0;
      p.root.position.set(w.x + Math.sin(yaw) * fwd, pose?.lift ?? 0, w.z + Math.cos(yaw) * fwd);
      p.root.rotation.y = yaw;
    }
    crowd.post(i, dt, simTime, pose);
  });
  dog.step({
    time: simTime,
    dt,
    people: people.map((p, i) => ({ walker: walkers[i], root: p.root, height: p.dims.height, speed: crowd.motions[i].speed, doing: jobs[i].doing, asleep: jobs[i].asleep })),
    owner: DOG_OWNER,
    home: homes[DOG_OWNER],
    green: L.green,
    obstacles: obs,
    walkers: about,
    camera: stage.camera.position,
    sound: (kind) => {
      const w = crowd.whereAt(dog.dog.root, dog.dog.height);
      if (!w || !crowd.sound.live) return;
      if (kind === 'woof') crowd.sound.woof(dog.dog.genome.size, w);
      // a paw down: the people's footstep, feather-light and quieter
      else crowd.sound.step(DOG_PAWS, { pan: w.pan, gain: w.gain * 0.7 });
    },
  });
  cat.step({
    time: simTime,
    dt,
    hours: village.hours,
    phase: village.phase,
    people: people.map((p, i) => ({ walker: walkers[i], root: p.root, height: p.dims.height, doing: jobs[i].doing, asleep: jobs[i].asleep })),
    dog: { x: dog.walker.x, z: dog.walker.z, speed: dog.m.speed },
    spots: catSpots,
    bed: catBed,
    hatch: village.hatch.stand,
    green: L.green,
    obstacles: obs,
    walkers: about,
    camera: stage.camera.position,
    sound: (kind) => {
      const w = crowd.whereAt(cat.cat.root, cat.cat.height);
      if (!w || !crowd.sound.live) return;
      if (kind === 'meow') crowd.sound.meow(cat.cat.genome.size, w);
      else if (kind === 'purr') crowd.sound.purr({ ...w, gain: w.gain * 0.7 });
      else crowd.sound.step(CAT_PAWS, { pan: w.pan, gain: w.gain * 0.45 });
    },
  });
  crowd.endStep(dt);
  talk();
  forest.update(simTime);
  orchard.update(simTime);
  // (the kitchen fire's banked while the inn's shut for the night)
  if (!jobs[INNKEEPER].asleep) burnClock += dt / secPerHour(village.hours);
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
  // lamps: lit for a while when someone gets home after dark; the inn's while it's open
  const dark = village.hours >= 17.5 || village.hours < 6.5;
  const innOpen = !jobs[INNKEEPER].asleep || seats.some((st) => st.state !== 'free');
  if (dark && innOpen) litUntil[HOME[INNKEEPER]] = Math.max(litUntil[HOME[INNKEEPER]], simTime + 0.75 * secPerHour(village.hours));
  litUntil.forEach((until, i) => {
    const on = dark && until > simTime;
    if (houses.isLit(i) !== on) houses.setLit(i, on);
  });
  // the kitchen fire smokes while there's firewood to burn
  if (innChimney) innChimney.rate = jobs[INNKEEPER].asleep ? 0.12 : innStack.count > 0 ? 1.8 : 0.15;
  smoke.update(dt, stage.toon.uniforms.uTint.value);
}

/**
 * The view on load: the whole village in frame, at the standard angle. Every
 * house, the districts (out to their edges), the windmill and the green are
 * measured where they'd fall on the screen, treetops and sails included;
 * the view is centred on all that and zoomed to fit it with a margin, for
 * whatever shape the window is. (?tx/?tz and ?zoom still win.)
 */
function frameVillage() {
  const cam = stage.camera;
  stage.resize();
  cam.updateMatrixWorld();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  const pts: THREE.Vector3[] = [];
  const round = (x: number, z: number, r: number, h: number) => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      for (const y of [0, h]) pts.push(new THREE.Vector3(x + Math.sin(a) * r, y, z + Math.cos(a) * r));
    }
  };
  for (const b of houses.buildings) round(b.x, b.z, Math.hypot(b.half.x, b.half.z), 3);
  round(L.forest.x, L.forest.z, L.forest.R + 0.5, 3.5);
  round(L.orchard.x, L.orchard.z, L.orchard.R, 2);
  round(L.pond.x, L.pond.z, L.pond.R, 0);
  round(L.field.x, L.field.z, 3.6, 0.5);
  round(L.windmill.x, L.windmill.z, 2, 4.5);
  round(L.green.x, L.green.z, L.green.R, 1.5);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) {
    const sx = p.dot(right), sy = p.dot(up);
    x0 = Math.min(x0, sx);
    x1 = Math.max(x1, sx);
    y0 = Math.min(y0, sy);
    y1 = Math.max(y1, sy);
  }
  // the middle of all that, back down onto the ground along the view
  const mid = right.clone().multiplyScalar((x0 + x1) / 2).addScaledVector(up, (y0 + y1) / 2);
  const back = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const target = q.has('tx') || q.has('tz') ? new THREE.Vector3(num('tx', 0), 0.5, num('tz', 0)) : mid.addScaledVector(back, (0.5 - mid.y) / back.y);
  cam.position.add(target.clone().sub(stage.controls.target));
  stage.controls.target.copy(target);
  if (!q.has('zoom')) {
    const margin = 1.08;
    cam.zoom = Math.min((cam.right - cam.left) / ((x1 - x0) * margin), (cam.top - cam.bottom) / ((y1 - y0) * margin));
    cam.updateProjectionMatrix();
  }
}
frameVillage();

// ---------------------------------------------------------------- watching it

const ROLE_ICON: Record<Role, string> = { lumberjack: '🪓', woodworker: '🪚', fisher: '🎣', innkeeper: '🍺', picker: '🍎', cidermaker: '⚙', regular: '🍻', cooper: '🛢', farmer: '🌾', baker: '🍞' };
const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;left:8px;bottom:30px;padding:6px 9px;background:#000a;color:#e8f4d8;font:12px/1.45 ui-monospace,monospace;white-space:pre;pointer-events:none;border-radius:3px;';
document.body.appendChild(panel);
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
/** Who's doing what, what's in the pile, and the tallies. */
function updatePanel() {
  panel.style.display = settings.panel ? '' : 'none';
  if (!settings.panel) return;
  const rows = jobs.map((j, i) => `${i === follow ? '▸' : ' '} ${ROLE_ICON[ROLES[i]]} ${VILLAGERS[i].name.padEnd(11)} ${j.doing}${j.carrying ? ' (carrying a log)' : j.armful.length ? ` (${{ wood: 'an armful of firewood', fish: 'an armful of fish', apple: 'apples', keg: 'a keg', mug: 'a tankard of cider', meal: 'a plate of supper', sheaf: 'sheaves', flour: 'a sack of flour', bread: 'bread' }[j.armful[0].kind]})` : ''}`);
  const loose = logs.filter((l) => l.place.at === 'ground').length;
  const standing = forest.trees.filter((t) => t.state === 'standing').length;
  panel.textContent = [
    ...rows,
    `  🐕 dog        ${dog.doing} (${VILLAGERS[DOG_OWNER].name}'s)`,
    `  🐈 cat        ${cat.doing || '…'}`,
    `day ${village.day} · the wind: ${wind.words} (${wind.strength.toFixed(2)})`,
    `wheat: ${(['ripe', 'cut', 'growing', 'stubble'] as const).map((k) => `${k} ${field.strips.filter((s) => s.state === k).length}`).join(' · ')} · strips mown ${village.stats.mown} · stook ${stook.count}/${stook.slots.length}`,
    `bakery: oven ${bakery.oven.firing ? 'firing' : bakery.oven.hot ? 'hot' : bakery.oven.heat > 0.2 ? 'cooling' : 'cold'} · flour ${bakery.flour.count} · wood ${bakery.wood.count} · batches baked ${village.stats.baked} · on the shelf ${bakery.shelf.count} · at the inn ${innBread.count} (taken ${village.stats.breadIn})`,
    `windmill: sails ${windmill.turning ? 'turning' : windmill.spin > 0.05 ? 'slowing' : 'still'} · grain ${windmill.grain} · on the floor ${threshingFloor.count} · threshed ${village.stats.threshed} · flour milled ${village.stats.flour}, on the rack ${sackRack.count}/${sackRack.slots.length}`,
    `woodpile ${pile.count}/${pile.slots.length}${pile.incoming ? ` (+${pile.incoming} coming)` : ''} · logs lying about ${loose}`,
    `trees standing ${standing}/${forest.trees.length} · felled ${village.stats.felled} · sawn ${village.stats.sawn}`,
    `firewood: yard ${yard.count}/${yard.slots.length} · inn ${innStack.count}/${innStack.slots.length}${innStack.incoming ? ` (+${innStack.incoming} coming)` : ''} · delivered ${village.stats.delivered} · burned ${village.stats.burned}`,
    `fish: caught ${village.stats.caught} · rack ${rack.count}/${rack.slots.length} (${rack.items.filter((it) => it && it.dry >= 1).length} dry) · larder ${larder.count}/${larder.slots.length}${larder.incoming ? ` (+${larder.incoming} coming)` : ''} · suppers served ${village.stats.meals}`,
    `cider: picked ${village.stats.picked} · baskets ${baskets.map((b) => b.count).join('+')} · hopper ${mill.hopper.count}/${mill.hopper.slots.length} · kegs filled ${village.stats.kegs} · at the mill ${millKegs.count} · at the inn ${innKegs.count} (${innKegs.items.reduce((n, k) => n + (k ? k.dry : 0), 0)} tankards) · poured ${village.stats.poured} · sips ${village.stats.drunk}`,
    `cooper: staves ${cooperage.staves.count} · shaved ${village.stats.shaved} · kegs made ${village.stats.kegsMade} · brought back ${village.stats.kegsBack} · hooped ${village.stats.hooped} · empties ready ${cooperage.empties.count} · under the spout ${spout.count ? (spout.items[0]!.dry > 0 ? 'full' : 'empty') : 'none'}`,
    `${String(Math.floor(village.hours)).padStart(2, '0')}:${String(Math.floor((village.hours % 1) * 60)).padStart(2, '0')} ${{ work: 'working', supper: 'supper at the inn', night: 'night' }[village.phase]} · meals ${village.stats.meals} · time ${clock(simTime)} · speed ×${settings.speed}${settings.paused ? ' (paused)' : ''}`,
  ].join('\n');
}

const gui = new GUI({ title: 'Village' });
gui.close(); // (folded up till someone wants it)
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

/**
 * ?follow=…: keep someone in the middle of the view: a number (their place
 * in VILLAGERS; one past the last is the dog), `dog`, or a role or a name
 * (`farmer`, `woodworker 2`: the first with that name, else that role).
 */
let follow = (() => {
  const f = q.get('follow');
  if (f === null) return -1;
  if (f === 'dog') return VILLAGERS.length;
  if (f === 'cat') return VILLAGERS.length + 1;
  if (/^\d+$/.test(f)) return Number(f);
  const byName = VILLAGERS.findIndex((v) => v.name === f);
  return byName >= 0 ? byName : VILLAGERS.findIndex((v) => v.role === f);
})();
function focusOn(i: number, k: number) {
  // (one past the villagers: the dog)
  // (one past them, the dog; two past, the cat)
  const it = people[i] ? { root: people[i].root, h: people[i].dims.height } : i === people.length ? { root: dog.dog.root, h: dog.dog.height * 2 } : i === people.length + 1 ? { root: cat.cat.root, h: cat.cat.height * 2 } : null;
  if (!it) return;
  const c = stage.controls;
  const off = stage.camera.position.clone().sub(c.target);
  c.target.lerp(new THREE.Vector3(it.root.position.x, it.h * 0.5, it.root.position.z), k);
  stage.camera.position.copy(c.target).add(off);
}

let flagTime = 0;
/** Every store (and the woodpile), for the test's book-keeping checks: anything new that holds things goes here. */
const allStores = () => [yard, innStack, rack, larder, ...baskets, mill.hopper, millKegs, innKegs, tankardSpot, spout, cooperage.block, cooperage.staves, cooperage.empties, stook, threshingFloor, sackRack, bakery.shelf, bakery.flour, bakery.wood, innBread, ...seats.map((s) => s.plate)];
const hooks: AppHooks = {
  paused: () => settings.paused,
  simulate: (dt) => {
    // fast-forward in whole steps no longer than 1/30 s, so jobs and physics behave the same at any speed
    const total = dt * settings.speed;
    const n = Math.max(1, Math.ceil(total / (1 / 30)));
    simulateSteps(n, total / n);
    return true;
  },
  follow: (dt, first) => {
    if (follow >= 0) focusOn(follow, first ? 1 : 1 - Math.exp(-dt * 4));
  },
  scenery: () => {
    pond.update(simTime);
    // (the flags fly on simulation time: paused, they hold still)
    for (const f of flags) f.update(wind.strength, wind.toward, wind.gust, simTime, simTime - flagTime);
    flagTime = simTime;
  },
  shadows: () => {
    stage.orient(dog.dog.root.userData.shadow, dog.dog.root.rotation.y);
    stage.orient(cat.cat.root.userData.shadow, cat.cat.root.rotation.y);
    forest.orientShadows();
    orchard.orientShadows(stage);
    houses.updateShadows(stage.lightWorld, look.shadowLength);
    windmill.updateShadow(stage.lightWorld, look.shadowLength);
  },
  extent: () => 14,
  beforeRender: (frame) => {
    if (frame % 6 === 0) updatePanel();
  },
  testHook: () => ({
    debug: () => ({ actors: crowd.actors, motions: crowd.motions, walkers, logs, pile, horse, forest, jobs, village, dog, linger: LINGER, kegsMax: KEGS_MAX, obstacles: obstacles(), nearest, dogOwner: DOG_OWNER, cat, stores: allStores(), flags, fromTemplate: L.fromTemplate }),
    follow: (i: number) => (follow = i),
    step: (sec: number) => {
      simulateSteps(Math.round(sec * 30), 1 / 30);
    },
    get time() {
      return simTime;
    },
  }),
};

stage.resize();
simulateSteps(Math.round(num('t', 0) * 60), 1 / 60);
simulateSteps(1, 0);
runApp(stage, crowd, hooks);
