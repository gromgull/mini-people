import * as THREE from 'three';
import GUI from 'lil-gui';
import type { Person } from './body';
import { BEARD_STYLES, type Genome, HAIR_STYLES, SHAPE_GENES, randomGenome } from './genome';
import { PALETTE } from './palette';
import { PARTS_LAYER } from './skin';
import { Trees } from './trees';
import { Pond } from './pond';
import { Houses } from './houses';
import { mulberry32 } from './rng';
import { type Motion, WALK_SPEED, defaultGait, newMotion } from './gait';
import { Animator } from './animate';
import { PERSONA_KEYS, PRESETS, derivePersona } from './persona';
import { ACTIONS, type ActionKind, Actor, BPM } from './actions';
import type { Where } from './audio';
import { Wander, type WanderState, scatter, wanderRadius } from './wander';
import { Gaze, LOOK_MODES, type LookMode } from './gaze';
import { Stage, VIEW_H, lookFromQuery, num, q } from './stage';
import { Crowd } from './crowd';

/**
 * The demo: modes for looking at people (single, a grid, a parade ring, a
 * wandering crowd, persona lanes), every action on a key, and a GUI for
 * all the knobs. The village (index.html) is the other app on the same code.
 */

const MODES = ['single', 'stand', 'parade', 'wander', 'compare'] as const;
type Mode = (typeof MODES)[number];



const settings = {
  ...lookFromQuery(),
  seed: num('seed', 1),
  count: num('count', 48),
  spacing: num('spacing', 0.9),
  spin: q.has('spin'),
  segments: num('segs', 8),
  eyes: true,
  merge: q.get('merge') !== '0', // one draw call per person (rigid skinning) instead of one per part
  mode: (MODES.includes(q.get('mode') as Mode) ? q.get('mode') : 'parade') as Mode,
  speed: num('speed', WALK_SPEED),
  animFps: num('fps', 0), // 0 = smooth; 8–12 = classic sprite feel
  follow: q.has('follow'),
  paused: q.has('paused'),
  gait: { ...defaultGait },
  personality: num('persona', 1), // global exaggeration of everyone's persona
  autoActions: q.has('auto'),
  musicSeated: q.has('sitplay'), // fiddlers and banjo players sit down to play
  walk: q.has('walk'), // single mode: stroll a loop instead of standing still
  trees: q.get('trees') !== '0',
  pond: q.get('pond') !== '0',
  houses: q.get('houses') !== '0',
  lookAt: (LOOK_MODES.includes(q.get('look') as LookMode) ? q.get('look') : 'auto') as LookMode,
};

// ---------------------------------------------------------------- renderer / scene

const stage = new Stage(settings);
const { renderer, scene, camera, controls, toon, outline, selectMat } = stage;
const resize = () => stage.resize();

// ---------------------------------------------------------------- population

let people: Person[] = [];
let selected = 0;
const selectGeo = new THREE.RingGeometry(1.05, 1.25, 28).rotateX(-Math.PI / 2);
const trees = new Trees(toon, outline, stage.shadowGeo, stage.shadowMat);
scene.add(trees.group);
const pond = new Pond(toon, outline);
scene.add(pond.group);
const houses = new Houses(toon, outline, stage.shadowMat);
scene.add(houses.group);
const selectRing = new THREE.Mesh(selectGeo, selectMat);
selectRing.position.y = 0.004;

function slotTransform(i: number) {
  const cols = Math.ceil(Math.sqrt(settings.count * 1.5));
  const rows = Math.ceil(settings.count / cols);
  const r = mulberry32(settings.seed * 7919 + i);
  const x = (i % cols) - (cols - 1) / 2 + (r() - 0.5) * 0.25;
  const z = Math.floor(i / cols) - (rows - 1) / 2 + (r() - 0.5) * 0.25;
  return { x: x * settings.spacing, z: z * settings.spacing, rot: (r() - 0.5) * 0.7 };
}

const crowd = new Crowd(stage, settings);
const sound = crowd.sound;
const voiceOf = (p: Person) => crowd.voiceOf(p);

function makePerson(i: number, genome = randomGenome(settings.seed * 100003 + i)) {
  const p = crowd.spawn(genome, i);
  const t = slotTransform(i);
  p.root.position.set(t.x, 0, t.z);
  p.root.rotation.y = t.rot;
  return p;
}

const removePerson = (p: Person) => crowd.despawn(p);

// motion state lives beside the person so rebuilding a body keeps its stride
let motions: Motion[] = [];
let anims: Animator[] = [];
let actors: Actor[] = [];
let gazes: Gaze[] = [];
let cursorWorld: THREE.Vector3 | null = null;
let offsets: { x: number; z: number; yaw: number; locked: boolean }[] = [];
let nextAuto: number[] = [];
let simTime = 0;
let spinAngle = 0;
// deterministic action trigger for tests: ?act=fall&actAt=0.5 (person = ?select or 0)
let scheduled: { at: number; who: number; kind: ActionKind; push?: THREE.Vector3 } | null =
  ACTIONS.includes(q.get('act') as ActionKind)
    ? { at: num('actAt', 0), who: q.has('actAll') ? -1 : num('select', 0), kind: q.get('act') as ActionKind }
    : null;
