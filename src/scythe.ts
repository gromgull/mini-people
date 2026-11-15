import * as THREE from 'three';
import type { Person } from './body';
import { type ActionPose, type PropKit, envelope, reachFist, smooth } from './actionkit';
import { type Chore, type ChoreOut, baked, disposeMesh } from './chores';
import { ROWS } from './palette';
import type { Part } from './trees';

/**
 * Mowing with a scythe: the long snath held by its two grips, the blade at
 * its foot lying flat along the ground, the whole thing swung round from the
 * body: back to the right (the blade lifted clear), then a long sweep low
 * across to the left, the body twisting with it. A step forward between
 * swings is the walker's (this is a moving action): the job asks for one
 * after each sweep.
 */

const BOX = (w: number, h: number, d: number, x: number, y: number, z: number, row: number): Part => ({ geo: new THREE.BoxGeometry(w, h, d).translate(x, y, z), row });

/** One swing (s, at tempo 1), and how it's split: back, the sweep, a breath. */
const SWING = 1.3;
const BACK = 0.5;
const SWEEP = 0.38;
/** How far round it goes (radians: + is to their left). */
const FROM = -0.85;
const TO = 0.7;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class Scythe implements Chore {
  private group = new THREE.Group();
  private swings = 6;
  private dur = 10;
  private durNow = 10;
  private e = 0;
  private t = 0;
  private s = 1;
  /** Sweeps finished so far (the job mows a step's worth for each). */
  sweeps = 0;
  private lastSweep = -1;
  /** Where the grips are, in the scythe's frame. */
  private grips: THREE.Vector3[] = [];

  constructor(private p: Person, kit: PropKit) {
    const d = p.dims;
    const s = (this.s = Math.sqrt(d.height));
    // the snath: from the heel (up by the hip) down and forward to the foot on the ground
    const hipY = d.legLen;
    const heel = new THREE.Vector3(-0.12, 0.05, -0.1).multiplyScalar(s);
    const foot = new THREE.Vector3(0.02, -hipY + 0.05, 0.95 * s);
    const len = heel.distanceTo(foot);
    const mid = heel.clone().add(foot).multiplyScalar(0.5);
    const snath = new THREE.BoxGeometry(0.028 * s, 0.028 * s, len).translate(0, 0, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), foot.clone().sub(heel).normalize());
    snath.applyQuaternion(q).translate(mid.x, mid.y, mid.z);
    const parts: Part[] = [{ geo: snath, row: ROWS.wood[1] }];
    // the two grips (nibs), sticking up off the snath
    for (const f of [0.18, 0.5]) {
      const at = heel.clone().lerp(foot, f);
      this.grips.push(at.clone().add(new THREE.Vector3(0, 0.07 * s, 0)));
      parts.push(BOX(0.022 * s, 0.08 * s, 0.022 * s, at.x, at.y + 0.04 * s, at.z, ROWS.wood[0]));
    }
    // the blade: flat along the ground off the foot, out to the left, a slight curve back
    const bl = 0.55 * s;
    for (let k = 0; k < 4; k++) {
      const x0 = foot.x + (k / 4) * bl, x1 = foot.x + ((k + 1) / 4) * bl;
      const z = foot.z - 0.04 * s * (k / 4) ** 2 * 4;
      parts.push(BOX(x1 - x0 + 0.004, 0.008, (0.06 - 0.012 * k) * s, (x0 + x1) / 2, foot.y - 0.01, z, ROWS.stone[1]));
    }
    this.group.add(baked(parts, kit));
    this.group.visible = false;
    p.root.add(this.group);
  }

  /** Set before start: how many swings. */
  plan(swings: number) {
    this.swings = Math.max(1, swings);
  }

  /** Stop after the swing that's under way. */
  stopSoon() {
    this.swings = Math.min(this.swings, this.lastSweep + 2);
  }

  start() {
    this.dur = 0.4 + this.swings * SWING + 0.4;
    this.sweeps = 0;
    this.lastSweep = -1;
    this.group.visible = true;
  }

  /** The swing's angle round the body, and the blade's lift, at time t. */
  private swing(t: number, k: number) {
    const tt = (t - 0.4) * k;
    if (tt < 0) return { ang: FROM * 0.5, lift: 0.1, sweeping: false, i: -1 };
    const i = Math.floor(tt / SWING);
    if (i >= this.swings) return { ang: TO * 0.6, lift: 0.08, sweeping: false, i };
    const f = (tt - i * SWING) / SWING;
    const back = BACK / SWING, sweep = SWEEP / SWING;
    if (f < back) {
      const g = smooth(f / back);
      return { ang: TO + (FROM - TO) * g, lift: 0.1 * Math.sin(Math.PI * g), sweeping: false, i };
    }
    if (f < back + sweep) {
      const g = smooth((f - back) / sweep);
      return { ang: FROM + (TO - FROM) * g, lift: 0, sweeping: true, i };
    }
    return { ang: TO, lift: 0.02, sweeping: false, i };
  }

  pre(t: number, _dt: number, P: ActionPose, tempo: number, out: ChoreOut) {
    this.t = t;
    const k = Math.sqrt(tempo);
    const dur = (this.durNow = this.dur / k);
    if (t >= dur) return false;
    const e = (this.e = envelope(t, dur, 0.4, 0.4));
    const sw = this.swing(t, k);
    if (sw.sweeping && sw.i !== this.lastSweep) {
      this.lastSweep = sw.i;
      out.events.push('swish');
    }
    // a sweep's done once it's past its end
    if (!sw.sweeping && sw.i === this.lastSweep && this.sweeps <= sw.i) this.sweeps = sw.i + 1;
    if (sw.sweeping) out.bursts.push({ kind: 'chaff', at: this.bladeWorld() });
    this.group.rotation.y = sw.ang;
    this.group.position.set(0, this.p.dims.legLen + sw.lift, 0.05);
    // twist with it, a bit bent over, knees soft
    for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: e, x: -0.7, z: 0.2, elbow: 0.6, stiff: 2 });
    P.spineY += sw.ang * 0.45 * e;
    P.spineX += 0.28 * e;
    P.crouch += 0.07 * e;
    P.headX += 0.2 * e;
    out.focus = this.bladeWorld();
    return true;
  }

  private bladeWorld() {
    return this.group.localToWorld(_b.set(0.3 * this.s, -this.p.dims.legLen + 0.05, 0.95 * this.s));
  }

  post(_t: number, _dt: number, _out: ChoreOut) {
    const p = this.p;
    const pop = Math.max(1e-3, smooth(Math.min(1, this.t / 0.3, (this.durNow - this.t) / 0.3)));
    this.group.scale.setScalar(pop);
    this.group.updateMatrix();
    // (person's right is −x: the right hand on the lower grip, the left at the top)
    reachFist(p, 'L', _a.copy(this.grips[0]).applyMatrix4(this.group.matrix), this.e, _b.set(0.7, -1, -0.4));
    reachFist(p, 'R', _a.copy(this.grips[1]).applyMatrix4(this.group.matrix), this.e, _b.set(-0.7, -1, -0.2));
  }

  hide() {
    this.group.visible = false;
  }

  dispose() {
    this.hide();
    disposeMesh(this.group);
  }
}
