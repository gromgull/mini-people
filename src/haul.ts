import * as THREE from 'three';
import { type Person, withRow } from './body';
import { type ActionPose, type PropKit, mesh, reachFist, smooth } from './actionkit';
import type { Chore, ChoreOut } from './chores';
import { ROWS } from './palette';

/**
 * Hauling a log on the shoulder: bend down to it, lift it to the chest with
 * both hands, swing it up onto the right shoulder, and walk with it there
 * (the right hand steadying it) for as long as it takes; then, when told
 * where it goes (`putDown`), bring it off the shoulder and set it down there,
 * bending as low as that place needs.
 *
 * The log leads and the hands follow (two-bone IK onto it each frame), like
 * the meals at the table. In the village the log is a real one (`aim` hands
 * over its mesh and where it lies); in the demo, with nothing aimed, a log is
 * conjured at the feet and put down again after a few seconds of carrying.
 */

export interface LogSpot {
  pos: THREE.Vector3; // centre, world
  yaw: number; // the log's axis is its local x, turned by this
}

const LIFT = 1.6;
const LOWER = 1.5;
const DEMO_CARRY = 6;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);
const _X = new THREE.Vector3(1, 0, 0);

type Pose = { pos: THREE.Vector3; q: THREE.Quaternion };

export class Haul implements Chore {
  private log: THREE.Object3D | null = null;
  private conjured: THREE.Object3D | null = null;
  private r = 0.065;
  private from: LogSpot | null = null;
  private to: LogSpot | null = null;
  private phase: 'lift' | 'carry' | 'lower' = 'lift';
  private t0 = 0;
  private t = 0;
  private demo = false;
  /** Set once it has been put down (the chore then ends). */
  done = false;

  constructor(private p: Person, private kit: PropKit) {}

  /** The log to pick up (its mesh, which this drives from now on) and where it lies. */
  aim(log: THREE.Object3D, from: LogSpot, r: number) {
    this.log = log;
    this.from = from;
    this.r = r;
  }

  /** Where it goes: start putting it down there. */
  putDown(to: LogSpot) {
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
    this.t0 = 0;
    this.t = 0;
    this.done = false;
    this.to = null;
    this.demo = !this.log;
    if (this.demo) {
      // nothing aimed: conjure one lying across the path at the feet
      const s = Math.sqrt(this.p.dims.height);
      this.r = 0.065 * s;
      if (!this.conjured) {
        const g = withRow(new THREE.CylinderGeometry(1, 1, 1, 7).rotateZ(Math.PI / 2), ROWS.bark[0]);
        const ends = withRow(new THREE.CylinderGeometry(0.82, 0.82, 1.004, 7).rotateZ(Math.PI / 2), ROWS.food[0]);
        this.conjured = new THREE.Group();
        this.conjured.add(mesh(ends, this.kit), mesh(g, this.kit));
        this.p.root.parent?.add(this.conjured);
      }
      this.conjured.scale.set(0.8 * s, this.r, this.r);
      this.conjured.visible = true;
      this.log = this.conjured;
      this.p.root.updateMatrixWorld(true);
      const pos = this.p.root.localToWorld(new THREE.Vector3(0, this.r, 0.42 * this.p.dims.height));
      this.from = { pos, yaw: this.p.root.rotation.y };
    }
  }

  pre(t: number, _dt: number, P: ActionPose, _tempo: number, out: ChoreOut) {
    this.t = t;
    if (this.phase === 'lift' && t - this.t0 >= LIFT) {
      this.phase = 'carry';
      this.t0 = t;
      out.events.push('grunt');
    }
    if (this.phase === 'carry' && this.demo && t - this.t0 > DEMO_CARRY) {
      this.p.root.updateMatrixWorld(true);
      this.putDown({ pos: this.p.root.localToWorld(new THREE.Vector3(0, this.r, 0.42 * this.p.dims.height)), yaw: this.p.root.rotation.y });
    }
    if (this.phase === 'lower' && t - this.t0 >= LOWER) {
      if (!this.done) out.events.push('log');
      this.done = true;
      if (this.demo && this.conjured) this.conjured.visible = false;
      return false;
    }
    out.holdSpeed = this.phase !== 'carry';
    // bend to wherever the log is low
    const k = this.bend();
    P.crouch = 0.3 * k;
    P.spineX = 0.85 * k;
    P.headX = 0.25 * k;
    if (this.phase === 'carry') {
      P.headZ = 0.16; // head tipped away from the load
      P.spineZ = -0.05;
    }
    return true;
  }