let wanders: WanderState[] = [];
const wanderSpread = () => settings.spacing / 0.9; // spacing slider, 0.9 = default density // wander mode: everyone's own position/heading/plan
let brain = new Wander(mulberry32(settings.seed * 7919));
let along: number[] = []; // distance travelled along the parade ring / lane
let compareBase: Genome | null = null; // the body every lane shares in compare mode
let singleGenome: Genome | null = null; // who single mode shows (else ?who= from the seed)
const SINGLE_R = 1.0; // radius of the single-mode stroll
const COMPARE = q.get('lanes')?.split(',').filter((k) => PRESETS[k]) ?? Object.keys(PRESETS);
const LANE_LEN = 9;
const LANE_GAP = 0.85;

const ringRadius = () => Math.max(1.2, (settings.count * 0.72) / (Math.PI * 2));
const styleOf = (p: Person) => crowd.styleOf(p);

/** Where the mode wants person i to be (before action offsets). */
function baseTransform(i: number) {
  if (settings.mode === 'stand') {
    const t = slotTransform(i);
    return { x: t.x, z: t.z, yaw: t.rot + spinAngle };
  }
  if (settings.mode === 'wander') {
    const w = wanders[i];
    return { x: w.x, z: w.z, yaw: w.yaw };
  }
  if (settings.mode === 'parade' || settings.mode === 'single') {
    const R = settings.mode === 'single' ? SINGLE_R : ringRadius();
    const th = along[i] / R;
    // counter-clockwise: velocity = (-sin, 0, cos)
    return { x: Math.cos(th) * R, z: Math.sin(th) * R, yaw: Math.atan2(-Math.sin(th), Math.cos(th)) };
  }
  // straight lanes toward the camera, wrapping off-screen
  const z = (((along[i] + LANE_LEN / 2) % LANE_LEN) + LANE_LEN) % LANE_LEN - LANE_LEN / 2;
  return { x: (i - (people.length - 1) / 2) * LANE_GAP, z, yaw: 0 };
}

/**
 * Place a person: path position + a decaying offset. While an action owns the
 * root (ragdoll, getting up) we leave it alone; when it lets go we capture the
 * difference as an offset and ease it away, so nobody snaps back to the path.
 */
function placeOne(i: number, lift = 0, spin = 0, fwd = 0) {
  const p = people[i];
  const a = actors[i];
  const o = offsets[i];
  const b = baseTransform(i);
  if (a?.rootLocked) {
    o.locked = true;
    return;
  }
  if (o.locked && settings.mode === 'wander') {
    // wanderers simply continue from wherever the action left them
    o.locked = false;
    const w = wanders[i];
    w.x = p.root.position.x;
    w.z = p.root.position.z;
    w.yaw = p.root.rotation.y;
    w.walking = false;
    o.x = o.z = o.yaw = 0;
    b.x = w.x; b.z = w.z; b.yaw = w.yaw;
  }
  if (o.locked) {
    o.locked = false;
    o.x = p.root.position.x - b.x;
    o.z = p.root.position.z - b.z;
    o.yaw = Math.atan2(Math.sin(p.root.rotation.y - b.yaw), Math.cos(p.root.rotation.y - b.yaw));
  }
  const yaw = b.yaw + o.yaw + spin;
  p.root.position.set(b.x + o.x + Math.sin(yaw) * fwd, lift, b.z + o.z + Math.cos(yaw) * fwd);
  p.root.rotation.y = yaw;
}

function placeAll() {
  people.forEach((_, i) => placeOne(i));
}

function setTargetSpeeds() {
  people.forEach((p, i) => {
    const m = motions[i];
    if (!m) return;
    if (settings.mode === 'stand' || settings.mode === 'wander') m.targetSpeed = 0;
    else if (settings.mode === 'parade') m.targetSpeed = settings.speed; // same speed or they'd collide
    else if (settings.mode === 'single' && !settings.walk) m.targetSpeed = 0;
    else m.targetSpeed = settings.speed * styleOf(p).speedK;
  });
}

