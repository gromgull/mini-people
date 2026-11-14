import * as THREE from 'three';
import { ROWS } from '../palette';
import type { Stage } from '../stage';
import { type Part, bake } from '../trees';

/**
 * The things the woodcutting chain moves around: logs, the woodpile they
 * wait on, and the sawhorse they're cut on. Each log is a real object with an
 * id and a place (on the ground, carried by someone, in the pile, on the
 * sawhorse), so the village can check none are lost or duplicated.
 */

export const LOG_R = 0.065;
export const LOG_L = 0.8;

export type LogPlace = { at: 'ground'; x: number; z: number; yaw: number } | { at: 'carried'; by: number } | { at: 'pile'; slot: number } | { at: 'horse' };

export interface Log {
  id: number;
  place: LogPlace;
  mesh: THREE.Object3D;
  /** Someone's on their way to pick it up (−1 = nobody). */
  claimedBy: number;
}

let logGeo: { flat: THREE.BufferGeometry; smooth: THREE.BufferGeometry } | null = null;
/** A short pine log along x, bark with pale cut ends. */
function logGeometry() {
  if (logGeo) return logGeo;
  const parts: Part[] = [{ geo: new THREE.CylinderGeometry(LOG_R, LOG_R, LOG_L, 7).rotateZ(Math.PI / 2), row: ROWS.bark[0] }];
  for (const e of [-1, 1]) parts.push({ geo: new THREE.CylinderGeometry(LOG_R * 0.82, LOG_R * 0.82, 0.006, 7).rotateZ(Math.PI / 2).translate((e * LOG_L) / 2, 0, 0), row: ROWS.food[0] });
  logGeo = bake(parts);
  return logGeo;
}

function outlined(g: { flat: THREE.BufferGeometry; smooth: THREE.BufferGeometry }, stage: Stage) {
  const m = new THREE.Mesh(g.flat, stage.toon);
  const o = new THREE.Mesh(g.smooth, stage.outline);
  m.raycast = o.raycast = () => {};
  m.add(o);
  return m;
}

/** Logs stacked in a little pyramid between two stakes, along the pile's x. */
export class Woodpile {
  readonly group = new THREE.Group();
  readonly slots: THREE.Vector3[] = [];
  readonly logs: (Log | null)[];
  /** Logs promised to the pile (on their way). */
  incoming = 0;

  constructor(stage: Stage, readonly x: number, readonly z: number, readonly yaw: number) {
    const d = LOG_R * 2.05;
    for (const [row, n] of [[0, 3], [1, 2], [2, 1]]) {
      for (let i = 0; i < n; i++) this.slots.push(new THREE.Vector3(0, LOG_R + row * d * 0.86, (i - (n - 1) / 2) * d));
    }
    this.logs = this.slots.map(() => null);
    // a couple of stakes and two bearers keep it off the ground
    const parts: Part[] = [];
    for (const sx of [-1, 1]) {
      parts.push({ geo: new THREE.BoxGeometry(0.05, 0.03, 4 * d).translate(sx * LOG_L * 0.3, 0.015, 0), row: ROWS.log[1] });
      for (const sz of [-1, 1]) parts.push({ geo: new THREE.BoxGeometry(0.035, 0.42, 0.035).translate(sx * LOG_L * 0.3, 0.21, sz * 1.7 * d), row: ROWS.log[0] });
    }
    for (const s of this.slots) s.y += 0.03;
    this.group.add(outlined(bake(parts), stage));
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
    stage.scene.add(this.group);
  }

  get count() {
    return this.logs.filter(Boolean).length;
  }

  /** The first free slot, bottom up. */
  freeSlot() {
    return this.logs.findIndex((l) => !l);
  }

  /** The topmost log (taken first). */
  topSlot() {
    for (let i = this.logs.length - 1; i >= 0; i--) if (this.logs[i]) return i;
    return -1;
  }

  /** Where slot i is, in the world. */
  slotWorld(i: number, out = new THREE.Vector3()) {
    this.group.updateMatrixWorld();
    return out.copy(this.slots[i]).applyMatrix4(this.group.matrixWorld);
  }

  /** Stand here (and face the pile) to put a log on it or take one off; `along` shifts it along the pile. */
  workSpot(out = new THREE.Vector3(), along = 0) {
    // in front of the pile's long side
    return out.set(this.x, 0, this.z).add(new THREE.Vector3(along, 0, 0.62).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw));
  }
}

/**
 * A sawhorse: two X trestles carrying a log at the height of its owner's
 * saw stroke (see Actor.sawFit), and a spot where they stand to saw.
 */
export class Sawhorse {
  readonly group = new THREE.Group();
  log: Log | null = null;
  claimedBy = -1;
  /** Where the log lies (world), and its yaw (along the horse). */
  readonly logAt = new THREE.Vector3();

  constructor(
    stage: Stage,
    readonly x: number,
    readonly z: number,
    readonly yaw: number,
    /** From Actor.sawFit for the owner: the cut point (owner's root frame), log centre height and radius, trestle spots. */
    readonly fit: { cut: THREE.Vector3; y: number; r: number; len: number; trestles: { x: number; h: number }[] },
  ) {
    const parts: Part[] = [];
    const top = fit.y - fit.r * 0.6;
    for (const t of fit.trestles) {
      // an X of two legs across the log, and a short top bar
      for (const s of [-1, 1]) {
        const leg = new THREE.BoxGeometry(0.035, Math.hypot(top, 0.36) + 0.06, 0.045);
        leg.rotateX(s * Math.atan2(0.18, top)).translate(t.x, top / 2, 0);
        parts.push({ geo: leg, row: ROWS.log[2] });
      }
      parts.push({ geo: new THREE.BoxGeometry(0.06, 0.04, 0.16).translate(t.x, top - 0.01, 0), row: ROWS.log[1] });
    }
    parts.push({ geo: new THREE.BoxGeometry(fit.trestles[0].x - fit.trestles[1].x, 0.03, 0.03).translate((fit.trestles[0].x + fit.trestles[1].x) / 2, top * 0.35, 0), row: ROWS.log[1] });
    this.group.add(outlined(bake(parts), stage));
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
    stage.scene.add(this.group);
    // the log's middle sits between the trestles; the cut is fit.len·0.6… from it
    this.logAt.set((fit.len * 1.45 - fit.len * 0.6) / 2, fit.y, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).add(new THREE.Vector3(x, 0, z));
  }

  /** Where the owner stands, and which way they face, to saw. */
  sawSpot() {
    const c = new THREE.Vector3(this.fit.cut.x, 0, this.fit.cut.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    return { x: this.x - c.x, z: this.z - c.z, yaw: this.yaw };
  }
}

/** Make a log mesh (added to the scene by the caller). */
export function makeLog(stage: Stage) {
  return outlined(logGeometry(), stage);
}
