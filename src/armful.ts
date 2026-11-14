import * as THREE from 'three';
import type { Person } from './body';
import { type ActionPose, type PropKit, reachFist, smooth } from './actionkit';
import type { Chore, ChoreOut } from './chores';
import { PIECE_L, PIECE_R, makePiece } from './firewood';

/**
 * Carrying an armful of small things (firewood) in both arms against the
 * chest: bend down to where they lie, gather them up one after another into
 * a little stack in the arms, walk with it as long as it takes, then (told
 * where each piece goes, `putDown`) bend and set them down one by one.
 *
 * Each item travels on its own from where it was to its place in the armful
 * and later to its own spot, a little after the one before, so a gather
 * reads as picking up and a put-down as stacking. The arms are solved onto
 * the bundle. Without items aimed (the demo) it conjures a few pieces of
 * firewood at the feet.
 */

export interface ItemPose {
  pos: THREE.Vector3; // world
  quat: THREE.Quaternion; // world
}

const LIFT = 1.5;
const LOWER = 1.5;
const DEMO_CARRY = 5;

const _a = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Armful implements Chore {
  private items: THREE.Object3D[] = [];
  private from: ItemPose[] = [];
  private to: ItemPose[] | null = null;
  private conjured: THREE.Object3D[] = [];
  private phase: 'lift' | 'carry' | 'lower' = 'lift';
  private t0 = 0;
  private t = 0;
  private demo = false;
  done = false;

  constructor(private p: Person, private kit: PropKit) {}

  /** The things to pick up (their meshes, which this drives from now on) and where each lies. */
  aim(items: THREE.Object3D[], from: ItemPose[]) {
    this.items = items;
    this.from = from;
  }

  /** Where each one goes (same order): start putting them down. */
  putDown(to: ItemPose[]) {
    if (this.phase !== 'carry') return false;
    this.to = to;
    this.phase = 'lower';
    this.t0 = this.t;
    return true;
  }

  get carrying() {
    return this.phase === 'carry';
  }

  start() {
    this.phase = 'lift';
    this.t0 = this.t = 0;
    this.done = false;
    this.to = null;
    this.demo = !this.items.length;
    if (this.demo) {
      // nothing aimed: a few pieces lying at the feet
      while (this.conjured.length < 4) {
        const m = makePiece(this.kit);
        this.p.root.parent?.add(m);
        this.conjured.push(m);
      }
      this.p.root.updateMatrixWorld(true);
      const rq = this.p.root.getWorldQuaternion(new THREE.Quaternion());
      this.items = this.conjured;
      this.from = this.conjured.map((m, k) => {
        m.visible = true;
        return {
          pos: this.p.root.localToWorld(new THREE.Vector3((k - 1.5) * 0.12, PIECE_R * 0.5, 0.42 * this.p.dims.height)),
          quat: rq.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 + (k - 1.5) * 0.3)),
        };
      });
    }
  }

  pre(t: number, _dt: number, P: ActionPose, _tempo: number, out: ChoreOut) {
    this.t = t;
    if (this.phase === 'lift' && t - this.t0 >= LIFT) {
      this.phase = 'carry';
      this.t0 = t;
    }
    if (this.phase === 'carry' && this.demo && t - this.t0 > DEMO_CARRY) {
      this.p.root.updateMatrixWorld(true);
      this.putDown(this.from.map((f) => ({ pos: f.pos.clone(), quat: f.quat.clone() })));
    }
    if (this.phase === 'lower' && t - this.t0 >= LOWER) {
      if (!this.done) out.events.push('log');
      this.done = true;
      if (this.demo) for (const m of this.conjured) m.visible = false;
      return false;
    }
    out.holdSpeed = this.phase !== 'carry';
    const k = this.bend();
    P.crouch = 0.3 * k;
    P.spineX = 0.8 * k + (this.phase === 'carry' ? -0.06 : 0); // lean back a touch against the load
    P.headX = 0.2 * k + (this.phase === 'carry' ? 0.12 : 0);
    // rough hugging arms for the springs; post() solves them onto the bundle
    for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: 1, x: -0.9 - 0.6 * k, z: 0.2, elbow: 1.5 - k, stiff: 2 });
    return true;
  }

  /** How bent down: toward the lowest of what's being picked up or put down. */
  private bend() {
    const u = this.t - this.t0;
    const H = this.p.dims.height;
    const low = (poses: ItemPose[] | null) => (poses && poses.length ? Math.max(0, Math.min(1, (0.6 * H - Math.min(...poses.map((p) => p.pos.y))) / (0.55 * H))) : 0);
    if (this.phase === 'lift') return low(this.from) * (u < 0.35 ? smooth(u / 0.35) : 1 - smooth((u - 1.0) / 0.5));
    if (this.phase === 'lower') return low(this.to) * (u < 0.25 ? smooth(u / 0.25) : 1 - smooth((u - 1.05) / 0.45));
    return 0;
  }

  /** Item k's place in the arms (world): a little stack against the chest, pieces across. */
  private held(k: number): ItemPose {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    const front = d.shoulderR * d.torsoDepth + PIECE_R * 1.5;
    // two side by side front to back, layers going up
    const local = new THREE.Vector3(((k * 7) % 3 - 1) * 0.015, d.shoulderY * 0.38 + Math.floor(k / 2) * PIECE_R * 1.1, front + ((k % 2) - 0.5) * PIECE_R * 1.8);
    const pos = J.spine.localToWorld(local);
    const quat = J.spine.getWorldQuaternion(new THREE.Quaternion()).multiply(_q.setFromAxisAngle(_a.set(0, 1, 0), 0.08 * ((k % 3) - 1)));
    return { pos, quat };
  }

  post(_t: number, _dt: number, _out: ChoreOut) {
    const p = this.p;
    const d = p.dims;
    p.root.updateMatrixWorld(true);
    const u = this.t - this.t0;
    const n = this.items.length;
    let grip = 1;
    this.items.forEach((m, k) => {
      const h = this.held(k);
      // one after another: each item's own 0 → 1 within the gather / put-down
      const stagger = (span: number, from: number) => smooth((u - from - (k / Math.max(1, n)) * span * 0.5) / (span * 0.5));
      let pose = h;
      if (this.phase === 'lift') {
        const g = stagger(0.75, 0.35);
        const f = this.from[k];
        pose = { pos: f.pos.clone().lerp(h.pos, g), quat: f.quat.clone().slerp(h.quat, g) };
        pose.pos.y += Math.sin(Math.PI * g) * 0.05;
      } else if (this.phase === 'lower' && this.to) {
        const g = stagger(0.75, 0.3);
        const tt = this.to[k];
        pose = { pos: h.pos.clone().lerp(tt.pos, g), quat: h.quat.clone().slerp(tt.quat, g) };
        pose.pos.y += Math.sin(Math.PI * g) * 0.04;
      }
      m.position.copy(pose.pos);
      m.quaternion.copy(pose.quat);
    });
    // hands under the bundle's ends; on during the gather, off at the end of the put-down
    if (this.phase === 'lift') grip = smooth(u / 0.4);
    if (this.phase === 'lower') grip = 1 - smooth((u - 1.1) / 0.35);
    const J = p.joints;
    const base = J.spine.localToWorld(new THREE.Vector3(0, d.shoulderY * 0.38 - PIECE_R * 0.7, d.shoulderR * d.torsoDepth + PIECE_R * 1.5));
    const right = _a.set(1, 0, 0).transformDirection(J.spine.matrixWorld).clone();
    for (const [side, s] of [['L', 1], ['R', -1]] as const) {
      const at = base.clone().addScaledVector(right, s * (PIECE_L * 0.5 + d.handR * 0.1));
      reachFist(p, side, p.root.worldToLocal(at), grip);
    }
  }

  hide() {
    for (const m of this.conjured) m.visible = false;
    this.items = [];
    this.from = [];
    this.to = null;
  }

  dispose() {
    this.hide();
    for (const m of this.conjured) m.removeFromParent();
  }
}
