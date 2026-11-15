import * as THREE from 'three';
import type { Person } from './body';
import { type ActionPose, type PropKit, envelope, reachFist, smooth } from './actionkit';
import { type Chore, type ChoreOut, baked, disposeMesh, grow } from './chores';
import { KEG_L, KEG_R, kegParts } from './keg';
import { ROWS } from './palette';
import type { Part } from './trees';

/**
 * The cooper's two jobs at the bench:
 *
 *   Shave – sat at the shaving horse, drawing a two-handled knife down a
 *     stave clamped in front of them, stroke after stroke, toward the body:
 *     the stave thins, shavings fly, then the next one.
 *   Hoop  – stood at the block with a keg on end on it, holding the hoop
 *     driver on the top hoop with the left hand and hammering it down with
 *     the right, working round the rim. A new keg is raised first (it grows
 *     up out of its staves); an old one just has its hoops tightened.
 *
 * Both put their props where the posed body is (like the banjo): the stave
 * from the knees and hips, the driver on the keg's rim; the arms are solved
 * onto the tools.
 */

const BOX = (w: number, h: number, d: number, x: number, y: number, z: number, row: number): Part => ({ geo: new THREE.BoxGeometry(w, h, d).translate(x, y, z), row });

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/** Strokes of the draw-knife to each stave, and how long one takes (s, at tempo 1). */
const STROKES = 6;
const STROKE = 1.0;
/** Between staves: unclamp, turn it, clamp the next. */
const SWAP = 0.6;
const LEAD = 1.0;

export class Shave implements Chore {
  private stave = new THREE.Group();
  private knife = new THREE.Group();
  private staves = 2;
  private dur = 10;
  /** Where along the stave the knife is (0 near end … 1 far end), how high off it, and the arm weight. */
  private u = 0.9;
  private lift = 0;
  private e = 0;
  private thick = 1;
  private s = 1;
  private stroke = -1;
  private durNow = 10;

  constructor(private p: Person, kit: PropKit) {
    const s = (this.s = Math.sqrt(p.dims.height));
    // the stave: a split board along +z from its near end, pale where it's shaved
    this.stave.add(baked([BOX(0.07, 1, 0.5, 0, 0.5, 0.25, ROWS.log[0])], kit));
    this.stave.scale.setScalar(s);
    // the knife: a blade across (x), a handle at each end turned back toward the body (−z)
    const W = 0.24;
    const parts: Part[] = [BOX(W, 0.012, 0.035, 0, 0, 0, ROWS.stone[1])];
    for (const sx of [-1, 1]) {
      parts.push(BOX(0.012, 0.012, 0.03, (sx * W) / 2, 0, -0.02, ROWS.stone[2]));
      parts.push({ geo: new THREE.CylinderGeometry(0.012, 0.014, 0.07, 6).rotateX(Math.PI / 2).translate((sx * W) / 2, 0, -0.07), row: ROWS.log[1] });
    }
    this.knife.add(baked(parts, kit));
    this.knife.scale.setScalar(s);
    this.stave.visible = this.knife.visible = false;
    p.root.add(this.stave, this.knife);
  }

  /** Set before start: how many staves to shave. */
  plan(staves: number) {
    this.staves = Math.max(1, staves);
  }

  start() {
    this.dur = LEAD + this.staves * (STROKES * STROKE + SWAP) + 0.4;
    this.stroke = -1;
    this.stave.visible = this.knife.visible = true;
  }

