export type Rng = () => number;

/** Small, fast, seedable PRNG. Same seed → same person. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bell-ish distribution on [0,1] (mean of three uniforms). */
export const bell = (r: Rng) => (r() + r() + r()) / 3;
export const pickIndex = (r: Rng, n: number) => Math.floor(r() * n);
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
