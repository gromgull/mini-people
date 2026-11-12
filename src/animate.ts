import type { Person } from './body';
import { type Motion, type BodyExtras, applyGait } from './gait';
import type { Style } from './persona';
import type { ActionPose } from './actions';
import type { LookHint } from './gaze';
import { Spring, type SpringParams } from './springs';
import { mulberry32 } from './rng';

const TAU = Math.PI * 2;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Each channel follows the base spring with its own frequency scale. */
const CHANNELS = {
  turnLean: 0.6,
  accelLean: 0.7,
  shiftX: 0.25,
  spineX: 1.0,
  spineY: 1.1,
  spineZ: 0.9,
  neckX: 0.9,
  headX: 1.2,
  headY: 1.0,
  headZ: 1.1,
  shLX: 0.8,
  shRX: 0.8,
  shLZ: 0.7,
  shRZ: 0.7,
  elL: 0.65,
  elR: 0.65,
} as const;

// ponytail: a loose pendulum, independent of personality
const TAIL: SpringParams = { f: 1.6, z: 0.22, r: 0 };
type Channel = keyof typeof CHANNELS;

/**
 * Layered procedural animation for one person:
 *   gait (legs IK + upper-body targets)
 *   + personality offsets (posture, elbows, arm spread, asymmetry)
 *   + inertia (turn & acceleration lean, head nod / arm bounce from pelvis bob)
 *   + noise (fidget, wobble) and idle (breathing, weight shift, glances)
 *   → second-order springs per channel → joint rotations.
 */
export class Animator {
  private springs = {} as Record<Channel, Spring>;
  private tailX = new Spring();
  private tailZ = new Spring();
  private seeds: number[];
  private prevHeading: number | null = null;
  private prevSpeed = 0;
  private prevPelvisY: number | null = null;
  private pelvisVel = 0;
  private pelvisAcc = 0;
  private extras: BodyExtras = { turnLean: 0, shiftX: 0, crouch: 0 };
  private sp: SpringParams = { f: 1, z: 1, r: 0 };

  constructor(seed: number) {
    for (const k of Object.keys(CHANNELS) as Channel[]) this.springs[k] = new Spring();
    const r = mulberry32(seed);
    this.seeds = Array.from({ length: 24 }, () => r() * 100);
  }

  /** Smooth pseudo-noise in about -1..1, one independent stream per index. */
  private noise(i: number, t: number, rate = 1) {
    const s = this.seeds;
    const u = t * rate;
    return (
      Math.sin(u * 1.13 + s[i]) * 0.5 + Math.sin(u * 2.31 + s[i + 1] * 1.7) * 0.32 + Math.sin(u * 4.77 + s[i] * 2.3) * 0.18
    );
  }

  private spring(ch: Channel, dt: number, x: number, base: SpringParams, stiff = 1) {
    this.sp.f = base.f * CHANNELS[ch] * stiff;
    this.sp.z = base.z;
    this.sp.r = base.r;
    return this.springs[ch].update(dt, x, this.sp);
  }

