import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { type Person, buildPerson } from './body';
import { type Genome, HAIR_STYLES, SHAPE_GENES, randomGenome } from './genome';
import { PALETTE, ROWS, createAtlas, defaultRamp, fillAtlas } from './palette';
import { createOutlineMaterial, createToonMaterial } from './materials';
import { mulberry32 } from './rng';
import { type Motion, WALK_SPEED, advance, defaultGait, newMotion } from './gait';
import { Animator } from './animate';
import { PERSONA_KEYS, PRESETS, derivePersona, styleFor } from './persona';
import { ACTIONS, type ActionKind, Actor } from './actions';
import { Sparks } from './fx';

const MODES = ['stand', 'parade', 'compare'] as const;
type Mode = (typeof MODES)[number];

// Colours are authored as display values and the atlas does all the shading,
// so skip colour management entirely: what's in the atlas is what hits the screen.
THREE.ColorManagement.enabled = false;

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);

const settings = {
  seed: num('seed', 1),
  count: num('count', 48),
  spacing: 0.9,
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
const toon = createToonMaterial(atlas);
const outline = createOutlineMaterial();
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
const selectMat = new THREE.MeshBasicMaterial({ color: '#ffe14a', depthWrite: false, transparent: true });

// ground uses the same toon material, just a different atlas row
{
  const g = new THREE.PlaneGeometry(400, 400);
  g.rotateX(-Math.PI / 2);
  g.setAttribute('aRow', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(ROWS.ground[0]), 1));
  scene.add(new THREE.Mesh(g, toon));
}

