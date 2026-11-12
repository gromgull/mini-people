import * as THREE from 'three';
import { JOINTS, type JointName, type Person, withRow } from './body';
import type { Motion } from './gait';
import type { Style } from './persona';
import { ROWS } from './palette';
import { Ragdoll } from './ragdoll';

export const ACTIONS = ['wave', 'hammer', 'jump', 'fall', 'carry', 'sit', 'talk', 'saw'] as const;
export type ActionKind = (typeof ACTIONS)[number];

/** Arm override blended into the animator's targets *before* the springs. */
export interface ArmOverride {
  w: number; // blend weight 0..1
  x: number; // shoulder pitch (−forward)
  z: number; // shoulder abduction (positive = away from body, either side)
  elbow: number; // elbow bend
  stiff: number; // spring frequency multiplier while overriding (crisp strikes)
}

/** What an action asks of the animator this frame. */
export interface ActionPose {
  crouch: number; // × leg length
  sitZ: number; // pelvis pushed back for sitting
  lift: number; // root height (jumps)
  spineX: number;
  headX: number;
  headY: number;
  headZ: number;
  arms: { L: ArmOverride; R: ArmOverride };
}

const arm = (): ArmOverride => ({ w: 0, x: 0, z: 0, elbow: 0, stiff: 1 });
const smooth = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 0→1→0 envelope with ease-in/out at the ends of [0, dur]. */
const envelope = (t: number, dur: number, tin: number, tout: number) => smooth(t / tin) * smooth((dur - t) / tout);

const JUMP_G = 14;
const SAW_CROUCH = 0.1;
const SAW_STROKE = 0.22; // half-stroke, × arm length
const _target = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _scl = new THREE.Vector3();

// ---------------------------------------------------------------- props

export interface PropKit {
  toon: THREE.Material;
  outline: THREE.Material;
}

let hammerGeo: { handle: THREE.BufferGeometry; head: THREE.BufferGeometry; rock: THREE.BufferGeometry } | null = null;
function geos() {
  if (hammerGeo) return hammerGeo;
  const handle = withRow(new THREE.CylinderGeometry(0.011, 0.013, 0.24, 6), ROWS.shoes[2]);
  handle.rotateX(Math.PI / 2);
  handle.translate(0, 0, 0.1);
  const head = withRow(new THREE.BoxGeometry(0.045, 0.11, 0.05), ROWS.shoes[3]);
  head.translate(0, 0, 0.22);
  const rock = withRow(new THREE.DodecahedronGeometry(0.1, 0), ROWS.hair[5]);
  rock.scale(1.2, 0.7, 1);
  rock.translate(0, 0.06, 0);
  hammerGeo = { handle, head, rock };
  return hammerGeo;
}

let boxGeos: { box: THREE.BufferGeometry; tape: THREE.BufferGeometry; slab: THREE.BufferGeometry; leg: THREE.BufferGeometry } | null = null;
/** Unit-sized props, scaled per person: a cardboard box and a little bench. */
function boxGeo() {
  if (boxGeos) return boxGeos;
  const box = withRow(new THREE.BoxGeometry(1, 1, 1), ROWS.pants[6]);
  const tape = withRow(new THREE.BoxGeometry(0.22, 1.02, 1.02), ROWS.pants[3]);
  const slab = withRow(new THREE.BoxGeometry(1, 0.16, 1), ROWS.shoes[2]);
  slab.translate(0, 0.92, 0);
  const leg = withRow(new THREE.BoxGeometry(0.12, 0.86, 0.8), ROWS.shoes[0]);
  leg.translate(0, 0.43, 0);
  boxGeos = { box, tape, slab, leg };
  return boxGeos;
}

let sawGeos: { handle: THREE.BufferGeometry; blade: THREE.BufferGeometry; log: THREE.BufferGeometry; end: THREE.BufferGeometry; trestle: THREE.BufferGeometry } | null = null;
function sawGeo() {
  if (sawGeos) return sawGeos;
  // saw: handle in the fist, blade continuing down the forearm line (hand -Y),
  // flat in the hand's y-z plane so strokes slide along it
  const handle = withRow(new THREE.BoxGeometry(0.03, 0.06, 0.05), ROWS.shoes[2]);
  handle.translate(0, -0.01, 0);
  const blade = withRow(new THREE.BoxGeometry(0.005, 0.3, 0.06), ROWS.shoes[3]);
  blade.translate(0, -0.18, 0.012);
  // half a log (unit length along +x from the cut, radius 1), bark + pale end
  const log = withRow(new THREE.CylinderGeometry(1, 1, 1, 9), ROWS.shoes[0]);
  log.rotateZ(Math.PI / 2);
  log.translate(0.5, 0, 0);
  const end = withRow(new THREE.CircleGeometry(0.86, 9), ROWS.pants[6]);
  end.rotateY(-Math.PI / 2);
  end.translate(-0.002, 0, 0);
  const trestle = withRow(new THREE.BoxGeometry(1, 1, 1), ROWS.shoes[2]);
  trestle.translate(0, 0.5, 0);
  sawGeos = { handle, blade, log, end, trestle };
  return sawGeos;
}

