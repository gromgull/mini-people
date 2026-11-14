import * as THREE from 'three';
import { Houses, type Site } from '../houses';
import { Stage, lookFromQuery, num, q } from '../stage';
import { Crowd, type CrowdSettings } from '../crowd';
import { defaultGait, newMotion } from '../gait';
import { Animator } from '../animate';
import { Actor } from '../actions';
import { Gaze } from '../gaze';
import { mulberry32 } from '../rng';
import { randomGenome } from '../genome';
import { Forest } from './forest';
import { LOG_L, LOG_R, type Log, Sawhorse, Woodpile, makeLog } from './things';

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

// where everyone stands for now
{
  const s = horse.sawSpot();
  people[iWood].root.position.set(s.x, 0, s.z);
  people[iWood].root.rotation.y = s.yaw;
  const w = pile.workSpot(_v);
  people[0].root.position.set(w.x - 0.8, 0, w.z + 0.6);
  people[0].root.rotation.y = 0.4;
}

// ---------------------------------------------------------------- loop

let simTime = 0;
function simulate(dt: number) {
  simTime += dt;
  crowd.beginStep(simTime, null, -1);
  people.forEach((_, i) => {
    const pose = crowd.pre(i, dt, simTime);
    crowd.motions[i].targetSpeed = 0;
    crowd.advance(i, dt);
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
  if (++frames === 2) (window as any).__mini = { ready: true, renderer: stage.renderer, camera: stage.camera, people, debug: () => ({ actors: crowd.actors, motions: crowd.motions, logs, pile, horse, forest }) };
}

stage.resize();
for (let i = 0, n = Math.round(num('t', 0) * 60); i < n; i++) simulate(1 / 60);
simulate(0);
stage.run(frame);
