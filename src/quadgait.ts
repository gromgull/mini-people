import * as THREE from 'three';
import { twoBoneIK, aimDown } from './ik';
import type { Quadruped } from './quadruped';

/**
 * Four-legged gaits for the quadruped rig: a walk (one foot at a time, in
 * the order left hind, left front, right hind, right front) that turns into
 * a trot (diagonal pairs together) as it speeds up.
 *
 * As with the people, the feet are the truth: each paw is planted on the
 * ground under its shoulder or hip for its stance and slides back exactly as
 * far as the body moves on, then swings forward, lifted, to land ahead.
 * The hips and the chest each ride as high as their legs can reach (so the
 * body bobs, and pitches when the front and back sink differently); each
 * leg is solved with two-bone IK (the front elbow pointing back, the hind
 * stifle forward), the hind leg's short raised segment tilting back as the
 * paw comes up; paws land flat. The head keeps steady against the bob and
 * the tail swings with the stride.
 */

export interface QuadMotion {
  /** 0 … 1 through the stride cycle (left hind lands at 0). */
  phase: number;
  speed: number;
}

interface Gait {
  /** Each leg's start in the cycle: left front, right front, left hind, right hind. */
  off: [number, number, number, number];
  /** Fraction of the cycle each foot is down. */
  duty: number;
  /** Cycle length, in leg lengths. */
  stride: number;
  /** How high a paw lifts, in leg lengths. */
  lift: number;
}

// (the trot's offsets are the walk's moved on round the cycle the short way,
// so blending one into the other never jumps)
// (strides keep a planted paw within about ±30° of straight down, as a dog's do)
const WALK: Gait = { off: [0.25, 0.75, 0, 0.5], duty: 0.64, stride: 1.6, lift: 0.16 };
const TROT: Gait = { off: [0.5, 1.0, 0, 0.5], duty: 0.42, stride: 2.2, lift: 0.22 };

/** A dog's walking and trotting speeds (m/s, scaled by its size). */
export const dogSpeeds = (dog: Quadruped) => ({ walk: 0.45 * dog.dims.s, trot: 1.1 * dog.dims.s });

const smooth = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qRoot = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0);

interface Leg {
  front: boolean;
  /** The joints: upper (shoulder/hip), middle (elbow/stifle), lower end (wrist/hock), and the paw (hind only). */
  upper: THREE.Object3D;
  middle: THREE.Object3D;
  end: THREE.Object3D;
  paw: THREE.Object3D | null;
  l1: number;
  l2: number;
  /** Where the foot (wrist / paw joint) stands at rest, root frame. */
  rest: THREE.Vector3;
  /** Hock above the paw at rest (hind), root frame. */
  meta: THREE.Vector3;
  /** Upper joint to foot (front) or hock (hind) at rest: the bend to keep. */
  reach: number;
  /** This frame's foot target (root frame), and whether it's down. */
  at: THREE.Vector3;
  swing: number;
}

export class QuadAnimator {
  private legs: Leg[];
  private hipsRest: THREE.Vector3;
  private hipsRot: THREE.Euler;
  private neckRest: number;
  private tailRest: [number, number, number];
  private bodyLen: number;
  private legLen: number;
  /** 0 … 1: how far into a trot. */
  trot = 0;
  /** Extra tail wag (0 … 1), set by whoever's driving. */
  wag = 0;
  private t = 0;

