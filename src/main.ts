import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { type Person, buildPerson } from './body';
import { BEARD_STYLES, MOUTH_STYLES, type Genome, HAIR_STYLES, SHAPE_GENES, randomGenome } from './genome';
import { PALETTE, ROWS, createAtlas, defaultRamp, fillAtlas } from './palette';
import { createFog, createGroundMaterial, createOutlineMaterial, createToonMaterial, defaultGrass } from './materials';
import { Clouds, createSky } from './environment';
import { mulberry32 } from './rng';
import { type Motion, WALK_SPEED, advance, defaultGait, newMotion } from './gait';
import { Animator } from './animate';
import { PERSONA_KEYS, PRESETS, derivePersona, styleFor } from './persona';
import { ACTIONS, type ActionKind, Actor, BPM } from './actions';
import { Sparks } from './fx';
import { Sound, type Voice, type Where, defaultAudio } from './audio';
import { Wander, type WanderState, scatter, wanderRadius } from './wander';
import { Gaze, type GazeWorld, LOOK_MODES, type LookMode } from './gaze';

const MODES = ['single', 'stand', 'parade', 'wander', 'compare'] as const;
type Mode = (typeof MODES)[number];

// Colours are authored as display values and the atlas does all the shading,
// so skip colour management entirely: what's in the atlas is what hits the screen.
THREE.ColorManagement.enabled = false;

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);

const settings = {
  seed: num('seed', 1),
  count: num('count', 48),
  spacing: num('spacing', 0.9),
  spin: q.has('spin'),
  segments: num('segs', 8),
  eyes: true,
  pixelSize: num('px', 3),
  outline: q.get('outline') !== '0',
  outlinePx: 1,
  outlineColor: '#1a1410',
  lightAz: 35,
  lightEl: 50,
  wrap: 0.35,
  ramp: { ...defaultRamp, smooth: q.get('smooth') === '1' },
  mode: (MODES.includes(q.get('mode') as Mode) ? q.get('mode') : 'parade') as Mode,
  speed: num('speed', WALK_SPEED),
  animFps: num('fps', 0), // 0 = smooth; 8–12 = classic sprite feel
  follow: q.has('follow'),
  paused: q.has('paused'),
  gait: { ...defaultGait },
  personality: num('persona', 1), // global exaggeration of everyone's persona
  autoActions: q.has('auto'),
  walk: q.has('walk'), // single mode: stroll a loop instead of standing still
  sky: q.get('sky') !== '0',
  grass: { ...defaultGrass, enabled: q.get('grass') !== '0', flowers: num('flowers', defaultGrass.flowers) },
  lookAt: (LOOK_MODES.includes(q.get('look') as LookMode) ? q.get('look') : 'auto') as LookMode,
};

// ---------------------------------------------------------------- renderer / scene

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#1d2a1a');

const atlas = createAtlas();
fillAtlas(atlas, settings.ramp);
// horizon haze: ground and everything on it fades out along the view direction
const fog = createFog();
const toon = createToonMaterial(atlas, fog);
const outline = createOutlineMaterial(fog);
// clouds live past the horizon, so they get materials without the haze
// (but share lighting and outline settings with everything else)
const cloudToon = createToonMaterial(atlas);
cloudToon.uniforms.uLightView = toon.uniforms.uLightView;
cloudToon.uniforms.uWrap.value = 1.6; // very soft light: white with a pale shade underneath
const cloudOutline = createOutlineMaterial();
for (const k of ['uPx', 'uResolution', 'uColor'] as const) cloudOutline.uniforms[k] = outline.uniforms[k];
const sky = createSky(fog);
scene.add(sky);
const clouds = new Clouds(cloudToon, cloudOutline);
scene.add(clouds.group);
let horizonFar = 30;
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
const selectMat = new THREE.MeshBasicMaterial({ color: '#ffe14a', depthWrite: false, transparent: true });

