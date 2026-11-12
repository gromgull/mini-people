import * as THREE from 'three';
import { JOINTS, type JointName, type Person, withRow } from './body';
import type { Motion } from './gait';
import type { Style } from './persona';
import { ROWS } from './palette';
import { Ragdoll } from './ragdoll';

export const ACTIONS = ['wave', 'hammer', 'jump', 'fall'] as const;
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
const _target = new THREE.Quaternion();

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

  private pose: ActionPose = { crouch: 0, lift: 0, spineX: 0, headX: 0, headY: 0, headZ: 0, arms: { L: arm(), R: arm() } };
  private side: 'L' | 'R' = 'R';
  private push = new THREE.Vector3();
  private stopNow = false;
  private ragdoll: Ragdoll | null = null;
  private getup: { t: number; dur: number; q: Map<JointName, THREE.Quaternion>; pelvis: THREE.Vector3 } | null = null;
  private hammer: THREE.Object3D | null = null;
  private rock: THREE.Object3D | null = null;
  private lastU = 0;

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
    this.holdSpeed = kind === 'hammer' || kind === 'fall';
    this.stopNow = kind === 'fall';
    this.lastU = 0;
    if (kind === 'hammer') this.showHammer(true);
  }

  stop() {
    this.showHammer(false);
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
    m.lockPhase = false;
    if (!this.kind) return null;
    if (this.stopNow) {
      m.speed = 0;
      this.stopNow = false;
    }
    this.t += dt;
    const P = this.pose;
    P.crouch = P.lift = P.spineX = P.headX = P.headY = P.headZ = 0;
    Object.assign(P.arms.L, arm());
    Object.assign(P.arms.R, arm());
    const d = this.p.dims;
    const tempo = st.tempo;
    const t = this.t;

    switch (this.kind) {
      case 'wave': {
        const dur = 2.6;
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

  /** After the animator: pose overrides that replace the animation outright. */
  post(dt: number, m: Motion, st: Style) {
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
