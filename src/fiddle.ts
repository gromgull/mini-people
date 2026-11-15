import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { type Person, withRow } from './body';
import { type ActionPose, type PropKit, envelope, mesh } from './actionkit';
import type { Chore, ChoreOut } from './chores';
import { twoBoneIK } from './ik';
import { ROWS } from './palette';
import { BPM, FORM_SLOTS, degToHz, joinBand, leaveBand, tune } from './tune';

/**
 * Playing the fiddle, standing or seated: the fiddle between the chin and
 * the left hand, the bow in the right hand, and a part of the shared tune
 * (whichever is free: melody, harmony or the low line), a note per bow
 * stroke, changing direction on every new note.
 *
 * The body leads here (unlike the banjo): the arms are posed roughly, then
 * the fiddle is put where the chin and left hand ended up, and the bow arm
 * is solved onto the strings.
 */

const BOW_LEN = 0.36;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _z = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _qU = new THREE.Quaternion();
const _qM = new THREE.Quaternion();

const mergeAll = (g: THREE.BufferGeometry[]) => {
  const out = mergeGeometries(g)!;
  g.forEach((x) => x.dispose());
  return out;
};

export class Fiddle implements Chore {
  private fiddle = new THREE.Group();
  private bowMesh = new THREE.Group();
  /** Which part of the tune this fiddler plays (0 melody, 1 harmony, 2 bass), −1 = not playing. */
  private voice = -1;
  private dur = 10;
  private bow = { dir: 1, start: 0, len: 0.25, lastSlot: -1 };
  private stroke = 0; // −1 … 1 along the bow
  private weight = 0;

  constructor(private p: Person, kit: PropKit) {
    const s = Math.sqrt(p.dims.height);
    const wood = ROWS.shoes[2];
    const dark = ROWS.shoes[1];
    // body: two overlapping flattened balls (an hourglass), neck + scroll toward +z
    const lower = withRow(new THREE.SphereGeometry(0.06, 10, 6), wood);
    lower.scale(1, 0.38, 1.1);
    const upper = withRow(new THREE.SphereGeometry(0.048, 10, 6), wood);
    upper.scale(1, 0.38, 1.1);
    upper.translate(0, 0, 0.075);
    const neck = withRow(new THREE.BoxGeometry(0.016, 0.014, 0.11), dark);
    neck.translate(0, 0.012, 0.16);
    const scroll = withRow(new THREE.SphereGeometry(0.014, 6, 4), dark);
    scroll.translate(0, 0.012, 0.22);
    this.fiddle.add(mesh(mergeAll([lower, upper, neck, scroll]), kit));
    this.fiddle.scale.setScalar(s * 1.6);
    // bow: frog at the origin, stick along +x
    const stick = withRow(new THREE.CylinderGeometry(0.004, 0.004, BOW_LEN, 4), dark);
    stick.rotateZ(Math.PI / 2);
    stick.translate(BOW_LEN / 2, 0.01, 0);
    const hair = withRow(new THREE.BoxGeometry(BOW_LEN * 0.9, 0.003, 0.008), ROWS.cloud[0]);
    hair.translate(BOW_LEN / 2, 0, 0);
    const frog = withRow(new THREE.BoxGeometry(0.02, 0.022, 0.012), dark);
    this.bowMesh.add(mesh(mergeAll([stick, hair, frog]), kit));
    this.bowMesh.scale.setScalar(s);
    this.fiddle.visible = this.bowMesh.visible = false;
    p.root.add(this.fiddle, this.bowMesh); // both placed every frame
  }

  /** Set before start: how long to play for (s; to the end of a phrase, so it stops on a cadence). */
  plan(dur: number) {
    this.dur = dur;
  }

  /** Finish at this action time instead (stopPlaying). */
  stopAt(t: number) {
    this.dur = Math.min(this.dur, t);
  }

  start() {
    this.voice = joinBand('fiddle');
    this.bow.lastSlot = -1;
    this.fiddle.visible = this.bowMesh.visible = true;
  }