function setMode(mode: Mode) {
  const rebuild = (mode === 'compare') !== (settings.mode === 'compare') || mode === 'compare' || (mode === 'single') !== (settings.mode === 'single');
  if (mode === 'compare' && settings.mode !== 'compare') compareBase = structuredClone(people[selected]?.genome ?? randomGenome(1));
  if (mode === 'single' && settings.mode !== 'single') singleGenome = structuredClone(people[selected]?.genome ?? randomGenome(1));
  if (mode === 'wander') {
    // start from wherever everyone is standing now
    wanders = people.map((p) => ({ x: p.root.position.x, z: p.root.position.z, yaw: p.root.rotation.y, tx: 0, tz: 0, walking: false, face: null, until: simTime + Math.random() * 2 }));
    offsets.forEach((o) => (o.x = o.z = o.yaw = 0));
  }
  settings.mode = mode;
  if (rebuild) rebuildAll();
  if (mode === 'single') {
    // look at the middle of their little loop
    const off = camera.position.clone().sub(controls.target);
    controls.target.set(0, 0.5, 0);
    camera.position.copy(controls.target).add(off);
  }
  setTargetSpeeds();
  placeAll();
  fitCamera();
}

function genomeFor(i: number): Genome {
  if (settings.mode === 'single') return structuredClone(singleGenome ?? randomGenome(settings.seed * 100003 + num('who', 0)));
  if (settings.mode !== 'compare') return randomGenome(settings.seed * 100003 + i);
  const g = structuredClone(compareBase ?? randomGenome(1));
  g.persona = { ...PRESETS[COMPARE[i]] };
  return g;
}

function rebuildAll() {
  people.forEach(removePerson);
  const n = settings.mode === 'compare' ? COMPARE.length : settings.mode === 'single' ? 1 : settings.count;
  people = Array.from({ length: n }, (_, i) => makePerson(i, genomeFor(i)));
  const r = mulberry32(settings.seed * 31 + 7);
  motions = people.map(() => newMotion(r()));
  anims = people.map((_, i) => new Animator(settings.seed * 977 + i));
  actors.forEach((a) => a.dispose());
  actors = people.map((p) => new Actor(p, crowd.kit));
  gazes = people.map((p, i) => new Gaze(p, i, mulberry32(settings.seed * 4243 + i)));
  offsets = people.map(() => ({ x: 0, z: 0, yaw: 0, locked: false }));
  Object.assign(crowd, { people, motions, anims, actors, gazes });
  wanders = scatter(n, mulberry32(settings.seed * 91 + 3), wanderSpread());
  brain = new Wander(mulberry32(settings.seed * 7919));
  brain.spread = wanderSpread();
  nextAuto = people.map(() => simTime + 1 + Math.random() * 6);
  const gap = settings.mode === 'compare' ? 0 : (Math.PI * 2 * ringRadius()) / n;
  along = people.map((_, i) => (settings.mode === 'compare' ? -1.5 + r() * 0.3 : i * gap));
  setTargetSpeeds();
  motions.forEach((m) => (m.speed = m.targetSpeed)); // start already walking
  placeAll();
  syncLabels();
  select(Math.min(selected, people.length - 1));
}

function rebuildOne(i: number) {
  const g = people[i].genome;
  actors[i]?.dispose();
  removePerson(people[i]);
  people[i] = makePerson(i, g);
  actors[i] = new Actor(people[i], crowd.kit);
  gazes[i] = new Gaze(people[i], i, mulberry32(settings.seed * 4243 + i));
  placeAll();
  attachRing();
}

const TURN_FIRST = 0.5; // rad: further off-path than this → turn on the spot before walking

function modeSpeed(i: number) {
  if (actors[i]?.holdSpeed || settings.mode === 'stand') return 0;
  const o = offsets[i];
  if (o && (o.locked || Math.abs(o.yaw) > TURN_FIRST)) return 0;
  if (settings.mode === 'parade') return settings.speed; // same speed or they'd collide
  if (settings.mode === 'single' && !settings.walk) return 0;
  return settings.speed * styleOf(people[i]).speedK;
}



const AUTO_POOL: ActionKind[] = ['wave', 'wave', 'jump', 'jump', 'hammer', 'fall', 'carry', 'carry', 'sit', 'talk', 'talk', 'saw', 'fiddle', 'dance', 'chop', 'pick', 'fish', 'dine', 'eat', 'drink', 'banjo', 'bass', 'pipe', 'pipe'];

function act(i: number, kind: ActionKind, push?: THREE.Vector3) {
  // hammering mid-parade would leave people standing in the stream
  if ((kind === 'hammer' || kind === 'saw' || kind === 'fiddle' || kind === 'dance' || kind === 'chop' || kind === 'pick' || kind === 'fish' || kind === 'dine' || kind === 'eat' || kind === 'drink' || kind === 'banjo' || kind === 'bass' || kind === 'pipe') && settings.mode === 'parade') kind = 'wave';
  const a = actors[i];
  if (!a) return;
  if (kind === 'talk') return startTalk(i);
  const music = kind === 'fiddle' || kind === 'banjo' || kind === 'bass';
  a.start(kind, { push, seated: music && kind !== 'bass' && settings.musicSeated });
  if (music && settings.mode === 'wander') {
    // music! some idle folk nearby get up and dance, and now and then
    // someone fetches their own fiddle, banjo or double bass and joins in
    const me = people[i].root.position;
    let band = 0;
    people.forEach((o, j) => {
      if (j !== i && !actors[j].busy && !wanders[j]?.walking && o.root.position.distanceTo(me) < 2.6 && Math.random() < 0.6) {
        const r = Math.random();
        const kind = band < 2 && r < 0.3 ? (r < 0.12 ? 'fiddle' : r < 0.22 ? 'banjo' : 'bass') : 'dance';
        if (kind !== 'dance') band++;
        setTimeout(() => !actors[j].busy && actors[j].start(kind, { seated: kind !== 'dance' && kind !== 'bass' && settings.musicSeated }), (kind === 'dance' ? 300 : 800) + Math.random() * 1500);
      }
    });
  }
}

