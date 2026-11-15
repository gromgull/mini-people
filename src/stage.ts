import { type Grade, gradeFromQuery, gradeMaterial, setGrade } from './grade';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ROWS, createAtlas, defaultRamp, fillAtlas } from './palette';
import { createFog, createGroundMaterial, createLampUniforms, createOutlineMaterial, createToonMaterial, defaultGrass, skinnedVariant } from './materials';
import { Backdrop } from './backdrop';
import { Clouds, Sun, createSky } from './environment';
import type { Caster } from './trees';
import { daylight, sunAt } from './daylight';

/**
 * Everything both apps (the demo and the village) draw with: the renderer and
 * its low-res pixel target, the orthographic camera and orbit controls, the
 * shared toon/outline materials, ground, sky, clouds, sun and moon, the time
 * of day and the light it gives, drop shadows, the fps overlay, and a
 * frame-rate-capped main loop. The apps own their scenery and people and
 * call in here each frame.
 */

// Colours are authored as display values and the atlas does all the shading,
// so skip colour management entirely: what's in the atlas is what hits the screen.
THREE.ColorManagement.enabled = false;

export const VIEW_H = 6;

/** Look settings shared by both apps (and their GUIs). */
export interface Look {
  pixelSize: number;
  outline: boolean;
  outlinePx: number;
  outlineColor: string;
  time: number; // hours
  dayCycle: boolean;
  dayMinutes: number;
  shadowLength: number;
  wrap: number;
  ramp: typeof defaultRamp;
  maxFps: number;
  stats: boolean;
  grass: typeof defaultGrass;
  /** The colour grade over the finished frame (see grade.ts). */
  grade: Grade;
}

export const q = new URLSearchParams(location.search);
export const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);

export function lookFromQuery(defaults: { time?: number } = {}): Look {
  return {
    pixelSize: num('px', 3),
    outline: q.get('outline') !== '0',
    outlinePx: 1,
    outlineColor: '#1a1410',
    time: ((num('time', defaults.time ?? 10) % 24) + 24) % 24, // hours: sets the sun (and the moon opposite it)
    dayCycle: q.get('daycycle') !== '0', // let the time of day run by itself
    dayMinutes: num('daymin', 30), // real minutes per day when it does
    shadowLength: 1, // 0 = round blobs, 1 = as long as the sun angle says
    wrap: 0.35,
    ramp: { ...defaultRamp, smooth: q.get('smooth') === '1' },
    maxFps: num('maxfps', 30), // render cap; 0 = every display refresh (60/120 Hz)
    stats: q.has('stats'), // fps / frame time / draw calls overlay
    grass: { ...defaultGrass, flowers: num('flowers', defaultGrass.flowers) },
    grade: gradeFromQuery(q),
  };
}

