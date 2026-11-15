import * as THREE from 'three';
import type { Person } from './body';
import { type ActionPose, type PropKit, envelope, reachFist, smooth } from './actionkit';
import { type Chore, type ChoreOut, baked, disposeMesh } from './chores';
import { ROWS } from './palette';

/**
 * Threshing with a flail: a long handle held in both hands at its end, a
 * short swingle hung from its tip on a leather link. Each blow: the handle
 * goes up and back over the head, the swingle dangling behind; then it
 * comes down hard and the swingle whips over and lands flat on the sheaves
 * on the floor in front. Thud; chaff.
 *
 * Everything moves in the person's own up-and-forward plane (root frame);
 * angles there are measured up from straight ahead.
 */

const BLOW = 1.05; // one blow (s, at tempo 1)
const UP = 0.55; // of it spent lifting
const DOWN = 0.18; // and coming down

const dir = (a: number, out = new THREE.Vector3()) => out.set(0, Math.sin(a), Math.cos(a));
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

export class Flail implements Chore {
  private handle = new THREE.Group();
  private swingle = new THREE.Group();
  private blows = 6;
  private dur = 8;
  private durNow = 8;
  private e = 0;
  private t = 0;
  private s = 1;
  private lastBlow = -1;
  private readonly hl: number;
  private readonly sl: number;
  /** This frame: the hands, the handle's way, the swingle's way (root frame). */
  private hands = new THREE.Vector3();
  private ah = 0;
  private as = 0;

  constructor(private p: Person, kit: PropKit) {
    const s = (this.s = Math.sqrt(p.dims.height));
    this.hl = 0.72 * s;
    this.sl = 0.42 * s;
    // each along its own +z from its near end
    this.handle.add(baked([{ geo: new THREE.CylinderGeometry(0.016 * s, 0.018 * s, this.hl, 6).rotateX(Math.PI / 2).translate(0, 0, this.hl / 2), row: ROWS.wood[0] }], kit));
    this.swingle.add(baked([
      { geo: new THREE.CylinderGeometry(0.024 * s, 0.024 * s, this.sl, 6).rotateX(Math.PI / 2).translate(0, 0, this.sl / 2 + 0.02), row: ROWS.wood[1] },
      { geo: new THREE.TorusGeometry(0.02 * s, 0.006 * s, 4, 6).translate(0, 0, 0.005), row: ROWS.bark[0] }, // the link
    ], kit));
    this.handle.visible = this.swingle.visible = false;
    p.root.add(this.handle, this.swingle);
  }

  /** Set before start: how many blows. */
  plan(blows: number) {
    this.blows = Math.max(1, blows);
  }

  start() {
    this.dur = 0.5 + this.blows * BLOW + 0.4;
    this.lastBlow = -1;
    this.handle.visible = this.swingle.visible = true;
  }

  pre(t: number, _dt: number, P: ActionPose, tempo: number, out: ChoreOut) {
    this.t = t;
    const k = Math.sqrt(tempo);
    const dur = (this.durNow = this.dur / k);
    if (t >= dur) return false;
    const e = (this.e = envelope(t, dur, 0.5, 0.4));
    const d = this.p.dims;
    const chest = d.legLen + d.hipAbove + d.shoulderY * 0.75;
    // where in the blow: u 0 = struck (down), 1 = right up
    const tt = (t - 0.5) * k;
    const i = Math.floor(tt / BLOW);
    let up = 0.3; // (before the first and after the last: held low, ready)
    let whip = 0; // the swingle's lag: 1 hanging back, 0 laid flat out
    if (tt >= 0 && i < this.blows) {
      const f = tt / BLOW - i;
      if (f < UP) {
        up = smooth(f / UP);
        whip = up;
      } else if (f < UP + DOWN) {
        const g = (f - UP) / DOWN;
        up = 1 - g * g;
        whip = 1 - smooth(Math.min(1, g * 1.3));
      } else {
        up = 0;
        whip = 0;
        if (i !== this.lastBlow) {
          this.lastBlow = i;
          out.events.push('thud');
          out.bursts.push({ kind: 'chaff', at: this.p.root.localToWorld(this.tip(_a)) });
        }
      }
    }
    // the hands: down in front at the strike, up by the head at the top
    this.hands.set(-0.04, chest - 0.25 + 0.5 * up, 0.32 - 0.22 * up);
    this.ah = -0.75 + 3.0 * up; // the handle: forward and down … up and back over the head
    this.as = whip * -1.97 + (1 - whip) * -0.08; // the swingle: hanging down behind … laid flat out in front
    for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: e, x: -1.0 - 1.2 * up, z: 0.15, elbow: 0.7, stiff: 2.5 });
    P.spineX += (0.38 - 0.42 * up) * e;
    P.crouch += (0.1 - 0.06 * up) * e;
    P.headX += (0.25 - 0.3 * up) * e;
    out.focus = this.p.root.localToWorld(this.tip(_b));
    return true;
  }

  /** The swingle's far end (root frame). */
  private tip(out: THREE.Vector3) {
    out.copy(this.hands).addScaledVector(dir(this.ah, _c), this.hl);
    return out.addScaledVector(dir(this.as, _c), this.sl);
  }

  post(_t: number, _dt: number, _out: ChoreOut) {
    const pop = Math.max(1e-3, smooth(Math.min(1, this.t / 0.3, (this.durNow - this.t) / 0.3)));
    const z = new THREE.Vector3(0, 0, 1);
    this.handle.position.copy(this.hands);
    this.handle.quaternion.setFromUnitVectors(z, dir(this.ah, _a));
    this.handle.scale.setScalar(pop);
    this.swingle.position.copy(this.hands).addScaledVector(dir(this.ah, _a), this.hl * pop);
    this.swingle.quaternion.setFromUnitVectors(z, dir(this.as, _a));
    this.swingle.scale.setScalar(pop);
    // the right hand at the very end, the left just above it
    reachFist(this.p, 'R', this.hands, this.e, _b.set(-0.7, -1, -0.3));
    reachFist(this.p, 'L', _c.copy(this.hands).addScaledVector(dir(this.ah, _a), 0.11 * this.s), this.e, _b.set(0.7, -1, -0.3));
  }

  hide() {
    this.handle.visible = this.swingle.visible = false;
  }

  dispose() {
    this.hide();
    disposeMesh(this.handle);
    disposeMesh(this.swingle);
  }
}
