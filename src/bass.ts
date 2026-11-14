import * as THREE from 'three';
import { type Person, withRow } from './body';
import { type ActionPose, type PropKit, envelope, mesh, reachFist, smooth } from './actionkit';
import type { Chore, ChoreOut } from './chores';
import { ROWS } from './palette';
import { BASS, FORM_SLOTS, degToHz, joinBand, leaveBand, tune } from './tune';

/**
 * Playing the double bass, standing: the instrument stands on its endpin a
 * little ahead and to the left, leaning back toward the player, its face
 * turned out to the front-right. The left hand holds the neck about
 * shoulder high (sliding with the notes), the right hand plucks at the end
 * of the fingerboard, pulling the string across on each note. It plays the
 * shared tune's bass part (root and fifth below, on the beat).
 *
 * The instrument is as tall as the player and is placed against them every
 * frame (in the root's frame), with both arms solved onto it.
 */

/** Along the instrument (× its length), from the endpin. */
const NECK_HI = 0.9;

const _a = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class DoubleBass implements Chore {
  private group = new THREE.Group();
  private voice = -1;
  private dur = 10;
  private lastSlot = -1;
  private pluckAt = -10;
  private stop = 0.76; // where along the neck the left hand is
  private stopTo = 0.76;
  private t = 0;
  private e = 0;
  private L = 1; // its length

  constructor(private p: Person, kit: PropKit) {
    const L = (this.L = p.dims.height * 0.97);
    const wood = ROWS.wood[1];
    const dark = ROWS.shoes[0];
    // the body: stacked squashed balls for the lower bout, the upper bout and
    // the waist between, a good depth front to back
    const DEPTH = 0.55;
    const parts: THREE.BufferGeometry[] = [];
    const ball = (r: number, y: number, row: number) => withRow(new THREE.SphereGeometry(r, 12, 8).scale(1, 1.15, DEPTH).translate(0, y, 0), row);
    parts.push(ball(0.2, 0.27, wood), ball(0.15, 0.5, wood), ball(0.1, 0.39, wood));
    // a box from a to b (in the yz plane), w wide and d deep
    const beam = (ay: number, az: number, by: number, bz: number, w: number, d: number, row: number) => {
      const len = Math.hypot(by - ay, bz - az);
      return withRow(new THREE.BoxGeometry(w, len, d).rotateX(Math.atan2(bz - az, by - ay)).translate(0, (ay + by) / 2, (az + bz) / 2), row);
    };
    // the belly's front: the lower bout's, and where the upper bout meets the neck
    const front = 0.2 * DEPTH;
    const nut = 0.03;
    // the neck behind, the fingerboard raised over the belly and running down to the nut
    parts.push(withRow(new THREE.BoxGeometry(0.04, 0.6 - NECK_HI + 0.4, 0.03).translate(0, (0.6 + NECK_HI) / 2 + 0.05, 0), wood));
    parts.push(beam(0.42, front + 0.004, NECK_HI, nut, 0.045, 0.025, dark));
    // the tailpiece, the bridge, the scroll, the pegs and the endpin
    parts.push(withRow(new THREE.BoxGeometry(0.05, 0.12, 0.012).translate(0, 0.16, front + 0.004), dark));
    parts.push(withRow(new THREE.BoxGeometry(0.09, 0.06, 0.012).rotateX(0.2).translate(0, 0.3, front + 0.03), ROWS.wood[2]));
    parts.push(withRow(new THREE.TorusGeometry(0.035, 0.016, 5, 8).rotateY(Math.PI / 2).translate(0, NECK_HI + 0.08, 0.0), wood));
    parts.push(withRow(new THREE.BoxGeometry(0.07, 0.02, 0.02).translate(0, NECK_HI + 0.02, 0), dark));
    parts.push(withRow(new THREE.CylinderGeometry(0.008, 0.008, 0.08, 5).translate(0, 0.04, 0), ROWS.stone[2]));
    // the strings: from the tailpiece up over the bridge, then along the fingerboard to the nut
    parts.push(beam(0.16, front + 0.012, 0.32, front + 0.062, 0.03, 0.004, ROWS.stone[1]));
    parts.push(beam(0.32, front + 0.062, NECK_HI, nut + 0.016, 0.03, 0.004, ROWS.stone[1]));
    for (const g of parts) {
      g.scale(L, L, L);
      this.group.add(mesh(g, kit));
    }
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
    this.voice = joinBand('bass');
    this.lastSlot = -1;
    this.pluckAt = -10;
    this.group.visible = true;
  }

  pre(t: number, _dt: number, P: ActionPose, _tempo: number, out: ChoreOut) {
    this.t = t;
    const dur = this.dur;
    if (t >= dur) return false;
    const e = (this.e = envelope(t, dur, 0.7, 0.6));
    const slot = Math.floor(out.beatTime * 2);
    if (t > 0.7 && t < dur - 0.5 && slot !== this.lastSlot) {
      this.lastSlot = slot;
      const n = tune().parts[BASS][slot % FORM_SLOTS];
      if (n.hold > 0) {
        out.pluck = { f: [degToHz(n.deg)], kind: 'bass' };
        this.pluckAt = t;
        // higher notes stop the string further down the neck
        this.stopTo = 0.8 - 0.015 * (((n.deg % 7) + 7) % 7);
      }
    }
    this.stop += (this.stopTo - this.stop) * 0.2;
    Object.assign(P.arms.L, { w: e, x: -1.3, z: 0.3, elbow: 1.2, stiff: 2 });
    Object.assign(P.arms.R, { w: e, x: -0.6, z: -0.1, elbow: 1.2, stiff: 2 });
    // leaning in to it, head over toward the neck, swaying with the beat
    const sway = Math.sin(out.beatTime * Math.PI);
    P.spineX += 0.12 * e;
    P.spineY += (0.15 + 0.04 * sway) * e;
    P.headZ -= 0.15 * e;
    P.headX += 0.1 * e;
    P.crouch += 0.025 * (1 - Math.abs(Math.cos(out.beatTime * Math.PI))) * e;
    return true;
  }

  post(_t: number, _dt: number, _out: ChoreOut) {
    const p = this.p;
    const H = p.dims.height;
    const L = this.L;
    const e = this.e;
    p.root.updateMatrixWorld(true);
    // stood on its endpin ahead and to the left (the person's left is +x),
    // leaning back toward them, its face turned out to the front-right
    const foot = _a.set(0.17 * H, 0, 0.26 * H); // (far enough out for its depth)
    _y.set(0.02, 1, -0.12).normalize();
    _z.set(-0.35, 0, 1).normalize();
    _x.crossVectors(_y, _z).normalize();
    _z.crossVectors(_x, _y);
    _m.makeBasis(_x, _y, _z);
    this.group.quaternion.setFromRotationMatrix(_m);
    this.group.position.copy(foot);
    // it's picked up and laid down (from and onto the ground) as they start and finish
    const k = smooth(Math.min(1, this.t / 0.5, (this.dur - this.t) / 0.4));
    this.group.scale.setScalar(Math.max(1e-3, k));
    this.group.updateMatrixWorld(true);
    // left hand round the neck
    const neck = this.group.localToWorld(new THREE.Vector3(0.025, this.stop * L, 0.0));
    reachFist(p, 'L', p.root.worldToLocal(neck), e, new THREE.Vector3(1, -0.6, -0.4));
    // right hand at the end of the fingerboard, pulling the string across on each note
    const since = this.t - this.pluckAt;
    const pull = since < 0.08 ? since / 0.08 : since < 0.3 ? 1 - (since - 0.08) / 0.22 : 0;
    // (beside the fingerboard where it meets the body, fingers hooked round the string from the player's side)
    const pluck = this.group.localToWorld(new THREE.Vector3(-0.05 * L - 0.04 * L * pull, 0.42 * L, 0.15 * L));
    reachFist(p, 'R', p.root.worldToLocal(pluck), e, new THREE.Vector3(-1, -0.6, -0.4));
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
