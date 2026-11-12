import * as THREE from 'three';
import type { Person } from './body';
import { Spring, type SpringParams } from './springs';

export const LOOK_MODES = ['auto', 'cursor', 'camera', 'selected'] as const;
export type LookMode = (typeof LOOK_MODES)[number];

/** What the whole scene offers as things to look at this frame. */
export interface GazeWorld {
  mode: LookMode;
  people: Person[];
  busy: (i: number) => boolean; // doing something worth staring at
  camera: THREE.Vector3;
  cursor: THREE.Vector3 | null;
  selected: number;
  time: number;
}

/** Head-turn request for the animator (radians, root-relative, unsprung). */
export interface LookHint {
  yaw: number;
  pitch: number;
}

// googly pupils: loose and bouncy, so head motion makes them jiggle
const PUPIL: SpringParams = { f: 5, z: 0.28, r: 0 };
const MAX_ANGLE = THREE.MathUtils.degToRad(46); // keep pupils readable from the front
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();
const _h = new THREE.Vector3();

export function headCentre(p: Person, out: THREE.Vector3) {
  return p.joints.head.localToWorld(out.set(0, p.dims.headR * 0.9, 0));
}

/**
 * Per-person gaze: picks something to look at, springs the pupils toward it
 * (googly wobble included), blinks now and then, and tells the animator how
 * far to turn the head.
 */
export class Gaze {
  private target = new THREE.Vector3();
  private hasTarget = false;
  private who = -1; // person index being watched, if any
  private nextPick = 0;
  private nextBlink = 0;
  private blinkT = -1;
  private springs: Spring[][] = [];
  readonly hint: LookHint = { yaw: 0, pitch: 0 };
  /** Conversation partner: overrides everything in auto mode. */
  partner = -1;

  constructor(private p: Person, private self: number, private rnd: () => number) {
    this.springs = p.eyes.map(() => [new Spring(), new Spring()]);
    this.nextBlink = 1 + rnd() * 4;
  }

  private pick(w: GazeWorld) {
    const me = this.p.root.position;
    // something dramatic nearby beats everything else
    let best = -1;
    let bestD = 3.2;
    w.people.forEach((o, i) => {
      if (i === this.self || !w.busy(i)) return;
      const dd = o.root.position.distanceTo(me);
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    });
    if (best >= 0) {
      this.who = best;
      this.nextPick = w.time + 1.5 + this.rnd() * 1.5;
      return;
    }
    const r = this.rnd();
    this.who = -1;
    if (r < 0.25) {
      this.target.copy(w.camera); // look at the player
      this.hasTarget = true;
    } else if (r < 0.65) {
      // a random neighbour in front of us
      const yaw = this.p.root.rotation.y;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const cands = w.people
        .map((o, i) => ({ i, d: o.root.position.distanceTo(me), front: (o.root.position.x - me.x) * fx + (o.root.position.z - me.z) * fz }))
        .filter((c) => c.i !== this.self && c.d < 3 && c.front > -0.2);
      if (cands.length) this.who = cands[Math.floor(this.rnd() * cands.length)].i;
      else this.hasTarget = false;
    } else {
      this.hasTarget = false; // just look ahead
    }
    this.nextPick = w.time + 1.2 + this.rnd() * 2.8;
  }

  /** Decide where to look. Call before the animator so the head can turn. */
  aim(w: GazeWorld) {
    const p = this.p;
    if (w.mode === 'auto' && this.partner >= 0 && w.people[this.partner]) {
      headCentre(w.people[this.partner], this.target);
      this.hasTarget = true;
      this.who = this.partner;
    } else if (w.mode === 'auto') {
      if (w.time >= this.nextPick || (this.who >= 0 && !w.people[this.who])) this.pick(w);
      // interrupt a dull glance if someone nearby starts doing something
      if (this.who < 0 || !w.busy(this.who)) {
        const near = w.people.findIndex((o, i) => i !== this.self && w.busy(i) && o.root.position.distanceTo(p.root.position) < 3.2);
        if (near >= 0 && near !== this.who) {
          this.who = near;
          this.nextPick = w.time + 1.5;
        }
      }
      if (this.who >= 0) {
        headCentre(w.people[this.who], this.target);
        this.hasTarget = true;
      }
    } else if (w.mode === 'camera') {
      this.target.copy(w.camera);
      this.hasTarget = true;
    } else if (w.mode === 'cursor') {
      this.hasTarget = !!w.cursor;
      if (w.cursor) this.target.copy(w.cursor);
    } else {
      const s = w.people[w.selected];
      this.hasTarget = !!s && w.selected !== this.self;
      if (this.hasTarget) headCentre(s, this.target);
    }

    // head turn: part of the way toward the target, in the root's frame
    if (this.hasTarget) {
      _t.copy(this.target);
      p.root.worldToLocal(_t);
      _h.set(0, p.dims.height - p.dims.headR, 0);
      _t.sub(_h);
      const yaw = Math.atan2(_t.x, Math.max(0.05, _t.z) + Math.max(0, -_t.z) * 0.2);
      const pitch = -Math.atan2(_t.y, Math.hypot(_t.x, _t.z));
      this.hint.yaw = THREE.MathUtils.clamp(yaw * 0.55, -0.9, 0.9);
      this.hint.pitch = THREE.MathUtils.clamp(pitch * 0.4, -0.35, 0.35);
    } else {
      this.hint.yaw = this.hint.pitch = 0;
    }
  }

  /** Move pupils (after the body is posed) and blink. */
  update(dt: number, time: number) {
    const p = this.p;
    if (!p.eyes.length) return;
    p.root.updateMatrixWorld(true);

    // blink: a quick squash of the eyeballs
    if (time >= this.nextBlink && this.blinkT < 0) this.blinkT = 0;
    let lid = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      lid = Math.max(0.08, Math.abs(1 - this.blinkT / 0.07));
      if (this.blinkT > 0.14) {
        this.blinkT = -1;
        this.nextBlink = time + 1.5 + this.rnd() * 4.5;
      }
    }

    p.eyes.forEach((e, k) => {
      if (this.hasTarget) {
        e.pivot.worldToLocal(_d.copy(this.target)).normalize();
      } else {
        _d.set(0, -0.05, 1); // forward, slightly down
      }
      // keep the pupil on the front of the eyeball
      const ang = Math.acos(THREE.MathUtils.clamp(_d.z, -1, 1));
      if (ang > MAX_ANGLE) {
        const k2 = Math.sin(MAX_ANGLE) / Math.max(1e-4, Math.hypot(_d.x, _d.y));
        _d.set(_d.x * k2, _d.y * k2, Math.cos(MAX_ANGLE));
      }
      const [sx, sy] = this.springs[k];
      let x = sx.update(dt, _d.x, PUPIL);
      let y = sy.update(dt, _d.y, PUPIL);
      const l = Math.hypot(x, y);
      const lim = Math.sin(MAX_ANGLE * 1.15); // springs may overshoot a bit — that's the googly bit
      if (l > lim) {
        x *= lim / l;
        y *= lim / l;
      }
      const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      e.pupil.position.set(x, y, z).multiplyScalar(e.r * 0.72);
      e.pupil.lookAt(e.pupil.position.clone().multiplyScalar(2).applyMatrix4(e.pivot.matrixWorld));
      e.pivot.scale.set(1, lid, 1);
    });
  }
}