  update(dt: number, p: Person, m: Motion, st: Style, heading: number, act: ActionPose | null = null, look: LookHint | null = null) {
    const J = p.joints;
    const d = p.dims;
    const sp = st.spring;
    const t = m.time;

    // --- inertia inputs ------------------------------------------------------
    const yawRate = this.prevHeading === null || dt <= 0 ? 0 : wrap(heading - this.prevHeading) / dt;
    const accel = dt > 0 ? (m.speed - this.prevSpeed) / dt : 0;
    this.prevHeading = heading;
    this.prevSpeed = m.speed;

    const idleK = clamp(1 - m.speed / 0.15, 0, 1) * st.idle; // only when (nearly) standing
    // lateral acceleration v·ω leans the body into the turn; yawRate < 0 turns toward -X
    const turnTarget = clamp(-m.speed * yawRate * st.turnLean, -0.5, 0.5);
    this.extras.turnLean = this.spring('turnLean', dt, turnTarget, sp);
    const shiftTarget = idleK * (0.6 * this.noise(0, t, 0.35) + 0.25 * Math.sign(this.noise(2, t, 0.12)));
    this.extras.shiftX = this.spring('shiftX', dt, shiftTarget, sp);
    const accelLean = this.spring('accelLean', dt, clamp(accel * 0.25, -0.35, 0.35), sp);
    this.extras.crouch = act?.crouch ?? 0;

    // --- gait: legs are posed now, upper body comes back as targets --------
    const u = applyGait(p, m, st.gait, this.extras);

    // pelvis vertical acceleration → head nod and arm bounce
    const py = J.pelvis.position.y;
    if (this.prevPelvisY !== null && dt > 0) {
      const v = (py - this.prevPelvisY) / dt;
      this.pelvisAcc = clamp((v - this.pelvisVel) / dt, -40, 40);
      this.pelvisVel = v;
    }
    this.prevPelvisY = py;
    const bobK = this.pelvisAcc / Math.max(0.2, d.legLen) * 0.0012;

    // --- personality + noise layers -----------------------------------------
    const P = st.posture; // -1 slouch … +1 proud
    const nz = st.noise;
    const breathe = Math.sin(t * TAU * 0.28) * 0.025 * (0.4 + idleK);
    const glance = idleK * (0.55 * this.noise(4, t, 0.5) + 0.35 * Math.sign(this.noise(6, t, 0.2)) * Math.abs(this.noise(8, t, 0.3)));

    const spineX = (act?.spineX ?? 0) + u.spineX - 0.14 * P + accelLean + breathe + nz * 0.04 * this.noise(10, t, 2.1);
    const spineY = (look?.yaw ?? 0) * 0.3 + u.spineY + nz * 0.08 * this.noise(12, t, 1.4) + glance * 0.25;
    const spineZ = u.spineZ + nz * 0.07 * this.noise(14, t, 1.7);
    const neckX = 0.28 * Math.max(0, -P) - 0.04 * Math.max(0, P); // slouch: head juts forward
    const headX = (act?.headX ?? 0) + (look?.pitch ?? 0) + u.headX - 0.24 * Math.max(0, -P) - 0.06 * Math.max(0, P) - accelLean * 0.6 - bobK + nz * 0.08 * this.noise(16, t, 2.6);
    const headY = (act?.headY ?? 0) + (look?.yaw ?? 0) * 0.7 + u.headY + glance * 0.7 + nz * 0.15 * this.noise(18, t, 1.2);
    const headZ = (act?.headZ ?? 0) + u.headZ + nz * 0.12 * this.noise(20, t, 1.9);

    const asymL = 1 + st.asym;
    const asymR = 1 - st.asym;
    const armFwd = 0.12 * P - 0.18 * Math.max(0, -P); // slouch rounds the shoulders
    let shLX = u.shoulderLX * asymL + armFwd + nz * 0.1 * this.noise(3, t, 2.2);
    let shRX = u.shoulderRX * asymR + armFwd + nz * 0.1 * this.noise(5, t, 2.4);
    const spread = d.armOut + st.armOut + bobK * 0.4 + idleK * 0.03 * breathe;
    let spL = spread;
    let spR = spread;
    let elL = 0.14 + st.elbow + u.elbowL * asymL + bobK * 0.5;
    let elR = 0.14 + st.elbow + u.elbowR * asymR + bobK * 0.5;

    // action arm overrides blend in *before* the springs, so they inherit personality
    let stL = 1;
    let stR = 1;
    if (act) {
      const L = act.arms.L;
      const R = act.arms.R;
      shLX += (L.x - shLX) * L.w; spL += (L.z - spL) * L.w; elL += (L.elbow - elL) * L.w; stL += (L.stiff - 1) * L.w;
      shRX += (R.x - shRX) * R.w; spR += (R.z - spR) * R.w; elR += (R.elbow - elR) * R.w; stR += (R.stiff - 1) * R.w;
    }

    // --- springs → joints ---------------------------------------------------
    J.spine.rotation.set(
      this.spring('spineX', dt, spineX, sp),
      this.spring('spineY', dt, spineY, sp),
      this.spring('spineZ', dt, spineZ, sp),
      'YXZ',
    );
    J.neck.rotation.set(this.spring('neckX', dt, neckX, sp), 0, 0);
    J.head.rotation.set(
      this.spring('headX', dt, headX, sp),
      this.spring('headY', dt, headY, sp),
      this.spring('headZ', dt, headZ, sp),
      'YXZ',
    );
    J.shoulderL.rotation.set(this.spring('shLX', dt, shLX, sp, stL), 0, this.spring('shLZ', dt, spL, sp, stL), 'ZYX');
    J.shoulderR.rotation.set(this.spring('shRX', dt, shRX, sp, stR), 0, -this.spring('shRZ', dt, spR, sp, stR), 'ZYX');
    J.elbowL.rotation.set(-Math.max(0, this.spring('elL', dt, elL, sp, stL)), 0, 0);
    J.elbowR.rotation.set(-Math.max(0, this.spring('elR', dt, elR, sp, stR)), 0, 0);

    // ponytail hangs toward world-down, lags behind head motion and bounces
    // with the pelvis; the low-damped spring supplies the swing
    if (p.tail) {
      const tilt = J.spine.rotation.x + J.neck.rotation.x + J.head.rotation.x;
      const roll = J.spine.rotation.z + J.head.rotation.z;
      const tx = -tilt + 0.25 + accelLean * 1.2 + clamp(this.pelvisAcc * 0.004, -0.3, 0.3);
      const tz = -roll - this.extras.turnLean * 1.5 + J.head.rotation.y * 0.3;
      p.tail.rotation.set(clamp(this.tailX.update(dt, tx, TAIL), -0.6, 1.4), 0, clamp(this.tailZ.update(dt, tz, TAIL), -0.9, 0.9));
    }
  }
}
