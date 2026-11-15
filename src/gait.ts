import * as THREE from 'three';
import type { Person } from './body';
import { twoBoneIK } from './ik';

/** How straight a standing leg is: hip to ankle, × the leg's full length (seat.ts sits from this height too). */
export const LEG_REACH = 0.997;

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
  time: number; // seconds alive, for idle/noise
  lockPhase: boolean; // freeze the stride (e.g. airborne)
}

export const newMotion = (phase = 0): Motion => ({ phase, speed: 0, targetSpeed: 0, time: phase * 100, lockPhase: false });

/** Whole-body influences computed by the animator (already spring-smoothed). */
export interface BodyExtras {
  turnLean: number; // rad, + leans toward local -X (into a right-hand turn)
  shiftX: number; // idle weight shift, × hip width (+ = onto left foot)
  crouch: number; // extra pelvis drop, × leg length (feet stay planted)
  sitZ: number; // pelvis pushed back (world units) for sitting; feet stay put
}

/** Upper-body *targets* from the gait; the animator layers & springs them. */
export interface UpperTargets {
  w: number; // walk weight 0..1.3
  spineX: number;
  spineY: number;
  spineZ: number;
  headX: number;
  headY: number;
  headZ: number;
  shoulderLX: number;
  shoulderRX: number;
  elbowL: number; // extra bend from swing
  elbowR: number;
}
const upper: UpperTargets = {
  w: 0, spineX: 0, spineY: 0, spineZ: 0, headX: 0, headY: 0, headZ: 0,
  shoulderLX: 0, shoulderRX: 0, elbowL: 0, elbowR: 0,
};

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
  m.time += dt;
  m.speed += (m.targetSpeed - m.speed) * (1 - Math.exp(-dt * 4));
  if (m.speed < 1e-4 || m.lockPhase) return;
  m.phase = (m.phase + (m.speed * dt) / cycleLength(p, g, m.speed)) % 1;
}

/**
 * Pose a person from their motion state. Everything is in the root's local
 * frame (root faces +Z, moves along +Z), so world placement is the caller's job.
 */
export function applyGait(p: Person, m: Motion, g: GaitParams, x: BodyExtras): UpperTargets {
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
  // lean into turns from the ankles: shift the pelvis sideways, then roll it
  const swayX = d.hipJointX * (g.sway * w * lStance + x.shiftX) - Math.sin(x.turnLean) * d.legLen * 0.6;
  const yaw = -g.hipYaw * w * Math.cos(TAU * ph); // left hip forward at left heel strike
  const roll = g.hipRoll * w * lStance + x.turnLean * 0.5 - x.shiftX * 0.08; // swing side drops

  // Inverted pendulum, solved rather than faked: the pelvis rides as high as it
  // can while both feet stay reachable with a near-straight leg. Bob falls out
  // of the stride geometry. (Knee bend is very sensitive near full extension:
  // 0.985·L already bends the knee ~20°, so we aim for 0.997·L.)
  const reach = L * LEG_REACH;
  let pelvisY = Infinity;
  for (const f of feet) {
    const hx = f.s * d.hipJointX * Math.cos(yaw) + swayX;
    const hz = -f.s * d.hipJointX * Math.sin(yaw);
    const h2 = reach * reach - (f.x - hx) ** 2 - (f.z - hz) ** 2;
    pelvisY = Math.min(pelvisY, ankleH + f.y + Math.sqrt(Math.max(0, h2)));
  }
  // optional extra springiness on top, lowest around heel strike
  const vault = 0.5 * (1 - Math.cos(2 * TAU * (ph - mid)));
  pelvisY -= d.legLen * (g.crouch + g.bounce * w * vault + x.crouch);

  J.pelvis.position.set(swayX, pelvisY, -x.sitZ);
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

  // --- upper body targets (posed by the animator) ----------------------------
  const spineYaw = -yaw * (1 + g.shoulderTwist); // net chest rotation opposes pelvis
  upper.w = w;
  upper.spineX = g.lean * w + 0.02;
  upper.spineY = spineYaw;
  upper.spineZ = -roll * 0.6 + x.turnLean * 0.5;
  upper.headX = 0.05 - g.lean * w * 0.6;
  upper.headY = -(yaw + spineYaw) * 0.7;
  upper.headZ = roll * 0.3 - x.turnLean * 0.6;
  const a = g.armSwing * w;
  const swingL = Math.cos(TAU * (ph - 0.5)); // +1 = left arm fully forward
  const swingR = Math.cos(TAU * ph);
  upper.shoulderLX = -a * swingL * 0.9 - a * 0.12; // slight forward bias (−X = forward)
  upper.shoulderRX = -a * swingR * 0.9 - a * 0.12; // slight forward bias (−X = forward)
  upper.elbowL = a * 0.5 * Math.max(0, swingL) + a * 0.15;
  upper.elbowR = a * 0.5 * Math.max(0, swingR) + a * 0.15;
  return upper;
}
