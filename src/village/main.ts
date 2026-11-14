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
import { Bench, LOG_L, LOG_R, type Log, Sawhorse, Woodpile, makeLog } from './things';
import { type Obstacle, Walker } from './walk';
import { type Job, Lumberjack, type Village, Woodworker } from './jobs';

/**
 * The village: a little settlement where people do jobs that feed each
 * other. For now, the woodcutting chain: a lumberjack fells pines and carries
 * the logs to a woodpile; a woodworker takes them from the pile and saws them
 * on a sawhorse.
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
  { kind: 'inn', x: 1, z: -14, yaw: 0 },
];
const houses = new Houses(stage.toon, stage.outline, stage.shadowMat, 23, SITES);
stage.scene.add(houses.group);
const forest = new Forest(stage, -11.5, -1, 4.2, 26);
stage.scene.add(forest.group);

// ---------------------------------------------------------------- people

type Role = 'lumberjack' | 'woodworker';
const ROLES: Role[] = ['lumberjack', 'woodworker'];
/** What each plays in their spare time. */
const INSTRUMENT: Record<Role, 'fiddle' | 'banjo'> = { lumberjack: 'fiddle', woodworker: 'banjo' };
const people = ROLES.map((_, i) => crowd.spawn(randomGenome(settings.seed * 100003 + 17 + i * 5), i));
const r = mulberry32(settings.seed * 31 + 7);
crowd.people = people;
crowd.motions = people.map(() => newMotion(r()));
crowd.anims = people.map((_, i) => new Animator(settings.seed * 977 + i));
crowd.actors = people.map((p) => new Actor(p, crowd.kit));
crowd.gazes = people.map((p, i) => new Gaze(p, i, mulberry32(settings.seed * 4243 + i)));
const iWood = ROLES.indexOf('woodworker');

// the woodworker's own sawhorse, made to their height, and the pile beside it
const horse = new Sawhorse(stage, -1.6, 1.3, -0.2, crowd.actors[iWood].sawFit({ r: LOG_R, len: LOG_L / 2.05 }));
const pile = new Woodpile(stage, -3.7, 0.9, 0.35);
// and a bench of their height to sit on between logs, looking over the yard
const bench = new Bench(stage, 0.7, 2.4, Math.atan2(-1.6 - 0.7, 1.3 - 2.4) + 0.4, crowd.actors[iWood].sitFit());

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
const benchObstacle: Obstacle = (() => {
  const back = _v.set(0, 0, -0.06).applyAxisAngle(new THREE.Vector3(0, 1, 0), bench.yaw);
  return { kind: 'box', x: bench.x + back.x, z: bench.z + back.z, yaw: bench.yaw, hx: 0.55, hz: bench.fit.depth / 2 + 0.06 };
})();
const treeObstacles = new Map<number, Obstacle>();
/** Everything solid right now. */
function obstacles(): Obstacle[] {
  const out = [...houseObstacles, pileObstacle, horseObstacle, benchObstacle];
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
  benches: [{ bench, obstacle: benchObstacle }],
  time: 0,
  stats: { felled: 0, sawn: 0 },
};
const jobs: Job[] = people.map((p, i) => {
  const w = { i, actor: crowd.actors[i], walker: walkers[i], root: p.root, instrument: INSTRUMENT[ROLES[i]] };
  return ROLES[i] === 'lumberjack' ? new Lumberjack(w) : new Woodworker(w);
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
  placeLogs();
}

stage.controls.target.set(num('tx', -2), 0.5, num('tz', -1));
stage.camera.position.add(new THREE.Vector3(num('tx', -2), 0, num('tz', -1)));
if (!q.has('zoom')) {
  stage.camera.zoom = 0.62;
  stage.camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- watching it

const ROLE_ICON: Record<Role, string> = { lumberjack: '🪓', woodworker: '🪚' };
const panel = document.createElement('div');
panel.style.cssText = 'position:fixed;left:8px;bottom:30px;padding:6px 9px;background:#000a;color:#e8f4d8;font:12px/1.45 ui-monospace,monospace;white-space:pre;pointer-events:none;border-radius:3px;';
document.body.appendChild(panel);
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
/** Who's doing what, what's in the pile, and the tallies. */
function updatePanel() {
  panel.style.display = settings.panel ? '' : 'none';
  if (!settings.panel) return;
  const rows = jobs.map((j, i) => `${i === follow ? '▸' : ' '} ${ROLE_ICON[ROLES[i]]} ${ROLES[i].padEnd(11)} ${j.doing}${j.carrying ? ' (carrying a log)' : ''}`);
  const loose = logs.filter((l) => l.place.at === 'ground').length;
  const standing = forest.trees.filter((t) => t.state === 'standing').length;
  panel.textContent = [
    ...rows,
    `woodpile ${pile.count}/${pile.slots.length}${pile.incoming ? ` (+${pile.incoming} coming)` : ''} · logs lying about ${loose}`,
    `trees standing ${standing}/${forest.trees.length} · felled ${village.stats.felled} · sawn ${village.stats.sawn}`,
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
  stage.updateEnvironment(dt, 14);
  stage.render(start, people.length);
  if (frames % 6 === 0) updatePanel();
  if (++frames === 2) (window as any).__mini = { ready: true, renderer: stage.renderer, camera: stage.camera, people, debug: () => ({ actors: crowd.actors, motions: crowd.motions, walkers, logs, pile, horse, forest, jobs, village }), step: (sec: number) => { for (let i = 0, n = Math.round(sec * 30); i < n; i++) simulate(1 / 30); }, get time() { return simTime; } };
}

stage.resize();
for (let i = 0, n = Math.round(num('t', 0) * 60); i < n; i++) simulate(1 / 60);
simulate(0);
stage.run(frame);
