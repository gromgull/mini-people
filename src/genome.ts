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
  fem: number; // masculine ↔ feminine build (shoulders, waist, hips)
  bust: number;
  noseWidth: number;
  noseLength: number;
  // looks
  skin: number;
  hair: number;
  hairStyle: number; // index into HAIR_STYLES
  shirt: number;
  pants: number;
  shoes: number;
  longSleeves: boolean;
  shorts: boolean;
  skirt: boolean;
  beard: number; // index into BEARD_STYLES
  mouth: number; // index into MOUTH_STYLES
  lips: number; // palette index
  // personality (drives animation, not geometry)
  persona: Persona;
}

export const SHAPE_GENES = [
  'height', 'girth', 'belly', 'legs', 'arms', 'head', 'shoulders', 'neck', 'hands', 'feet', 'nose', 'noseWidth', 'noseLength', 'eyeSize', 'fem', 'bust',
] as const;

export const MOUTH_STYLES = ['line', 'smile', 'frown', 'smirk', 'O'] as const;

export const BEARD_STYLES = ['none', 'full', 'wizard', 'goatee', 'sideburns', 'moustache'] as const;

export const HAIR_STYLES = ['bald', 'short', 'long', 'hat', 'ponytail', 'bun'] as const;

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
    eyeSize: r(), // new genes are drawn last so older seeds keep their bodies
    fem: 0,
    bust: 0,
    skirt: false,
    noseWidth: 0.5,
    noseLength: 0.5,
    beard: 0,
    mouth: 1,
    lips: 0,
    persona: { weight: 0, energy: 0, dainty: 0, posture: 0, swagger: 0, sloppy: 0 },
  };
  // about half the crowd reads as female; a few in-between builds
  const femR = r();
  g.fem = femR < 0.48 ? lerp(0.55, 1, r()) : femR < 0.56 ? lerp(0.3, 0.55, r()) : r() * 0.25;
  const bustR = r();
  g.bust = g.fem > 0.5 ? lerp(0.15, 1, bustR) : 0;
  const hairR = r();
  const hairPick = r();
  if (g.fem > 0.5 && g.hairStyle !== 3 && hairR < 0.85) g.hairStyle = [1, 2, 2, 2, 4, 4, 5][pickIndex(() => hairPick, 7)];
  else if (g.fem <= 0.5 && g.hairStyle === 2 && hairR < 0.6) g.hairStyle = 1;
  g.skirt = g.fem > 0.5 && r() < 0.4;
  g.noseWidth = bell(r);
  g.noseLength = bell(r);
  // mouths: mostly content, some deadpan, a few grumpy, smug or startled
  // beards: mostly on masculine builds; grey/white hair leans wizard
  const beardR = r();
  const beardPick = r();
  const grey = g.hair === 5 || g.hair === 6;
  if (g.fem < 0.4 && beardR < 0.45) {
    const pool = grey ? [1, 2, 2, 2, 3, 4, 5] : [1, 1, 1, 2, 3, 3, 3, 4, 4, 5, 5];
    g.beard = pool[pickIndex(() => beardPick, pool.length)];
  }
  g.mouth = [1, 1, 1, 1, 1, 0, 0, 0, 2, 2, 3, 3, 4][pickIndex(r, 13)];
  const lipR = r();
  g.lips = g.fem > 0.5 ? (lipR < 0.6 ? 3 + Math.floor(r() * 2) : 2) : Math.floor(lipR * 3); // 0–2 muted, 3–4 red
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
  bustR: number;
  armOut: number; // rest-pose abduction so arms clear the body
}

export function deriveBody(g: Genome): BodyDims {
  const H = lerp(0.8, 1.3, g.height);
  const sH = Math.sqrt(H);
  const G = lerp(0.75, 1.6, g.girth);
  const F = g.fem;

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
  const shoulderR = torsoR * lerp(0.92, 1.35, g.shoulders) * lerp(1, 0.86, F);
  const waistR = torsoR * (0.9 + 0.5 * g.belly) * lerp(1, 0.84, F * (1 - 0.6 * g.belly));
  const hipR = torsoR * (0.95 + 0.2 * g.belly) * lerp(1, 1.14, F);
  const hipAbove = trunk * 0.3;
  const torsoLen = trunk - hipAbove;

  const upperArmR = 0.026 * lerp(0.8, 1.6, g.girth) * sH;
  const foreArmR = upperArmR * 0.82;
  const armLen = H * lerp(0.25, 0.34, g.arms);
  const handR = lerp(0.036, 0.052, g.hands) * sH * lerp(0.95, 1.15, g.girth) * lerp(1, 0.9, F);

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
    // wider feminine hips are padding, not wider-set legs
    hipJointX: Math.min(hipR * lerp(0.55, 0.46, F), hipR - thighR * 0.6),
    shoulderX,
    shoulderY: torsoLen - upperArmR * 1.3,
    upperArmLen: armLen * 0.5,
    foreArmLen: armLen * 0.5,
    upperArmR,
    foreArmR,
    handR,
    noseR: headR * lerp(0.09, 0.22, g.nose),
    eyeR: headR * lerp(0.22, 0.34, g.eyeSize),
    bustR: torsoR * lerp(0, 0.52, g.bust),
    armOut,
  };
}