/** Talk to the nearest free neighbour (who talks back), or to nobody. */
function startTalk(i: number) {
  const me = people[i].root.position;
  let best = -1;
  let bestD = 1.6;
  people.forEach((o, j) => {
    if (j === i || actors[j].busy || (settings.mode === 'wander' && wanders[j]?.walking)) return;
    const d = o.root.position.distanceTo(me);
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  });
  for (const [a, b] of best >= 0 ? [[i, best], [best, i]] : [[i, -1]]) {
    actors[a].start('talk');
    actors[a].partner = b;
    if (settings.mode === 'parade' || (settings.mode === 'single' && settings.walk)) actors[a].holdSpeed = false; // chat on the move
    if (settings.mode === 'wander' && b >= 0) {
      const w = wanders[a];
      const o = people[b].root.position;
      w.walking = false;
      w.face = Math.atan2(o.x - w.x, o.z - w.z);
    }
  }
}

/** One simulation step: actions, locomotion, animation, effects. */
function simulate(dt: number) {
  simTime += dt;
  if (settings.mode === 'stand' && settings.spin) spinAngle += dt * 0.8;
  if (scheduled && simTime >= scheduled.at) {
    if (scheduled.who < 0) people.forEach((_, i) => act(i, scheduled!.kind));
    else act(scheduled.who, scheduled.kind, scheduled.push);
    scheduled = null;
  }
  const decay = 1 - Math.exp(-dt * 1.5);
  crowd.beginStep(simTime, cursorWorld, selected);
  const turnStep = 3.2 * dt; // rad/s turning on the spot
  people.forEach((p, i) => {
    const m = motions[i];
    const a = actors[i];
    const st = styleOf(p);
    if (settings.autoActions && settings.mode !== 'wander' && !a.busy && simTime > nextAuto[i]) {
      const k = AUTO_POOL[Math.floor(Math.random() * AUTO_POOL.length)];
      act(i, k === 'sit' && settings.mode === 'parade' ? 'carry' : k); // no benches in the stream
      nextAuto[i] = simTime + 3 + Math.random() * 10;
    }
    let pose = crowd.pre(i, dt, simTime);
    const o = offsets[i];
    if (settings.mode === 'wander') {
      if (a.depart) brain.send(i, wanders); // off somewhere with what they've got
      const plan = brain.think(i, wanders, { busy: a.busy, holdSpeed: a.holdSpeed || o.locked, speed: m.speed, prefSpeed: settings.speed * st.speedK }, simTime, dt);
      if (plan.act) {
        act(i, plan.act);
        pose = a.pre(0, m, st);
      }
      m.targetSpeed = plan.speed;
      crowd.advance(i, dt);
      if (!o.locked) brain.move(i, wanders, m.speed, dt);
    } else {
      m.targetSpeed = modeSpeed(i);
      crowd.advance(i, dt);
    }
    if (settings.mode !== 'stand' && settings.mode !== 'wander') along[i] += m.speed * dt;
    if (!o.locked && settings.mode !== 'wander') {
      // Turn back toward the path at a steady rate (plus a soft finish), and
      // only drift back onto it while actually walking — never skate.
      const ay = Math.max(0, Math.abs(o.yaw) - turnStep);
      o.yaw = Math.sign(o.yaw) * (ay - ay * decay);
      if (settings.mode !== 'stand') {
        const k = decay * Math.min(1, m.speed / WALK_SPEED);
        o.x -= o.x * k;
        o.z -= o.z * k;
      }
    }
    placeOne(i, pose?.lift ?? 0, pose?.spin ?? 0, pose?.fwd ?? 0);
    crowd.post(i, dt, simTime, pose);
  });
  crowd.endStep(dt);
}

// ---------------------------------------------------------------- labels (compare mode)

const labelLayer = document.createElement('div');
labelLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;font:600 12px ui-monospace,monospace;color:#fff;';
document.body.appendChild(labelLayer);
let labels: HTMLDivElement[] = [];

