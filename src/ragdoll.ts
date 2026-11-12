import * as THREE from 'three';
import type { JointName, Person } from './body';
import { aimDown, frameYX, frameZY } from './ik';

/**
 * Lightweight Verlet ragdoll (Jakobsen-style): point masses at the joints,
 * distance constraints for bones plus cross-braces for a stiff torso, cheap
 * hinge corrections so knees/elbows don't bend backwards, and a ground plane
 * with friction. The result is mapped back onto the normal rig every frame,
 * so the same meshes and hierarchy are used throughout.
 */

const P = {
  pelvis: 0, hipL: 1, kneeL: 2, ankleL: 3, toeL: 4, hipR: 5, kneeR: 6, ankleR: 7, toeR: 8,
  waist: 9, neck: 10, head: 11, shL: 12, elL: 13, wrL: 14, shR: 15, elR: 16, wrR: 17,
} as const;
const N = 18;

const GRAVITY = 13; // a bit above 9.8: tiny people should fall snappily
const STEP = 1 / 120;
const ITER = 8;

interface Constraint {
  a: number;
  b: number;
  rest: number;
  min: boolean; // only push apart (keeps head off chest etc.)
  k: number; // stiffness 0..1
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _qInv = new THREE.Quaternion();

export class Ragdoll {
  pos = Array.from({ length: N }, () => new THREE.Vector3());
  prev = Array.from({ length: N }, () => new THREE.Vector3());
  radius = new Float32Array(N);
  invMass = new Float32Array(N).fill(1);
  cons: Constraint[] = [];
  private acc = 0;
  stillTime = 0;
  age = 0;
  /** Protective reflex: hands reach this way for the first moments of a fall. */
  reach = new THREE.Vector3();

  /** Snapshot the person's current (animated) pose into particles. */
  constructor(private p: Person, velocity: THREE.Vector3, kick: (i: number, v: THREE.Vector3) => void = () => {}) {
    const J = p.joints;
    const d = p.dims;
    p.root.updateMatrixWorld(true);
    const at = (j: JointName, i: number) => J[j].getWorldPosition(this.pos[i]);
    at('pelvis', P.pelvis);
    at('hipL', P.hipL); at('kneeL', P.kneeL); at('ankleL', P.ankleL);
    at('hipR', P.hipR); at('kneeR', P.kneeR); at('ankleR', P.ankleR);
    at('spine', P.waist); at('neck', P.neck);
    at('shoulderL', P.shL); at('elbowL', P.elL); at('wristL', P.wrL);
    at('shoulderR', P.shR); at('elbowR', P.elR); at('wristR', P.wrR);
    this.pos[P.head].copy(J.head.localToWorld(_v.set(0, d.headR * 0.9, 0)));
    this.pos[P.toeL].copy(J.ankleL.localToWorld(_v.set(0, -d.footH * 0.5, d.footLen * 0.6)));
    this.pos[P.toeR].copy(J.ankleR.localToWorld(_v.set(0, -d.footH * 0.5, d.footLen * 0.6)));

    const R = this.radius;
    R[P.pelvis] = d.hipR * 0.8;
    R[P.waist] = d.waistR * 0.8;
    R[P.neck] = d.shoulderR * 0.6;
    R[P.head] = d.headR;
    R[P.hipL] = R[P.hipR] = d.thighR;
    R[P.kneeL] = R[P.kneeR] = d.thighR * 0.85;
    R[P.ankleL] = R[P.ankleR] = d.footH * 0.7;
    R[P.toeL] = R[P.toeR] = d.footH * 0.5;
    R[P.shL] = R[P.shR] = d.upperArmR;
    R[P.elL] = R[P.elR] = d.upperArmR * 0.9;
    R[P.wrL] = R[P.wrR] = d.handR;
    // heavier core, lighter extremities → limbs flail, torso leads
    for (const i of [P.pelvis, P.waist, P.neck]) this.invMass[i] = 0.4;
    this.invMass[P.head] = 0.7;

    const c = (a: number, b: number, k = 1, min = false, scale = 1) =>
      this.cons.push({ a, b, rest: this.pos[a].distanceTo(this.pos[b]) * scale, k, min });
    // torso box (stiff)
    c(P.pelvis, P.hipL); c(P.pelvis, P.hipR); c(P.hipL, P.hipR);
    c(P.pelvis, P.waist); c(P.waist, P.hipL); c(P.waist, P.hipR);
    c(P.waist, P.neck); c(P.neck, P.shL); c(P.neck, P.shR); c(P.shL, P.shR);
    c(P.waist, P.shL); c(P.waist, P.shR);
    c(P.pelvis, P.neck, 0.6); // a little spine bend allowed
    c(P.hipL, P.shL, 0.4); c(P.hipR, P.shR, 0.4); c(P.hipL, P.shR, 0.4); c(P.hipR, P.shL, 0.4);
    // head
    c(P.neck, P.head);
    c(P.head, P.waist, 1, true, 0.85);
    c(P.head, P.shL, 1, true, 0.8); c(P.head, P.shR, 1, true, 0.8);
    // legs + feet
    for (const [h, k, a, t] of [[P.hipL, P.kneeL, P.ankleL, P.toeL], [P.hipR, P.kneeR, P.ankleR, P.toeR]]) {
      c(h, k); c(k, a); c(a, t); c(k, t, 0.5);
      c(h, a, 1, true, 0.45); // can't fold the leg completely flat
    }
    // arms
    for (const [s, e, w] of [[P.shL, P.elL, P.wrL], [P.shR, P.elR, P.wrR]]) {
      c(s, e); c(e, w);
      c(s, w, 1, true, 0.35);
    }

    // initial velocity: prev = pos - v·dt (Verlet stores velocity implicitly)
    for (let i = 0; i < N; i++) {
      _w.copy(velocity);
      kick(i, _w);
      this.prev[i].copy(this.pos[i]).addScaledVector(_w, -STEP);
    }
  }

