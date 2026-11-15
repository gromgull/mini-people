import * as THREE from 'three';
import type { Person } from './body';
import { twoBoneIK } from './ik';

/** Shared bits for actions: pose types, easing, and prop meshes. */

/** Arm override blended into the animator's targets *before* the springs. */
export interface ArmOverride {
  w: number; // blend weight 0..1
  x: number; // shoulder pitch (−forward)
  z: number; // shoulder abduction (positive = away from body, either side)
  elbow: number; // elbow bend
  stiff: number; // spring frequency multiplier while overriding (crisp strikes)
}

/** What an action asks of the animator this frame. */
export interface ActionPose {
  crouch: number; // × leg length
  sitZ: number; // pelvis pushed back for sitting
  lift: number; // root height (jumps)
  spineX: number;
  headX: number;
  headY: number;
  headZ: number;
  spineY: number; // chest twist
  spineZ: number; // side bend
  spin: number; // extra facing (rad) on top of wherever the person faces
  fwd: number; // root slid forward along the facing (shuffling up to a table)
  arms: { L: ArmOverride; R: ArmOverride };
}

export interface PropKit {
  toon: THREE.Material;
  outline: THREE.Material;
}

export const arm = (): ArmOverride => ({ w: 0, x: 0, z: 0, elbow: 0, stiff: 1 });
export const smooth = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 0→1→0 envelope with ease-in/out at the ends of [0, dur]. */
export const envelope = (t: number, dur: number, tin: number, tout: number) => smooth(t / tin) * smooth((dur - t) / tout);

/** A toon mesh with its outline hull. */
export function mesh(geo: THREE.BufferGeometry, kit: PropKit) {
  const m = new THREE.Mesh(geo, kit.toon);
  const o = new THREE.Mesh(geo, kit.outline);
  o.raycast = () => {};
  m.add(o);
  return m;
}

export type ArmAngles = { x: number; z: number; elbow: number };

/**
 * Pose the upper body with plain FK (no springs), run `fn` (to read where a
 * hand or prop ends up), then put every joint back. Used to fit conjured props
 * to the pose an action is about to strike.
 */
export function withFK<T>(p: Person, pose: { spineX?: number; spineY?: number; R?: ArmAngles; L?: ArmAngles }, fn: () => T): T {
  const J = p.joints;
  const joints = [J.spine, J.shoulderL, J.shoulderR, J.elbowL, J.elbowR];
  const saved = joints.map((j) => j.quaternion.clone());
  J.spine.rotation.set(pose.spineX ?? 0, pose.spineY ?? 0, 0, 'YXZ');
  if (pose.R) {
    J.shoulderR.rotation.set(pose.R.x, 0, -pose.R.z, 'ZYX');
    J.elbowR.rotation.set(-pose.R.elbow, 0, 0);
  }
  if (pose.L) {
    J.shoulderL.rotation.set(pose.L.x, 0, pose.L.z, 'ZYX');
    J.elbowL.rotation.set(-pose.L.elbow, 0, 0);
  }
  p.root.updateMatrixWorld(true);
  const out = fn();
  joints.forEach((j, i) => j.quaternion.copy(saved[i]));
  p.root.updateMatrixWorld(true);
  return out;
}

/** A point in some object's frame, expressed in the person's root frame. */
export function inRoot(p: Person, obj: THREE.Object3D, local: THREE.Vector3, out = new THREE.Vector3()) {
  return p.root.worldToLocal(obj.localToWorld(out.copy(local)));
}

const _t = new THREE.Vector3();
const _u = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _qU = new THREE.Quaternion();
const _qM = new THREE.Quaternion();

/**
 * Solve one arm (after the animator) so its fist, the hand ball, sits at
 * `fist` (root frame), blended in by w. Elbows point out, down and a little
 * back unless `pole` (spine frame) says otherwise.
 */
export function reachFist(p: Person, side: 'L' | 'R', fist: THREE.Vector3, w: number, pole?: THREE.Vector3) {
  if (w <= 1e-3) return;
  const J = p.joints;
  const d = p.dims;
  const sh = side === 'R' ? J.shoulderR : J.shoulderL;
  const el = side === 'R' ? J.elbowR : J.elbowL;
  const tgt = J.spine.worldToLocal(p.root.localToWorld(_t.copy(fist)));
  const dir = _u.subVectors(tgt, sh.position).normalize();
  tgt.addScaledVector(dir, -d.handR * 0.7); // the hand ball hangs past the wrist
  if (pole) _pole.copy(pole);
  else _pole.set(side === 'R' ? -0.75 : 0.75, -1, -0.35);
  twoBoneIK(sh.position, tgt, _pole, d.upperArmLen, d.foreArmLen, _qU, _qM);
  sh.quaternion.slerp(_qU, w);
  el.quaternion.slerp(_qM, w);
  sh.updateMatrixWorld(true); // just this arm (the spine it hangs from is current: it was read above)
}