function syncLabels() {
  labels.forEach((l) => l.remove());
  labels = settings.mode !== 'compare' ? [] : COMPARE.map((name) => {
    const el = document.createElement('div');
    el.textContent = name;
    el.style.cssText = 'position:absolute;transform:translate(-50%,-100%);padding:1px 5px;background:#0008;border-radius:3px;white-space:nowrap;';
    labelLayer.appendChild(el);
    return el;
  });
}

const _lp = new THREE.Vector3();
function updateLabels() {
  labels.forEach((el, i) => {
    const p = people[i];
    if (!p) return;
    _lp.set(0, p.dims.height + 0.12, 0).applyMatrix4(p.root.matrixWorld).project(camera);
    el.style.left = `${((_lp.x + 1) / 2) * window.innerWidth}px`;
    el.style.top = `${((1 - _lp.y) / 2) * window.innerHeight}px`;
  });
}

function fitCamera() {
  if (q.has('zoom')) return;
  camera.zoom = settings.mode === 'single' ? (VIEW_H * 0.3) / (SINGLE_R * 0.75) : settings.mode === 'parade' ? Math.min(1, (VIEW_H * 0.42) / (ringRadius() + 0.6)) : settings.mode === 'wander' ? Math.min(1.4, (VIEW_H * 0.5) / (wanderRadius(people.length, wanderSpread()) * 0.7 + 0.4)) : settings.mode === 'compare' ? 1.25 : 1;
  camera.updateProjectionMatrix();
}

function attachRing() {
  const p = people[selected];
  if (!p) return;
  selectRing.scale.setScalar(Math.max(p.dims.hipR, p.dims.shoulderR, p.dims.waistR) * 1.4);
  p.root.add(selectRing);
  selectRing.visible = settings.mode !== 'single'; // no need to point out the only one
}

// ---------------------------------------------------------------- GUI

const gui = new GUI({ title: 'Mini People' });
if (q.has('nogui')) {
  gui.hide();
  document.getElementById('hint')?.remove();
}

const pop = gui.addFolder('Population');
const newCrowd = () => {
  singleGenome = null; // single mode shows someone from the new seed
  rebuildAll();
};
pop.add(settings, 'seed', 1, 9999, 1).onFinishChange(newCrowd);
pop.add(settings, 'count', 1, 200, 1).onFinishChange(rebuildAll);
pop.add(settings, 'spacing', 0.5, 2, 0.05).onChange(() => {
  brain.spread = wanderSpread();
  if (settings.mode === 'wander') {
    // re-scatter at the new density
    wanders = scatter(people.length, mulberry32(settings.seed * 91 + 3), wanderSpread());
    fitCamera();
  }
  placeAll();
});
pop.add({ reroll: () => { settings.seed = Math.floor(Math.random() * 9999) + 1; pop.controllersRecursive().forEach((c) => c.updateDisplay()); newCrowd(); } }, 'reroll').name('🎲 new crowd');
pop.add(settings, 'spin').name('spin (stand mode)');

const motion = gui.addFolder('Motion');
motion.add({ mode: settings.mode }, 'mode', MODES).onChange(setMode);
const walkCtl = motion.add(settings, 'walk').name('🚶 walk (single)  [W]').onChange(setTargetSpeeds);
motion.add(settings, 'speed', 0, 1.5, 0.01).onChange(setTargetSpeeds);
motion.add(settings, 'personality', 0, 2, 0.01).name('personality amount');
motion.add(settings, 'animFps', 0, 30, 1).name('anim fps (0=smooth)');
motion.add(settings, 'paused');
motion.add(settings, 'follow').name('camera follows selected');
const gaitF = motion.addFolder('Gait').close();
const G = settings.gait;
gaitF.add(G, 'stride', 0.6, 2.5, 0.01);
gaitF.add(G, 'duty', 0.5, 0.75, 0.01).name('duty (ground time)');
gaitF.add(G, 'stepHeight', 0, 0.4, 0.005).name('step height');
gaitF.add(G, 'bounce', 0, 0.15, 0.001);
gaitF.add(G, 'sway', 0, 1.5, 0.01);
gaitF.add(G, 'hipYaw', 0, 0.6, 0.01).name('hip yaw');
gaitF.add(G, 'hipRoll', 0, 0.3, 0.005).name('hip roll');
gaitF.add(G, 'shoulderTwist', 0, 3, 0.05).name('shoulder twist');
gaitF.add(G, 'armSwing', 0, 1.4, 0.01).name('arm swing');
gaitF.add(G, 'lean', -0.2, 0.5, 0.01);
gaitF.add(G, 'crouch', 0, 0.25, 0.005);
gaitF.add(G, 'stance', 0, 2, 0.01).name('stance width');
gaitF.add(G, 'footRoll', 0, 0.8, 0.01).name('foot roll');
gaitF.add({ reset: () => { Object.assign(G, defaultGait); gaitF.controllersRecursive().forEach((c) => c.updateDisplay()); } }, 'reset');

