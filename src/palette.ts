import * as THREE from 'three';

/**
 * Gradient atlas: every row is a lighting ramp for one base colour.
 * The shader looks up u = lighting (0 = shadow, 1 = lit), v = row.
 */

export const PALETTE = {
  skin: ['#f6d3b3', '#eab890', '#d49c6c', '#b37a4a', '#8c5836', '#5f3b24'],
  hair: ['#2a1c14', '#5a3820', '#9c6230', '#dcb460', '#c4441e', '#8e8e8e', '#efece2'],
  shirt: ['#d83a3a', '#3a6ad8', '#3aa04a', '#e8c030', '#8a4ad0', '#f08030', '#f2f2ea', '#30b0b0', '#e060a0', '#5e6670'],
  pants: ['#34457a', '#5a3a28', '#3c3c40', '#7a6a50', '#2a5a3a', '#8a2a2a', '#c4b494'],
  shoes: ['#3a2418', '#202022', '#784420', '#a8a8a8'],
  eye: ['#121218'],
  eyeWhite: ['#f7f5ee'],
  lips: ['#4a2420', '#6a2a28', '#8a3236', '#b0343e', '#c8404c', '#d86070', '#e88090'],
  ground: ['#7fae4c'],
  cloud: ['#fbfaf4'],
  pine: ['#2e6a4c', '#38754f', '#2a5f47'],
  bark: ['#6a4630', '#7a5236'],
  leaf: ['#4e9a3a', '#5aa642', '#64a23c'],
  apple: ['#d6372e', '#c42a2a', '#e04a2a'],
  water: ['#4f9fc8', '#3b86b6'],
  shore: ['#a8a070'],
  stone: ['#8e8b85', '#a19c92', '#78756f'],
  fish: ['#a9c2cf', '#e0884a', '#5f7f96'],
  stockfish: ['#c8a46c', '#9a7448'], // dried: body, fins and tail
  wood: ['#b07a46', '#94643a', '#c99a62'],
  food: ['#f1e2ac', '#eee8d8', '#e6b34a'], // apple flesh, fish bones, ale
  plaster: ['#efe3c4', '#e6d6b2'],
  timber: ['#4a3222', '#3c2a1e'],
  log: ['#8d5d38', '#7a4f2f', '#9c6c42'],
  roof: ['#a24a30', '#6e5a48', '#6f8442', '#7d6a55', '#86392a', '#57473a', '#5d7238'], // clay tiles, shingles, turf, weathered; then darker courses for tiles, shingles, turf
  paint: ['#3d6e8c', '#8a3a32', '#4f7a40', '#c9a542'], // shutters and doors
  pane: ['#2c3844', '#f4c86a'], // dark glass, lamplit
  fur: ['#ead8b4', '#c99a5c', '#a5622f', '#5e3b26', '#2c2622', '#8f8a84', '#f3efe6'], // cream, tan, red-brown, chocolate, black, grey, white
  nose: ['#1d1716'],
} as const;

export type ColorGroup = keyof typeof PALETTE;

export interface RampSettings {
  bands: number; // 1..5 hard bands (ignored when smooth)
  bias: number; // >1 pushes more surface into shadow
  smooth: boolean;
  shadowDepth: number; // how dark the darkest band is
  hueShift: number; // shadows toward blue/purple, highlights toward yellow
  highlight: number;
}

export const defaultRamp: RampSettings = {
  bands: 3,
  bias: 1.0,
  smooth: false,
  shadowDepth: 0.22,
  hueShift: 0.06,
  highlight: 0.1,
};

const WIDTH = 64;

/** Map from colour group → atlas row of each entry. */
export const ROWS: Record<ColorGroup, number[]> = (() => {
  const out = {} as Record<ColorGroup, number[]>;
  let i = 0;
  for (const g of Object.keys(PALETTE) as ColorGroup[]) {
    out[g] = PALETTE[g].map(() => i++);
  }
  return out;
})();
export const ROW_COUNT = Object.values(PALETTE).reduce((n, a) => n + a.length, 0);

const SHADOW_TINT = new THREE.Color('#2b2a6a'); // cool purple-blue
const LIGHT_TINT = new THREE.Color('#fff2c8'); // warm sunlight

/**
 * Painterly ramp: shadows are the base multiplied darker and pulled toward a
 * cool tint; highlights are pulled toward warm white. (Darkening in HSL keeps
 * saturation fixed and makes light skin go neon red, so we stay in RGB.)
 */
function rampColor(base: THREE.Color, t: number, s: RampSettings, flat: boolean): THREE.Color {
  if (flat) return base.clone();
  // base colour sits at k along the ramp; below it is shadow, above it highlight
  const k = 0.68;
  if (t <= k) {
    const a = 1 - t / k; // 1 at deepest shadow
    return base
      .clone()
      .multiplyScalar(1 - s.shadowDepth * 1.6 * a)
      .lerp(SHADOW_TINT, s.hueShift * 3 * a);
  }
  const a = (t - k) / (1 - k);
  return base.clone().lerp(LIGHT_TINT, s.highlight * a);
}

/** Ramp position of band i of n so the base colour is always the second-to-last band. */
function bandT(i: number, n: number): number {
  if (n <= 1) return 0.68;
  if (n === 2) return i === 0 ? 0 : 0.68;
  const k = 0.68;
  const baseIdx = n - 2;
  return i <= baseIdx ? (i / baseIdx) * k : 1;
}

export function createAtlas(): THREE.DataTexture {
  const data = new Uint8Array(WIDTH * ROW_COUNT * 4);
  const tex = new THREE.DataTexture(data, WIDTH, ROW_COUNT, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export function fillAtlas(tex: THREE.DataTexture, s: RampSettings) {
  const data = tex.image.data as Uint8Array;
  let row = 0;
  for (const g of Object.keys(PALETTE) as ColorGroup[]) {
    const flat = g === 'eye';
    for (const hex of PALETTE[g]) {
      const base = new THREE.Color(hex);
      for (let x = 0; x < WIDTH; x++) {
        const u = (x + 0.5) / WIDTH;
        let t: number;
        if (s.smooth) {
          t = Math.pow(u, s.bias);
        } else {
          const n = Math.max(1, Math.round(s.bands));
          const band = Math.min(n - 1, Math.floor(Math.pow(u, s.bias) * n));
          t = bandT(band, n);
        }
        const c = rampColor(base, t, s, flat);
        const o = (row * WIDTH + x) * 4;
        data[o] = Math.round(c.r * 255);
        data[o + 1] = Math.round(c.g * 255);
        data[o + 2] = Math.round(c.b * 255);
        data[o + 3] = 255;
      }
      row++;
    }
  }
  tex.needsUpdate = true;
}