function mesh(geo: THREE.BufferGeometry, kit: PropKit) {
  const m = new THREE.Mesh(geo, kit.toon);
  const o = new THREE.Mesh(geo, kit.outline);
  o.raycast = () => {};
  m.add(o);
  return m;
}

// ---------------------------------------------------------------- actor

/**
 * Runs one action at a time for a person. `pre()` runs before the animator
 * and returns overrides that get springed like everything else (so personality
 * flavours every action); `post()` runs after it for things that replace the
 * pose outright (ragdoll, getting up).
 */
export class Actor {
  kind: ActionKind | null = null;
  t = 0;
  holdSpeed = false; // stop walking for this action
  rootLocked = false; // the action owns the root transform
  impact = false; // set on the frame a hammer blow lands
  hammerHead: THREE.Object3D | null = null;

  private pose: ActionPose = { crouch: 0, sitZ: 0, lift: 0, spineX: 0, headX: 0, headY: 0, headZ: 0, arms: { L: arm(), R: arm() } };
  private side: 'L' | 'R' = 'R';
  private push = new THREE.Vector3();
  private stopNow = false;
  private ragdoll: Ragdoll | null = null;
  private getup: { t: number; dur: number; q: Map<JointName, THREE.Quaternion>; pelvis: THREE.Vector3 } | null = null;
  private hammer: THREE.Object3D | null = null;
  private rock: THREE.Object3D | null = null;
  private lastU = 0;
  private tempo = 1;
  private box: THREE.Object3D | null = null;
  private boxHeld = new THREE.Matrix4(); // box pose in spine space while carried
  private boxGround = new THREE.Vector3(); // where it sits on the ground (root space)
  private bench: THREE.Object3D | null = null;
  private seat = { h: 0, z: 0, crouch: 0 };
  private benchScale = new THREE.Vector3();
  /** Talking: who to face (index into the crowd), set by the caller. */
  partner = -1;
  dust = false; // set on frames where a saw stroke throws sawdust
  /** Sound cues raised this frame (consumed by the audio layer). */
  events: ('oof' | 'hup' | 'grunt' | 'hey' | 'thunk' | 'creak' | 'log')[] = [];
  beat = false; // a talk gesture beat started this frame
  sawSpeed = 0; // 0…1 stroke speed while sawing
  sawPush = false;
  private prevT = 0;
  private crossed(at: number) {
    return this.prevT < at && this.t >= at;
  }
  sawTip: THREE.Object3D | null = null;
  private saw: THREE.Object3D | null = null;
  private logSet: THREE.Object3D | null = null;
  private logHalves: THREE.Object3D[] = [];
  private beats = { next: 0, L: { x: -0.5, z: 0.2, elbow: 1.2, w: 1 }, R: { x: -0.5, z: 0.2, elbow: 1.2, w: 1 }, head: 0, headUntil: 0, dur: 5 };
  private lastStroke = 0;

  constructor(private p: Person, private kit: PropKit) {}

  get busy() {
    return this.kind !== null;
  }

  start(kind: ActionKind, opts: { push?: THREE.Vector3; side?: 'L' | 'R' } = {}) {
    if (this.kind === 'fall') return; // let them finish falling/getting up
    this.stop();
    this.kind = kind;
    this.t = 0;
    this.side = opts.side ?? (Math.random() < 0.7 ? 'R' : 'L');
    this.push.copy(opts.push ?? new THREE.Vector3());
    this.holdSpeed = kind !== 'wave' && kind !== 'jump';
    this.stopNow = kind === 'fall';
    this.lastU = 0;
    this.lastStroke = -1;
    if (kind === 'hammer') this.showHammer(true);
    if (kind === 'carry') this.makeBox();
    if (kind === 'sit') this.makeBench();
    if (kind === 'talk') {
      this.beats.next = 0;
      this.beats.headUntil = 0;
      this.beats.dur = 4 + Math.random() * 3;
    }
    if (kind === 'saw') this.makeSaw();
  }