  pre(t: number, _dt: number, P: ActionPose, tempo: number, out: ChoreOut) {
    const dur = (this.durNow = this.dur / Math.sqrt(tempo));
    if (t >= dur) return false;
    const e = (this.e = envelope(t, dur, 0.6, 0.4));
    // which stave, which stroke, and how far through it
    const k = Math.sqrt(tempo);
    const tt = (t - LEAD / k) * k;
    const per = STROKES * STROKE + SWAP;
    const n = Math.floor(tt / per);
    const into = tt - n * per;
    let pulling = false;
    if (tt < 0 || n >= this.staves || into >= STROKES * STROKE) {
      // resting the knife at the far end (before, between and after staves)
      this.u = 0.85;
      this.lift = 0.04;
      this.thick = tt < 0 ? 1 : 0.4; // (a fresh one before the first; the one just done after each)
    } else {
      const i = Math.floor(into / STROKE);
      const f = into / STROKE - i;
      // pull down the stave (on the wood), then carry it back up (lifted)
      if (f < 0.55) {
        const g = smooth(f / 0.55);
        this.u = 0.85 - 0.7 * g;
        this.lift = 0;
        pulling = true;
      } else {
        const g = smooth((f - 0.55) / 0.45);
        this.u = 0.15 + 0.7 * g;
        this.lift = 0.05 * Math.sin(Math.PI * g);
      }
      this.thick = 1 - 0.6 * ((i + Math.min(1, f / 0.55)) / STROKES);
      const sn = n * STROKES + i;
      if (sn !== this.stroke) {
        this.stroke = sn;
        out.events.push('shave');
      }
      if (pulling && f > 0.45 && f - 0.45 < 0.1 && i % 2 === 0) out.bursts.push({ kind: 'chips', at: this.knife.getWorldPosition(new THREE.Vector3()) });
    }
    // rough arms for the springs; post() puts the hands on the handles
    for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: e, x: -0.8, z: 0.2, elbow: 1.0, stiff: 2 });
    // reach forward down the stave, sit back as the knife comes in
    P.spineX += (0.18 + 0.28 * this.u + (pulling ? 0.04 : 0)) * e;
    P.headX += 0.3 * e;
    out.focus = this.knife.getWorldPosition(new THREE.Vector3());
    return true;
  }

  post(t: number, _dt: number, _out: ChoreOut) {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    const H = d.height;
    const s = this.s;
    p.root.updateMatrixWorld(true);
    // the stave: from just in front of the belly, sloping up past the knees
    const kneeL = p.root.worldToLocal(J.kneeL.getWorldPosition(_a));
    const kneeR = p.root.worldToLocal(J.kneeR.getWorldPosition(_b));
    const knee = kneeL.add(kneeR).multiplyScalar(0.5);
    const pelvis = p.root.worldToLocal(J.pelvis.getWorldPosition(_b));
    const front = Math.max(d.waistR, d.hipR) * d.torsoDepth;
    const near = _c.set(0, knee.y + d.thighR * 2 + 0.06 * H, pelvis.z + front + 0.06 * H);
    const far = _a.set(0, knee.y + d.thighR * 2 + 0.16 * H, knee.z + 0.2 * H);
    const len = far.distanceTo(near);
    const dir = _z.subVectors(far, near).normalize();
    this.stave.position.copy(near);
    this.stave.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    const pop = Math.max(1e-3, smooth(Math.min(1, t / 0.5, (this.durNow - t) / 0.3)));
    this.stave.scale.set(s * pop, s * pop * 0.03 * this.thick, (len / 0.5) * pop);
    // the knife: across the stave on its top face, handles toward the body
    _x.crossVectors(UP, dir).normalize(); // across, to their left (+x)
    _y.crossVectors(dir, _x).normalize(); // the stave's top face
    const on = _b.copy(near).addScaledVector(dir, len * this.u).addScaledVector(_y, 0.03 * s * this.thick + 0.012 * s + this.lift);
    this.knife.position.copy(on);
    _m.makeBasis(_x, _y, _z.copy(dir));
    this.knife.quaternion.setFromRotationMatrix(_m);
    this.knife.scale.setScalar(s * pop);
    this.knife.updateMatrix();
    // fists round the handles (the person's right is −x)
    const grip = (sx: number) => new THREE.Vector3(sx * 0.12, 0, -0.075).applyMatrix4(this.knife.matrix);
    reachFist(p, 'L', grip(1), this.e, _a.set(0.8, -1, -0.5));
    reachFist(p, 'R', grip(-1), this.e, _a.set(-0.8, -1, -0.5));
  }

  hide() {
    this.stave.visible = this.knife.visible = false;
  }

  dispose() {
    this.hide();
    disposeMesh(this.stave);
    disposeMesh(this.knife);
  }
}

