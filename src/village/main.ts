import * as THREE from 'three';
import { Houses, type Site } from '../houses';
import { Stage, lookFromQuery, num, q } from '../stage';
import { Crowd, type CrowdSettings } from '../crowd';
import { WALK_SPEED, defaultGait, newMotion } from '../gait';
import { Animator } from '../animate';
import { Actor } from '../actions';
import { Gaze } from '../gaze';
import { mulberry32 } from '../rng';
import { randomGenome } from '../genome';
import { Forest } from './forest';
import { LOG_L, LOG_R, type Log, Sawhorse, Woodpile, makeLog } from './things';
import { type Goal, type Obstacle, Walker } from './walk';

/**
 * The village: a little settlement where people do jobs that feed each
 * other. For now, the woodcutting chain: a lumberjack fells pines and carries
 * the logs to a woodpile; a woodworker takes them from the pile and saws them
 * on a sawhorse.
 */

const look = lookFromQuery();
if (q.has('nogui')) document.getElementById('hint')?.remove();
const stage = new Stage(look);
const settings: CrowdSettings & { seed: number; paused: boolean } = {
  gait: { ...defaultGait },
  personality: 1,
  segments: num('segs', 8),
  eyes: true,
  merge: q.get('merge') !== '0',
  lookAt: 'auto',
  seed: num('seed', 1),
  paused: q.has('paused'),
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
const people = ROLES.map((_, i) => crowd.spawn(randomGenome(settings.seed * 100003 + 17 + i * 5), i));
const r = mulberry32(settings.seed * 31 + 7);
crowd.people = people;
crowd.motions = people.map(() => newMotion(r()));
crowd.anims = people.map((_, i) => new Animator(settings.seed * 977 + i));
crowd.actors = people.map((p) => new Actor(p, crowd.kit));
crowd.gazes = people.map((p, i) => new Gaze(p, i, mulberry32(settings.seed * 4243 + i)));
const iWood = ROLES.indexOf('woodworker');

// the woodworker's own sawhorse, made to their height, and the pile beside it
const horse = new Sawhorse(stage, 0.9, 1.4, -0.2, crowd.actors[iWood].sawFit({ r: LOG_R, len: LOG_L / 2.05 }));
const pile = new Woodpile(stage, -1.1, 1.0, 0.25);

const logs: Log[] = [];
let nextLogId = 0;
function newLog(): Log {
  const mesh = makeLog(stage);
  stage.scene.add(mesh);
  const log: Log = { id: nextLogId++, place: { at: 'ground', x: 0, z: 0, yaw: 0 }, mesh };
  logs.push(log);
  return log;
}
// (a few to look at while the jobs aren't in yet)
for (let i = 0; i < 3; i++) {
  const l = newLog();
  l.place = { at: 'pile', slot: i };
  pile.logs[i] = l;
}
{
  const l = newLog();
  l.place = { at: 'horse' };
  horse.log = l;
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
  return { kind: 'box', x: horse.x + mid.x, z: horse.z + mid.z, yaw: horse.yaw, hx: Math.abs(t[0].x - t[1].x) / 2 + 0.08, hz: 0.14 };
})();
const treeObstacles = new Map<number, Obstacle>();
/** Everything solid right now. */
function obstacles(): Obstacle[] {
  const out = [...houseObstacles, pileObstacle, horseObstacle];
  for (const t of forest.trees) {
    if (t.state === 'felling') continue;
    let o = treeObstacles.get(t.id);
    if (!o) treeObstacles.set(t.id, (o = { kind: 'circle', x: t.x, z: t.z, r: 0 }));
    (o as { r: number }).r = forest.specs[t.variant].rt * t.k * 1.15 + (t.state === 'growing' ? 0.06 : 0.02);
    out.push(o);
  }
  return out;
}
/** Which way to face so a point is straight ahead. */
const facing = (fromX: number, fromZ: number, toX: number, toZ: number) => Math.atan2(toX - fromX, toZ - fromZ);

// (step 2: a patrol to try the walking — pile, a tree, the sawhorse)
const patrol: (() => Goal)[] = [
  () => { const w = pile.workSpot(_v); return { x: w.x, z: w.z, yaw: facing(w.x, w.z, pile.x, pile.z) }; },
  () => {
    const t = forest.standing()[5];
    const o = treeObstacles.get(t.id) ?? null;
    return { x: t.x + 0.45, z: t.z + 0.1, yaw: facing(t.x + 0.45, t.z + 0.1, t.x, t.z), ignore: o };
  },
  () => { const s = horse.sawSpot(); return { x: s.x + 0.6, z: s.z - 0.4, yaw: s.yaw }; },
];
const legs = people.map((_, i) => i);

// ---------------------------------------------------------------- loop

let simTime = 0;
function simulate(dt: number) {
  simTime += dt;
  crowd.beginStep(simTime, null, -1);
  const obs = obstacles();
  people.forEach((p, i) => {
    const pose = crowd.pre(i, dt, simTime);
    const w = walkers[i];
    const a = crowd.actors[i];
    const m = crowd.motions[i];
    if (!w.goal || (w.arrived && !a.busy)) {
      if (w.arrived) a.start('wave');
      legs[i] = (legs[i] + 1) % patrol.length;
      w.go(patrol[legs[i]]());
    }
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

let frames = 0;
function frame(start: number) {
  const dt = stage.delta();
  crowd.frameTick();
  if (!settings.paused) simulate(dt);
  crowd.sweep();
  stage.controls.update();
  stage.updateLight(dt, settings.paused);
  crowd.orientShadows();
  forest.orientShadows();
  houses.updateShadows(stage.lightWorld, look.shadowLength);
  stage.updateEnvironment(dt, 14);
  stage.render(start, people.length);
  if (++frames === 2) (window as any).__mini = { ready: true, renderer: stage.renderer, camera: stage.camera, people, debug: () => ({ actors: crowd.actors, motions: crowd.motions, walkers, logs, pile, horse, forest }), step: (sec: number) => { for (let i = 0, n = Math.round(sec * 30); i < n; i++) simulate(1 / 30); }, get time() { return simTime; } };
}

stage.resize();
for (let i = 0, n = Math.round(num('t', 0) * 60); i < n; i++) simulate(1 / 60);
simulate(0);
stage.run(frame);
