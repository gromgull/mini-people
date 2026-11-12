import * as THREE from 'three';

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _qShin = new THREE.Quaternion();

/**
 * Orientation whose local -Y points along `dir` and whose local +Z leans
 * toward `pole` (our limbs hang down -Y, and +Z is "front of the limb").
 */
export function aimDown(dir: THREE.Vector3, pole: THREE.Vector3, out: THREE.Quaternion) {
  _y.copy(dir).negate();
  _z.copy(pole).addScaledVector(_y, -pole.dot(_y));
  if (_z.lengthSq() < 1e-10) _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
  _z.normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

/**
 * Analytic two-bone IK in the *parent space of the upper joint*.
 *   root:   upper joint position (hip/shoulder) in parent space
 *   target: desired end position (ankle/wrist) in parent space
 *   pole:   direction the middle joint (knee/elbow) should point
 * Writes local quaternions for the upper and middle joints. Bones are assumed
 * to point down -Y in rest pose with no rest rotation.
 */
export function twoBoneIK(
  root: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  l1: number,
  l2: number,
  outUpper: THREE.Quaternion,
  outMiddle: THREE.Quaternion,
) {
  _d.subVectors(target, root);
  const dist = THREE.MathUtils.clamp(_d.length(), Math.abs(l1 - l2) + 1e-4, (l1 + l2) * 0.9999);
  _d.normalize();
  // pole projected onto the plane perpendicular to the reach direction
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-10) _p.set(0, 0, 1);
  _p.normalize();

  const cosA = THREE.MathUtils.clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  // upper bone direction, bent toward the pole
  _a.copy(_d).multiplyScalar(cosA).addScaledVector(_p, sinA);
  // lower bone direction: from the middle joint to the (clamped) end point
  _b.copy(_d).multiplyScalar(dist).addScaledVector(_a, -l1).normalize();

  aimDown(_a, _p, outUpper);
  aimDown(_b, _p, _qShin);
  outMiddle.copy(outUpper).invert().multiply(_qShin);
}

/** Orientation with local +Y along `y` and local +X as close to `xHint` as possible. */
export function frameYX(y: THREE.Vector3, xHint: THREE.Vector3, out: THREE.Quaternion) {
  _y.copy(y).normalize();
  _x.copy(xHint).addScaledVector(_y, -xHint.dot(_y));
  if (_x.lengthSq() < 1e-10) _x.set(1, 0, 0).addScaledVector(_y, -_y.x);
  _x.normalize();
  _z.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

/** Orientation with local +Z along `z` and local +Y as close to `yHint` as possible. */
export function frameZY(z: THREE.Vector3, yHint: THREE.Vector3, out: THREE.Quaternion) {
  _z.copy(z).normalize();
  _y.copy(yHint).addScaledVector(_z, -yHint.dot(_z));
  if (_y.lengthSq() < 1e-10) _y.set(0, 1, 0).addScaledVector(_z, -_z.y);
  _y.normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}