const actF = gui.addFolder('Actions');
for (const [k, label] of [['wave', '👋 wave  [1]'], ['hammer', '🔨 hammer  [2]'], ['jump', '⤴ jump  [3]'], ['fall', '🤕 trip  [4]'], ['carry', '📦 carry  [5]'], ['sit', '🪑 sit  [6]'], ['talk', '💬 talk  [7]'], ['saw', '🪚 saw  [8]'], ['fiddle', '🎻 fiddle  [9]'], ['dance', '💃 dance  [0]'], ['chop', '🪓 chop a tree  [C]'], ['pick', '🍎 pick an apple  [A]'], ['fish', '🎣 fish  [F]'], ['dine', '🍽 sit at a table  [T]'], ['eat', '🐟 eat  [E]'], ['drink', '🍺 drink  [D]'], ['haul', '🪵 haul a log  [H]'], ['banjo', '🪕 banjo  [B]'], ['bass', '🎻 double bass  [U]'], ['pipe', '💨 smoke a pipe  [P]'], ['armful', '🔥 armful of firewood  [G]']] as const)
  actF.add({ go: () => act(selected, k) }, 'go').name(label);
actF.add({ all: () => people.forEach((_, i) => setTimeout(() => act(i, 'jump'), Math.random() * 400)) }, 'all').name('everyone jump!');
actF.add({ all: () => people.forEach((_, i) => act(i, 'fall')) }, 'all').name('everyone trip!');
actF.add(settings, 'autoActions').name('random crowd actions');
actF.add(settings, 'musicSeated').name('musicians sit down');
actF.add(settings, 'lookAt', LOOK_MODES).name('👀 look at');

const sndF = gui.addFolder('Sound');
const applySound = () => sound.apply();
sndF.add(sound.settings, 'enabled').name('🔊 on').onChange(applySound);
sndF.add(sound.settings, 'volume', 0, 1, 0.01).onChange(applySound);
sndF.add(sound.settings, 'steps', 0, 1.5, 0.01).name('footsteps').onChange(applySound);
sndF.add(sound.settings, 'voices', 0, 1.5, 0.01).onChange(applySound);
sndF.add(sound.settings, 'tools', 0, 1.5, 0.01).name('tools & props').onChange(applySound);
sndF.add(sound.settings, 'music', 0, 1.5, 0.01).onChange(applySound);
sndF.add(sound.settings, 'crunch').name('retro crunch').onChange(applySound);
// sound lab: audition each recipe on its own, with the selected person's voice
const lab = sndF.addFolder('Sound lab').close();
const labV = () => (people[selected] ? voiceOf(people[selected]) : { f0: 150, formant: 1, rate: 1, weight: 0.5 });
const C: Where = { pan: 0, gain: 1 };
const labWalk = (weight: number) => {
  const v = { ...labV(), weight };
  for (let k = 0; k < 6; k++) setTimeout(() => sound.step(v, { pan: k % 2 ? 0.15 : -0.15, gain: 1 }), k * 330);
};
const labBtn = (name: string, fn: () => void) => lab.add({ go: () => { sound.start(); setTimeout(fn, 30); } }, 'go').name(name);
labBtn('one step', () => sound.step(labV(), C));
labBtn('steps: light', () => labWalk(0.1)); // (a six-step walk)
labBtn('steps: heavy', () => labWalk(0.95));
labBtn('steps: selected person', () => labWalk(labV().weight));
labBtn('talk: selected person', () => sound.phrase(-1, labV(), C));
labBtn('talk: deep voice', () => sound.phrase(-1, { f0: 100, formant: 0.9, rate: 0.85, weight: 0.8 }, C));
labBtn('talk: high voice', () => sound.phrase(-1, { f0: 235, formant: 1.22, rate: 1.2, weight: 0.2 }, C));
labBtn('hammer blow', () => sound.hammer(C));
labBtn('saw (3 strokes)', () => {
  const t0 = performance.now();
  const tick = () => {
    const u = (performance.now() - t0) / 620;
    const on = u < 3;
    sound.saw(-1, on, Math.abs(Math.sin(Math.PI * 2 * u)), u % 1 < 0.5, C);
    if (on) requestAnimationFrame(tick);
  };
  tick();
});
for (const k of ['oof', 'hup', 'grunt', 'gasp', 'hey'] as const) labBtn(k, () => sound.exclaim(k, labV(), C));
labBtn('box down (thunk)', () => sound.thunk(C, 1));
labBtn('bench creak', () => sound.creak(C));
labBtn('clap', () => sound.clap(C));
labBtn('fiddle tune', () => {
  const eighth = 30 / BPM;
  [0, 2, 4, 7, 9, 7, 4, 2, 0, 4, 7, 12, 9, 7, 4, 0].forEach((s, k) => setTimeout(() => sound.fiddleNote(293.66 * 2 ** (s / 12), eighth * (k === 15 ? 2 : 1), C), k * eighth * 1000));
});