/** One hammer blow, and how much of it is lifting the hammer. */
const BLOW = 0.62;
/** Blows before moving the driver on round the rim. */
const PER_SPOT = 4;
/** Where round the rim the driver goes, in turn (radians from the side facing them). */
const ROUND = [0, 0.55, -0.55, 0.3, -0.3];

/** What the hoop-driving works on: a real keg standing on end (its mesh), else one conjured on a block in front. */
export interface HoopPlan {
  keg?: THREE.Object3D;
  /** Blows to strike. */
  blows: number;
  /** A new keg: raise it from its staves first. */
  raise?: boolean;
}

export class Hoop implements Chore {
  private hammer = new THREE.Group();
  private driver = new THREE.Group();
  /** The conjured block and keg (when there's no real one). */
  private block = new THREE.Group();
  private ownKeg: THREE.Object3D;
  private keg: THREE.Object3D | null = null;
  private plan_: HoopPlan = { blows: 8 };
  private dur = 6;
  private blow = -1;
  private e = 0;
  private head = new THREE.Vector3();
  private rim = new THREE.Vector3();
  private s = 1;
  private t = 0;
  private durNow = 6;

  constructor(private p: Person, kit: PropKit) {
    const s = (this.s = Math.sqrt(p.dims.height));
    // hammer: handle along +z from the grip, the head across at the far end
    this.hammer.add(baked([BOX(0.022, 0.022, 0.24, 0, 0, 0.12, ROWS.log[1]), BOX(0.035, 0.09, 0.035, 0, 0, 0.245, ROWS.stone[1])], kit));
    this.hammer.scale.setScalar(s);
    // the driver: a short wooden block with an iron lip at the bottom, standing up from the origin
    this.driver.add(baked([BOX(0.03, 0.09, 0.03, 0, 0.045, 0, ROWS.log[1]), BOX(0.034, 0.015, 0.034, 0, 0.0075, 0, ROWS.stone[2])], kit));
    this.driver.scale.setScalar(s);
    // a block (a short round of trunk) with a keg standing on end on it
    const H = p.dims.height;
    const bh = 0.24 * H;
    this.block.add(baked([{ geo: new THREE.CylinderGeometry(0.12, 0.135, bh, 9).translate(0, bh / 2, 0), row: ROWS.log[2] }], kit));
    this.ownKeg = baked(kegParts(), kit);
    this.ownKeg.rotation.z = Math.PI / 2; // on end
    this.ownKeg.position.set(0, bh + KEG_L / 2, 0);
    this.block.add(this.ownKeg);
    this.block.position.set(0, 0, 0.4 * s);
    this.hammer.visible = this.driver.visible = this.block.visible = false;
    p.root.add(this.hammer, this.driver, this.block);
  }

  /** Set before start: the keg, how many blows, and whether it's a new one to raise. */
  aim(plan: HoopPlan) {
    this.plan_ = plan;
  }

  private get raising() {
    return this.plan_.raise ? 1.4 : 0;
  }

  start() {
    this.keg = this.plan_.keg ?? null;
    this.block.visible = !this.keg;
    this.keg ??= this.ownKeg;
    this.dur = 0.5 + this.raising + this.plan_.blows * BLOW + 0.5;
    this.blow = -1;
    this.hammer.visible = this.driver.visible = true;
  }

