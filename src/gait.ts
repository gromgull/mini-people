import * as THREE from 'three';
import type { Person } from './body';
import { twoBoneIK } from './ik';

/** Global walk tuning (milestone 3 will layer personality on top of this). */
export interface GaitParams {
  stride: number; // cycle length as a multiple of leg length
  duty: number; // fraction of the cycle a foot is on the ground
  stepHeight: number; // foot lift, × leg length
  bounce: number; // extra pelvis dip at heel strike, × leg length (on top of the natural vault)
  sway: number; // pelvis side shift, × hip width
  hipYaw: number; // pelvis twist (rad)
  hipRoll: number; // pelvis drop on the swing side (rad)
  shoulderTwist: number; // counter-rotation of chest vs pelvis
  armSwing: number; // rad
  lean: number; // forward lean at full speed (rad)
  crouch: number; // constant knee bend, × leg length
  stance: number; // foot spacing, × hip width
  footRoll: number; // heel/toe pitch (rad)
}

export const defaultGait: GaitParams = {
  stride: 1.45,
  duty: 0.58,
  stepHeight: 0.14,
  bounce: 0.01,
  sway: 0.35,
  hipYaw: 0.18,
  hipRoll: 0.07,
  shoulderTwist: 1.4,
  armSwing: 0.55,
  lean: 0.12,
  crouch: 0.008,
  stance: 1.0,
  footRoll: 0.35,
};

/** Per-person runtime motion state. */
export interface Motion {
  phase: number; // 0..1 gait cycle; left heel strikes at 0, right at 0.5
  speed: number; // current ground speed (units/s), smoothed
  targetSpeed: number;
}

export const newMotion = (phase = 0): Motion => ({ phase, speed: 0, targetSpeed: 0 });

/** Reference speed the gait is tuned for; amplitudes scale with speed / this. */
export const WALK_SPEED = 0.55;

const TAU = Math.PI * 2;
const smooth = (t: number) => t * t * (3 - 2 * t);

const _euler = new THREE.Euler();
const _qPelvis = new THREE.Quaternion();
const _pelvisInv = new THREE.Matrix4();
const _target = new THREE.Vector3();
const _hip = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _qFoot = new THREE.Quaternion();
const _qChain = new THREE.Quaternion();

/** Cycle length (distance travelled per full two-step cycle) at a given speed. */
export function cycleLength(p: Person, g: GaitParams, speed: number) {
  // stride shortens at low speed so cadence never goes to zero abruptly
  const w = Math.min(1.4, speed / WALK_SPEED);
  return Math.max(1e-3, p.dims.legLen * g.stride * Math.sqrt(w));
}

/** Advance the phase so feet stay planted for the distance travelled. */
export function advance(m: Motion, p: Person, g: GaitParams, dt: number) {
  m.speed += (m.targetSpeed - m.speed) * (1 - Math.exp(-dt * 4));
  if (m.speed < 1e-4) return;
  m.phase = (m.phase + (m.speed * dt) / cycleLength(p, g, m.speed)) % 1;
}

/**
 * Pose a person from their motion state. Everything is in the root's local
 * frame (root faces +Z, moves along +Z), so world placement is the caller's job.
 */
