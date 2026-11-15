import * as THREE from 'three';
import type { Person } from './body';
import { type ActionPose, type PropKit, envelope, reachFist, smooth } from './actionkit';
import { type Chore, type ChoreOut, baked, disposeMesh } from './chores';
import { ROWS } from './palette';
import type { Part } from './trees';

/**
 * The baker's two jobs with their hands:
 *
 *   Knead – at the trough, both hands pushing a ball of dough away and
 *     drawing it back, over and over; it squashes and folds as they go.
 *   Peel  – the long wooden peel slid into the oven's mouth and back:
 *     loaves ride in on its blade ('in'), or come out on it ('out').
 *
 * Each works at a point it's given (the trough's top, the oven's mouth,
 * in the world), or one in front of them at a working height if not.
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Where they work: a point given in the world, else in front of them (root frame). */
function workPoint(p: Person, at: THREE.Vector3 | null, out: THREE.Vector3, h: number, fwd: number) {
  if (at) return p.root.worldToLocal(out.copy(at));
  return out.set(0, h, fwd);
}

export class Knead implements Chore {
  private dough: THREE.Object3D;
  private at: THREE.Vector3 | null = null;
  private dur = 8;
  private durNow = 8;
  private e = 0;
  private t = 0;
  private push = 0;
  private s = 1;

  constructor(private p: Person, kit: PropKit) {
    this.s = Math.sqrt(p.dims.height);
    this.dough = baked([{ geo: new THREE.SphereGeometry(0.075, 8, 6).scale(1, 0.6, 1), row: ROWS.food[0] }], kit);
    this.dough.visible = false;
    p.root.add(this.dough);
  }

  /** Set before start: where the dough is (world; null = in front of them), and for how long (s). */
  plan(at: THREE.Vector3 | null, dur = 8) {
    this.at = at;
    this.dur = dur;
  }

  start() {
    this.dough.visible = true;
  }

  pre(t: number, _dt: number, P: ActionPose, tempo: number, out: ChoreOut) {
    this.t = t;
    const dur = (this.durNow = this.dur / Math.sqrt(tempo));
    if (t >= dur) return false;
    const e = (this.e = envelope(t, dur, 0.5, 0.5));
    // a push every 0.75 s: away (the heels of the hands), then drawn back folded
    const f = ((t * Math.sqrt(tempo)) / 0.75) % 1;
    this.push = f < 0.45 ? smooth(f / 0.45) : 1 - smooth((f - 0.45) / 0.55);
    for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: e, x: -0.8, z: 0.15, elbow: 0.8, stiff: 2 });
    P.spineX += (0.3 + 0.12 * this.push) * e;
    P.headX += 0.25 * e;
    out.focus = this.p.root.localToWorld(this.dough.position.clone());
    return true;
  }

  post(_t: number, _dt: number, _out: ChoreOut) {
    const p = this.p;
    const d = p.dims;
    const at = workPoint(p, this.at, _a, d.legLen + 0.02, 0.38 * this.s);
    const pop = Math.max(1e-3, smooth(Math.min(1, this.t / 0.3, (this.durNow - this.t) / 0.3)));
    // the dough under the hands, pushed out and squashed flat as it goes
    this.dough.position.copy(at).add(_b.set(0, 0.03, 0.06 * this.push));
    this.dough.scale.set(pop * this.s * (1 + 0.25 * this.push), pop * this.s * (1 - 0.3 * this.push), pop * this.s * (1 + 0.35 * this.push));
    for (const [sd, x] of [['L', 0.055], ['R', -0.055]] as const) {
      reachFist(p, sd, _b.copy(this.dough.position).add(new THREE.Vector3(x * this.s, 0.06 * this.s, -0.03)), this.e);
    }
  }

  hide() {
    this.dough.visible = false;
  }

  dispose() {
    this.hide();
    disposeMesh(this.dough);
  }
}

/** One stroke of the peel (s, at tempo 1): in, and out. */
const STROKE = 1.6;

export class Peel implements Chore {
  private peel = new THREE.Group();
  private loaves = new THREE.Group();
  private at: THREE.Vector3 | null = null;
  private mode: 'in' | 'out' = 'in';
  private dur = 4;
  private durNow = 4;
  private e = 0;
  private t = 0;
  private reach = 0;
  private s = 1;
  private readonly L: number;