// ground: toon-lit like everything else, plus grass patches (falls back to plain toon)
const groundMat = createGroundMaterial(atlas, fog, ROWS.ground[0]);
groundMat.uniforms.uLightView = toon.uniforms.uLightView;
groundMat.uniforms.uWrap = toon.uniforms.uWrap;
let ground: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
{
  const g = new THREE.PlaneGeometry(1600, 1600);
  g.rotateX(-Math.PI / 2);
  g.setAttribute('aRow', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(ROWS.ground[0]), 1));
  ground = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(g, toon);
  scene.add(ground);
}

const VIEW_H = 6;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1200);
camera.zoom = num('zoom', 1);
{
  const az = THREE.MathUtils.degToRad(num('az', 25));
  const el = THREE.MathUtils.degToRad(num('el', 35));
  const r = 300; // far back: an ortho view doesn't change, but low angles mustn't start below the ground
  camera.position.set(Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r, Math.cos(az) * Math.cos(el) * r);
}
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);
camera.position.y += 0.5;
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;

// low-res target → nearest-neighbour upscale for the pixel look
const rt = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
const blitScene = new THREE.Scene();
const blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: rt.texture })));

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  const aspect = w / h;
  camera.left = (-VIEW_H * aspect) / 2;
  camera.right = (VIEW_H * aspect) / 2;
  camera.top = VIEW_H / 2;
  camera.bottom = -VIEW_H / 2;
  camera.updateProjectionMatrix();
  const px = Math.max(1, settings.pixelSize);
  const bw = Math.max(1, Math.floor((w * renderer.getPixelRatio()) / px));
  const bh = Math.max(1, Math.floor((h * renderer.getPixelRatio()) / px));
  rt.setSize(bw, bh);
  outline.uniforms.uResolution.value.set(bw, bh);
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- population

let people: Person[] = [];
let selected = 0;
const shadowGeo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
const selectGeo = new THREE.RingGeometry(1.05, 1.25, 28).rotateX(-Math.PI / 2);
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

function makePerson(i: number, genome = randomGenome(settings.seed * 100003 + i)) {
  const p = buildPerson(genome, toon, outline, { segments: settings.segments, eyes: settings.eyes });
  const t = slotTransform(i);
  p.root.position.set(t.x, 0, t.z);
  p.root.rotation.y = t.rot;
  p.root.userData.index = i;
  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  const sr = Math.max(p.dims.hipR, p.dims.shoulderR, p.dims.waistR) * 1.35;
  shadow.scale.setScalar(sr);
  shadow.position.y = 0.002;
  shadow.raycast = () => {};
  p.root.add(shadow);
  scene.add(p.root);
  return p;
}