  pre(t: number, _dt: number, P: ActionPose, _tempo: number, out: ChoreOut) {
    const dur = this.dur;
    if (t >= dur) return false;
    const e = envelope(t, dur, 0.5, 0.5);
    // play along the shared beat in eighth notes
    const slot = Math.floor(out.beatTime * 2);
    const eighth = 30 / BPM; // seconds per eighth note at the shared tempo
    if (t > 0.5 && t < dur - 0.5 && slot !== this.bow.lastSlot) {
      this.bow.lastSlot = slot;
      const n = tune().parts[Math.max(0, this.voice)][slot % FORM_SLOTS];
      if (n.hold > 0) {
        out.note = { f: degToHz(n.deg), dur: eighth * n.hold };
        this.bow.dir = -this.bow.dir; // change bow direction on every new note
        this.bow.start = t;
        this.bow.len = eighth * n.hold;
      }
    }
    // bow arm: the hand travels across with each stroke
    const k = Math.min(1, (t - this.bow.start) / this.bow.len);
    this.stroke = this.bow.dir * (2 * k - 1);
    this.weight = e;
    // rough bowing pose for the springs; post() solves the exact arm with IK
    Object.assign(P.arms.R, { w: e, x: -1.0, z: 0.35, elbow: 1.3, stiff: 2 });
    Object.assign(P.arms.L, { w: e, x: -1.2, z: 0.85, elbow: 0.55, stiff: 2 }); // holding the fiddle out to the side
    const sway = Math.sin(out.beatTime * Math.PI);
    P.headZ = 0.3 * e; // chin on the fiddle
    P.headY = 0.2 * e;
    P.headX = 0.12 * e;
    P.spineZ = 0.06 * sway * e;
    P.spineY = 0.08 * sway * e;
    P.crouch = 0.02 * (1 - Math.abs(Math.cos(out.beatTime * Math.PI))) * e; // a little bounce on the beat
    return true;
  }

  post(_t: number, _dt: number, _out: ChoreOut) {
    this.placeFiddle();
    this.placeBow();
  }

  /** Put the fiddle between the chin and the left hand (after posing). */
  private placeFiddle() {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    p.root.updateMatrixWorld(true);
    const chin = p.root.worldToLocal(J.head.localToWorld(_a.set(d.headR * 0.35, d.headR * 0.1, d.headR * 0.35)));
    const hand = p.root.worldToLocal(J.wristL.localToWorld(_b.set(0, -d.handR * 0.6, 0)));
    const dir = _c.subVectors(hand, chin).normalize();
    this.fiddle.position.copy(chin).addScaledVector(dir, -0.02);
    // neck along chin→hand; top face roughly up and a little toward the player
    this.fiddle.quaternion.setFromUnitVectors(_z.set(0, 0, 1), dir);
    this.fiddle.rotateZ(0.12); // a slight tilt; more would stand the bow up steeply
  }

  /**
   * The bow crosses the strings just above the fiddle body, square to the
   * neck, and slides along its own length; the right arm is then solved
   * (two-bone IK in the chest's frame) so the hand holds the frog.
   */
  private placeBow() {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    const f = this.fiddle;
    const bow = this.bowMesh;
    f.updateMatrix();
    // contact point (between bridge and fingerboard) and "across the strings"
    const contact = _a.set(0, 0.03, 0.06).applyMatrix4(f.matrix);
    const across = _c.set(1, 0, 0).transformDirection(f.matrix);
    if (across.x < 0) across.negate(); // the frog end is on the player's right (−x)
    const len = BOW_LEN * Math.sqrt(d.height);
    const along = 0.5 + 0.38 * this.stroke; // where on the bow the strings are
    const frogPos = _b.copy(contact).addScaledVector(across, -along * len);
    bow.position.copy(frogPos);
    bow.quaternion.setFromUnitVectors(_z.set(1, 0, 0), across);

    // right arm: wrist to the frog, elbow out and down
    p.root.updateMatrixWorld(true);
    const wristTarget = J.spine.worldToLocal(p.root.localToWorld(frogPos.clone()));
    wristTarget.y += d.handR * 0.4;
    twoBoneIK(J.shoulderR.position, wristTarget, _pole.set(-1, -0.7, -0.4), d.upperArmLen, d.foreArmLen, _qU, _qM);
    const w = this.weight;
    J.shoulderR.quaternion.slerp(_qU, w);
    J.elbowR.quaternion.slerp(_qM, w);
  }

  hide() {
    this.fiddle.visible = this.bowMesh.visible = false;
    leaveBand(this.voice);
    this.voice = -1;
  }

  dispose() {
    this.hide();
    for (const g of [this.fiddle, this.bowMesh]) {
      g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      g.removeFromParent();
    }
  }
}