export function applyGait(p: Person, m: Motion, g: GaitParams) {
  const d = p.dims;
  const J = p.joints;
  const w = Math.min(1.3, m.speed / WALK_SPEED); // 0 = standing, 1 = normal walk
  const ph = m.phase;
  const C = cycleLength(p, g, m.speed) * Math.min(1, w * 4); // collapse to 0 when standing
  const D = g.duty * C; // distance a planted foot travels backward
  const L = d.thighLen + d.shinLen;
  const ankleH = d.footH;

  // --- foot targets (root space) --------------------------------------------
  const feet = [
    { side: 'L' as const, s: 1, off: 0, x: 0, y: 0, z: 0, pitch: 0 },
    { side: 'R' as const, s: -1, off: 0.5, x: 0, y: 0, z: 0, pitch: 0 },
  ];
  for (const f of feet) {
    const lp = (ph + 1 - f.off) % 1; // this leg's local phase, 0 = heel strike
    if (lp < g.duty) {
      const t = lp / g.duty;
      f.z = D * (0.5 - t);
      f.y = 0;
      // toes-up just after heel strike, heel-off near the end of stance
      f.pitch = -g.footRoll * w * 0.5 * Math.max(0, 1 - t * 6) + g.footRoll * w * smooth(Math.max(0, (t - 0.75) / 0.25));
    } else {
      const t = (lp - g.duty) / (1 - g.duty);
      f.z = D * (smooth(t) - 0.5);
      f.y = Math.sin(Math.PI * t) * d.legLen * g.stepHeight * Math.min(1, w);
      f.pitch = g.footRoll * w * (1 - smooth(t)) * 0.8 - g.footRoll * w * 0.5 * smooth(Math.max(0, (t - 0.6) / 0.4));
    }
    f.x = f.s * d.hipJointX * g.stance;
  }

  // --- pelvis -------------------------------------------------------------
  const mid = g.duty / 2;
  const lStance = Math.cos(TAU * (ph - mid)); // +1 when left foot is mid-stance
  const swayX = d.hipJointX * g.sway * w * lStance;
  const yaw = -g.hipYaw * w * Math.cos(TAU * ph); // left hip forward at left heel strike
  const roll = g.hipRoll * w * lStance; // swing side drops

  // Inverted pendulum, solved rather than faked: the pelvis rides as high as it
  // can while both feet stay reachable with a near-straight leg. Bob falls out
  // of the stride geometry. (Knee bend is very sensitive near full extension:
  // 0.985·L already bends the knee ~20°, so we aim for 0.997·L.)
  const reach = L * 0.997;
  let pelvisY = Infinity;
  for (const f of feet) {
    const hx = f.s * d.hipJointX * Math.cos(yaw) + swayX;
    const hz = -f.s * d.hipJointX * Math.sin(yaw);
    const h2 = reach * reach - (f.x - hx) ** 2 - (f.z - hz) ** 2;
    pelvisY = Math.min(pelvisY, ankleH + f.y + Math.sqrt(Math.max(0, h2)));
  }
  // optional extra springiness on top, lowest around heel strike
  const vault = 0.5 * (1 - Math.cos(2 * TAU * (ph - mid)));
  pelvisY -= d.legLen * (g.crouch + g.bounce * w * vault);

  J.pelvis.position.set(swayX, pelvisY, 0);
  J.pelvis.quaternion.setFromEuler(_euler.set(0, yaw, roll, 'YXZ'));
  J.pelvis.updateMatrix();
  _pelvisInv.copy(J.pelvis.matrix).invert();
  _qPelvis.copy(J.pelvis.quaternion);

  // --- legs (IK) ------------------------------------------------------------
  for (const f of feet) {
    const hip = J[`hip${f.side}`];
    const knee = J[`knee${f.side}`];
    _target.set(f.x, ankleH + f.y, f.z).applyMatrix4(_pelvisInv);
    _hip.copy(hip.position);
    _pole.set(f.s * 0.15, 0, 1); // knees forward, slightly out
    twoBoneIK(_hip, _target, _pole, d.thighLen, d.shinLen, hip.quaternion, knee.quaternion);

    // foot orientation in root space = pitch only; undo the chain above it
    _qFoot.setFromEuler(_euler.set(f.pitch, 0, 0));
    _qChain.copy(_qPelvis).multiply(hip.quaternion).multiply(knee.quaternion).invert();
    J[`ankle${f.side}`].quaternion.copy(_qChain).multiply(_qFoot);
  }

  // --- trunk & head ---------------------------------------------------------
  const spineYaw = -yaw * (1 + g.shoulderTwist); // net chest rotation opposes pelvis
  J.spine.rotation.set(g.lean * w + 0.02, spineYaw, -roll * 0.6, 'YXZ');
  J.head.rotation.set(0.05 - g.lean * w * 0.6, -(yaw + spineYaw) * 0.7, roll * 0.3, 'YXZ');

  // --- arms (FK swing, opposite to the legs) ---------------------------------
  for (const [side, off] of [['L', 0.5], ['R', 0]] as const) {
    const s = side === 'L' ? 1 : -1;
    const swing = Math.cos(TAU * (ph - off)); // +1 = this arm fully forward
    const a = g.armSwing * w;
    J[`shoulder${side}`].rotation.set(-a * swing * 0.9 + a * 0.15, 0, s * d.armOut, 'ZYX');
    J[`elbow${side}`].rotation.set(-0.22 - a * 0.5 * Math.max(0, swing) - a * 0.15, 0, 0);
  }
}