function removePerson(p: Person) {
  scene.remove(p.root);
  p.dispose();
}

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
const kit = { toon, outline };
const sparks = new Sparks(scene);
// ---------------------------------------------------------------- sound
const sound = new Sound({ ...defaultAudio, enabled: !q.has('mute') });
const startSound = () => sound.start();
window.addEventListener('pointerdown', startSound);
window.addEventListener('keydown', startSound);
document.addEventListener('visibilitychange', () => sound.setHidden(document.hidden));
// Watchdog: if frames stop (alt-tab to an occluding window, minimised, …) the
// per-frame updates that keep continuous sounds honest stop too — so pause the
// whole engine until frames come back. Timers keep running when rAF doesn't.
let lastFrameAt = performance.now();
let stalled = false;
setInterval(() => {
  if (!stalled && performance.now() - lastFrameAt > 250) {
    stalled = true;
    sound.setHidden(true);
  }
}, 100);
let prevPhase: number[] = [];
let walkersHeard = 0; // on-screen walkers last frame (footsteps share the space)
let walkersNow = 0;
let wasGasping: boolean[] = [];
const voiceCache = new WeakMap<Person, Voice>();
const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;
/** A person's voice and tread, from their body and personality. */
function voiceOf(p: Person): Voice {
  let v = voiceCache.get(p);
  if (!v) {
    const g = p.genome;
    const small = 1 - g.height;
    v = {
      f0: lerpN(100, 235, 0.65 * g.fem + 0.35 * small) * (1.08 - 0.16 * g.girth) * (0.92 + 0.16 * g.persona.energy),
      formant: lerpN(0.9, 1.22, 0.55 * g.fem + 0.45 * small),
      rate: 0.8 + 0.5 * g.persona.energy,
      weight: Math.min(1, 0.55 * g.persona.weight + 0.45 * g.girth + 0.2 * g.height - 0.1),
    };
    voiceCache.set(p, v);
  }
  return v;
}
const _sp = new THREE.Vector3();
/** Stereo position + loudness from where the person is on screen; null = off-screen. */
function whereOf(p: Person): Where | null {
  _sp.set(0, p.dims.height * 0.8, 0).applyMatrix4(p.root.matrixWorld).project(camera);
  if (Math.abs(_sp.x) > 1.15 || Math.abs(_sp.y) > 1.15) return null;
  // what's near the middle of the view is what you're listening to
  const centre = Math.min(1, Math.max(0.2, 1.15 - 0.85 * Math.hypot(_sp.x, _sp.y)));
  return { pan: _sp.x * 0.8, gain: Math.min(1.2, 0.3 + 0.45 * camera.zoom) * centre };
}