  stop() {
    this.showHammer(false);
    if (this.box) this.box.visible = false;
    if (this.bench) this.bench.visible = false;
    if (this.saw) {
      this.saw.visible = false;
      this.saw.rotation.x = 0;
    }
    if (this.logSet) this.logSet.visible = false;
    this.partner = -1;
    this.kind = null;
    this.ragdoll = null;
    this.getup = null;
    this.holdSpeed = false;
    this.rootLocked = false;
  }

  dispose() {
    this.stop();
    this.hammer?.removeFromParent();
    this.rock?.removeFromParent();
    this.box?.removeFromParent();
    this.bench?.removeFromParent();
    this.saw?.removeFromParent();
    this.logSet?.removeFromParent();
  }

  /** Saw in the right hand; log on a sawhorse where the blade meets it. */
  private makeSaw() {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    const s = Math.sqrt(d.height);
    const g = sawGeo();
    if (!this.saw) {
      this.saw = new THREE.Group();
      this.saw.add(mesh(g.handle, this.kit), mesh(g.blade, this.kit));
      this.sawTip = new THREE.Object3D();
      this.sawTip.position.set(0, -0.2, 0.04);
      this.saw.add(this.sawTip);
      this.saw.scale.setScalar(s);
      this.saw.position.y = -d.handR * 0.7;
      J.wristR.add(this.saw);
      this.logSet = new THREE.Group();
      this.logHalves = [1, -1].map((side) => {
        const h = new THREE.Group();
        h.add(mesh(g.log, this.kit), mesh(g.end, this.kit));
        h.scale.x = side; // mirrored half
        this.logSet!.add(h);
        return h;
      });
      for (const x of [-1, 1]) {
        const t = mesh(g.trestle, this.kit);
        t.userData.side = x;
        this.logSet.add(t);
      }
      p.root.add(this.logSet);
    }
    this.saw.visible = true;

    // FK the mid-stroke pose to find where the blade cuts
    const joints = [J.spine, J.shoulderR, J.elbowR];
    const saved = joints.map((j) => j.quaternion.clone());
    const mid = this.sawStroke(0.5);
    J.spine.rotation.set(0.45, 0, 0);
    J.shoulderR.rotation.set(mid.x, 0, -mid.z, 'ZYX');
    J.elbowR.rotation.set(-mid.elbow, 0, 0);
    p.root.updateMatrixWorld(true);
    const cut = p.root.worldToLocal(this.saw.localToWorld(new THREE.Vector3(0, -0.2, 0.012)));
    joints.forEach((j, i) => j.quaternion.copy(saved[i]));
    p.root.updateMatrixWorld(true);
    cut.y -= SAW_CROUCH * d.legLen; // the crouch lowers everything

    const r = 0.055 * s;
    const len = 0.24 * s; // per half
    const y = Math.max(r, cut.y - r * 0.1); // blade runs through the log, not over it
    this.logSet!.position.set(cut.x, 0, cut.z);
    this.logHalves.forEach((h, i) => {
      h.position.set(0, y, 0);
      h.rotation.set(0, 0, 0);
      // the cut sits near the right-hand end; the long piece runs under the left hand
      h.scale.set(i === 0 ? len * 1.45 : -len * 0.6, r, r);
    });
    this.logSet!.children.forEach((c) => {
      if (c.userData.side === undefined) return;
      c.position.set(c.userData.side > 0 ? len * 1.15 : -len * 0.4, 0, 0);
      c.scale.set(0.025 * s, Math.max(0.001, y - r * 0.6), r * 2.6);
      c.visible = y > r * 1.5;
    });
    this.logSet!.visible = true;
  }

