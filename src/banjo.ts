import * as THREE from 'three';
import { type Person, withRow } from './body';
import { type ActionPose, type PropKit, envelope, mesh, reachFist, smooth } from './actionkit';
import type { Chore, ChoreOut } from './chores';
import { ROWS } from './palette';
import { BANJO, FORM_SLOTS, degToHz, joinBand, leaveBand, tune } from './tune';

/**
 * Playing the banjo, standing or seated (whatever the actor's posture is):
 * the pot rests against the right hip with the head facing out, the neck
 * runs up across the body to the left, the left hand on the neck and the
 * right hand picking over the head. It plays the shared tune's banjo part (a
 * roll through each bar's chord, the drone string on the off-beats), so it
 * fits under any fiddlers who are playing.
 *
 * Like the meals, the instrument leads: it's placed against the body every
 * frame and both arms are solved onto it.
 */

const NECK = 0.44; // neck length (× scale), from the pot's edge
const POT_R = 0.085;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

export class Banjo implements Chore {
  private group = new THREE.Group();
  private voice = -1;
  private dur = 10;
  private lastSlot = -1;
  private pluckAt = -10;
  private fret = 0.55; // where along the neck the left hand is (0 = pot, 1 = nut)
  private fretTo = 0.55;
  private t = 0;
  private e = 0;
  private scale = 1;

  constructor(private p: Person, kit: PropKit) {
    const s = (this.scale = Math.sqrt(p.dims.height) * 1.25);
    const rim = ROWS.shoes[2];
    const dark = ROWS.shoes[0];
    // pot: a wooden hoop with a pale skin head facing +z, a dark resonator behind
    const hoop = withRow(new THREE.CylinderGeometry(POT_R, POT_R, 0.036, 16, 1, true).rotateX(Math.PI / 2), rim);
    const head = withRow(new THREE.CircleGeometry(POT_R * 0.97, 16).translate(0, 0, 0.018), ROWS.food[1]);
    const back = withRow(new THREE.CylinderGeometry(POT_R * 1.02, POT_R * 0.9, 0.02, 16).rotateX(Math.PI / 2).translate(0, 0, -0.026), dark);
    const bridge = withRow(new THREE.BoxGeometry(0.03, 0.006, 0.006).translate(-POT_R * 0.35, 0, 0.021), dark);
    // neck along +x from the pot's rim, with the peghead and the short fifth-string peg
    const neck = withRow(new THREE.BoxGeometry(NECK, 0.03, 0.016).translate(POT_R + NECK / 2 - 0.01, 0, 0.012), rim);
    const peg = withRow(new THREE.BoxGeometry(0.07, 0.045, 0.014).translate(POT_R + NECK + 0.03, 0, 0.012), dark);
    const fifth = withRow(new THREE.CylinderGeometry(0.005, 0.005, 0.03, 4).translate(POT_R + NECK * 0.35, 0.022, 0.012), ROWS.food[1]);
    const strings = withRow(new THREE.BoxGeometry(POT_R * 0.65 + NECK, 0.012, 0.003).translate((-POT_R * 0.35 + POT_R + NECK) / 2, 0, 0.022), ROWS.stone[1]);
    for (const g of [hoop, back, neck, peg]) this.group.add(mesh(g, kit));
    for (const g of [head, bridge, fifth, strings]) {
      const m = new THREE.Mesh(g, kit.toon);
      m.raycast = () => {};
      this.group.add(m);
    }
    this.group.scale.setScalar(s);
    this.group.visible = false;
    p.root.add(this.group);
  }

  /** Set before start: the beat clock now, and how long to play for (s). */
  plan(_beatTime: number, dur: number) {
    this.dur = dur;
  }

  /** Finish at this action time instead (stopPlaying). */
  stopAt(t: number) {
    this.dur = Math.min(this.dur, Math.max(t, 0.6));
  }

  start() {
    this.voice = joinBand('banjo');
    this.lastSlot = -1;
    this.pluckAt = -10;
    this.group.visible = true;
  }

