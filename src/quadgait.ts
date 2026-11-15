import * as THREE from 'three';
import { twoBoneIK, aimDown } from './ik';
import { placePupils } from './gaze';
import { Spring } from './springs';
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
  /** Sat or lying: the hind leg folded under. */
  fold: number;
}

export class QuadAnimator {
  private legs: Leg[];
  private hipsRest: THREE.Vector3;
  private hipsRot: THREE.Euler;
  private neckRest: number;
  private headRest: number;
  private tailRest: [number, number, number];
  /** The chest's height above the hips' joint, and the chest's rest height (world). */
  private chestUp: number;
  private chestRestY: number;
  private G: number;
  private bodyLen: number;
  private legLen: number;
  /** 0 … 1: how far into a trot. */
  trot = 0;
  /** Extra tail wag (0 … 1), set by whoever's driving. */
  wag = 0;
  /** How far into each pose it is now (0 … 1), and where it's heading. */
  readonly pose = { sit: 0, lie: 0, sniff: 0 };
  private want = { sit: 0, lie: 0, sniff: 0 };
  /** Where it's looking, head and all (world), or nowhere in particular. */
  look: THREE.Vector3 | null = null;
  /** Where its eyes are on (world): a glance; the head turns part of the way. (`look` wins.) */
  gazeAt: THREE.Vector3 | null = null;
  private pupils: Spring[][];
  private nextBlink = 1 + Math.random() * 3;
  private blinkT = -1;
  private lastLp: number[] = [0, 0, 0, 0];
  /** Eyes shut (asleep). */
  eyesShut = false;
  private lookYaw = 0;
  private lookPitch = 0;
  private barkT = -1;
  /** Sounds this frame ('woof'), for whoever plays them. */
  events: string[] = [];

  /** Settle into a pose (the gait carries on underneath: stand still for sit and lie). */
  setPose(kind: 'stand' | 'sit' | 'lie' | 'sniff') {
    this.want.sit = kind === 'sit' ? 1 : 0;
    this.want.lie = kind === 'lie' ? 1 : 0;
    this.want.sniff = kind === 'sniff' ? 1 : 0;
  }

  /** Down (sitting or lying) or on the way: not for walking off just yet. */
  get down() {
    return this.pose.sit + this.pose.lie > 0.05;
  }

  bark() {
    if (this.barkT < 0) this.barkT = 0;
  }
  private t = 0;

  constructor(private dog: Quadruped) {
    const J = dog.joints;
    const d = dog.dims;
    this.legLen = d.upper + d.lower;
    this.bodyLen = d.bodyLen;
    this.hipsRest = J.hips.position.clone();
    this.hipsRot = J.hips.rotation.clone();
    this.neckRest = J.neck.rotation.x;
    this.headRest = J.head.rotation.x;
    this.chestUp = J.chest.position.y;
    this.chestRestY = J.hips.position.y + J.chest.position.y;
    this.G = d.girth;
    this.pupils = dog.eyes.map(() => [new Spring(), new Spring()]);
    this.tailRest = [J.tail0.rotation.x, J.tail1.rotation.x, J.tail2.rotation.x];
    dog.root.updateMatrixWorld(true);
    const inRoot = (o: THREE.Object3D) => dog.root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
    this.legs = (['L', 'R'] as const).flatMap((s) => {
      const fu = J[`shoulder${s}`], fm = J[`elbow${s}`], fe = J[`wrist${s}`];
      const hu = J[`hip${s}`], hm = J[`stifle${s}`], he = J[`hock${s}`], hp = J[`paw${s}`];
      const front: Leg = { front: true, upper: fu, middle: fm, end: fe, paw: null, l1: d.upper, l2: d.lower, rest: inRoot(fe), meta: new THREE.Vector3(), reach: inRoot(fu).distanceTo(inRoot(fe)), at: new THREE.Vector3(), swing: 0, fold: 0 };
      const hind: Leg = { front: false, upper: hu, middle: hm, end: he, paw: hp, l1: d.thigh, l2: d.shank, rest: inRoot(hp), meta: inRoot(he).sub(inRoot(hp)), reach: inRoot(hu).distanceTo(inRoot(he)), at: new THREE.Vector3(), swing: 0, fold: 0 };
      return [front, hind];
    });
    // (order the legs to match the gait's offsets: left front, right front, left hind, right hind)
    this.legs = [this.legs[0], this.legs[2], this.legs[1], this.legs[3]];
  }