  /** 0 standing … 1 bent right down, from where the log is in the lift/put-down. */
  private bend() {
    const u = this.t - this.t0;
    const H = this.p.dims.height;
    const lowness = (spot: LogSpot | null) => (spot ? Math.max(0, Math.min(1, (0.55 * H - spot.pos.y) / (0.5 * H))) : 0);
    if (this.phase === 'lift') return lowness(this.from) * (u < 0.5 ? smooth(u / 0.5) : 1 - smooth((u - 0.55) / 0.6));
    if (this.phase === 'lower') return lowness(this.to) * (u < 0.4 ? 0 : u < 1.0 ? smooth((u - 0.4) / 0.5) : 1 - smooth((u - 1.05) / 0.4));
    return 0;
  }

  /** The three places the log passes through, in the root frame. */
  private poses() {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    p.root.updateMatrixWorld(true);
    const rootQ = p.root.getWorldQuaternion(new THREE.Quaternion());
    const rootQi = rootQ.clone().invert();
    const spot = (s: LogSpot): Pose => ({
      pos: p.root.worldToLocal(s.pos.clone()),
      q: rootQi.clone().multiply(new THREE.Quaternion().setFromAxisAngle(_Y, s.yaw)),
    });
    // across the chest, in both hands
    const chest: Pose = {
      pos: p.root.worldToLocal(J.spine.localToWorld(new THREE.Vector3(0, d.shoulderY * 0.6, d.shoulderR * d.torsoDepth + this.r + 0.08))),
      q: new THREE.Quaternion(),
    };
    // on top of the right shoulder, pointing fore and aft
    const sh = J.spine.localToWorld(J.shoulderR.position.clone().add(_a.set(-d.upperArmR * 0.9, d.upperArmR * 1.05 + this.r * 0.9, 0.04)));
    const spineQ = J.spine.getWorldQuaternion(new THREE.Quaternion());
    const shoulder: Pose = {
      pos: p.root.worldToLocal(sh),
      q: rootQi.clone().multiply(spineQ).multiply(_q2.setFromAxisAngle(_Y, Math.PI / 2)),
    };
    return { spot, chest, shoulder, rootQ };
  }

  post(_t: number, _dt: number, _out: ChoreOut) {
    const log = this.log;
    if (!log) return;
    const p = this.p;
    const d = p.dims;
    const u = this.t - this.t0;
    const { spot, chest, shoulder, rootQ } = this.poses();
    const mix = (a: Pose, b: Pose, k: number): Pose => ({ pos: a.pos.clone().lerp(b.pos, k), q: a.q.clone().slerp(b.q, k) });
    let at: Pose;
    let wL = 1, wR = 1;
    let reach = 1; // hands on (blending in at the start of the lift, off at the end of the put-down)
    if (this.phase === 'lift') {
      const from = spot(this.from!);
      if (u < 0.5) {
        at = from;
        reach = smooth(u / 0.45);
      } else if (u < 1.1) at = mix(from, chest, smooth((u - 0.5) / 0.6));
      else {
        const k = smooth((u - 1.1) / 0.5);
        at = mix(chest, shoulder, k);
        wL = 1 - k;
      }
      at.pos.y += Math.sin(Math.PI * Math.min(1, Math.max(0, (u - 0.5) / 1.1))) * 0.04; // a little heave
    } else if (this.phase === 'carry') {
      at = shoulder;
      wL = 0;
    } else {
      const to = spot(this.to!);
      if (u < 0.4) {
        const k = smooth(u / 0.4);
        at = mix(shoulder, chest, k);
        wL = k;
      } else if (u < 1.05) at = mix(chest, to, smooth((u - 0.4) / 0.6));
      else {
        at = to;
        reach = 1 - smooth((u - 1.05) / 0.4);
      }
    }
    // place the log (world)
    log.position.copy(p.root.localToWorld(at.pos.clone()));
    log.quaternion.copy(rootQ).multiply(at.q);
    // hands: either side of the middle, on top of it when low, under it when carried
    const axis = _a.copy(_X).applyQuaternion(at.q);
    const onShoulder = this.phase === 'carry' || (this.phase === 'lift' && u > 1.1) || (this.phase === 'lower' && u < 0.4);
    const grip = (side: 1 | -1) => {
      if (onShoulder && side < 0) {
        // right hand: on the log in front of the shoulder
        return at.pos.clone().addScaledVector(axis, (this.r + 0.16) * (axis.z >= 0 ? 1 : -1)).add(_b.set(0, -this.r - d.handR * 0.5, 0));
      }
      const low = at.pos.y < 0.5 * d.height;
      return at.pos.clone().addScaledVector(axis, side * 0.17).add(_b.set(0, low ? this.r + d.handR * 0.6 : -this.r - d.handR * 0.5, 0));
    };
    reachFist(p, 'R', grip(-1), wR * reach);
    reachFist(p, 'L', grip(1), wL * reach);
  }

  hide() {
    if (this.conjured) this.conjured.visible = false;
    this.log = null;
    this.from = this.to = null;
  }

  dispose() {
    this.hide();
    this.conjured?.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.conjured?.removeFromParent();
  }
}