  get centre() {
    return this.pos[P.pelvis];
  }

  /** Push every particle (e.g. a shove), weighted by inverse mass. */
  impulse(v: THREE.Vector3) {
    for (let i = 0; i < N; i++) this.prev[i].addScaledVector(v, -STEP * this.invMass[i]);
  }

  step(dt: number) {
    this.age += dt;
    this.acc += Math.min(dt, 0.1);
    let maxV = 0;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      maxV = Math.max(maxV, this.integrate());
    }
    this.stillTime = maxV < 0.25 ? this.stillTime + dt : 0;
  }

  private integrate() {
    const { pos, prev } = this;
    let maxV = 0;
    for (let i = 0; i < N; i++) {
      _v.subVectors(pos[i], prev[i]).multiplyScalar(0.995);
      maxV = Math.max(maxV, _v.length() / STEP);
      prev[i].copy(pos[i]);
      pos[i].add(_v);
      pos[i].y -= GRAVITY * STEP * STEP;
    }
    if (this.age < 0.6) {
      // an acceleration (Verlet: position nudges accumulate into velocity)
      const k = (1 - this.age / 0.6) * STEP * STEP * 7;
      pos[P.wrL].addScaledVector(this.reach, k);
      pos[P.wrR].addScaledVector(this.reach, k);
    }
    for (let it = 0; it < ITER; it++) {
      for (const c of this.cons) {
        const a = pos[c.a], b = pos[c.b];
        _v.subVectors(b, a);
        const len = _v.length() || 1e-6;
        if (c.min && len >= c.rest) continue;
        const wa = this.invMass[c.a], wb = this.invMass[c.b];
        const diff = ((len - c.rest) / (len * (wa + wb))) * c.k;
        a.addScaledVector(_v, diff * wa);
        b.addScaledVector(_v, -diff * wb);
      }
      this.hinges();
      for (let i = 0; i < N; i++) if (pos[i].y < this.radius[i]) pos[i].y = this.radius[i];
    }
    // ground friction: bleed off horizontal velocity of touching particles
    for (let i = 0; i < N; i++) {
      if (pos[i].y <= this.radius[i] + 1e-3) {
        prev[i].x = pos[i].x - (pos[i].x - prev[i].x) * 0.82;
        prev[i].z = pos[i].z - (pos[i].z - prev[i].z) * 0.82;
      }
    }
    return maxV;
  }

