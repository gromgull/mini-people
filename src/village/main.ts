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
import { randomGenome } from '../genome';
import { Forest } from './forest';
import { Bench, Crate, type Item, LOG_L, LOG_R, type Log, Rack, Sawhorse, Stack, type Store, Woodpile, makeFish, makeLog, setDry } from './things';
import { Pond } from '../pond';
import { type Chimney, Smoke } from '../smoke';
import { makePiece } from '../firewood';
import { type Obstacle, Walker } from './walk';
import { Fisher, Innkeeper, type Job, Lumberjack, type Village, Woodworker } from './jobs';

/**
 * The village: a little settlement where people do jobs that feed each
 * other. For now, the firewood chain: a lumberjack fells pines and carries
 * the logs to a woodpile; a woodworker saws them into firewood on a
 * sawhorse, stacks it in the yard, and carries armfuls to the inn, whose
 * kitchen fire burns through it.
 */

const look = lookFromQuery();
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

const SITES: Site[] = [
  { kind: 'cabin', x: -6.5, z: -7, yaw: 0.35 }, // the lumberjack's, by the forest
  { kind: 'cabin', x: 4.5, z: -6.5, yaw: -0.3 }, // the woodworker's
  { kind: 'cabin', x: 15.5, z: -4, yaw: -0.9 }, // the fisher's, up from the pond
  { kind: 'inn', x: 1, z: -14, yaw: 0 }, // (the innkeeper lives in)
];
const houses = new Houses(stage.toon, stage.outline, stage.shadowMat, 23, SITES);
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
const forest = new Forest(stage, -11.5, -1, 4.2, 26);
stage.scene.add(forest.group);
// a good-sized pond off to the east, for the fisher
const pond = new Pond(stage.toon, stage.outline, 10, 2, 3.6, 5);
stage.scene.add(pond.group);

// ---------------------------------------------------------------- people