  /** Arm angles for a saw stroke, u = 0 (pulled back) … 1 (pushed through). */
  private sawStroke(u: number) {
    // The hand slides in a straight line along the blade (= the mid-stroke
    // forearm direction), solved as a planar two-bone chain in the spine's
    // sagittal plane. Angles: θ = shoulder pitch forward from hanging, e = elbow.
    const d = this.p.dims;
    const a = d.upperArmLen;
    const b = d.foreArmLen + d.handR * 0.7;
    const th0 = 0.3;
    const e0 = 1.25;
    const dir = th0 + e0; // blade / stroke direction, from "down"
    const f0 = a * Math.sin(th0) + b * Math.sin(dir);
    const h0 = a * Math.cos(th0) + b * Math.cos(dir);
    const k = (u - 0.5) * 2 * SAW_STROKE * (a + b);
    const f = f0 + k * Math.sin(dir);
    const h = h0 + k * Math.cos(dir);
    const D = Math.min(Math.hypot(f, h), (a + b) * 0.985);
    const e = Math.PI - Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - D * D) / (2 * a * b))));
    const th = Math.atan2(f, h) - Math.atan2(b * Math.sin(e), a + b * Math.cos(e));
    return { x: -th, z: 0.05, elbow: e, blade: dir };
  }

  /** The carry pose's arm angles (shared by the FK fit and the animation). */
  private carryArms() {
    const d = this.p.dims;
    return { x: -0.7, z: d.armOut * 0.6 + 0.02, elbow: 1.1 };
  }

  /**
   * Size a box to fit between the hands: pose the carry arms with plain FK,
   * read the hands in spine space, then restore the pose.
   */
  private makeBox() {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    if (!this.box) {
      const g = boxGeo();
      this.box = new THREE.Group();
      this.box.add(mesh(g.box, this.kit), new THREE.Mesh(g.tape, this.kit.toon)); // tape: no outline of its own
      p.root.add(this.box);
    }
    const joints = [J.spine, J.shoulderL, J.shoulderR, J.elbowL, J.elbowR];
    const saved = joints.map((j) => j.quaternion.clone());
    const a = this.carryArms();
    J.spine.rotation.set(0, 0, 0);
    J.shoulderL.rotation.set(a.x, 0, a.z, 'ZYX');
    J.shoulderR.rotation.set(a.x, 0, -a.z, 'ZYX');
    J.elbowL.rotation.set(-a.elbow, 0, 0);
    J.elbowR.rotation.set(-a.elbow, 0, 0);
    p.root.updateMatrixWorld(true);
    const hand = (w: THREE.Object3D) => J.spine.worldToLocal(w.localToWorld(new THREE.Vector3(0, -d.handR * 0.7, 0)));
    const hl = hand(J.wristL);
    const hr = hand(J.wristR);
    joints.forEach((j, i) => j.quaternion.copy(saved[i]));
    p.root.updateMatrixWorld(true);

    const w = Math.max(0.08, hl.distanceTo(hr) - d.handR * 0.9);
    const front = d.shoulderR * d.torsoDepth; // keep the box clear of the chest/belly
    const mid = hl.add(hr).multiplyScalar(0.5);
    const depth = Math.min(w * 0.85, Math.max(0.05, (mid.z - front * 1.05) * 2));
    const h = w * 0.7;
    this.box.scale.set(w, h, depth);
    this.boxHeld.compose(mid.setY(mid.y + h * 0.15), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    this.boxGround.set(0, h / 2, d.legLen * 0.36 + depth / 2);
    this.box.position.copy(this.boxGround);
    this.box.quaternion.identity();
    this.box.visible = true;
  }

  private makeBench() {
    const p = this.p;
    const d = p.dims;
    if (!this.bench) {
      const g = boxGeo();
      this.bench = new THREE.Group();
      const legs = [-0.4, 0.4].map((x) => {
        const m = mesh(g.leg, this.kit);
        m.position.x = x;
        return m;
      });
      this.bench.add(mesh(g.slab, this.kit), ...legs);
      p.root.add(this.bench);
    }
    // seat at knee height, far enough back that the thighs lie on it
    const standY = d.footH + (d.thighLen + d.shinLen) * 0.997;
    const h = d.footH + d.shinLen * 0.92;
    this.seat.h = h;
    this.seat.z = d.thighLen * 0.85;
    this.seat.crouch = (standY - (h + d.hipBelow * 0.9)) / d.legLen;
    this.benchScale.set(d.hipR * 3.2, h, d.thighLen * 1.1);
    this.bench.scale.setScalar(1e-3);
    this.bench.position.set(0, 0, -this.seat.z - d.thighLen * 0.05);
    this.bench.visible = true;
  }

  private showHammer(on: boolean) {
    if (on && !this.hammer) {
      const g = geos();
      const s = Math.sqrt(this.p.dims.height);
      this.hammer = new THREE.Group();
      this.hammer.add(mesh(g.handle, this.kit));
      this.hammer.add(mesh(g.head, this.kit));
      // marker at the striking face (the head mesh's origin is at the fist)
      this.hammerHead = new THREE.Object3D();
      this.hammerHead.position.set(0, -0.05, 0.22);
      this.hammer.add(this.hammerHead);
      this.hammer.scale.setScalar(s);
      this.hammer.position.y = -this.p.dims.handR * 0.7;
      this.hammer.rotation.x = 0.95; // handle angled down from the fist: head meets the ground on the strike
      this.p.joints.wristR.add(this.hammer);
      this.rock = mesh(g.rock, this.kit);
      this.rock.scale.setScalar(s);
      this.p.root.add(this.rock);
    }
    if (on && this.rock) this.placeRock();
    if (this.hammer) this.hammer.visible = on;
    if (this.rock) this.rock.visible = on;
  }

  /**
   * Put the rock where the hammer will land: pose the strike with plain FK,
   * read the hammer head position in root space, then restore the pose.
   */
  private placeRock() {
    const J = this.p.joints;
    const saved = [J.spine, J.shoulderR, J.elbowR].map((j) => j.quaternion.clone());
    J.spine.rotation.set(0.42, 0, 0);
    J.shoulderR.rotation.set(-0.4, 0, -0.12, 'ZYX');
    J.elbowR.rotation.set(-0.1, 0, 0);
    this.p.root.updateMatrixWorld(true);
    const at = this.p.root.worldToLocal(this.hammerHead!.getWorldPosition(new THREE.Vector3()));
    [J.spine, J.shoulderR, J.elbowR].forEach((j, i) => j.quaternion.copy(saved[i]));
    this.rock!.position.set(at.x, 0, at.z);
  }

  /** Before the animator: returns overrides (or null when idle). */
  pre(dt: number, m: Motion, st: Style): ActionPose | null {
    this.impact = false;
    this.dust = false;
    this.beat = false;
    this.sawSpeed = 0;
    this.events.length = 0;
    m.lockPhase = false;
    if (!this.kind) return null;
    if (this.stopNow) {
      m.speed = 0;
      this.stopNow = false;
    }
    this.prevT = this.t;
    this.t += dt;
    const P = this.pose;
    P.crouch = P.sitZ = P.lift = P.spineX = P.headX = P.headY = P.headZ = 0;
    Object.assign(P.arms.L, arm());
    Object.assign(P.arms.R, arm());
    const d = this.p.dims;
    const tempo = st.tempo;
    this.tempo = tempo;
    const t = this.t;

    switch (this.kind) {
      case 'wave': {
        const dur = 2.6;
        if (this.crossed(0.25) && this.side === 'R') this.events.push('hey');
        if (t >= dur) return this.finish();
        const e = envelope(t, dur, 0.3, 0.45);
        const ph = Math.PI * 2 * 2.2 * tempo * t;
        Object.assign(P.arms[this.side], {
          w: e,
          x: -0.25,
          z: 2.45 + 0.3 * Math.sin(ph),
          elbow: 0.55 + 0.35 * Math.sin(ph + 0.8),
          stiff: 1.8,
        });
        P.headX = -0.12 * e;
        P.headZ = (this.side === 'R' ? -0.12 : 0.12) * e;
        P.spineX = -0.05 * e;
        return P;
      }

      case 'hammer': {
        const lead = 0.35;
        const T = 0.85 / tempo;
        const blows = 3;
        const dur = lead + T * blows + 0.3;
        if (t >= dur) return this.finish();
        const e = envelope(t, dur, lead, 0.4);
        const raw = Math.max(0, t - lead) / T;
        const u = raw >= blows ? 0.9 : raw % 1;
        let x: number, el: number;
        let z = 0.12;
        // wind-up → fast strike → *hold* (springs catch up, the blow reads) → rebound
        if (u < 0.5) {
          const k = smooth(u / 0.5);
          x = lerp(-0.6, -2.5, k);
          el = lerp(0.3, 1.7, k);
          z = 0.12 + 0.4 * k; // swing wide so the hammer clears the head
        } else if (u < 0.6) {
          const k = ((u - 0.5) / 0.1) ** 2; // accelerating strike
          x = lerp(-2.5, -0.4, k);
          el = lerp(1.7, 0.1, k);
          z = lerp(0.52, 0.12, k);
        } else if (u < 0.78) {
          x = -0.4;
          el = 0.1;
        } else {
          const k = (u - 0.78) / 0.22;
          x = lerp(-0.4, -0.6, k) - 0.15 * Math.sin(Math.PI * k);
          el = lerp(0.1, 0.3, k);
        }
        const HIT = 0.66; // when the springed arm actually arrives
        if (raw < blows && this.lastU < HIT && u >= HIT) this.impact = true;
        this.lastU = u;
        Object.assign(P.arms.R, { w: e, x, z, elbow: el, stiff: 3.2 });
        Object.assign(P.arms.L, { w: e, x: -0.75, z: 0.2, elbow: 1.2, stiff: 1 });
        const strike = u >= 0.5 && u < 0.8 ? Math.sin(((u - 0.5) / 0.3) * Math.PI) : 0;
        P.crouch = (0.07 + 0.03 * strike) * e;
        P.spineX = (0.3 + 0.12 * strike) * e;
        P.headX = 0.3 * e;
        return P;
      }

      case 'jump': {
        const tA = 0.24 / Math.sqrt(tempo); // anticipation
        const h = d.legLen * 0.7 * st.hop;
        const v0 = Math.sqrt(2 * JUMP_G * h);
        const tAir = (2 * v0) / JUMP_G;
        const tL = 0.32;
        if (t < tA) {
          const k = smooth(t / tA);
          P.crouch = 0.32 * k;
          P.spineX = 0.3 * k;
          P.headX = -0.1 * k;
          for (const s of ['L', 'R'] as const) Object.assign(P.arms[s], { w: k, x: 0.7, z: 0.3, elbow: 0.3, stiff: 2 });
        } else if (t < tA + tAir) {
          if (this.crossed(tA)) this.events.push('hup');
          const s = t - tA;
          m.lockPhase = true; // stride frozen mid-air
          const tuck = 0.25 * Math.sin((Math.PI * s) / tAir);
          P.lift = v0 * s - 0.5 * JUMP_G * s * s + tuck * d.legLen;
          P.crouch = tuck;
          P.spineX = -0.12;
          P.headX = -0.2;
          for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: 1, x: -0.4, z: 2.3, elbow: 0.4, stiff: 2.2 });
        } else if (t < tA + tAir + tL) {
          const k = (t - tA - tAir) / tL;
          P.crouch = 0.34 * (1 - k) ** 2; // squash on landing
          P.spineX = 0.25 * (1 - k);
          for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: 1 - k, x: -0.5, z: 0.7, elbow: 0.5, stiff: 1.5 });
        } else return this.finish();
        return P;
      }

      case 'carry': {
        const tUp = 0.8 / Math.sqrt(tempo);
        const tCarry = 7;
        const tDown = 0.8 / Math.sqrt(tempo);
        const dur = tUp + tCarry + tDown + 0.3;
        if (t >= dur) return this.finish();
        const a = this.carryArms();
        // bend: 0 standing, 1 squatting down at the box
        let bend = 0;
        if (t < tUp) bend = Math.sin(Math.PI * (t / tUp));
        else if (t > tUp + tCarry && t < tUp + tCarry + tDown) bend = Math.sin(Math.PI * ((t - tUp - tCarry) / tDown));
        const carrying = t >= tUp * 0.5 && t < tUp + tCarry + tDown * 0.5;
        if (this.crossed(tUp + tCarry + tDown * 0.5)) this.events.push('thunk');
        this.holdSpeed = t < tUp || t > tUp + tCarry;
        const reachX = -1.0; // arms down toward the box at the bottom of the bend
        for (const sd of ['L', 'R'] as const) {
          Object.assign(P.arms[sd], {
            w: carrying || bend > 0.05 ? 1 : 0,
            x: lerp(a.x, reachX, bend),
            z: a.z,
            elbow: lerp(a.elbow, 0.35, bend),
            stiff: 2.2,
          });
        }
        if (!carrying && bend < 0.05) P.arms.L.w = P.arms.R.w = smooth(1 - (t - tUp - tCarry - tDown) / 0.3);
        P.crouch = 0.38 * bend + (carrying ? 0.025 : 0);
        P.spineX = 1.05 * bend + (carrying ? -0.07 * (1 - bend) : 0); // lean back against the load
        P.headX = -0.25 * bend + (carrying ? 0.1 : 0);
        return P;
      }

      case 'sit': {
        const tIn = 0.35; // bench appears
        const tDown = 0.9 / Math.sqrt(tempo);
        const tSit = 6;
        const tUp = 0.8 / Math.sqrt(tempo);
        const dur = tIn + tDown + tSit + tUp + 0.25;
        if (t >= dur) return this.finish();
        let k = 0; // 0 standing → 1 seated
        if (t < tIn) k = 0;
        else if (t < tIn + tDown) k = smooth((t - tIn) / tDown);
        else if (t < tIn + tDown + tSit) k = 1;
        else k = 1 - smooth((t - tIn - tDown - tSit) / tUp);
        const moving = k > 0 && k < 1 ? Math.sin(Math.PI * k) : 0;
        if (this.crossed(tIn + tDown * 0.85)) this.events.push('creak');
        // push the hips back first, then drop: reads as lowering onto a seat
        const back = smooth(Math.min(1, k * 1.6));
        P.sitZ = this.seat.z * back;
        P.crouch = this.seat.crouch * smooth(Math.max(0, (k - 0.15) / 0.85));
        P.spineX = 0.45 * moving - 0.04 * k; // lean forward to balance, then sit up
        P.headX = -0.2 * moving;
        const pop = t < tIn ? smooth(t / tIn) : t > dur - 0.25 ? smooth((dur - t) / 0.25) : 1;
        if (this.bench) this.bench.scale.copy(this.benchScale).multiplyScalar(Math.max(1e-3, pop));
        for (const sd of ['L', 'R'] as const) {
          // hands rest on the thighs; push off them when moving
          Object.assign(P.arms[sd], { w: k, x: -0.12 - 0.3 * moving, z: 0.14, elbow: 1.0, stiff: 1 });
        }
        return P;
      }

      case 'talk': {
        const B = this.beats;
        const dur = B.dur;
        if (t >= dur) return this.finish();
        const e = envelope(t, dur, 0.35, 0.5);
        // a new gesture beat every so often: one or both hands
        if (t >= B.next) {
          B.next = t + (0.45 + Math.random() * 0.6) / tempo;
          this.beat = true;
          const which = Math.random();
          for (const sd of ['L', 'R'] as const) {
            const go = which < 0.4 || (which < 0.7 ? sd === 'R' : sd === 'L');
            const b = B[sd];
            if (go) {
              b.x = -0.25 - Math.random() * 0.7;
              b.z = 0.15 + Math.random() * 0.55;
              b.elbow = 0.9 + Math.random() * 1.0;
              b.w = 1;
            } else if (Math.random() < 0.5) b.w = 0.35; // let it drop a bit
          }
          // head: nod, shake, or tilt for a moment
          if (t > B.headUntil && Math.random() < 0.6) {
            B.head = Math.floor(Math.random() * 3) + 1;
            B.headUntil = t + 0.5 + Math.random() * 0.5;
          }
        }
        const ph = t * Math.PI * 2;
        for (const sd of ['L', 'R'] as const) {
          const b = B[sd];
          const flick = 0.12 * Math.sin(ph * 2.3 * tempo + (sd === 'L' ? 0 : 1.7));
          Object.assign(P.arms[sd], { w: e * b.w, x: b.x + flick * 0.5, z: b.z, elbow: b.elbow + flick, stiff: 1.6 });
        }
        const headOn = t < B.headUntil ? Math.sin(Math.PI * (1 - (B.headUntil - t) / 0.9)) : 0;
        const hk = Math.max(0, headOn) * e;
        if (B.head === 1) P.headX = 0.2 * Math.sin(ph * 2.6) * hk; // nod
        if (B.head === 2) P.headY = 0.35 * Math.sin(ph * 2.2) * hk; // shake
        if (B.head === 3) P.headZ = 0.18 * hk; // tilt
        P.spineX = 0.04 * Math.sin(ph * 0.7) * e; // lean in a little now and then
        return P;
      }

      case 'saw': {
        const lead = 0.4;
        const strokes = 7;
        const T = 0.62 / tempo;
        const dur = lead + strokes * T + 0.9;
        if (t >= dur) return this.finish();
        const e = envelope(t, dur, lead, 0.4);
        const raw = Math.max(0, t - lead) / T;
        const u = raw < strokes ? 0.5 - 0.5 * Math.cos(Math.PI * 2 * raw) : 0; // back → through → back
        // stroke speed (|du/dt| normalised) drives the saw sound
        this.sawSpeed = raw < strokes ? Math.abs(Math.sin(Math.PI * 2 * raw)) : 0;
        this.sawPush = raw % 1 < 0.5;
        if (this.crossed(lead + (strokes + 0.3) * T)) this.events.push('log');
        const a = this.sawStroke(u);
        Object.assign(P.arms.R, { w: e, x: a.x, z: a.z, elbow: a.elbow, stiff: 2.6 });
        Object.assign(P.arms.L, { w: e, x: -0.85, z: 0.0, elbow: 0.15, stiff: 1.4 }); // steadies the log
        P.crouch = SAW_CROUCH * e;
        P.spineX = (0.45 + 0.05 * u) * e;
        P.headX = 0.3 * e;
        P.headZ = 0.05 * e;
        // sawdust on each push
        const stroke = Math.floor(raw);
        this.dust = raw < strokes && raw % 1 > 0.45 && stroke !== this.lastStroke;
        if (this.dust) this.lastStroke = stroke;
        // the last stroke cuts through: halves drop apart
        const split = smooth((raw - strokes) / 0.4);
        this.logHalves.forEach((h, i) => {
          const sgn = i === 0 ? 1 : -1;
          h.position.x = sgn * split * 0.03;
          h.rotation.z = -sgn * split * 0.25;
        });
        if (this.logSet) this.logSet.visible = t < dur - 0.15;
        return P;
      }

      case 'fall': {
        if (this.getup) {
          const k = this.getup.t / this.getup.dur;
          P.crouch = 0.5 * (1 - smooth(k * 1.2)); // rise through a crouch
          P.spineX = 0.5 * (1 - smooth(k));
          return P;
        }
        return null;
      }
    }
    return null;
  }

  private finish() {
    this.stop();
    return null;
  }

  /** Box follows the chest while carried, blending from/to the ground. */
  private postCarry() {
    if (!this.box) return;
    const p = this.p;
    const tUp = 0.8 / Math.sqrt(this.tempo);
    const tCarry = 7;
    const tDown = tUp;
    const t = this.t;
    // 0 = on the ground, 1 = in the hands
    let k = 0;
    if (t < tUp) k = smooth((t / tUp - 0.5) * 2);
    else if (t < tUp + tCarry) k = 1;
    else k = 1 - smooth(((t - tUp - tCarry) / tDown) * 2);
    p.root.updateMatrixWorld(true);
    _m.copy(p.root.matrixWorld).invert().multiply(p.joints.spine.matrixWorld).multiply(this.boxHeld);
    _m.decompose(_pos, _q, _scl);
    this.box.position.lerpVectors(this.boxGround, _pos, k);
    this.box.quaternion.identity().slerp(_q, k);
    const gone = Math.max(0, t - tUp - tCarry - tDown);
    this.box.visible = gone < 0.25;
  }

  /** After the animator: pose overrides that replace the animation outright. */
  post(dt: number, m: Motion, st: Style) {
    if (this.kind === 'saw' && this.saw) {
      // hold the blade at a constant angle: undo the forearm's swing in the fist
      const J = this.p.joints;
      const fore = -(J.shoulderR.rotation.x + J.elbowR.rotation.x);
      this.saw.rotation.x = fore - this.sawStroke(0.5).blade;
      return;
    }
    if (this.kind === 'carry') return this.postCarry();
    if (this.kind !== 'fall') return;
    const p = this.p;
    const J = p.joints;

    if (!this.ragdoll && !this.getup) {
      // start falling from whatever pose we're in, keeping momentum
      const yaw = p.root.rotation.y;
      const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const v = fwd.clone().multiplyScalar(m.speed);
      const trip = this.push.lengthSq() === 0;
      const push = trip ? fwd.clone().multiplyScalar(0.5 + 0.6 * m.speed).setY(0.1) : this.push;
      this.ragdoll = new Ragdoll(p, v, (i, vel) => {
        if (i >= 9) vel.addScaledVector(push, 1); // upper body
        else if (trip) vel.multiplyScalar(0.1); // feet caught
        else vel.addScaledVector(push, 0.4);
        // knees buckle (indices 2/6) so the body crumples instead of toppling like a plank
        if (i === 2 || i === 6) vel.addScaledVector(fwd, 0.9).y -= 0.6;
      });
      this.events.push('oof');
      // reflex: throw the hands out toward where we're falling
      this.ragdoll.reach.copy(push).setY(0).normalize().setY(-0.6);
      this.rootLocked = true;
      m.speed = 0;
    }

    if (this.ragdoll) {
      const r = this.ragdoll;
      r.step(dt);
      r.apply();
      if (r.stillTime > 0.8 || r.age > 4.5) {
        // re-root where the body lies, facing along it, then blend up
        p.root.position.set(r.centre.x, 0, r.centre.z);
        p.root.rotation.y = r.lyingYaw();
        p.root.updateMatrixWorld(true);
        r.apply();
        const q = new Map<JointName, THREE.Quaternion>();
        for (const j of JOINTS) q.set(j, J[j].quaternion.clone());
        this.getup = { t: 0, dur: 1.5 / Math.sqrt(st.tempo), q, pelvis: J.pelvis.position.clone() };
        this.events.push('grunt');
        this.ragdoll = null;
      }
      return;
    }

    if (this.getup) {
      const g = this.getup;
      g.t += dt;
      const k = smooth(g.t / g.dur);
      // (slerpQuaternions copies its first arg into `this`, so stash the target)
      for (const j of JOINTS) J[j].quaternion.slerpQuaternions(g.q.get(j)!, _target.copy(J[j].quaternion), k);
      J.pelvis.position.lerpVectors(g.pelvis, J.pelvis.position, k);
      if (g.t >= g.dur) this.stop();
    }
  }
}