window.addEventListener('keydown', (e) => {
  const k = ({ '1': 'wave', '2': 'hammer', '3': 'jump', '4': 'fall', '5': 'carry', '6': 'sit', '7': 'talk', '8': 'saw', '9': 'fiddle', '0': 'dance' } as const)[e.key as '1'];
  const k2 = ({ c: 'chop', a: 'pick', f: 'fish', t: 'dine', e: 'eat', d: 'drink', h: 'haul', b: 'banjo', u: 'bass', p: 'pipe', g: 'armful' } as const)[e.key.toLowerCase() as 'c'];
  if (k) act(selected, k);
  if (k2 && !e.ctrlKey && !e.metaKey) act(selected, k2);
  if (e.key === 'w' || e.key === 'W') walkCtl.setValue(!settings.walk);
  if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) statsCtl.setValue(!settings.stats);
});

let selFolder: GUI | null = null;
function select(i: number) {
  selected = i;
  attachRing();
  selFolder?.destroy();
  const p = people[i];
  if (!p) return;
  selFolder = gui.addFolder(`Person #${i}`);
  const g = p.genome;
  const rebuild = () => rebuildOne(selected);
  const shape = selFolder.addFolder('Shape');
  for (const k of SHAPE_GENES) shape.add(g, k, 0, 1, 0.01).onChange(rebuild);
  const looks = selFolder.addFolder('Looks');
  const idx = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, j) => [String(j), j]));
  looks.add(g, 'skin', idx(PALETTE.skin.length)).onChange(rebuild);
  looks.add(g, 'hair', idx(PALETTE.hair.length)).onChange(rebuild);
  looks.add(g, 'hairStyle', Object.fromEntries(HAIR_STYLES.map((n, j) => [n, j]))).onChange(rebuild);
  looks.add(g, 'lips', idx(PALETTE.lips.length)).onChange(rebuild);
  looks.add(g, 'beard', Object.fromEntries(BEARD_STYLES.map((n, j) => [n, j]))).onChange(rebuild);
  looks.add(g, 'shirt', idx(PALETTE.shirt.length)).onChange(rebuild);
  looks.add(g, 'pants', idx(PALETTE.pants.length)).onChange(rebuild);
  looks.add(g, 'shoes', idx(PALETTE.shoes.length)).onChange(rebuild);
  looks.add(g, 'longSleeves').onChange(rebuild);
  looks.add(g, 'shorts').onChange(rebuild);
  looks.add(g, 'skirt').onChange(rebuild);
  const pers = selFolder.addFolder('Personality');
  for (const k of PERSONA_KEYS) pers.add(g.persona, k, 0, 1, 0.01).onChange(setTargetSpeeds);
  const refresh = () => pers.controllersRecursive().forEach((c) => c.updateDisplay());
  pers.add({ preset: '—' }, 'preset', ['—', ...Object.keys(PRESETS)]).onChange((name: string) => {
    if (PRESETS[name]) Object.assign(g.persona, PRESETS[name]);
    refresh();
    setTargetSpeeds();
  });
  pers.add({ derive: () => { Object.assign(g.persona, derivePersona(g, mulberry32(Math.random() * 1e9))); refresh(); setTargetSpeeds(); } }, 'derive').name('🎲 from body');
  selFolder.add({ randomize: () => {
    const ng = randomGenome(Math.floor(Math.random() * 1e9));
    Object.assign(p.genome, ng);
    rebuild();
    select(selected);
  } }, 'randomize').name('🎲 randomize person');
}

const look = gui.addFolder('Look');
const refill = () => stage.refillAtlas();
look.add(settings, 'pixelSize', 1, 8, 1).name('pixel size').onChange(resize);
look.add(settings, 'maxFps', { '15': 15, '24': 24, '30': 30, '60': 60, uncapped: 0 }).name('max fps');
const statsCtl = look.add(settings, 'stats').name('show fps  [S]');
look.add(settings, 'sky').name('sky & horizon');
look.add(settings.ramp, 'bands', 1, 5, 1).onChange(refill);
look.add(settings.ramp, 'smooth').onChange(refill);
look.add(settings.ramp, 'bias', 0.3, 3, 0.05).name('shadow bias').onChange(refill);
look.add(settings.ramp, 'shadowDepth', 0, 0.6, 0.01).name('shadow depth').onChange(refill);
look.add(settings.ramp, 'hueShift', 0, 0.2, 0.005).name('hue shift').onChange(refill);
look.add(settings.ramp, 'highlight', 0, 0.5, 0.01).onChange(refill);
look.add(settings, 'wrap', 0, 1, 0.01).name('light wrap');
const timeF = gui.addFolder('Time of day');
timeF.add(settings, 'time', 0, 24, 0.05).name('time (h)').decimals(2).listen();
timeF.add(settings, 'dayCycle').name('run');
timeF.add(settings, 'dayMinutes', 1, 120, 1).name('day length (min)');
look.add(settings, 'shadowLength', 0, 1.5, 0.05).name('shadow length');
look.add(settings, 'outline');
look.add(settings, 'outlinePx', 0.5, 3, 0.25).name('outline px');
look.addColor(settings, 'outlineColor').name('outline color');
look.add(settings, 'segments', 4, 16, 2).onFinishChange(rebuildAll);
look.add(settings, 'eyes').onChange(rebuildAll);
look.add(settings, 'merge').name('one draw call each').onChange(rebuildAll);