type Role = 'lumberjack' | 'woodworker' | 'fisher' | 'innkeeper';
const ROLES: Role[] = ['lumberjack', 'woodworker', 'fisher', 'innkeeper'];
/** What each plays in their spare time. */
const INSTRUMENT: Record<Role, 'fiddle' | 'banjo' | null> = { lumberjack: 'fiddle', woodworker: 'banjo', fisher: null, innkeeper: 'fiddle' };
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
const horse = new Sawhorse(stage, -1.6, 1.3, -0.2, crowd.actors[iWood].sawFit({ r: LOG_R, len: LOG_L / 2.05 }));
const pile = new Woodpile(stage, -3.7, 0.9, 0.35);
// firewood: a stack in the yard for what's been sawn, and one by the inn's
// kitchen end (beside the chimney) that the inn burns from
const yard = new Stack(stage, 'yard', -0.35, -0.25, -1.2); // (ends toward the usual view)
const innStack = (() => {
  const b = houses.buildings.find((h) => h.kind === 'inn')!;
  const at = new THREE.Vector3(b.half.x + 0.3, 0, 0.75).applyAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
  return new Stack(stage, 'inn', b.x + at.x, b.z + at.z, b.yaw + Math.PI / 2);
})();
// fish: a drying rack between the pond and the inn, and a larder crate by
// the inn's kitchen hatch
const rack = new Rack(stage, 'rack', 9.2, -4.4, 0.35);
const larder = (() => {
  const b = houses.buildings.find((h) => h.kind === 'inn')!;
  const at = new THREE.Vector3(0.55, 0, -0.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
  return new Crate(stage, 'larder', b.pickup!.x + at.x, b.pickup!.z + at.z, b.yaw);
})();

const items: Item[] = [];
let nextItemId = 0;
function newItem(kind: Item['kind']): Item {
  const mesh = kind === 'wood' ? makePiece(crowd.kit) : makeFish(stage);
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
      const k = Math.min(1, (simTime - tw.t0) / tw.dur);
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
/** Fish dry on the rack over this many seconds. */
const DRY_TIME = 120;
/** The inn's guests eat a fish every so often. */
const EAT_EVERY = 50;
let nextMeal = EAT_EVERY;
/** The inn's kitchen fire burns a piece every so often. */
const BURN_EVERY = 25;
let nextBurn = BURN_EVERY;
// and a bench of their height to sit on between logs, looking over the yard
const bench = new Bench(stage, 0.7, 2.4, Math.atan2(-1.6 - 0.7, 1.3 - 2.4) + 0.4, crowd.actors[iWood].sitFit());
// the innkeeper's, out front of the inn left of the door; the fisher's, looking over the pond
const innBench = (() => {
  const b = houses.buildings.find((h) => h.kind === 'inn')!;
  const at = new THREE.Vector3(-1.7, 0, 2.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
  return new Bench(stage, b.x + at.x, b.z + at.z, b.yaw + 0.15, crowd.actors[ROLES.indexOf('innkeeper')].sitFit());
})();
const pondBench = new Bench(stage, 5.2, 3.6, Math.PI / 2 + 0.25, crowd.actors[ROLES.indexOf('fisher')].sitFit());

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

const walkers = people.map((_, i) => new Walker(-1 + i * 2, 3, Math.PI));
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
const treeObstacles = new Map<number, Obstacle>();
/** Everything solid right now. */
function obstacles(): Obstacle[] {
  const out = [...houseObstacles, pileObstacle, horseObstacle, benchObstacle, innBenchObstacle, pondBenchObstacle, pondObstacle, rackObstacle, larderObstacle, ...stackObstacles];
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
    { bench, obstacle: benchObstacle },
    { bench: innBench, obstacle: innBenchObstacle },
    { bench: pondBench, obstacle: pondBenchObstacle },
  ],
  time: 0,
  yard,
  inn: innStack,
  pond,
  rack,
  larder,
  items,
  newItem,
  removeItem,
  stats: { felled: 0, sawn: 0, delivered: 0, burned: 0, caught: 0, dried: 0, fishIn: 0, eaten: 0 },
};
const jobs: Job[] = people.map((p, i) => {
  const w = { i, actor: crowd.actors[i], walker: walkers[i], root: p.root, instrument: INSTRUMENT[ROLES[i]] };
  const J = { lumberjack: Lumberjack, woodworker: Woodworker, fisher: Fisher, innkeeper: Innkeeper }[ROLES[i]];
  return new J(w);
});

// ---------------------------------------------------------------- loop

let simTime = 0;
function simulate(dt: number) {
  simTime += dt;
  village.time = simTime;
  crowd.beginStep(simTime, null, -1);
  const obs = obstacles();
  people.forEach((p, i) => {
    const pose = crowd.pre(i, dt, simTime);
    const w = walkers[i];
    const a = crowd.actors[i];
    const m = crowd.motions[i];
    jobs[i].tick(village);
    m.targetSpeed = a.holdSpeed ? 0 : w.think(dt, obs, walkers, WALK_SPEED * crowd.styleOf(p).speedK);
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
  forest.update(simTime);
  if (simTime >= nextBurn) {
    nextBurn += BURN_EVERY;
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
  if (simTime >= nextMeal) {
    nextMeal += EAT_EVERY;
    const top = larder.top(1)[0];
    if (top !== undefined && larder.available > 0) {
      removeItem(larder.items[top]!);
      larder.items[top] = null;
      village.stats.eaten++;
    }
  }
  placeLogs();
  placeItems();
  // the kitchen fire smokes while there's firewood to burn
  if (innChimney) innChimney.rate = innStack.count > 0 ? 1.8 : 0.15;
  smoke.update(dt, stage.toon.uniforms.uTint.value);
}

stage.controls.target.set(num('tx', -2), 0.5, num('tz', -1));
stage.camera.position.add(new THREE.Vector3(num('tx', -2), 0, num('tz', -1)));
if (!q.has('zoom')) {
  stage.camera.zoom = 0.62;
  stage.camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- watching it

const ROLE_ICON: Record<Role, string> = { lumberjack: '🪓', woodworker: '🪚', fisher: '🎣', innkeeper: '🍺' };
const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;left:8px;bottom:30px;padding:6px 9px;background:#000a;color:#e8f4d8;font:12px/1.45 ui-monospace,monospace;white-space:pre;pointer-events:none;border-radius:3px;';
document.body.appendChild(panel);
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
/** Who's doing what, what's in the pile, and the tallies. */
function updatePanel() {
  panel.style.display = settings.panel ? '' : 'none';
  if (!settings.panel) return;
  const rows = jobs.map((j, i) => `${i === follow ? '▸' : ' '} ${ROLE_ICON[ROLES[i]]} ${ROLES[i].padEnd(11)} ${j.doing}${j.carrying ? ' (carrying a log)' : j.armful.length ? ` (an armful of ${j.armful[0].kind === 'fish' ? 'fish' : 'firewood'})` : ''}`);
  const loose = logs.filter((l) => l.place.at === 'ground').length;
  const standing = forest.trees.filter((t) => t.state === 'standing').length;
  panel.textContent = [
    ...rows,
    `woodpile ${pile.count}/${pile.slots.length}${pile.incoming ? ` (+${pile.incoming} coming)` : ''} · logs lying about ${loose}`,
    `trees standing ${standing}/${forest.trees.length} · felled ${village.stats.felled} · sawn ${village.stats.sawn}`,
    `firewood: yard ${yard.count}/${yard.slots.length} · inn ${innStack.count}/${innStack.slots.length}${innStack.incoming ? ` (+${innStack.incoming} coming)` : ''} · delivered ${village.stats.delivered} · burned ${village.stats.burned}`,
    `fish: caught ${village.stats.caught} · rack ${rack.count}/${rack.slots.length} (${rack.items.filter((it) => it && it.dry >= 1).length} dry) · larder ${larder.count}/${larder.slots.length}${larder.incoming ? ` (+${larder.incoming} coming)` : ''} · eaten ${village.stats.eaten}`,
    `time ${clock(simTime)} · speed ×${settings.speed}${settings.paused ? ' (paused)' : ''}`,
  ].join('\n');
}

const gui = new GUI({ title: 'Village' });
if (q.has('nogui')) gui.hide();
gui.add(settings, 'speed', { '×1': 1, '×4': 4, '×16': 16 }).name('speed');
gui.add(settings, 'paused');
gui.add(settings, 'panel').name("who's doing what");
gui.add(look, 'time', 0, 24, 0.05).name('time of day (h)').decimals(2).listen();
gui.add(look, 'dayCycle').name('day runs');
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
  houses.updateShadows(stage.lightWorld, look.shadowLength);
  pond.update(simTime);
  stage.updateEnvironment(dt, 14);
  stage.render(start, people.length);
  if (frames % 6 === 0) updatePanel();
  if (++frames === 2) (window as any).__mini = { ready: true, renderer: stage.renderer, camera: stage.camera, people, debug: () => ({ actors: crowd.actors, motions: crowd.motions, walkers, logs, pile, horse, forest, jobs, village }), step: (sec: number) => { for (let i = 0, n = Math.round(sec * 30); i < n; i++) simulate(1 / 30); }, get time() { return simTime; } };
}

stage.resize();
for (let i = 0, n = Math.round(num('t', 0) * 60); i < n; i++) simulate(1 / 60);
simulate(0);
stage.run(frame);