  constructor(private dog: Quadruped) {
    const J = dog.joints;
    const d = dog.dims;
    this.legLen = d.upper + d.lower;
    this.bodyLen = d.bodyLen;
    this.hipsRest = J.hips.position.clone();
    this.hipsRot = J.hips.rotation.clone();
    this.neckRest = J.neck.rotation.x;
    this.tailRest = [J.tail0.rotation.x, J.tail1.rotation.x, J.tail2.rotation.x];
    dog.root.updateMatrixWorld(true);
    const inRoot = (o: THREE.Object3D) => dog.root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
    this.legs = (['L', 'R'] as const).flatMap((s) => {
      const fu = J[`shoulder${s}`], fm = J[`elbow${s}`], fe = J[`wrist${s}`];
      const hu = J[`hip${s}`], hm = J[`stifle${s}`], he = J[`hock${s}`], hp = J[`paw${s}`];
      const front: Leg = { front: true, upper: fu, middle: fm, end: fe, paw: null, l1: d.upper, l2: d.lower, rest: inRoot(fe), meta: new THREE.Vector3(), reach: inRoot(fu).distanceTo(inRoot(fe)), at: new THREE.Vector3(), swing: 0 };
      const hind: Leg = { front: false, upper: hu, middle: hm, end: he, paw: hp, l1: d.thigh, l2: d.shank, rest: inRoot(hp), meta: inRoot(he).sub(inRoot(hp)), reach: inRoot(hu).distanceTo(inRoot(he)), at: new THREE.Vector3(), swing: 0 };
      return [front, hind];
    });
    // (order the legs to match the gait's offsets: left front, right front, left hind, right hind)
    this.legs = [this.legs[0], this.legs[2], this.legs[1], this.legs[3]];
  }

  /** The gait for this speed: a walk blending into a trot. */
  private gait(speed: number): Gait {
    const sp = dogSpeeds(this.dog);
    const k = smooth((speed - sp.walk * 1.1) / (sp.trot * 0.9 - sp.walk * 1.1));
    this.trot += (k - this.trot) * 0.1;
    const t = this.trot;
    const mix = (a: number, b: number) => a + (b - a) * t;
    return { off: WALK.off.map((o, i) => mix(o, TROT.off[i])) as Gait['off'], duty: mix(WALK.duty, TROT.duty), stride: mix(WALK.stride, TROT.stride), lift: mix(WALK.lift, TROT.lift) };
  }

  /** Cycle length (metres) at this speed (shorter strides when slow, so the cadence never drops to nothing). */
  cycle(speed: number) {
    const g = this.gait(speed);
    const w = Math.min(1, speed / dogSpeeds(this.dog).walk);
    return this.legLen * g.stride * (0.35 + 0.65 * Math.sqrt(w));
  }

  /** Move the stride on for the distance covered. */
  advance(m: QuadMotion, dt: number) {
    m.phase = (m.phase + (m.speed * dt) / Math.max(1e-3, this.cycle(m.speed))) % 1;
  }