const grassF = look.addFolder('Ground').close();
grassF.add(settings.grass, 'enabled').name('grass patches');
grassF.add(settings.grass, 'scale', 1, 20, 0.1).name('patch size');
grassF.add(settings.grass, 'ragged', 0, 0.4, 0.005).name('edge raggedness');
grassF.add(settings.grass, 'tooth', 0.05, 1.5, 0.01).name('tooth size');
grassF.add(settings.grass, 'contrast', 0, 2, 0.05).name('patch contrast');
grassF.add(settings.grass, 'flowers', 0, 1, 0.01).name('flowers');
grassF.add(settings.grass, 'flowerSize', 0.03, 0.1, 0.005).name('flower size');
grassF.add(settings, 'trees');
grassF.add(settings, 'pond');
grassF.add(settings, 'houses');

// ---------------------------------------------------------------- picking

const ray = new THREE.Raycaster();
ray.layers.enable(PARTS_LAYER); // merged people still pick by their (undrawn) parts
let downAt: [number, number] | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
// cursor → a point at roughly head height above the ground, for "look at cursor"
const lookPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.75);
renderer.domElement.addEventListener('pointermove', (e) => {
  const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  cursorWorld = ray.ray.intersectPlane(lookPlane, cursorWorld ?? new THREE.Vector3());
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(people.map((p) => p.root), true)[0];
  let o: THREE.Object3D | null = hit?.object ?? null;
  while (o && o.userData.index === undefined) o = o.parent;
  if (!o) return;
  if (e.shiftKey) {
    // shove away from the camera, slightly upward
    const dir = ray.ray.direction.clone().setY(0).normalize().multiplyScalar(2.2).setY(0.6);
    act(o.userData.index, 'fall', dir);
  } else select(o.userData.index);
});

// ---------------------------------------------------------------- loop

let frames = 0;
let simAcc = 0;

const FOCUS_Y = num('fy', 0.5); // focus height as a fraction of body height (0.85 ≈ face)

/** Move camera + orbit target so the selected person is centred. */
function focusSelected(k = 1) {
  const p = people[selected];
  if (!p) return;
  const off = camera.position.clone().sub(controls.target);
  controls.target.lerp(new THREE.Vector3(p.root.position.x, p.dims.height * FOCUS_Y, p.root.position.z), k);
  camera.position.copy(controls.target).add(off);
}

function frame(frameStart: number) {
  const dt = stage.delta();
  crowd.frameTick();
  let simulated = false;
  if (!settings.paused) {
    if (settings.animFps > 0) {
      // "animating on twos": pose & position only update at a low fixed rate
      const step = 1 / settings.animFps;
      simAcc += dt;
      while (simAcc >= step) {
        simulate(step);
        simAcc -= step;
        simulated = true;
      }
    } else {
      simulate(dt);
      simulated = true;
    }
  }
  // stop continuous sounds whose owner stopped reporting (mode switch, pause…)
  if (simulated || settings.paused) crowd.sweep();
  if (settings.follow) focusSelected(1 - Math.exp(-dt * 6));
  controls.update();

  stage.updateLight(dt, settings.paused);
  trees.group.visible = settings.trees;
  pond.group.visible = settings.pond;
  houses.group.visible = settings.houses;
  pond.update(simTime);
  crowd.orientShadows();
  if (trees.group.visible) for (const c of trees.casters) stage.orient(c, 0);
  if (houses.group.visible) houses.updateShadows(stage.lightWorld, settings.shadowLength);
  const tgt = controls.target;
  let extent = 0;
  for (const p of people) extent = Math.max(extent, Math.hypot(p.root.position.x - tgt.x, p.root.position.z - tgt.z));
  stage.updateEnvironment(dt, extent);

  updateLabels();
  stage.render(frameStart, people.length);

  if (++frames === 2) (window as any).__mini = { ready: true, renderer, camera, get people() { return people; }, select, sound, voiceOf, rebuild: (i: number) => rebuildOne(i), debug: () => ({ offsets, actors, motions, baseTransform }) };
}

resize();
rebuildAll();
fitCamera();
// deterministic pre-roll for screenshots: ?t=seconds (combine with &paused)
for (let i = 0, n = Math.round(num('t', 0) * 60); i < n; i++) simulate(1 / 60);
simulate(0);
if (q.has('select')) {
  select(num('select', 0));
  if (q.has('focus')) focusSelected();
}
stage.run(frame);
