import type { GaitParams } from './gait';
import type { SpringParams } from './springs';
import { type Rng, bell, clamp01 } from './rng';

/**
 * High-level personality. Every trait is 0..1 with 0.5 = neutral; they're
 * mapped onto many low-level parameters at once in `styleFor`.
 */
export interface Persona {
  weight: number; // light ↔ heavy
  energy: number; // tired ↔ lively
  dainty: number; // coarse ↔ dainty / precise
  posture: number; // slouched ↔ proud
  swagger: number; // stiff ↔ swaggering
  sloppy: number; // tidy ↔ clumsy / loose
}

export const PERSONA_KEYS = ['weight', 'energy', 'dainty', 'posture', 'swagger', 'sloppy'] as const;

export const NEUTRAL: Persona = { weight: 0.5, energy: 0.5, dainty: 0.5, posture: 0.5, swagger: 0.5, sloppy: 0.5 };

export const PRESETS: Record<string, Persona> = {
  neutral: NEUTRAL,
  heavy: { weight: 1, energy: 0.3, dainty: 0.1, posture: 0.45, swagger: 0.45, sloppy: 0.35 },
  dainty: { weight: 0.05, energy: 0.65, dainty: 1, posture: 0.75, swagger: 0.3, sloppy: 0.1 },
  clumsy: { weight: 0.5, energy: 0.65, dainty: 0.15, posture: 0.35, swagger: 0.3, sloppy: 1 },
  swagger: { weight: 0.6, energy: 0.6, dainty: 0.3, posture: 0.9, swagger: 1, sloppy: 0.4 },
  tired: { weight: 0.6, energy: 0, dainty: 0.4, posture: 0.05, swagger: 0.2, sloppy: 0.55 },
  eager: { weight: 0.3, energy: 1, dainty: 0.55, posture: 0.7, swagger: 0.4, sloppy: 0.35 },
};

/** Seeded persona that loosely follows body shape (bigger → heavier, etc.). */
export function derivePersona(
  shape: { girth: number; belly: number; height: number; legs: number },
  r: Rng,
): Persona {
  const n = () => (r() - 0.5) * 0.5;
  return {
    weight: clamp01(0.15 + shape.girth * 0.55 + shape.belly * 0.25 + (shape.height - 0.5) * 0.15 + n() * 0.6),
    energy: clamp01(bell(r) + (shape.legs - 0.5) * 0.2 - (shape.girth - 0.5) * 0.2),
    dainty: clamp01(bell(r) - (shape.girth - 0.5) * 0.5 + n() * 0.5),
    posture: clamp01(bell(r) + n() * 0.6),
    swagger: clamp01(r() < 0.15 ? 0.75 + r() * 0.25 : bell(r) * 0.9),
    sloppy: clamp01(r() < 0.12 ? 0.75 + r() * 0.25 : bell(r) * 0.8),
  };
}

/** Everything the animator needs, derived from a persona. */
export interface Style {
  gait: GaitParams;
  spring: SpringParams; // base response; channels scale f from this
  speedK: number; // preferred speed multiplier (free-walking modes)
  armOut: number; // extra arm abduction
  elbow: number; // constant elbow bend
  posture: number; // -1 slouch … +1 proud
  noise: number; // amplitude of fidget / wobble noise
  asym: number; // left/right asymmetry
  turnLean: number; // how much they lean into turns
  idle: number; // amount of idle weight shifting / looking around
  tempo: number; // action speed multiplier
  hop: number; // jump height multiplier
}

const ex = Math.exp;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export function styleFor(base: GaitParams, p: Persona, amount: number): Style {
  // centred, scaled traits in roughly -1..1 (beyond with amount > 1)
  const s = (k: keyof Persona) => (p[k] - 0.5) * 2 * amount;
  const W = s('weight'), E = s('energy'), D = s('dainty'), P = s('posture'), L = s('sloppy');
  // swagger gets theatrical fast: soften the strutting side
  const S0 = s('swagger');
  const S = S0 > 0 ? S0 * 0.42 : S0;
  const pos = (x: number) => Math.max(0, x);

  const gait: GaitParams = {
    stride: base.stride * ex(-0.2 * W + 0.12 * E - 0.28 * D + 0.1 * S - 0.1 * pos(-P)),
    duty: clamp(base.duty + 0.05 * W - 0.04 * E, 0.5, 0.75),
    stepHeight: base.stepHeight * ex(-0.5 * W + 0.4 * E + 0.35 * D + 0.25 * P),
    bounce: base.bounce * ex(0.7 * W + 0.6 * E) + 0.012 * pos(E) + 0.01 * pos(W),
    sway: base.sway * ex(0.9 * W + 0.5 * S - 0.6 * D),
    hipYaw: base.hipYaw * ex(0.2 * W + 0.8 * S + 0.35 * D),
    hipRoll: base.hipRoll * ex(0.5 * W + 0.6 * S + 0.6 * D),
    shoulderTwist: base.shoulderTwist * ex(0.6 * S - 0.3 * D),
    armSwing: Math.min(0.85, base.armSwing * ex(-0.4 * W + 0.35 * E - 0.6 * D + 0.45 * S)),
    lean: base.lean + 0.08 * E - 0.05 * W,
    crouch: base.crouch + 0.04 * pos(-P) + 0.008 * pos(W) + 0.008 * pos(-E),
    stance: base.stance * ex(0.5 * W + 0.3 * S - 0.8 * D),
    footRoll: base.footRoll * ex(-0.6 * W + 0.5 * D + 0.3 * E),
  };

  return {
    gait,
    spring: {
      f: 2.4 * ex(-0.7 * W + 0.45 * E + 0.35 * D),
      z: clamp(0.65 + 0.3 * W - 0.35 * L + 0.1 * D, 0.28, 1.4),
      r: clamp(0.6 + 0.9 * D + 0.5 * E - 0.6 * W, -0.3, 3),
    },
    speedK: ex(0.25 * E - 0.15 * W - 0.1 * D),
    armOut: 0.12 * pos(W) + 0.05 * S,
    elbow: 0.08 + 0.55 * pos(D) + 0.15 * pos(E),
    posture: clamp(P, -1.5, 1.5),
    noise: 0.12 + 0.9 * pos(L),
    asym: 0.35 * pos(L),
    turnLean: 0.5 * ex(0.4 * W + 0.3 * E),
    idle: clamp(0.5 + 0.4 * E + 0.3 * L, 0.1, 1.5),
    tempo: ex(0.35 * E - 0.3 * W + 0.15 * D),
    hop: ex(0.5 * E - 0.55 * W + 0.15 * D),
  };
}