  /** The keg's top middle (root frame), whatever way it stands. */
  private kegTop(out: THREE.Vector3) {
    const k = this.keg!;
    k.updateWorldMatrix(true, false);
    // the keg lies along its local x: on end, that's up
    const a = k.localToWorld(_a.set(KEG_L / 2, 0, 0));
    const b = k.localToWorld(_b.set(-KEG_L / 2, 0, 0));
    return this.p.root.worldToLocal(out.copy(a.y > b.y ? a : b));
  }

  pre(t: number, _dt: number, P: ActionPose, tempo: number, out: ChoreOut) {
    this.t = t;
    const dur = (this.durNow = this.dur / Math.sqrt(tempo));
    if (t >= dur) return false;
    const e = (this.e = envelope(t, dur, 0.5, 0.5));
    // raising a new keg: it grows up out of its staves
    if (this.raising && this.keg) {
      const k = (t - 0.3) / this.raising;
      this.keg.scale.setScalar(k >= 1 ? 1 : grow(k));
    }
    const tb = t - 0.5 - this.raising;
    const i = Math.floor(tb / BLOW);
    const f = tb / BLOW - i;
    // where round the rim the driver is, facing them
    const top = this.kegTop(_c);
    const toMe = _a.set(-top.x, 0, -top.z).normalize();
    const ang = ROUND[Math.max(0, Math.floor(Math.max(0, i) / PER_SPOT)) % ROUND.length];
    toMe.applyAxisAngle(UP, ang);
    this.rim.copy(top).addScaledVector(toMe, KEG_R * 0.8);
    // the hammer's head: up and back over the shoulder, then down onto the driver
    const strike = _b.copy(this.rim).setY(this.rim.y + 0.09 * this.s);
    const raised = _x.copy(strike).addScaledVector(toMe, 0.06).setY(strike.y + 0.22 * this.s);
    let h = 1; // 1 = up, 0 = on the driver
    if (tb >= 0 && i < this.plan_.blows) {
      h = f < 0.55 ? smooth(f / 0.55) : f < 0.72 ? 1 - ((f - 0.55) / 0.17) ** 2 : 0;
      if (i !== this.blow && f >= 0.72) {
        this.blow = i;
        out.events.push('clank');
      }
    }
    this.head.lerpVectors(strike, raised, h);
    for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: e, x: -0.7, z: 0.15, elbow: 1.2, stiff: 2 });
    P.spineX += 0.3 * e;
    P.crouch += 0.04 * e;
    P.headX += 0.25 * e;
    out.focus = this.p.root.localToWorld(this.rim.clone());
    return true;
  }

  post(_t: number, _dt: number, _out: ChoreOut) {
    const p = this.p;
    const s = this.s;
    const pop = Math.max(1e-3, smooth(Math.min(1, this.t / 0.35, (this.durNow - this.t) / 0.3)));
    // the driver stands on the rim, leaning out a little
    this.driver.position.copy(this.rim);
    this.driver.quaternion.identity();
    this.driver.scale.setScalar(s * pop);
    // the hammer: grip toward the body from the head, a little low
    const grip = _a.copy(this.head).add(_b.set(-this.head.x, -0.25 * this.head.y, -this.head.z).normalize().multiplyScalar(0.245 * s));
    this.hammer.position.copy(grip);
    this.hammer.quaternion.setFromUnitVectors(_z.set(0, 0, 1), _y.subVectors(this.head, grip).normalize());
    this.hammer.scale.setScalar(s * pop);
    reachFist(p, 'L', _c.copy(this.rim).setY(this.rim.y + 0.07 * s), this.e, _x.set(0.8, -1, -0.3));
    reachFist(p, 'R', grip, this.e);
  }

  hide() {
    this.hammer.visible = this.driver.visible = this.block.visible = false;
    if (this.keg && this.keg !== this.ownKeg) this.keg.scale.setScalar(1);
    this.keg = null;
  }

  dispose() {
    this.hide();
    for (const g of [this.hammer, this.driver, this.block]) disposeMesh(g);
  }
}