  /** Knees must point forward of the hip–ankle line, elbows behind shoulder–wrist. */
  private hinges() {
    const pos = this.pos;
    this.frame(P.pelvis, P.waist, P.hipL, P.hipR);
    for (const [h, k, a] of [[P.hipL, P.kneeL, P.ankleL], [P.hipR, P.kneeR, P.ankleR]]) {
      _w.addVectors(pos[h], pos[a]).multiplyScalar(0.5);
      const off = _v.subVectors(pos[k], _w).dot(_fwd);
      if (off < 0) pos[k].addScaledVector(_fwd, -off * 0.6);
    }
    this.frame(P.waist, P.neck, P.shL, P.shR);
    for (const [s, e, w] of [[P.shL, P.elL, P.wrL], [P.shR, P.elR, P.wrR]]) {
      _w.addVectors(pos[s], pos[w]).multiplyScalar(0.5);
      const off = _v.subVectors(pos[e], _w).dot(_fwd);
      if (off > 0) pos[e].addScaledVector(_fwd, -off * 0.6);
    }
  }

  /** Fill _up/_right/_fwd from a body segment (up = a→b, right = r−l… +X is left). */
  private frame(a: number, b: number, left: number, right: number) {
    _up.subVectors(this.pos[b], this.pos[a]).normalize();
    _right.subVectors(this.pos[left], this.pos[right]);
    _right.addScaledVector(_up, -_right.dot(_up)).normalize();
    _fwd.crossVectors(_right, _up).normalize();
  }

  /** Write particle state back onto the rig (root stays where it is). */
  apply() {
    const p = this.p;
    const J = p.joints;
    const pos = this.pos;
    p.root.updateMatrixWorld();
    const qRoot = p.root.quaternion;

    // pelvis
    this.frame(P.pelvis, P.waist, P.hipL, P.hipR);
    const qPelvis = frameYX(_up, _right, new THREE.Quaternion());
    const pelvisFwd = _fwd.clone();
    J.pelvis.position.copy(p.root.worldToLocal(_v.copy(pos[P.pelvis])));
    J.pelvis.quaternion.copy(_qInv.copy(qRoot).invert().multiply(qPelvis));

    // chest
    this.frame(P.waist, P.neck, P.shL, P.shR);
    const qSpine = frameYX(_up, _right, new THREE.Quaternion());
    const chestRight = _right.clone();
    const chestFwd = _fwd.clone();
    J.spine.quaternion.copy(_qInv.copy(qPelvis).invert().multiply(qSpine));

    // neck/head: aim the neck at the head particle
    const qNeck = frameYX(_v.subVectors(pos[P.head], pos[P.neck]), chestRight, new THREE.Quaternion());
    J.neck.quaternion.copy(_qInv.copy(qSpine).invert().multiply(qNeck));
    J.head.quaternion.identity();

    // legs
    for (const [side, h, k, a, t] of [['L', P.hipL, P.kneeL, P.ankleL, P.toeL], ['R', P.hipR, P.kneeR, P.ankleR, P.toeR]] as const) {
      const qHip = aimDown(_v.subVectors(pos[k], pos[h]), pelvisFwd, new THREE.Quaternion());
      const qKnee = aimDown(_v.subVectors(pos[a], pos[k]), pelvisFwd, new THREE.Quaternion());
      const qAnkle = frameZY(_v.subVectors(pos[t], pos[a]), _w.subVectors(pos[k], pos[a]), new THREE.Quaternion());
      J[`hip${side}`].quaternion.copy(_qInv.copy(qPelvis).invert().multiply(qHip));
      J[`knee${side}`].quaternion.copy(_qInv.copy(qHip).invert().multiply(qKnee));
      J[`ankle${side}`].quaternion.copy(_qInv.copy(qKnee).invert().multiply(qAnkle));
    }

    // arms
    for (const [side, s, e, w] of [['L', P.shL, P.elL, P.wrL], ['R', P.shR, P.elR, P.wrR]] as const) {
      const qSh = aimDown(_v.subVectors(pos[e], pos[s]), chestFwd, new THREE.Quaternion());
      const qEl = aimDown(_v.subVectors(pos[w], pos[e]), chestFwd, new THREE.Quaternion());
      J[`shoulder${side}`].quaternion.copy(_qInv.copy(qSpine).invert().multiply(qSh));
      J[`elbow${side}`].quaternion.copy(_qInv.copy(qSh).invert().multiply(qEl));
      J[`wrist${side}`].quaternion.identity();
    }
  }

  /** Ground-plane heading the body lies along (pelvis → head), for getting up. */
  lyingYaw() {
    _v.subVectors(this.pos[P.head], this.pos[P.pelvis]);
    return Math.atan2(_v.x, _v.z);
  }
}