export class Stage {
  readonly renderer = new THREE.WebGLRenderer({ antialias: false });
  readonly scene = new THREE.Scene();
  readonly atlas = createAtlas();
  // horizon haze: ground and everything on it fades out along the view direction
  readonly fog = createFog();
  /** A lamp's light, shared by everything lit (see `lamp`). */
  private lampU = createLampUniforms();
  readonly toon = createToonMaterial(this.atlas, this.fog, this.lampU);
  /** One lamp: where it is (world), its colour (black = off) and how far it reaches. */
  readonly lamp = ((u) => ({
    at: new THREE.Vector3(),
    color: u.uLampColor.value,
    get range() {
      return u.uLampR.value;
    },
    set range(v: number) {
      u.uLampR.value = v;
    },
  }))(this.lampU);
  readonly outline = createOutlineMaterial(this.fog);
  readonly skinMats = { toon: skinnedVariant(this.toon), outline: skinnedVariant(this.outline) };
  // clouds live past the horizon, so they get materials without the haze
  // (but share lighting and outline settings with everything else)
  readonly cloudToon = createToonMaterial(this.atlas);
  readonly cloudOutline = createOutlineMaterial();
  readonly sky = createSky(this.fog);
  readonly clouds: Clouds;
  /** The land round about past the horizon: mountains, hills, the open valley (see backdrop.ts). */
  readonly backdrop: Backdrop;
  readonly sun = new Sun();
  readonly moon = new Sun('moon');
  // stencil: each pixel takes shadow once, so overlapping shadows don't stack darker
  readonly shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
  });
  readonly shadowGeo = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
  readonly selectMat = new THREE.MeshBasicMaterial({ color: '#ffe14a', depthWrite: false, transparent: true });
  readonly groundMat: THREE.ShaderMaterial;
  readonly ground: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1200);
  readonly controls: OrbitControls;
  // low-res target → nearest-neighbour upscale for the pixel look
  readonly rt = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: true });
  private blitScene = new THREE.Scene();
  private blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private blitMat!: THREE.ShaderMaterial;
  private horizonFar = 30;
  /** Seconds the world has run (not wall time): the stars' twinkle. */
  private skyClock = 0;
  /** What shades the scene: the sun, or the moon once the sun is down. */
  readonly lightWorld = new THREE.Vector3();
  private sunWorld = new THREE.Vector3();
  private moonWorld = new THREE.Vector3();
  private day = daylight(50);
  private clock = new THREE.Clock();
  private shadowYaw = 0;
  private shadowStretch = 0;
  private statsEl = document.createElement('div');
  private st = { n: 0, ms: 0, worst: 0, since: performance.now() };

  constructor(readonly look: Look) {
    const r = this.renderer;
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(r.domElement);
    this.scene.background = new THREE.Color('#1d2a1a');
    fillAtlas(this.atlas, look.ramp);

    this.cloudToon.uniforms.uLightView = this.toon.uniforms.uLightView;
    this.cloudToon.uniforms.uTint = this.toon.uniforms.uTint;
    this.cloudToon.uniforms.uWrap.value = 1.6; // very soft light: white with a pale shade underneath
    for (const k of ['uPx', 'uResolution', 'uColor'] as const) this.cloudOutline.uniforms[k] = this.outline.uniforms[k];
    this.scene.add(this.sky);
    this.clouds = new Clouds(this.cloudToon, this.cloudOutline);
    this.scene.add(this.clouds.group);
    const tu = this.toon.uniforms;
    this.backdrop = new Backdrop(this.atlas, { uLightView: tu.uLightView, uTint: tu.uTint, uWrap: tu.uWrap, uHaze: this.fog.uHaze });
    this.scene.add(this.backdrop.group);
    this.scene.add(this.sun.group, this.moon.group);

    // ground: toon-lit like everything else, plus grass patches (falls back to plain toon)
    this.groundMat = createGroundMaterial(this.atlas, this.fog, ROWS.ground[0], this.lampU);
    this.groundMat.uniforms.uLightView = this.toon.uniforms.uLightView;
    this.groundMat.uniforms.uWrap = this.toon.uniforms.uWrap;
    this.groundMat.uniforms.uTint = this.toon.uniforms.uTint;
    {
      const g = new THREE.PlaneGeometry(1600, 1600);
      g.rotateX(-Math.PI / 2);
      g.setAttribute('aRow', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(ROWS.ground[0]), 1));
      this.ground = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(g, this.groundMat);
      this.scene.add(this.ground);
    }

    const camera = this.camera;
    camera.zoom = num('zoom', 1);
    {
      const az = THREE.MathUtils.degToRad(num('az', 25));
      const el = THREE.MathUtils.degToRad(num('el', 35));
      const R = 300; // far back: an ortho view doesn't change, but low angles mustn't start below the ground
      camera.position.set(Math.sin(az) * Math.cos(el) * R, Math.sin(el) * R, Math.cos(az) * Math.cos(el) * R);
    }
    this.controls = new OrbitControls(camera, r.domElement);
    this.controls.target.set(num('tx', 0), 0.5, num('tz', 0)); // ?tx=&tz= look somewhere else (screenshots)
    camera.position.add(new THREE.Vector3(num('tx', 0), 0.5, num('tz', 0)));
    this.controls.enableDamping = true;
    // pan across the ground, not the screen: panning in the screen's plane (the default) lifts the pivot
    // into the air or sinks it underground the further you go, and then orbiting swings round a far-off point
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = Math.PI * 0.49; // down to ~2° above the ground

    this.blitMat = gradeMaterial(this.rt.texture);
    this.blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMat));
    window.addEventListener('resize', () => this.resize());

    this.statsEl.style.cssText = 'position:fixed;left:8px;top:8px;padding:4px 7px;background:#000a;color:#e8f4d8;font:12px/1.35 ui-monospace,monospace;white-space:pre;pointer-events:none;border-radius:3px;z-index:10;';
    document.body.appendChild(this.statsEl);
  }

  refillAtlas() {
    fillAtlas(this.atlas, this.look.ramp);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const camera = this.camera;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    camera.left = (-VIEW_H * aspect) / 2;
    camera.right = (VIEW_H * aspect) / 2;
    camera.top = VIEW_H / 2;
    camera.bottom = -VIEW_H / 2;
    camera.updateProjectionMatrix();
    const px = Math.max(1, this.look.pixelSize);
    const bw = Math.max(1, Math.floor((w * this.renderer.getPixelRatio()) / px));
    const bh = Math.max(1, Math.floor((h * this.renderer.getPixelRatio()) / px));
    this.rt.setSize(bw, bh);
    this.outline.uniforms.uResolution.value.set(bw, bh);
  }

  /** Seconds since the last call, capped (a stalled tab shouldn't teleport anyone). */
  delta() {
    return Math.min(this.clock.getDelta(), 0.1);
  }

  /**
   * Advance the clock (a whole day in look.dayMinutes, stopped while paused)
   * and set the light, tints and haze colour from it.
   */
  updateLight(dt: number, paused: boolean) {
    const look = this.look;
    if (!paused) this.skyClock += dt;
    if (look.dayCycle && !paused) look.time = (look.time + (dt * 24) / (look.dayMinutes * 60)) % 24;
    const pos = sunAt(look.time);
    const az = THREE.MathUtils.degToRad(pos.az);
    const el = THREE.MathUtils.degToRad(pos.el);
    this.sunWorld.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    this.moonWorld.copy(this.sunWorld).negate(); // a full moon, opposite the sun
    // shade by the sun while it's up, by the moon once it has set; never from
    // below the ground (the tint does the dimming)
    const L = this.lightWorld.copy(pos.el > -3 ? this.sunWorld : this.moonWorld);
    const minY = Math.sin(THREE.MathUtils.degToRad(4));
    if (L.y < minY) {
      const h = Math.hypot(L.x, L.z) || 1;
      const k = Math.sqrt(1 - minY * minY) / h;
      L.set(L.x * k, minY, L.z * k);
    }
    daylight(pos.el, this.day);
    this.toon.uniforms.uTint.value.copy(this.day.tint);
    this.fog.uHaze.value.copy(this.day.horizon);
    this.shadowMat.opacity = this.day.shadow;
    this.camera.updateMatrixWorld();
    this.toon.uniforms.uLightView.value.copy(L).transformDirection(this.camera.matrixWorldInverse);
    // drop shadows point away from the light, as long as a pole of the caster's
    // height would throw (capped, so a low sun doesn't paint the whole field)
    const h = Math.hypot(L.x, L.z);
    this.shadowYaw = h > 1e-4 ? Math.atan2(L.z, -L.x) : 0; // local +x → away from the sun
    this.shadowStretch = h > 1e-4 ? Math.min(h / Math.max(L.y, 1e-4), 3) : 0; // 1/tan(elevation)
  }

  /**
   * Not real shadows: a blob is an ellipse that starts under the caster and
   * stretches away from the light. `parentYaw` undoes the parent's turn.
   */
  orient(s: Caster, parentYaw: number) {
    const len = s.h * this.shadowStretch * this.look.shadowLength;
    const a = s.r + len * 0.5; // semi-major
    s.pivot.rotation.y = this.shadowYaw - parentYaw;
    s.shadow.scale.set(a, 1, s.r);
    s.shadow.position.x = a - s.r; // near end stays at the feet
  }

  /** A blob shadow to hang under someone (see orient). */
  makeCaster(r: number, h: number): Caster {
    const shadow = new THREE.Mesh(this.shadowGeo, this.shadowMat);
    shadow.raycast = () => {};
    const pivot = new THREE.Group();
    pivot.position.y = 0.002;
    pivot.add(shadow);
    return { pivot, shadow, r, h };
  }

  private _fwd = new THREE.Vector3();
  private _hz = new THREE.Vector3();
  private _sunNdc = new THREE.Vector3();
  /**
   * Material settings from the look, and the horizon: its distance follows
   * `extent` (how far out from the view centre things are); haze, sky line,
   * clouds, sun and moon follow it.
   */
  updateEnvironment(dt: number, extent: number) {
    const look = this.look;
    this.toon.uniforms.uWrap.value = look.wrap;
    const gm = this.groundMat.uniforms;
    gm.uScale.value = look.grass.scale;
    gm.uRagged.value = look.grass.ragged;
    gm.uTooth.value = look.grass.tooth;
    gm.uContrast.value = look.grass.contrast;
    gm.uFlowers.value = look.grass.flowers;
    gm.uFlowerSize.value = look.grass.flowerSize;

    const fog = this.fog;
    const camera = this.camera;
    const tgt = this.controls.target;
    // keep everyone well inside the clear zone; ease so the horizon doesn't jump
    const want = Math.max(24, extent * 4 + 14);
    this.horizonFar += (want - this.horizonFar) * Math.min(1, dt * 2);
    const horizonFar = this.horizonFar;
    const fwd = this._fwd.subVectors(tgt, camera.position).setY(0).normalize();
    fog.uFogC.value.set(tgt.x, tgt.z);
    fog.uFogDir.value.set(fwd.x, fwd.z);
    fog.uFogFar.value = horizonFar;
    fog.uFogNear.value = horizonFar * 0.8;
    this.clouds.update(camera, tgt, horizonFar, dt);
    this.backdrop.update(camera, tgt, horizonFar);
    this.sun.update(camera, tgt, horizonFar, this.sunWorld);
    this.moon.update(camera, tgt, horizonFar, this.moonWorld);
    this.sun.setColor(this.day.sun);
    this._hz.copy(tgt).setY(0).addScaledVector(fwd, horizonFar).project(camera);
    const u = this.sky.material.uniforms;
    u.uHorizon.value = this._hz.y;
    u.uRes.value.set(this.rt.width, this.rt.height);
    // time of day: sky colours, a glow around the sun when it faces us, stars at night
    u.uTop.value.copy(this.day.top);
    u.uGlow.value.copy(this.day.glow);
    u.uGlowAmt.value = this.day.glowAmt * THREE.MathUtils.smoothstep(this.sun.facing, -0.2, 0.6);
    u.uSunX.value = this._sunNdc.copy(this.sun.at).project(camera).x;
    u.uStars.value = this.day.stars;
    // a full turn of the view slides the stars by three screen widths, and round again
    const wrap = Math.round(this.rt.width * 3);
    u.uStarWrap.value = wrap;
    u.uStarShift.value = (((Math.atan2(fwd.x, fwd.z) / (Math.PI * 2)) * wrap) % wrap + wrap) % wrap;
    u.uTime.value = this.skyClock; // (the stars twinkle in the world's time: still when paused)
    this.outline.visible = look.outline;
    this.skinMats.outline.visible = look.outline;
    this.cloudOutline.visible = look.outline;
    this.outline.uniforms.uPx.value = look.outlinePx;
    this.outline.uniforms.uColor.value.set(look.outlineColor);
  }

  /** Draw: the scene into the low-res target, then that onto the screen. */
  render(frameStart: number, peopleCount: number) {
    const r = this.renderer;
    // the lamp, in view space
    this.camera.updateMatrixWorld();
    this.lampU.uLampView.value.copy(this.lamp.at).applyMatrix4(this.camera.matrixWorldInverse);
    r.setRenderTarget(this.rt);
    r.render(this.scene, this.camera);
    const calls = r.info.render.calls;
    const tris = r.info.render.triangles;
    r.setRenderTarget(null);
    setGrade(this.blitMat, this.look.grade, this.rt.width, this.rt.height);
    r.render(this.blitScene, this.blitCam);
    this.stats(frameStart, calls, tris, peopleCount);
  }

  /**
   * fps (frames actually drawn), frame time (CPU ms spent simulating and
   * submitting a frame: the headroom under the fps cap) and the scene pass's
   * draw calls and triangles. Averaged over half a second.
   */
  private stats(start: number, calls: number, tris: number, people: number) {
    const el = this.statsEl;
    const look = this.look;
    el.style.display = look.stats ? '' : 'none';
    if (!look.stats) return;
    const s = this.st;
    const now = performance.now();
    const took = now - (start || now);
    s.n++;
    s.ms += took;
    s.worst = Math.max(s.worst, took);
    if (now - s.since < 500) return;
    const fps = (s.n * 1000) / (now - s.since);
    el.textContent = `${fps.toFixed(0)} fps${look.maxFps ? ` (cap ${look.maxFps})` : ''}\n${(s.ms / s.n).toFixed(1)} ms/frame (worst ${s.worst.toFixed(1)})\n${calls} draw calls\n${(tris / 1000).toFixed(0)}k triangles · ${people} people`;
    s.n = 0;
    s.ms = 0;
    s.worst = 0;
    s.since = now;
  }

  /**
   * Run `frame` at most look.maxFps times a second: pixel art gains nothing
   * from 120 fps, and simulating and drawing a crowd isn't free, so the cap
   * saves most of the CPU. rAF keeps ticking at the display rate and frames
   * that come too soon are skipped. The schedule advances in fixed steps (not
   * "now"), so on refresh rates that don't divide evenly (75, 144 Hz…) the
   * average still lands on the cap; a little slack keeps 60/120 Hz on an
   * exact every-2nd/4th rhythm. `frame` gets the time it started (for stats).
   */
  run(frame: (start: number) => void) {
    let lastRenderAt = -Infinity;
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      const cap = this.look.maxFps;
      if (cap > 0) {
        const step = 1000 / cap;
        if (now - lastRenderAt < step - 2) return;
        lastRenderAt = Math.max(lastRenderAt + step, now - step); // don't bank up time after a stall
      } else lastRenderAt = now;
      frame(performance.now());
    };
    frame(0);
    requestAnimationFrame(loop);
  }
}