  /** How far into a trot this speed calls for (0 walk … 1 trot). */
  private trotFor(speed: number) {
    const sp = dogSpeeds(this.dog);
    return smooth((speed - sp.walk * 1.1) / (sp.trot * 0.9 - sp.walk * 1.1));
  }

  /** The gait, as far into a trot as it is now (`trot` eases toward the speed's in update). */
  private gait(_speed: number): Gait {
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

  /** Pose the dog for this moment of the stride (and whatever pose it's in). */
  update(m: QuadMotion, dt: number) {
    this.t += dt;
    this.events.length = 0;
    // into a trot (or out of it) over a few strides, not all at once
    this.trot += (this.trotFor(m.speed) - this.trot) * Math.min(1, dt * 3);
    const dog = this.dog;
    const J = dog.joints;
    const d = dog.dims;
    const G = this.G;
    const g = this.gait(m.speed);
    const sp = dogSpeeds(dog);
    const w = Math.min(1.2, m.speed / sp.walk); // 0 standing … 1 walking
    const C = this.cycle(m.speed) * Math.min(1, w * 4); // (collapses to nothing standing still)
    const D = g.duty * C; // how far a planted paw slides back
    const lift = this.legLen * g.lift * Math.min(1, w);
    // poses ease in and out (lying goes via a sit: the back end goes down first)
    const P = this.pose;
    const ease = Math.min(1, dt / 0.55);
    for (const k of ['sit', 'lie', 'sniff'] as const) P[k] += (this.want[k] - P[k]) * ease;
    const sit = Math.min(1, P.sit + P.lie * 0.6); // the back end's down
    const lie = P.lie;
    const fold = Math.max(sit, lie);

    // --- where each paw is
    let landed = false;
    this.legs.forEach((leg, i) => {
      const lp = (((m.phase - g.off[i]) % 1) + 1) % 1; // this leg's own phase: 0 = it lands
      if (lp < this.lastLp[i] - 0.5 && m.speed > 0.05) landed = true; // (wrapped round: a paw down)
      this.lastLp[i] = lp;
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
      // sitting and lying: hind paws tucked forward under the hips; lying, the front paws reach out ahead
      if (!leg.front) leg.at.z += fold * d.thigh * 0.45;
      else leg.at.z += lie * this.legLen * 0.8;
      leg.fold = leg.front ? 0 : fold;
    });

    // --- hips and chest: walking, each as high as its legs can reach; sitting, the hips
    // down on the haunches and the chest kept up; lying, both down on the belly
    const sink = (front: boolean) => {
      let drop = 0;
      for (const leg of this.legs) {
        if (leg.front !== front) continue;
        const dz = front ? leg.at.z - leg.rest.z : 0;
        const dzh = front ? 0 : leg.at.z - leg.rest.z - fold * d.thigh * 0.45;
        const z = front ? dz - lie * this.legLen * 0.8 : dzh;
        drop = Math.max(drop, leg.reach - Math.sqrt(Math.max(1e-6, leg.reach * leg.reach - z * z)));
      }
      return drop;
    };
    // (paws landing together, as a trot's diagonal pair does, are one patter)
    if (landed) this.events.push('step');
    const walkH = this.hipsRest.y - sink(false);
    const walkC = this.chestRestY - sink(true);
    const sitH = G * 1.15, sitC = this.chestRestY + G * 0.1;
    const lieH = G * 0.95, lieC = G * 1.05;
    let Yh = walkH + (sitH - walkH) * sit;
    let Yc = walkC + (sitC - walkC) * sit;
    Yh += (lieH - Yh) * lie;
    Yc += (lieC - Yc) * lie;
    // sniffing: the front end dips toward the ground
    Yc -= P.sniff * (this.chestRestY - this.hipsRest.y + G * 0.6) * 0.3;
    // a bark: a jolt up through the chest
    let barkK = 0;
    if (this.barkT >= 0) {
      if (this.barkT === 0) this.events.push('woof');
      this.barkT += dt;
      barkK = Math.sin(Math.PI * Math.min(1, this.barkT / 0.3));
      if (this.barkT > 0.3) this.barkT = -1;
    }
    Yc += barkK * G * 0.25;
    const bounce = 0.012 * this.legLen * this.trot * Math.abs(Math.sin(2 * Math.PI * m.phase * 2));
    J.hips.position.set(this.hipsRest.x, Yh - bounce, this.hipsRest.z);
    // tip the hips so the chest is at its height: chest local (0, up, L) turned by p about x has height up·cos p − L·sin p
    const pitch = -Math.asin(Math.max(-0.95, Math.min(0.95, (Yc - Yh - this.chestUp) / this.bodyLen)));
    // a little roll with the stride, more at the trot
    const roll = 0.04 * Math.min(1, w) * Math.sin(2 * Math.PI * m.phase);
    J.hips.rotation.set(this.hipsRot.x + pitch, this.hipsRot.y, this.hipsRot.z + roll);

    // --- head: steady against the bob; down to the ground sniffing; lower lying; toward whatever it's looking at
    let wantYaw = 0, wantPitch = 0;
    const headAt = this.look ?? this.gazeAt;
    if (headAt) {
      // (a glance turns the head only part of the way: the eyes do the rest)
      const k = this.look ? 1 : 0.4;
      dog.root.updateMatrixWorld(true);
      const local = J.chest.worldToLocal(headAt.clone());
      wantYaw = k * Math.max(-1.2, Math.min(1.2, Math.atan2(local.x, local.z)));
      wantPitch = k * Math.max(-0.5, Math.min(0.5, -Math.atan2(local.y - G * 2, Math.hypot(local.x, local.z))));
    }
    this.lookYaw += (wantYaw - this.lookYaw) * Math.min(1, dt * 5);
    this.lookPitch += (wantPitch - this.lookPitch) * Math.min(1, dt * 5);
    const sniffBob = P.sniff * 0.06 * Math.sin(this.t * 15);
    J.neck.rotation.set(this.neckRest - pitch * 0.85 + 0.05 * Math.min(1, w) * Math.sin(4 * Math.PI * m.phase) + P.sniff * 1.15 + lie * 0.35 + this.lookPitch * 0.5, this.lookYaw * 0.55, 0, 'YXZ');
    J.head.rotation.set(this.headRest + P.sniff * 0.45 + sniffBob - barkK * 0.35 + this.lookPitch * 0.5 - lie * 0.1, this.lookYaw * 0.45, 0, 'YXZ');

    // --- tail: swinging with the stride, wagging; down behind on the ground sitting or lying
    const wag = this.wag * Math.sin(this.t * 14);
    const tailDown = fold * 0.9;
    J.tail0.rotation.set(this.tailRest[0] - 0.1 * Math.min(1, w) - tailDown, 0.25 * Math.min(1, w) * Math.sin(2 * Math.PI * m.phase) + 0.6 * wag, 0, 'YXZ');
    J.tail1.rotation.set(this.tailRest[1] * (1 - fold * 0.8), 0.15 * wag, 0, 'YXZ');
    J.tail2.rotation.set(this.tailRest[2] * (1 - fold * 0.8), 0.2 * wag, 0, 'YXZ');

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

    // --- eyes: on whatever it's looking at (blinking now and then)
    if (this.t >= this.nextBlink && this.blinkT < 0) this.blinkT = 0;
    let lid = this.eyesShut ? 0.08 : 1;
    if (this.blinkT >= 0 && !this.eyesShut) {
      this.blinkT += dt;
      lid = Math.max(0.08, Math.abs(1 - this.blinkT / 0.07));
      if (this.blinkT > 0.14) {
        this.blinkT = -1;
        this.nextBlink = this.t + 1.5 + Math.random() * 4;
      }
    }
    dog.root.updateMatrixWorld(true);
    placePupils(dog.eyes, this.gazeAt ?? this.look, this.pupils, dt, lid);
  }

  /** The hind leg's raised segment (hock above the paw) now: tilted back as the paw comes up, down flat behind it sitting. */
  private metaNow(leg: Leg) {
    const a = 0.7 * leg.swing - 1.35 * leg.fold; // (swinging: hock ahead, paw trailing; sat: hock back on the ground)
    return new THREE.Vector3(leg.meta.x, leg.meta.y * Math.cos(a) - leg.meta.z * Math.sin(a), leg.meta.y * Math.sin(a) + leg.meta.z * Math.cos(a));
  }
}
