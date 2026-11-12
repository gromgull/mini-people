import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { type Person, buildPerson } from './body';
import { HAIR_STYLES, SHAPE_GENES, randomGenome } from './genome';
import { PALETTE, ROWS, createAtlas, defaultRamp, fillAtlas } from './palette';
import { createOutlineMaterial, createToonMaterial } from './materials';
import { mulberry32 } from './rng';
import { type Motion, WALK_SPEED, advance, applyGait, defaultGait, newMotion } from './gait';

const MODES = ['stand', 'parade'] as const;
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
let along: number[] = []; // distance travelled along the parade ring

const ringRadius = () => Math.max(1.2, (settings.count * 0.72) / (Math.PI * 2));

function placeAll() {
  people.forEach((p, i) => {
    if (settings.mode === 'stand') {
      const t = slotTransform(i);
      p.root.position.set(t.x, 0, t.z);
      p.root.rotation.y = t.rot;
    } else {
      const R = ringRadius();
      const th = along[i] / R;
      p.root.position.set(Math.cos(th) * R, 0, Math.sin(th) * R);
      // counter-clockwise: velocity = (-sin, 0, cos)
      p.root.rotation.y = Math.atan2(-Math.sin(th), Math.cos(th));
    }
  });
}

function setMode(mode: Mode) {
  settings.mode = mode;
  const v = mode === 'parade' ? settings.speed : 0;
  motions.forEach((m) => (m.targetSpeed = v));
  placeAll();
}

function rebuildAll() {
  people.forEach(removePerson);
  people = Array.from({ length: settings.count }, (_, i) => makePerson(i));
  const r = mulberry32(settings.seed * 31 + 7);
  motions = people.map(() => newMotion(r()));
  const gap = (Math.PI * 2 * ringRadius()) / settings.count;
  along = people.map((_, i) => i * gap);
  setMode(settings.mode);
  motions.forEach((m) => (m.speed = m.targetSpeed)); // start already walking
  select(Math.min(selected, people.length - 1));
}

function rebuildOne(i: number) {
  const g = people[i].genome;
  removePerson(people[i]);
  people[i] = makePerson(i, g);
  placeAll();
  attachRing();
}

/** One simulation step: move along paths, advance gait phase, pose. */
function simulate(dt: number) {
  people.forEach((p, i) => {
    const m = motions[i];
    advance(m, p, settings.gait, dt);
    if (settings.mode === 'parade') along[i] += m.speed * dt;
    else if (settings.spin) p.root.rotation.y += dt * 0.8;
    applyGait(p, m, settings.gait);
  });
  if (settings.mode === 'parade') placeAll();
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
motion.add(settings, 'mode', MODES).onChange(setMode);
motion.add(settings, 'speed', 0, 1.5, 0.01).onChange(() => setMode(settings.mode));
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
  if (o) select(o.userData.index);
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

  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.render(blitScene, blitCam);

  if (++frames === 2) (window as any).__mini = { ready: true, people, select };
  requestAnimationFrame(frame);
}

resize();
rebuildAll();
// fit the parade ring in view unless a zoom was asked for
if (!q.has('zoom') && settings.mode === 'parade') {
  camera.zoom = Math.min(1, (VIEW_H * 0.42) / (ringRadius() + 0.6));
  camera.updateProjectionMatrix();
}
// deterministic pre-roll for screenshots: ?t=seconds (combine with &paused)
for (let i = 0, n = Math.round(num('t', 0) * 60); i < n; i++) simulate(1 / 60);
simulate(0);
if (q.has('select')) {
  select(num('select', 0));
  if (q.has('focus')) focusSelected();
}
frame();
