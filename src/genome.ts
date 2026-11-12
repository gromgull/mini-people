import { PALETTE } from './palette';
import { type Persona, derivePersona } from './persona';
import { bell, clamp01, lerp, mulberry32, pickIndex } from './rng';

/**
 * A person's genome. Shape genes are normalized 0..1; colour genes are
 * palette indices. Everything else is derived from this.
 */
export interface Genome {
  // shape
  height: number;
  girth: number;
  belly: number;
  legs: number;
  arms: number;
  head: number;
  shoulders: number;
  neck: number;
  hands: number;
  feet: number;
  nose: number;
  eyeSize: number;
  // looks
  skin: number;
  hair: number;
  hairStyle: number; // 0 bald, 1 short, 2 long, 3 hat
  shirt: number;
  pants: number;
  shoes: number;
  longSleeves: boolean;
  shorts: boolean;
  // personality (drives animation, not geometry)
  persona: Persona;
}

export const SHAPE_GENES = [
  'height', 'girth', 'belly', 'legs', 'arms', 'head', 'shoulders', 'neck', 'hands', 'feet', 'nose', 'eyeSize',
] as const;

export const HAIR_STYLES = ['bald', 'short', 'long', 'hat'] as const;

export function randomGenome(seed: number): Genome {
  const r = mulberry32(seed);
  const height = bell(r);
  // a minority of stocky folks so the crowd has visible "types"
  const girth = r() < 0.18 ? lerp(0.7, 1, r()) : clamp01(bell(r) * 0.9);
  const g: Genome = {
    height,
    girth,
    belly: clamp01(girth * 0.75 + (r() - 0.5) * 0.5),
    legs: bell(r),
    arms: bell(r),
    // short people get relatively bigger heads (cuter, reads better small)
    head: clamp01(0.5 + (r() - 0.5) * 0.8 - (height - 0.5) * 0.5),
    shoulders: clamp01(bell(r) + (girth - 0.5) * 0.3),
    neck: r(),
    hands: bell(r),
    feet: bell(r),
    nose: r(),
    skin: pickIndex(r, PALETTE.skin.length),
    hair: pickIndex(r, PALETTE.hair.length),
    hairStyle: [0, 1, 1, 1, 2, 2, 3][pickIndex(r, 7)],
    shirt: pickIndex(r, PALETTE.shirt.length),
    pants: pickIndex(r, PALETTE.pants.length),
    shoes: pickIndex(r, PALETTE.shoes.length),
    longSleeves: r() < 0.55,
    shorts: r() < 0.25,
    eyeSize: r(), // drawn last so older seeds keep their bodies
    persona: { weight: 0, energy: 0, dainty: 0, posture: 0, swagger: 0, sloppy: 0 },
  };
  // separate stream so adding personality doesn't reshuffle existing bodies
  g.persona = derivePersona(g, mulberry32(seed ^ 0x5bd1e995));
  return g;
}

/** Concrete body dimensions (world units, ~metres but cartoon-proportioned). */
export interface BodyDims {
  height: number;
  headR: number;
  neckLen: number;
  neckR: number;
  legLen: number; // hip joint → ground
  thighLen: number;
  shinLen: number;
  thighR: number;
  shinR: number;
  footH: number;
  footLen: number;
  footW: number;
  hipBelow: number; // hip cylinder extent below the pelvis joint
  hipAbove: number; // pelvis joint → waist
  torsoLen: number; // waist → shoulder top
  torsoDepth: number; // z-squash of trunk
  shoulderR: number;
  waistR: number;
  hipR: number;
  hipJointX: number;
  shoulderX: number;
  shoulderY: number; // from waist
  upperArmLen: number;
  foreArmLen: number;
  upperArmR: number;
  foreArmR: number;
  handR: number;
  noseR: number;
  eyeR: number;
  armOut: number; // rest-pose abduction so arms clear the body
}

export function deriveBody(g: Genome): BodyDims {
  const H = lerp(0.8, 1.3, g.height);
  const sH = Math.sqrt(H);
  const G = lerp(0.75, 1.6, g.girth);

  const headR = lerp(0.1, 0.155, g.head) * sH;
  const neckLen = lerp(0.015, 0.07, g.neck) * H * (1 - 0.5 * g.girth);
  const body = H - 1.9 * headR - neckLen;
  const legLen = body * lerp(0.42, 0.56, g.legs);
  const trunk = body - legLen;

  const footH = 0.045 * H;
  const thighR = 0.036 * lerp(0.8, 1.6, g.girth) * sH;
  const shinR = thighR * 0.78;
  const thighLen = (legLen - footH) * 0.5;
  const shinLen = legLen - footH - thighLen;

  const torsoR = 0.082 * G * sH;
  const shoulderR = torsoR * lerp(0.92, 1.35, g.shoulders);
  const waistR = torsoR * (0.9 + 0.5 * g.belly);
  const hipR = torsoR * (0.95 + 0.2 * g.belly);
  const hipAbove = trunk * 0.3;
  const torsoLen = trunk - hipAbove;

  const upperArmR = 0.026 * lerp(0.8, 1.6, g.girth) * sH;
  const foreArmR = upperArmR * 0.82;
  const armLen = H * lerp(0.3, 0.42, g.arms);
  const handR = lerp(0.036, 0.052, g.hands) * sH * lerp(0.95, 1.15, g.girth);

  const shoulderX = shoulderR * 0.92;
  const maxR = Math.max(waistR, hipR);
  const armOut = Math.atan2(Math.max(0, maxR + upperArmR * 1.4 - shoulderX), armLen * 0.85) + 0.06;

  return {
    height: H,
    headR,
    neckLen,
    neckR: Math.min(headR * 0.45, torsoR * 0.5),
    legLen,
    thighLen,
    shinLen,
    thighR,
    shinR,
    footH,
    footLen: lerp(0.12, 0.18, g.feet) * H,
    footW: thighR * 1.5,
    hipBelow: thighR * 0.9,
    hipAbove,
    torsoLen,
    torsoDepth: lerp(0.72, 0.9, g.girth),
    shoulderR,
    waistR,
    hipR,
    hipJointX: Math.min(hipR * 0.55, hipR - thighR * 0.6),
    shoulderX,
    shoulderY: torsoLen - upperArmR * 1.3,
    upperArmLen: armLen * 0.5,
    foreArmLen: armLen * 0.5,
    upperArmR,
    foreArmR,
    handR,
    noseR: headR * lerp(0.12, 0.3, g.nose),
    eyeR: headR * lerp(0.22, 0.34, g.eyeSize),
    armOut,
  };
}