const sawdust = new Sparks(scene, 48, ['#d9b77a', '#b8925a', '#e8d2a0'], 6);
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
const styleOf = (p: Person) => styleFor(settings.gait, p.genome.persona, settings.personality);

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
function placeOne(i: number, lift = 0, spin = 0) {
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
  p.root.position.set(b.x + o.x, lift, b.z + o.z);
  p.root.rotation.y = b.yaw + o.yaw + spin;
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
  actors = people.map((p) => new Actor(p, kit));
  gazes = people.map((p, i) => new Gaze(p, i, mulberry32(settings.seed * 4243 + i)));
  offsets = people.map(() => ({ x: 0, z: 0, yaw: 0, locked: false }));
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
  actors[i] = new Actor(people[i], kit);
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

const gazeWorld: GazeWorld = {
  mode: 'auto',
  people: [],
  busy: (i) => {
    const k = actors[i]?.kind;
    return k === 'fall' || k === 'jump' || k === 'hammer' || k === 'saw';
  },
  camera: new THREE.Vector3(),
  cursor: null,
  selected: 0,
  time: 0,
};


const AUTO_POOL: ActionKind[] = ['wave', 'wave', 'jump', 'jump', 'hammer', 'fall', 'carry', 'carry', 'sit', 'talk', 'talk', 'saw', 'fiddle', 'dance'];

function act(i: number, kind: ActionKind, push?: THREE.Vector3) {
  // hammering mid-parade would leave people standing in the stream
  if ((kind === 'hammer' || kind === 'saw' || kind === 'fiddle' || kind === 'dance') && settings.mode === 'parade') kind = 'wave';
  const a = actors[i];
  if (!a) return;
  if (kind === 'talk') return startTalk(i);
  a.start(kind, { push });
  if (kind === 'fiddle' && settings.mode === 'wander') {
    // music! some idle folk nearby get up and dance, and now and then
    // someone fetches their own fiddle and plays a harmony part
    const me = people[i].root.position;
    let band = 0;
    people.forEach((o, j) => {
      if (j !== i && !actors[j].busy && !wanders[j]?.walking && o.root.position.distanceTo(me) < 2.6 && Math.random() < 0.6) {
        const kind = band < 2 && Math.random() < 0.3 ? 'fiddle' : 'dance';
        if (kind === 'fiddle') band++;
        setTimeout(() => !actors[j].busy && actors[j].start(kind), (kind === 'fiddle' ? 800 : 300) + Math.random() * 1500);
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

/** Turn this frame's motion and action cues for person i into sound. */
function soundFor(i: number, p: Person, m: Motion, a: Actor, gasped: boolean) {
  const prev = prevPhase[i] ?? m.phase;
  prevPhase[i] = m.phase;
  if (!sound.live) {
    if (sound.ctx) sound.saw(i, false, 0, false, { pan: 0, gain: 0 });
    return;
  }
  const w = whereOf(p);
  const v = voiceOf(p);
  // heel strikes: left at phase 0, right at 0.5
  if (w && m.speed > 0.06 && !m.lockPhase && !a.rootLocked) {
    walkersNow++;
    // a crowd's footsteps blend into a patter instead of adding up
    const crowd = 1 / Math.sqrt(Math.max(1, walkersHeard / 1.5));
    const crossed = (at: number) => (prev < at && m.phase >= at) || (prev > m.phase && (at === 0 || m.phase >= at));
    if (crossed(0) || crossed(0.5)) sound.step(v, { pan: w.pan, gain: w.gain * crowd * Math.min(1, 0.5 + m.speed) });
  }
  sound.saw(i, !!w && a.kind === 'saw' && a.sawSpeed > 0, a.sawSpeed, a.sawPush, w ?? { pan: 0, gain: 0 });
  if (!w) return;
  if (a.impact) sound.hammer(w);
  if (a.note) sound.fiddleNote(a.note.f, a.note.dur, w);
  if (a.beat && Math.random() < (a.partner >= 0 ? 0.55 : 0.2) && !(a.partner >= 0 && sound.speaking(a.partner)) && !sound.speaking(i)) sound.phrase(i, v, w);
  if (gasped && Math.random() < 0.2) sound.exclaim('gasp', v, w);
  for (const e of a.events) {
    if (e === 'clap') sound.clap(w);
    else if (e === 'thunk') sound.thunk(w, 1);
    else if (e === 'log') sound.thunk(w, 0.8);
    else if (e === 'creak') sound.creak(w);
    else sound.exclaim(e, v, w);
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
  gazeWorld.mode = settings.lookAt;
  gazeWorld.people = people;
  gazeWorld.camera.copy(camera.position);
  gazeWorld.cursor = cursorWorld;
  gazeWorld.selected = selected;
  gazeWorld.time = simTime;
  const turnStep = 3.2 * dt; // rad/s turning on the spot
  walkersHeard = walkersNow;
  walkersNow = 0;
  people.forEach((p, i) => {
    const m = motions[i];
    const a = actors[i];
    const st = styleOf(p);
    if (settings.autoActions && settings.mode !== 'wander' && !a.busy && simTime > nextAuto[i]) {
      const k = AUTO_POOL[Math.floor(Math.random() * AUTO_POOL.length)];
      act(i, k === 'sit' && settings.mode === 'parade' ? 'carry' : k); // no benches in the stream
      nextAuto[i] = simTime + 3 + Math.random() * 10;
    }
    a.beatTime = (simTime * BPM) / 60; // shared beat: dancers and fiddlers keep time together
    let pose = a.pre(dt, m, st);
    const o = offsets[i];
    if (settings.mode === 'wander') {
      const plan = brain.think(i, wanders, { busy: a.busy, holdSpeed: a.holdSpeed || o.locked, speed: m.speed, prefSpeed: settings.speed * st.speedK }, simTime, dt);
      if (plan.act) {
        act(i, plan.act);
        pose = a.pre(0, m, st);
      }
      m.targetSpeed = plan.speed;
      advance(m, p, st.gait, dt);
      if (!o.locked) brain.move(i, wanders, m.speed, dt);
    } else {
      m.targetSpeed = modeSpeed(i);
      advance(m, p, st.gait, dt);
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
    placeOne(i, pose?.lift ?? 0, pose?.spin ?? 0);
    gazes[i].partner = a.kind === 'talk' ? a.partner : -1;
    gazes[i].aim(gazeWorld);
    anims[i].update(dt, p, m, st, p.root.rotation.y, pose, gazes[i].hint);
    a.post(dt, m, st);
    gazes[i].update(dt, simTime);
    const gasp = gazes[i].surprised || (a.kind === 'fall' && a.rootLocked);
    if (p.mouth) {
      // gasp while falling or while staring at someone else's drama
      p.mouth.rest.visible = !gasp;
      p.mouth.o.visible = gasp;
    }
    soundFor(i, p, m, a, gazes[i].surprised && !wasGasping[i]);
    wasGasping[i] = gazes[i].surprised;
    if (a.impact && a.hammerHead) {
      p.root.updateMatrixWorld(true);
      sparks.burst(a.hammerHead.getWorldPosition(new THREE.Vector3()), 7, Math.sqrt(p.dims.height));
    }
    if (a.dust && a.sawTip) {
      p.root.updateMatrixWorld(true);
      sawdust.burst(a.sawTip.getWorldPosition(new THREE.Vector3()), 4, 0.35);
    }
  });
  sparks.update(dt);
  sawdust.update(dt);
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
for (const [k, label] of [['wave', '👋 wave  [1]'], ['hammer', '🔨 hammer  [2]'], ['jump', '⤴ jump  [3]'], ['fall', '🤕 trip  [4]'], ['carry', '📦 carry  [5]'], ['sit', '🪑 sit  [6]'], ['talk', '💬 talk  [7]'], ['saw', '🪚 saw  [8]'], ['fiddle', '🎻 fiddle  [9]'], ['dance', '💃 dance  [0]']] as const)
  actF.add({ go: () => act(selected, k) }, 'go').name(label);
actF.add({ all: () => people.forEach((_, i) => setTimeout(() => act(i, 'jump'), Math.random() * 400)) }, 'all').name('everyone jump!');
actF.add({ all: () => people.forEach((_, i) => act(i, 'fall')) }, 'all').name('everyone trip!');
actF.add(settings, 'autoActions').name('random crowd actions');
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
  if (k) act(selected, k);
  if (e.key === 'w' || e.key === 'W') walkCtl.setValue(!settings.walk);
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
  looks.add(g, 'mouth', Object.fromEntries(MOUTH_STYLES.map((n, j) => [n, j]))).onChange(rebuild);
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
const refill = () => fillAtlas(atlas, settings.ramp);
look.add(settings, 'pixelSize', 1, 8, 1).name('pixel size').onChange(resize);
look.add(settings, 'sky').name('sky & horizon');
look.add(settings.ramp, 'bands', 1, 5, 1).onChange(refill);
look.add(settings.ramp, 'smooth').onChange(refill);
look.add(settings.ramp, 'bias', 0.3, 3, 0.05).name('shadow bias').onChange(refill);
look.add(settings.ramp, 'shadowDepth', 0, 0.6, 0.01).name('shadow depth').onChange(refill);
look.add(settings.ramp, 'hueShift', 0, 0.2, 0.005).name('hue shift').onChange(refill);
look.add(settings.ramp, 'highlight', 0, 0.5, 0.01).onChange(refill);
look.add(settings, 'wrap', 0, 1, 0.01).name('light wrap');
look.add(settings, 'lightAz', -180, 180, 1).name('light azimuth');
look.add(settings, 'lightEl', 5, 90, 1).name('light elevation');
look.add(settings, 'outline');
look.add(settings, 'outlinePx', 0.5, 3, 0.25).name('outline px');
look.addColor(settings, 'outlineColor').name('outline color');
look.add(settings, 'segments', 4, 16, 2).onFinishChange(rebuildAll);
look.add(settings, 'eyes').onChange(rebuildAll);

const grassF = look.addFolder('Ground').close();
grassF.add(settings.grass, 'enabled').name('grass patches');
grassF.add(settings.grass, 'scale', 1, 20, 0.1).name('patch size');
grassF.add(settings.grass, 'ragged', 0, 0.4, 0.005).name('edge raggedness');
grassF.add(settings.grass, 'tooth', 0.05, 1.5, 0.01).name('tooth size');
grassF.add(settings.grass, 'contrast', 0, 2, 0.05).name('patch contrast');
grassF.add(settings.grass, 'flowers', 0, 1, 0.01).name('flowers');
grassF.add(settings.grass, 'flowerSize', 0.03, 0.1, 0.005).name('flower size');

// ---------------------------------------------------------------- picking

const ray = new THREE.Raycaster();
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

const lightWorld = new THREE.Vector3();
const clock = new THREE.Clock();
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

const _fwd = new THREE.Vector3();
const _hz = new THREE.Vector3();
/** Horizon distance from the crowd's extent; haze, sky line and clouds follow. */
function updateEnvironment(dt: number) {
  const tgt = controls.target;
  sky.visible = clouds.group.visible = settings.sky;
  if (!settings.sky) {
    fog.uFogFar.value = fog.uFogNear.value = 1e9;
    return;
  }
  let extent = 0;
  for (const p of people) extent = Math.max(extent, Math.hypot(p.root.position.x - tgt.x, p.root.position.z - tgt.z));
  // keep everyone well inside the clear zone; ease so the horizon doesn't jump
  const want = Math.max(24, extent * 4 + 14);
  horizonFar += (want - horizonFar) * Math.min(1, dt * 2);
  _fwd.subVectors(tgt, camera.position).setY(0).normalize();
  fog.uFogC.value.set(tgt.x, tgt.z);
  fog.uFogDir.value.set(_fwd.x, _fwd.z);
  fog.uFogFar.value = horizonFar;
  fog.uFogNear.value = horizonFar * 0.8;
  clouds.update(camera, tgt, horizonFar, dt);
  _hz.copy(tgt).setY(0).addScaledVector(_fwd, horizonFar).project(camera);
  sky.material.uniforms.uHorizon.value = _hz.y;
  sky.material.uniforms.uRes.value.set(rt.width, rt.height);
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  lastFrameAt = performance.now();
  if (stalled) {
    stalled = false;
    if (!document.hidden) sound.setHidden(false);
  }
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
  if (simulated || settings.paused) sound.sweep();
  if (settings.follow) focusSelected(1 - Math.exp(-dt * 6));
  controls.update();

  const az = THREE.MathUtils.degToRad(settings.lightAz);
  const el = THREE.MathUtils.degToRad(settings.lightEl);
  lightWorld.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  camera.updateMatrixWorld();
  toon.uniforms.uLightView.value.copy(lightWorld).transformDirection(camera.matrixWorldInverse);
  toon.uniforms.uWrap.value = settings.wrap;
  ground.material = settings.grass.enabled ? groundMat : toon;
  groundMat.uniforms.uScale.value = settings.grass.scale;
  groundMat.uniforms.uRagged.value = settings.grass.ragged;
  groundMat.uniforms.uTooth.value = settings.grass.tooth;
  groundMat.uniforms.uContrast.value = settings.grass.contrast;
  groundMat.uniforms.uFlowers.value = settings.grass.flowers;
  groundMat.uniforms.uFlowerSize.value = settings.grass.flowerSize;
  updateEnvironment(dt);
  outline.visible = settings.outline;
  cloudOutline.visible = settings.outline;
  outline.uniforms.uPx.value = settings.outlinePx;
  outline.uniforms.uColor.value.set(settings.outlineColor);

  updateLabels();
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.render(blitScene, blitCam);

  if (++frames === 2) (window as any).__mini = { ready: true, get people() { return people; }, select, sound, voiceOf, rebuild: (i: number) => rebuildOne(i), debug: () => ({ offsets, actors, motions, baseTransform }) };
  requestAnimationFrame(frame);
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
frame();