  /** Pose the dog for this moment of the stride. */
  update(m: QuadMotion, dt: number) {
    this.t += dt;
    const dog = this.dog;
    const J = dog.joints;
    const g = this.gait(m.speed);
    const sp = dogSpeeds(dog);
    const w = Math.min(1.2, m.speed / sp.walk); // 0 standing … 1 walking
    const C = this.cycle(m.speed) * Math.min(1, w * 4); // (collapses to nothing standing still)
    const D = g.duty * C; // how far a planted paw slides back
    const lift = this.legLen * g.lift * Math.min(1, w);

    // --- where each paw is
    this.legs.forEach((leg, i) => {
      const lp = (((m.phase - g.off[i]) % 1) + 1) % 1; // this leg's own phase: 0 = it lands
      leg.at.copy(leg.rest);
      if (lp < g.duty) {
        leg.at.z += D * (0.5 - lp / g.duty);
        leg.swing = 0;
      } else {
        const t = (lp - g.duty) / (1 - g.duty);
        leg.at.z += D * (smooth(t) - 0.5);
        leg.at.y += Math.sin(Math.PI * t) * lift * (leg.front ? 1 : 0.85);
        leg.swing = Math.sin(Math.PI * t);
      }
    });

    // --- hips and chest: each as high as its legs can reach, keeping their standing bend
    const sink = (front: boolean) => {
      let drop = 0;
      for (const leg of this.legs) {
        if (leg.front !== front) continue;
        const foot = front ? leg.at : _w.copy(leg.at).add(this.metaNow(leg));
        const restFoot = front ? leg.rest : _v.copy(leg.rest).add(leg.meta);
        // height lost to the foot being ahead of or behind where it stands at rest
        const dz = foot.z - restFoot.z;
        drop = Math.max(drop, leg.reach - Math.sqrt(Math.max(1e-6, leg.reach * leg.reach - dz * dz)));
      }
      return drop;
    };
    const dropH = sink(false);
    const dropC = sink(true);
    const bounce = 0.012 * this.legLen * this.trot * Math.abs(Math.sin(2 * Math.PI * m.phase * 2));
    J.hips.position.set(this.hipsRest.x, this.hipsRest.y - dropH - bounce, this.hipsRest.z);
    const pitch = (dropC - dropH) / this.bodyLen;
    // a little roll with the stride, more at the trot
    const roll = 0.04 * Math.min(1, w) * Math.sin(2 * Math.PI * m.phase);
    J.hips.rotation.set(this.hipsRot.x + pitch, this.hipsRot.y, this.hipsRot.z + roll);

    // --- head steady against the bob; the tail swings with the stride (and wags)
    J.neck.rotation.x = this.neckRest - pitch * 0.8 + 0.05 * Math.min(1, w) * Math.sin(4 * Math.PI * m.phase);
    const wag = this.wag * Math.sin(this.t * 14);
    J.tail0.rotation.set(this.tailRest[0] - 0.1 * Math.min(1, w), 0.25 * Math.min(1, w) * Math.sin(2 * Math.PI * m.phase) + 0.6 * wag, 0, 'YXZ');
    J.tail1.rotation.set(this.tailRest[1], 0.15 * wag, 0, 'YXZ');
    J.tail2.rotation.set(this.tailRest[2], 0.2 * wag, 0, 'YXZ');

    // --- legs
    dog.root.updateMatrixWorld(true);
    dog.root.getWorldQuaternion(_qRoot);
    for (const leg of this.legs) {
      const parent = leg.upper.parent!;
      // the end of the two-bone chain: the wrist (front), the hock above the paw (hind)
      const endRoot = leg.front ? _v.copy(leg.at) : _v.copy(leg.at).add(this.metaNow(leg));
      const target = parent.worldToLocal(dog.root.localToWorld(endRoot.clone()));
      // pole: front elbow back, hind stifle forward (in the parent's frame, from the root's)
      _pole.set(0, 0, leg.front ? -1 : 1).applyQuaternion(_qRoot);
      parent.getWorldQuaternion(_qParent);
      _pole.applyQuaternion(_qParent.invert());
      twoBoneIK(leg.upper.position, target, _pole, leg.l1, leg.l2, _qa, _qb);
      leg.upper.quaternion.copy(_qa);
      leg.middle.quaternion.copy(_qb);
      leg.upper.updateMatrixWorld(true);
      if (leg.paw) {
        // the hock: its short segment pointing down at the paw
        const pawW = dog.root.localToWorld(_w.copy(leg.at));
        const hockW = leg.end.getWorldPosition(new THREE.Vector3());
        const dir = pawW.sub(hockW).normalize();
        leg.middle.getWorldQuaternion(_qParent);
        _qParent.invert();
        dir.applyQuaternion(_qParent);
        aimDown(dir, new THREE.Vector3(0, 0, 1), leg.end.quaternion);
        leg.end.updateMatrixWorld(true);
      }
      // the paw flat on the ground (its toes dipping as it lifts)
      const foot = leg.paw ?? leg.end;
      foot.parent!.getWorldQuaternion(_qParent);
      _qPitch.setFromAxisAngle(X, 0.6 * leg.swing);
      foot.quaternion.copy(_qParent.invert()).multiply(_qRoot).multiply(_qPitch);
    }
  }

  /** The hind leg's raised segment (hock above the paw) now: tilted back as the paw comes up. */
  private metaNow(leg: Leg) {
    const a = 0.7 * leg.swing; // (hock ahead, paw trailing behind)
    return new THREE.Vector3(leg.meta.x, leg.meta.y * Math.cos(a) - leg.meta.z * Math.sin(a), leg.meta.y * Math.sin(a) + leg.meta.z * Math.cos(a));
  }
}