const VIEW_H = 6;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
camera.zoom = num('zoom', 1);
{
  const az = THREE.MathUtils.degToRad(num('az', 25));
  const el = THREE.MathUtils.degToRad(num('el', 35));
  const r = 40;
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
let offsets: { x: number; z: number; yaw: number; locked: boolean }[] = [];
let nextAuto: number[] = [];
let simTime = 0;
let spinAngle = 0;
const kit = { toon, outline };
const sparks = new Sparks(scene);
// deterministic action trigger for tests: ?act=fall&actAt=0.5 (person = ?select or 0)
let scheduled: { at: number; who: number; kind: ActionKind; push?: THREE.Vector3 } | null =
  ACTIONS.includes(q.get('act') as ActionKind)
    ? { at: num('actAt', 0), who: q.has('actAll') ? -1 : num('select', 0), kind: q.get('act') as ActionKind }
    : null;
let along: number[] = []; // distance travelled along the parade ring / lane
let compareBase: Genome | null = null; // the body every lane shares in compare mode
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
  if (settings.mode === 'parade') {
    const R = ringRadius();
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
function placeOne(i: number, lift = 0) {
  const p = people[i];
  const a = actors[i];
  const o = offsets[i];
  const b = baseTransform(i);
  if (a?.rootLocked) {
    o.locked = true;
    return;
  }
  if (o.locked) {
    o.locked = false;
    o.x = p.root.position.x - b.x;
    o.z = p.root.position.z - b.z;
    o.yaw = Math.atan2(Math.sin(p.root.rotation.y - b.yaw), Math.cos(p.root.rotation.y - b.yaw));
  }
  p.root.position.set(b.x + o.x, lift, b.z + o.z);
  p.root.rotation.y = b.yaw + o.yaw;
}

function placeAll() {
  people.forEach((_, i) => placeOne(i));
}

function setTargetSpeeds() {
  people.forEach((p, i) => {
    const m = motions[i];
    if (!m) return;
    if (settings.mode === 'stand') m.targetSpeed = 0;
    else if (settings.mode === 'parade') m.targetSpeed = settings.speed; // same speed or they'd collide
    else m.targetSpeed = settings.speed * styleOf(p).speedK;
  });
}

function setMode(mode: Mode) {
  const rebuild = (mode === 'compare') !== (settings.mode === 'compare') || mode === 'compare';
  if (mode === 'compare' && settings.mode !== 'compare') compareBase = structuredClone(people[selected]?.genome ?? randomGenome(1));
  settings.mode = mode;
  if (rebuild) rebuildAll();
  setTargetSpeeds();
  placeAll();
  fitCamera();
}

function genomeFor(i: number): Genome {
  if (settings.mode !== 'compare') return randomGenome(settings.seed * 100003 + i);
  const g = structuredClone(compareBase ?? randomGenome(1));
  g.persona = { ...PRESETS[COMPARE[i]] };
  return g;
}

function rebuildAll() {
  people.forEach(removePerson);
  const n = settings.mode === 'compare' ? COMPARE.length : settings.count;
  people = Array.from({ length: n }, (_, i) => makePerson(i, genomeFor(i)));
  const r = mulberry32(settings.seed * 31 + 7);
  motions = people.map(() => newMotion(r()));
  anims = people.map((_, i) => new Animator(settings.seed * 977 + i));
  actors.forEach((a) => a.dispose());
  actors = people.map((p) => new Actor(p, kit));
  offsets = people.map(() => ({ x: 0, z: 0, yaw: 0, locked: false }));
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
  placeAll();
  attachRing();
}

const TURN_FIRST = 0.5; // rad: further off-path than this → turn on the spot before walking

function modeSpeed(i: number) {
  if (actors[i]?.holdSpeed || settings.mode === 'stand') return 0;
  const o = offsets[i];
  if (o && (o.locked || Math.abs(o.yaw) > TURN_FIRST)) return 0;
  if (settings.mode === 'parade') return settings.speed; // same speed or they'd collide
  return settings.speed * styleOf(people[i]).speedK;
}

const AUTO_POOL: ActionKind[] = ['wave', 'wave', 'jump', 'jump', 'hammer', 'fall'];

function act(i: number, kind: ActionKind, push?: THREE.Vector3) {
  // hammering mid-parade would leave people standing in the stream
  if (kind === 'hammer' && settings.mode === 'parade') kind = 'wave';
  actors[i]?.start(kind, { push });
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
  const turnStep = 3.2 * dt; // rad/s turning on the spot
  people.forEach((p, i) => {
    const m = motions[i];
    const a = actors[i];
    const st = styleOf(p);
    if (settings.autoActions && !a.busy && simTime > nextAuto[i]) {
      act(i, AUTO_POOL[Math.floor(Math.random() * AUTO_POOL.length)]);
      nextAuto[i] = simTime + 3 + Math.random() * 10;
    }
    const pose = a.pre(dt, m, st);
    m.targetSpeed = modeSpeed(i);
    advance(m, p, st.gait, dt);
    if (settings.mode !== 'stand') along[i] += m.speed * dt;
    const o = offsets[i];
    if (!o.locked) {
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
    placeOne(i, pose?.lift ?? 0);
    anims[i].update(dt, p, m, st, p.root.rotation.y, pose);
    a.post(dt, m, st);
    if (a.impact && a.hammerHead) {
      p.root.updateMatrixWorld(true);
      sparks.burst(a.hammerHead.getWorldPosition(new THREE.Vector3()), 7, Math.sqrt(p.dims.height));
    }
  });
  sparks.update(dt);
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
  camera.zoom = settings.mode === 'parade' ? Math.min(1, (VIEW_H * 0.42) / (ringRadius() + 0.6)) : settings.mode === 'compare' ? 1.25 : 1;
  camera.updateProjectionMatrix();
}

function attachRing() {
  const p = people[selected];
  if (!p) return;
  selectRing.scale.setScalar(Math.max(p.dims.hipR, p.dims.shoulderR, p.dims.waistR) * 1.4);
  p.root.add(selectRing);
}

// ---------------------------------------------------------------- GUI

const gui = new GUI({ title: 'Mini People' });
if (q.has('nogui')) {
  gui.hide();
  document.getElementById('hint')?.remove();
}

const pop = gui.addFolder('Population');
pop.add(settings, 'seed', 1, 9999, 1).onFinishChange(rebuildAll);
pop.add(settings, 'count', 1, 200, 1).onFinishChange(rebuildAll);
pop.add(settings, 'spacing', 0.5, 2, 0.05).onChange(placeAll);
pop.add({ reroll: () => { settings.seed = Math.floor(Math.random() * 9999) + 1; pop.controllersRecursive().forEach((c) => c.updateDisplay()); rebuildAll(); } }, 'reroll').name('🎲 new crowd');
pop.add(settings, 'spin').name('spin (stand mode)');

const motion = gui.addFolder('Motion');
motion.add({ mode: settings.mode }, 'mode', MODES).onChange(setMode);
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
for (const [k, label] of [['wave', '👋 wave  [1]'], ['hammer', '🔨 hammer  [2]'], ['jump', '⤴ jump  [3]'], ['fall', '🤕 trip  [4]']] as const)
  actF.add({ go: () => act(selected, k) }, 'go').name(label);
actF.add({ all: () => people.forEach((_, i) => setTimeout(() => act(i, 'jump'), Math.random() * 400)) }, 'all').name('everyone jump!');
actF.add({ all: () => people.forEach((_, i) => act(i, 'fall')) }, 'all').name('everyone trip!');
actF.add(settings, 'autoActions').name('random crowd actions');

window.addEventListener('keydown', (e) => {
  const k = ({ '1': 'wave', '2': 'hammer', '3': 'jump', '4': 'fall' } as const)[e.key as '1'];
  if (k) act(selected, k);
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
  looks.add(g, 'shirt', idx(PALETTE.shirt.length)).onChange(rebuild);
  looks.add(g, 'pants', idx(PALETTE.pants.length)).onChange(rebuild);
  looks.add(g, 'shoes', idx(PALETTE.shoes.length)).onChange(rebuild);
  looks.add(g, 'longSleeves').onChange(rebuild);
  looks.add(g, 'shorts').onChange(rebuild);
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

// ---------------------------------------------------------------- picking

const ray = new THREE.Raycaster();
let downAt: [number, number] | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
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

/** Move camera + orbit target so the selected person is centred. */
function focusSelected(k = 1) {
  const p = people[selected];
  if (!p) return;
  const off = camera.position.clone().sub(controls.target);
  controls.target.lerp(new THREE.Vector3(p.root.position.x, p.dims.height * 0.5, p.root.position.z), k);
  camera.position.copy(controls.target).add(off);
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!settings.paused) {
    if (settings.animFps > 0) {
      // "animating on twos": pose & position only update at a low fixed rate
      const step = 1 / settings.animFps;
      simAcc += dt;
      while (simAcc >= step) {
        simulate(step);
        simAcc -= step;
      }
    } else {
      simulate(dt);
    }
  }
  if (settings.follow) focusSelected(1 - Math.exp(-dt * 6));
  controls.update();

  const az = THREE.MathUtils.degToRad(settings.lightAz);
  const el = THREE.MathUtils.degToRad(settings.lightEl);
  lightWorld.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  camera.updateMatrixWorld();
  toon.uniforms.uLightView.value.copy(lightWorld).transformDirection(camera.matrixWorldInverse);
  toon.uniforms.uWrap.value = settings.wrap;
  outline.visible = settings.outline;
  outline.uniforms.uPx.value = settings.outlinePx;
  outline.uniforms.uColor.value.set(settings.outlineColor);

  updateLabels();
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.render(blitScene, blitCam);

  if (++frames === 2) (window as any).__mini = { ready: true, people, select, debug: () => ({ offsets, actors, motions, baseTransform }) };
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