  constructor(private p: Person, kit: PropKit) {
    const s = (this.s = Math.sqrt(p.dims.height));
    this.L = 1.0 * s;
    // the handle along +z from the hands, the blade at its far end
    const parts: Part[] = [
      { geo: new THREE.CylinderGeometry(0.014 * s, 0.014 * s, this.L, 6).rotateX(Math.PI / 2).translate(0, 0, this.L / 2), row: ROWS.wood[0] },
      { geo: new THREE.BoxGeometry(0.24 * s, 0.012, 0.26 * s).translate(0, 0, this.L + 0.12 * s), row: ROWS.wood[2] },
    ];
    this.peel.add(baked(parts, kit));
    // two loaves on the blade
    for (const x of [-0.055, 0.055]) {
      const loaf = baked([{ geo: new THREE.SphereGeometry(0.05, 8, 5).scale(1.3, 0.75, 1).translate(x * s * 1.2, 0.03, this.L + 0.12 * s), row: ROWS.wood[2] }], kit);
      this.loaves.add(loaf);
    }
    this.peel.add(this.loaves);
    this.peel.visible = false;
    p.root.add(this.peel);
  }

  /** Set before start: the oven's mouth (world; null = straight ahead), and loaves going in or coming out. */
  plan(at: THREE.Vector3 | null, mode: 'in' | 'out', strokes = 2) {
    this.at = at;
    this.mode = mode;
    this.dur = 0.4 + strokes * STROKE + 0.4;
  }

  start() {
    this.peel.visible = true;
  }

  pre(t: number, _dt: number, P: ActionPose, tempo: number, out: ChoreOut) {
    this.t = t;
    const k = Math.sqrt(tempo);
    const dur = (this.durNow = this.dur / k);
    if (t >= dur) return false;
    const e = (this.e = envelope(t, dur, 0.4, 0.4));
    const tt = (t - 0.4) * k;
    const f = tt < 0 ? 0 : (tt / STROKE) % 1;
    const n = Math.floor(Math.max(0, tt) / STROKE);
    this.reach = tt < 0 || tt >= dur * k - 0.8 ? 0 : f < 0.5 ? smooth(f / 0.5) : 1 - smooth((f - 0.5) / 0.5);
    // loaves: on the blade going in (the first stroke), on it coming out (the last)
    const last = Math.max(0, Math.floor((this.dur - 0.8) / STROKE) - 1);
    this.loaves.visible = this.mode === 'in' ? n === 0 && (f < 0.5 || tt < 0) : n === last && f >= 0.5;
    for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: e, x: -0.9, z: 0.1, elbow: 0.6, stiff: 2 });
    P.spineX += (0.12 + 0.12 * this.reach) * e;
    P.crouch += 0.04 * e;
    out.focus = this.at ?? this.p.root.localToWorld(new THREE.Vector3(0, 0.8, this.L));
    return true;
  }

  post(_t: number, _dt: number, _out: ChoreOut) {
    const p = this.p;
    const d = p.dims;
    const chest = d.legLen + d.hipAbove + d.shoulderY * 0.45;
    // the blade's end at full reach is the mouth; the hands slide 0.35 back from there at rest
    const mouth = workPoint(p, this.at, _a, chest - 0.08, this.L + 0.6 * this.s);
    const hands0 = new THREE.Vector3(0, chest - 0.05, 0.12 * this.s);
    const dir = mouth.clone().sub(hands0).normalize();
    const full = mouth.clone().addScaledVector(dir, -(this.L + 0.18 * this.s)); // hands at full reach
    const hands = full.clone().addScaledVector(dir, -0.35 * this.s * (1 - this.reach));
    const pop = Math.max(1e-3, smooth(Math.min(1, this.t / 0.3, (this.durNow - this.t) / 0.3)));
    this.peel.position.copy(hands);
    this.peel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    this.peel.scale.setScalar(pop);
    reachFist(p, 'R', hands, this.e, _b.set(-0.7, -1, -0.3));
    reachFist(p, 'L', hands.clone().addScaledVector(dir, 0.25 * this.s), this.e, _b.set(0.7, -1, -0.3));
  }

  hide() {
    this.peel.visible = false;
  }

  dispose() {
    this.hide();
    disposeMesh(this.peel);
  }
}
