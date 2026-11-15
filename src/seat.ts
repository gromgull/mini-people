import type { BodyDims } from './genome';
import { type ActionPose, smooth } from './actionkit';
import { LEG_REACH } from './gait';

/**
 * Sitting down, in one place: what seat fits a person, how far down they go
 * for a seat of any height, and the movement of lowering onto it (and
 * getting up again). Everything that sits uses these: a conjured bench
 * (the 'sit' action, and sitting through other actions), the village's
 * benches (built to a reference sitter's fit), and a meal at a table
 * (conjured or the inn's).
 *
 * The body sits by two pose numbers, layered onto the gait (gait.ts): the
 * pelvis goes back by `sitZ` with the feet left where they are, and down
 * by `crouch` (× leg length), the legs solved to reach.
 */

/** A seat for a body of these dims. */
export interface SeatFit {
  /** Seat height: just under the knee. */
  h: number;
  /** How far back the hips go to sit (the thighs then lie along the seat). */
  z: number;
  /** How far down the hips go, × leg length. */
  crouch: number;
  /** Where the bench's middle is, ahead of their feet (root frame: negative, it's behind). */
  benchZ: number;
  /** The bench's depth, front to back. */
  depth: number;
}

/** Hip height standing, as the gait stands them (legs very nearly straight). */
const standingHipY = (d: BodyDims) => d.footH + (d.thighLen + d.shinLen) * LEG_REACH;

/** How far down (× leg length) the hips go to sit on a seat this high (the hip joint sits a little above the seat). */
export function crouchFor(d: BodyDims, seatH: number) {
  return (standingHipY(d) - (seatH + d.hipBelow * 0.9)) / d.legLen;
}

/** The seat that fits this body: knee height, far enough behind the feet that the thighs lie on it. */
export function seatFit(d: BodyDims): SeatFit {
  const h = d.footH + d.shinLen * 0.92;
  const z = d.thighLen * 0.85;
  return { h, z, crouch: crouchFor(d, h), benchZ: -z - d.thighLen * 0.05, depth: d.thighLen * 1.1 };
}

/** How long sitting down and getting up take (s) at this tempo, and when the seat creaks on the way down (× the time down). */
export function sitTimes(tempo: number) {
  const slow = 1 / Math.sqrt(tempo);
  return { down: 0.9 * slow, up: 0.8 * slow, creak: 0.85 };
}

/** Hands on the thighs, pushing off them while moving: arm angles (see setArm). */
export const thighRest = (moving: number) => ({ x: -0.12 - 0.3 * moving, z: 0.14, elbow: 1.0 });

/**
 * Lower onto a seat (k: 0 standing → 1 sat; back again to get up): the hips
 * go back first, then down, leaning forward to balance on the way and
 * sitting up at the end. Sets sitZ, adds to crouch, spineX and headX.
 * Returns how much they're on the move (0 at either end, 1 halfway), for
 * the arms to push off the thighs by.
 */
export function lowerOnto(P: ActionPose, seat: { z: number; crouch: number }, k: number) {
  const moving = k > 0 && k < 1 ? Math.sin(Math.PI * k) : 0;
  P.sitZ = seat.z * smooth(Math.min(1, k * 1.6));
  P.crouch += seat.crouch * smooth(Math.max(0, (k - 0.15) / 0.85));
  P.spineX += 0.45 * moving - 0.04 * k;
  P.headX -= 0.2 * moving;
  return moving;
}