  pre(t: number, _dt: number, P: ActionPose, _tempo: number, out: ChoreOut) {
    this.t = t;
    const dur = this.dur;
    if (t >= dur) return false;
    const e = (this.e = envelope(t, dur, 0.6, 0.5));
    // pick along the shared beat in eighth notes
    const slot = Math.floor(out.beatTime * 2);
    if (t > 0.6 && t < dur - 0.5 && slot !== this.lastSlot) {
      this.lastSlot = slot;
      const n = tune().parts[BANJO][slot % FORM_SLOTS];
      if (n.hold > 0) {
        out.pluck = { f: degToHz(n.deg) };
        this.pluckAt = t;
        // the fretting hand shifts with the chord (once a bar)
        if (slot % 8 === 0) this.fretTo = 0.45 + 0.25 * ((tune().chords[Math.floor((slot % FORM_SLOTS) / 8)] % 3) / 2);
      }
    }
    this.fret += (this.fretTo - this.fret) * 0.15;
    // rough arms for the springs; post() solves them onto the banjo
    Object.assign(P.arms.R, { w: e, x: -0.55, z: 0.25, elbow: 1.5, stiff: 2 });
    Object.assign(P.arms.L, { w: e, x: -1.0, z: 0.1, elbow: 1.3, stiff: 2 });
    const bob = 1 - Math.abs(Math.cos(out.beatTime * Math.PI)); // a nod on the beat
    P.spineX += 0.08 * e;
    P.headX += (0.25 + 0.06 * bob) * e; // looking down at the strings
    P.headY += 0.18 * e;
    P.headZ += 0.08 * e;
    P.spineY += 0.06 * Math.sin(out.beatTime * Math.PI * 0.5) * e;
    return true;
  }

  post(_t: number, _dt: number, _out: ChoreOut) {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    const e = this.e;
    const s = this.scale;
    p.root.updateMatrixWorld(true);
    // the pot against the right hip (the person's right is −x), head facing out
    const front = d.waistR * d.torsoDepth + POT_R * s * 0.25;
    const pot = J.spine.localToWorld(_a.set(-d.waistR * 0.45, d.shoulderY * 0.22, front));
    // neck up and across to the left shoulder, a little forward
    _x.set(1, 0.62, 0.32).normalize().transformDirection(J.spine.matrixWorld);
    _z.set(0, 0.2, 1).transformDirection(J.spine.matrixWorld);
    _y.crossVectors(_z, _x).normalize();
    _z.crossVectors(_x, _y);
    _m.makeBasis(_x, _y, _z);
    _q.setFromRotationMatrix(_m);
    // into the root's frame
    const rootQ = p.root.getWorldQuaternion(new THREE.Quaternion());
    this.group.position.copy(p.root.worldToLocal(pot.clone()));
    this.group.quaternion.copy(rootQ.invert().multiply(_q));
    this.group.scale.setScalar(s * Math.max(1e-3, smooth(Math.min(1, this.t / 0.35, (this.dur - this.t) / 0.3))));
    this.group.updateMatrixWorld(true);
    // left hand round the neck, at the fret
    const fret = this.group.localToWorld(_a.set(POT_R + NECK * this.fret, -0.02, -0.01));
    reachFist(p, 'L', p.root.worldToLocal(fret), e, _b.set(0.6, -1, -0.2));
    // right hand over the head near the bridge, striking down on each pluck
    const since = this.t - this.pluckAt;
    const lift = since < 0.06 ? 1 - since / 0.06 : since < 0.2 ? (since - 0.06) / 0.14 : 1;
    const pick = this.group.localToWorld(_a.set(-POT_R * 0.15, 0.01 + 0.012 * lift, 0.045 + 0.015 * lift));
    reachFist(p, 'R', p.root.worldToLocal(pick), e);
  }

  hide() {
    this.group.visible = false;
    leaveBand(this.voice);
    this.voice = -1;
  }

  dispose() {
    this.hide();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.group.removeFromParent();
  }
}
