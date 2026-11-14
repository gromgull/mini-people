import * as THREE from 'three';
import { type Person, withRow } from './body';
import { type ActionPose, type PropKit, mesh, reachFist, smooth } from './actionkit';
import type { Chore, ChoreOut } from './chores';
import { ROWS } from './palette';

/**
 * Smoking a pipe, standing or seated (whatever the actor's posture is): out
 * comes the pipe, held by the bowl at the chest with the stem toward the
 * mouth; every few seconds it goes up to the lips for a long draw, comes
 * down again, and a breath of smoke follows it out. The bowl smoulders all
 * the while, a thin wisp rising off it. The smoke itself is the world's (the
 * crowd lets go each puff the chore reports).
 */

const DRAW = { up: 0.6, hold: 1.1, down: 0.55 };
const OUT_AT = 0.35; // after it's down: breathe out

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _u = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class Pipe implements Chore {
  private group = new THREE.Group();
  private dur = 18;
  private t = 0;
  private e = 0;
  private nextDraw = 0;
  private drawAt = -10;
  private draw = 0; // 0 … 1: at the lips
  private nextWisp = 0;
  private stem: number;
  private s: number;

  constructor(private p: Person, kit: PropKit) {
    const s = (this.s = Math.sqrt(p.dims.height));
    this.stem = 0.11 * s;
    // the bowl at the origin standing up, the stem along +z to the mouthpiece
    const wood = ROWS.timber[0];
    const bowl = withRow(new THREE.CylinderGeometry(0.017, 0.013, 0.034, 8).translate(0, 0.012, 0), wood);
    const ash = withRow(new THREE.CircleGeometry(0.013, 8).rotateX(-Math.PI / 2).translate(0, 0.0295, 0), ROWS.stone[2]);
    const shank = withRow(new THREE.CylinderGeometry(0.005, 0.006, this.stem / s, 5).rotateX(Math.PI / 2).translate(0, 0, this.stem / s / 2), wood);
    const bit = withRow(new THREE.BoxGeometry(0.009, 0.004, 0.02).translate(0, 0, this.stem / s - 0.008), ROWS.shoes[1]);
    for (const g of [bowl, shank, bit]) this.group.add(mesh(g, kit));
    const ashM = new THREE.Mesh(ash, kit.toon);
    ashM.raycast = () => {};
    this.group.add(ashM);
    this.group.scale.setScalar(s);
    this.group.visible = false;
    p.root.add(this.group);
  }

  /** Set before start: how long to smoke (s). */
  plan(dur: number) {
    this.dur = dur;
  }

  /** Put it away at this action time instead. */
  stopAt(t: number) {
    this.dur = Math.min(this.dur, Math.max(t, this.t + 0.3));
  }

  start() {
    this.t = 0;
    this.nextDraw = 1.0 + Math.random();
    this.drawAt = -10;
    this.draw = 0;
    this.nextWisp = 0.8;
    this.group.visible = true;
  }

  pre(t: number, dt: number, P: ActionPose, _tempo: number, out: ChoreOut) {
    this.t = t;
    const dur = this.dur;
    if (t >= dur) return false;
    // out of the pocket and up to the chest; away again at the end
    const e = (this.e = smooth(Math.min(t / 0.6, (dur - t) / 0.5)));
    // a draw now and then (not one it can't finish)
    if (t >= this.nextDraw && this.drawAt < 0 && t + DRAW.up + DRAW.hold + DRAW.down < dur - 0.6) {
      this.drawAt = t;
      this.nextDraw = Infinity;
    }
    const u = this.drawAt >= 0 ? t - this.drawAt : -1;
    this.draw = u < 0 ? 0 : u < DRAW.up ? smooth(u / DRAW.up) : u < DRAW.up + DRAW.hold ? 1 : smooth(1 - (u - DRAW.up - DRAW.hold) / DRAW.down);
    const outU = u - DRAW.up - DRAW.hold - DRAW.down - OUT_AT; // breathing out
    if (outU >= 1.2) {
      this.drawAt = -1;
      this.nextDraw = t + 2.5 + Math.random() * 3.5;
    }
    // breathing in: chest up, chin a touch up; breathing out: a slow sigh
    const inhale = u >= DRAW.up && u < DRAW.up + DRAW.hold ? Math.sin((Math.PI * (u - DRAW.up)) / DRAW.hold) : 0;
    const exhale = outU >= 0 && outU < 1.2 ? Math.sin((Math.PI * outU) / 1.2) : 0;
    P.spineX += (-0.05 * inhale + 0.04 * exhale - 0.02) * e;
    P.headX += (-0.1 * inhale - 0.12 * exhale) * e;
    // the pipe hand: at the chest (the rest of the arm's own), the other hangs
    Object.assign(P.arms.R, { w: e, x: -0.3, z: 0.14, elbow: 1.75, stiff: 1.5 });
    out.focus = null;

    // smoke: a thin wisp off the bowl, and the breath out in a few puffs
    const p = this.p;
    if (e > 0.5 && t >= this.nextWisp) {
      this.nextWisp = t + 0.3 + Math.random() * 0.25;
      p.root.updateMatrixWorld(true);
      const top = this.group.localToWorld(_a.set(0, 0.03, 0));
      out.puffs.push({ at: top.clone(), size: 0.007 * this.s, vel: new THREE.Vector3((Math.random() - 0.5) * 0.02, 0.1, (Math.random() - 0.5) * 0.02) });
    }
    if (outU >= 0 && outU < 0.7 && Math.floor(outU / 0.14) !== Math.floor((outU - dt) / 0.14)) {
      const { mouth, fwd } = this.mouth();
      const at = p.root.localToWorld(mouth.clone().addScaledVector(fwd, p.dims.headR * 0.2));
      const dir = fwd.clone().transformDirection(p.root.matrixWorld);
      out.puffs.push({ at, size: 0.014 * this.s, vel: dir.multiplyScalar(0.16).add(_u.set(0, 0.07, 0)) });
    }
    return true;
  }

  /** The lips and which way the face looks (root frame). */
  private mouth() {
    const p = this.p;
    const hr = p.dims.headR;
    const J = p.joints;
    const mouth = p.root.worldToLocal(J.head.localToWorld(new THREE.Vector3(0, hr * 0.38, hr * 0.95)));
    const fwd = p.root.worldToLocal(J.head.localToWorld(new THREE.Vector3(0, hr * 0.38, hr * 1.95))).sub(mouth).normalize();
    return { mouth, fwd };
  }

  post(_t: number, _dt: number, _out: ChoreOut) {
    const p = this.p;
    const d = p.dims;
    p.root.updateMatrixWorld(true);
    const { mouth, fwd } = this.mouth();
    // up to the lips: the bowl a stem's length ahead of the mouth, a little low
    if (this.draw > 0) {
      const bowl = mouth.clone().addScaledVector(fwd, this.stem * 0.92).add(_u.set(0, -0.012 * this.s, 0));
      const fist = bowl.clone().add(_u.set(0, -d.handR * 1.1, -d.handR * 0.2));
      reachFist(p, 'R', fist, this.draw * this.e, _b.set(-1, -0.5, -0.4));
      p.root.updateMatrixWorld(true);
    }
    // the bowl sits in the fist, the stem pointing at the mouth
    const bowl = p.root.worldToLocal(p.joints.wristR.localToWorld(_a.set(0, -d.handR * 1.0, d.handR * 0.9)));
    bowl.y += d.handR * 0.4;
    const dir = mouth.clone().sub(bowl).normalize();
    this.group.position.copy(bowl);
    // (bowl upright: no roll about the stem)
    const x = _u.set(0, 1, 0).cross(dir).normalize();
    const y = _b.crossVectors(dir, x);
    this.group.quaternion.setFromRotationMatrix(_m.makeBasis(x, y, dir));
    this.group.scale.setScalar(this.s * Math.max(1e-3, this.e));
  }

  hide() {
    this.group.visible = false;
  }

  dispose() {
    this.hide();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.group.removeFromParent();
  }
}
