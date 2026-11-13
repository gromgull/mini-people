import * as THREE from 'three';

/**
 * Time of day, keyed on the sun's elevation (degrees): sky colours, the tint
 * over everything lit, the sunset glow, how many stars show, the sun's colour
 * and how dark drop shadows are. Keyframes are interpolated linearly.
 *
 * Night is black-blue with stars; dawn/dusk runs black → red → orange → blue.
 * Below the horizon the moon (opposite the sun) takes over the lighting, so the
 * scene goes dim and blue rather than pitch black.
 */

interface Key {
  el: number;
  top: string; // sky overhead
  horizon: string; // sky at the horizon, also the haze the ground fades into
  tint: [number, number, number]; // multiplies everything lit
  glow: string; // sky colour around the sun near the horizon
  glowAmt: number;
  stars: number; // 0…1
  sun: string; // sun disc colour
  shadow: number; // drop-shadow opacity
}

const KEYS: Key[] = [
  { el: -90, top: '#04071a', horizon: '#0b1028', tint: [0.24, 0.28, 0.46], glow: '#000000', glowAmt: 0, stars: 1, sun: '#ff6a2a', shadow: 0.12 },
  { el: -14, top: '#060a20', horizon: '#121834', tint: [0.24, 0.28, 0.46], glow: '#000000', glowAmt: 0, stars: 1, sun: '#ff6a2a', shadow: 0.12 },
  { el: -8, top: '#101838', horizon: '#33284c', tint: [0.3, 0.3, 0.48], glow: '#5a2848', glowAmt: 0.5, stars: 0.75, sun: '#ff5a2a', shadow: 0.06 },
  { el: -3, top: '#1e2a58', horizon: '#9a3a30', tint: [0.55, 0.46, 0.52], glow: '#d84a2a', glowAmt: 0.9, stars: 0.3, sun: '#ff5a2a', shadow: 0 },
  { el: 1, top: '#38568e', horizon: '#e0703a', tint: [0.95, 0.78, 0.62], glow: '#f08a3a', glowAmt: 1, stars: 0, sun: '#ff8a40', shadow: 0.14 },
  { el: 6, top: '#4c7cc0', horizon: '#eeaa76', tint: [1, 0.88, 0.76], glow: '#f6b070', glowAmt: 0.6, stars: 0, sun: '#ffc070', shadow: 0.18 },
  { el: 15, top: '#589adc', horizon: '#dde2cc', tint: [1, 0.96, 0.9], glow: '#fff0c0', glowAmt: 0.2, stars: 0, sun: '#ffeeb0', shadow: 0.22 },
  { el: 30, top: '#5aa0e2', horizon: '#cfe2dc', tint: [1, 1, 1], glow: '#fff2c8', glowAmt: 0, stars: 0, sun: '#fff4c4', shadow: 0.22 },
  { el: 90, top: '#5aa0e2', horizon: '#cfe2dc', tint: [1, 1, 1], glow: '#fff2c8', glowAmt: 0, stars: 0, sun: '#fff4c4', shadow: 0.22 },
];

export interface Daylight {
  top: THREE.Color;
  horizon: THREE.Color;
  tint: THREE.Color;
  glow: THREE.Color;
  glowAmt: number;
  stars: number;
  sun: THREE.Color;
  shadow: number;
}

// (colours are built lazily: main turns colour management off first)
let cache: { a: THREE.Color[][] } | null = null;
const cols = () => (cache ??= { a: KEYS.map((k) => [k.top, k.horizon, k.glow, k.sun].map((c) => new THREE.Color(c))) }).a;

export function daylight(el: number, out?: Daylight): Daylight {
  const o = out ?? { top: new THREE.Color(), horizon: new THREE.Color(), tint: new THREE.Color(), glow: new THREE.Color(), glowAmt: 0, stars: 0, sun: new THREE.Color(), shadow: 0 };
  const c = cols();
  let i = 0;
  while (i < KEYS.length - 2 && el > KEYS[i + 1].el) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = THREE.MathUtils.clamp((el - a.el) / (b.el - a.el), 0, 1);
  o.top.copy(c[i][0]).lerp(c[i + 1][0], t);
  o.horizon.copy(c[i][1]).lerp(c[i + 1][1], t);
  o.glow.copy(c[i][2]).lerp(c[i + 1][2], t);
  o.sun.copy(c[i][3]).lerp(c[i + 1][3], t);
  o.tint.setRGB(...(a.tint.map((v, k) => v + (b.tint[k] - v) * t) as [number, number, number]));
  o.glowAmt = a.glowAmt + (b.glowAmt - a.glowAmt) * t;
  o.stars = a.stars + (b.stars - a.stars) * t;
  o.shadow = a.shadow + (b.shadow - a.shadow) * t;
  return o;
}

/** Highest the sun gets (at noon); at midnight it's this far below the horizon. */
const MAX_EL = 55;
/**
 * World azimuths (degrees) of the noon sun and of the sunset. The default
 * camera sits at azimuth 25 looking toward 205: the noon sun lights faces from
 * front-right (the old default light), and the sun sets 20° off the view
 * direction, so a zoomed-out default view watches it go down.
 */
const NOON_AZ = 35;
const SUNSET_AZ = 185;

/**
 * The sun's position at a time of day (hours, 0–24): up at 06:00, highest at
 * noon, down at 18:00; the same curve carries on below the horizon at night
 * (the moon, opposite, is highest at midnight). The azimuth isn't a real sun's
 * steady 15°/h: by day it sweeps from sunrise to sunset through noon (25°/h),
 * and at night it creeps the rest of the way round (5°/h), so the light and the
 * sunset both land where the default view wants them. Degrees.
 */
export function sunAt(hours: number) {
  const h = ((hours % 24) + 24) % 24;
  const dayRate = (SUNSET_AZ - NOON_AZ) / 6; // °/h between 06:00 and 18:00
  const sunriseAz = NOON_AZ - 6 * dayRate;
  const nightRate = (sunriseAz + 360 - SUNSET_AZ) / 12;
  const az =
    h >= 6 && h <= 18 ? NOON_AZ + (h - 12) * dayRate
    : SUNSET_AZ + (h >= 18 ? h - 18 : h + 6) * nightRate;
  return { az, el: MAX_EL * Math.sin(((h - 6) / 24) * Math.PI * 2) };
}
