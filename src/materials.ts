import * as THREE from 'three';
import { ROW_COUNT } from './palette';

/**
 * Horizon haze, shared by every material that should fade into it. Distance
 * is measured along the camera's horizontal view direction from the view
 * centre, so the horizon is a straight line; past `uFogFar` fragments are
 * dropped and the sky behind shows through.
 */
export interface FogUniforms {
  uFogC: { value: THREE.Vector2 }; // view centre (world xz)
  uFogDir: { value: THREE.Vector2 }; // horizontal view direction (world xz, unit)
  uFogNear: { value: number };
  uFogFar: { value: number };
  uHaze: { value: THREE.Color };
}

export const createFog = (far = 12): FogUniforms => ({
  uFogC: { value: new THREE.Vector2() },
  uFogDir: { value: new THREE.Vector2(0, -1) },
  uFogNear: { value: far * 0.5 },
  uFogFar: { value: far },
  uHaze: { value: new THREE.Color('#cfe2dc') },
});

const FOG_GLSL = /* glsl */ `
  uniform vec2 uFogC;
  uniform vec2 uFogDir;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec3 uHaze;
  varying vec3 vWorld;
  // 0 = clear … 1 = fully hazed; discards past the horizon
  float fogAmount() {
    float d = dot(vWorld.xz - uFogC, uFogDir);
    if (d > uFogFar) discard;
    float k = smoothstep(uFogNear, uFogFar, d);
    return floor(k * 5.0 + 0.5) / 5.0; // banded, to match the toon ramps
  }
`;

/**
 * One lamp (the street-lamp by the inn's tables): a warm point light on top
 * of the sun, in view space, falling off to nothing at uLampR and banded like
 * the toon ramps. Off when its colour is black. Its uniforms are shared by
 * every material that's lit by it.
 */
export const createLampUniforms = () => ({
  uLampView: { value: new THREE.Vector3() },
  uLampColor: { value: new THREE.Color(0, 0, 0) },
  uLampR: { value: 7 },
});
export type LampUniforms = ReturnType<typeof createLampUniforms>;
const LAMP_GLSL = /* glsl */ `
  uniform vec3 uLampView;
  uniform vec3 uLampColor;
  uniform float uLampR;
  varying vec3 vView;
  // how much of the lamp lands here (0 … 1, in a few flat bands)
  float lampK(vec3 n) {
    if (uLampColor.r + uLampColor.g + uLampColor.b <= 0.0) return 0.0;
    vec3 L = uLampView - vView;
    float d = length(L);
    float fall = clamp(1.0 - d / uLampR, 0.0, 1.0);
    fall *= fall;
    float ndl = clamp((dot(n, L / max(d, 1e-3)) + 0.4) / 1.4, 0.0, 1.0);
    return floor(fall * ndl * 4.0 + 0.35) / 4.0;
  }
`;

/**
 * Rigid skinning for merged characters (see skin.ts): every vertex belongs to
 * exactly one part, and the part's matrix (relative to the character root)
 * comes from a uniform array. Without SKINNED this is a no-op. Instanced
 * meshes get their instance matrix applied on top.
 */
export const MAX_BONES = 48;
const SKIN_GLSL = /* glsl */ `
  #ifdef SKINNED
  attribute float aBone;
  attribute float aEdge;
  uniform mat4 uBones[MAX_BONES];
  vec3 skinPos0() { return (uBones[int(aBone + 0.5)] * vec4(position, 1.0)).xyz; }
  vec3 skinNormal0() { return mat3(uBones[int(aBone + 0.5)]) * normal; }
  #else
  vec3 skinPos0() { return position; }
  vec3 skinNormal0() { return normal; }
  #endif
  // instanced meshes (forest trees, stumps): three supplies instanceMatrix
  #ifdef USE_INSTANCING
  vec3 skinPos() { return (instanceMatrix * vec4(skinPos0(), 1.0)).xyz; }
  vec3 skinNormal() { return mat3(instanceMatrix) * skinNormal0(); }
  #else
  vec3 skinPos() { return skinPos0(); }
  vec3 skinNormal() { return skinNormal0(); }
  #endif
`;

/**
 * A skinned twin of a toon or outline material: same shaders with SKINNED
 * defined, sharing the base material's uniform objects (so light, tint, fog
 * and outline width stay in step) plus its own bone array, filled per mesh
 * just before it draws.
 */
export function skinnedVariant(base: THREE.ShaderMaterial) {
  return new THREE.ShaderMaterial({
    uniforms: { ...base.uniforms, uBones: { value: new Float32Array(16 * MAX_BONES) } },
    vertexShader: base.vertexShader,
    fragmentShader: base.fragmentShader,
    defines: { SKINNED: '', MAX_BONES },
    side: base.side,
  });
}

/**
 * One shared toon material for everything: lighting picks the column,
 * the per-vertex `aRow` attribute picks the colour ramp in the atlas.
 */
export function createToonMaterial(atlas: THREE.Texture, fog: FogUniforms = createFog(1e9), lamp: LampUniforms = createLampUniforms()) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...fog,
      ...lamp,
      uAtlas: { value: atlas },
      uRows: { value: ROW_COUNT },
      uLightView: { value: new THREE.Vector3(0, 1, 0) },
      uWrap: { value: 0.35 },
      uTint: { value: new THREE.Color(1, 1, 1) }, // time-of-day light colour
    },
    vertexShader: /* glsl */ `
      attribute float aRow;
      varying vec3 vN;
      varying float vRow;
      varying vec3 vWorld;
      varying vec3 vView;
      ${SKIN_GLSL}
      void main() {
        vec3 pos = skinPos();
        vN = normalize(normalMatrix * skinNormal());
        vRow = aRow;
        vec4 wp = modelMatrix * vec4(pos, 1.0);
        vWorld = wp.xyz;
        vView = (viewMatrix * wp).xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform float uRows;
      uniform vec3 uLightView;
      uniform float uWrap;
      uniform vec3 uTint;
      varying vec3 vN;
      varying float vRow;
      ${FOG_GLSL}
      ${LAMP_GLSL}
      void main() {
        float haze = fogAmount();
        vec3 n = normalize(vN);
        float ndl = dot(n, uLightView);
        // wrapped lambert: uWrap=0 → plain lambert, 1 → half-lambert
        float u = clamp((ndl + uWrap) / (1.0 + uWrap), 0.001, 0.999);
        float row = (vRow + 0.5) / uRows;
        vec3 c = texture2D(uAtlas, vec2(u, row)).rgb * uTint;
        // the lamp: its colour on the lit end of the ramp
        c += texture2D(uAtlas, vec2(0.97, row)).rgb * uLampColor * lampK(n);
        gl_FragColor = vec4(mix(c, uHaze, haze), 1.0);
      }
    `,
  });
}

/**
 * Inverted-hull outline with a constant width in (render-target) pixels:
 * the vertex is pushed along its screen-space normal direction.
 */
export function createOutlineMaterial(fog: FogUniforms = createFog(1e9)) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      ...fog,
      uColor: { value: new THREE.Color('#1a1410') },
      uPx: { value: 1.0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      uniform float uPx;
      uniform vec2 uResolution;
      varying vec3 vWorld;
      ${SKIN_GLSL}
      void main() {
        vec3 pos = skinPos();
        vWorld = (modelMatrix * vec4(pos, 1.0)).xyz;
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        #ifdef SKINNED
        if (aEdge < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; } // part drawn without an outline
        #endif
        vec3 n = normalize(normalMatrix * skinNormal());
        vec2 d = (projectionMatrix * vec4(n, 0.0)).xy * uResolution; // → pixel space
        float l = length(d);
        if (l > 1e-6) d /= l;
        clip.xy += d * uPx * 2.0 / uResolution * clip.w;
        gl_Position = clip;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      ${FOG_GLSL}
      void main() { gl_FragColor = vec4(mix(uColor, uHaze, fogAmount()), 1.0); }
    `,
  });
}

export interface GrassSettings {
  scale: number; // world size of the colour patches
  ragged: number; // how hard the zig-zag teeth bite across patch edges
  tooth: number; // world size of the triangles the edges zig-zag over
  contrast: number; // 0 = flat ground … 1 = full tone difference between patches
  flowers: number; // 0 = none … 1 = dense meadows where the density map allows
  flowerSize: number; // petal length (world units)
}

export const defaultGrass: GrassSettings = { scale: 7, ragged: 0.01, tooth: 0.3, contrast: 0.6, flowers: 0.6, flowerSize: 0.1 };

/**
 * Toon ground with painted-looking grass patches: two independent world-space
 * noise fields give a layer of dark patches and a layer of light ones over the
 * base colour. Light sits on top, so it can cover base or dark directly; they're
 * separate layers rather than levels of one height map. To keep the edges low-poly, each field
 * is only evaluated on the corners of a small triangle grid (each corner nudged by
 * a random amount) and interpolated linearly inside each triangle, so the patch
 * edges are polylines: a distorted triangle wave. Everything lives on the ground
 * plane, so the pattern stays put when the camera orbits or zooms.
 *
 * Flowers are painted on too: one possible flower per grid cell, kept or not by
 * a coarse density map (bare stretches, then clumps). Each is three triangular
 * petals at a random rotation, somewhere between pink and lilac.
 */
export function createGroundMaterial(atlas: THREE.Texture, fog: FogUniforms, row: number, lamp: LampUniforms = createLampUniforms()) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...fog,
      ...lamp,
      uAtlas: { value: atlas },
      uRow: { value: (row + 0.5) / ROW_COUNT },
      uLightView: { value: new THREE.Vector3(0, 1, 0) },
      uWrap: { value: 0.35 },
      uScale: { value: defaultGrass.scale },
      uRagged: { value: defaultGrass.ragged },
      uTooth: { value: defaultGrass.tooth },
      uContrast: { value: defaultGrass.contrast },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uFlowers: { value: defaultGrass.flowers },
      uFlowerSize: { value: defaultGrass.flowerSize },
      uPink: { value: new THREE.Color('#e88ac8') },
      uLilac: { value: new THREE.Color('#b58ae8') },
      uDark: { value: new THREE.Vector3(0.7, 0.83, 0.9) }, // cool, teal-ish shade
      uLight: { value: new THREE.Vector3(1.08, 1.07, 0.97) }, // warm, sunlit
    },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vWorld;
      varying vec3 vView;
      void main() {
        vN = normalize(normalMatrix * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vView = (viewMatrix * wp).xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform float uRow;
      uniform vec3 uLightView;
      uniform float uWrap;
      uniform float uScale;
      uniform float uRagged;
      uniform float uTooth;
      uniform float uContrast;
      uniform vec3 uTint;
      uniform float uFlowers;
      uniform float uFlowerSize;
      uniform vec3 uPink;
      uniform vec3 uLilac;
      uniform vec3 uDark;
      uniform vec3 uLight;
      varying vec3 vN;
      ${FOG_GLSL}
      ${LAMP_GLSL}

      float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x),
                   mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
      }
      // patch field: two big octaves for the shapes, a small one to wobble the outlines
      float field(vec2 p, float seed) {
        p = p / uScale + seed * vec2(37.1, -91.7);
        return vnoise(p) * 0.55 + vnoise(p * 2.1 + 17.3) * 0.3 + vnoise(p * 5.3 - 4.1) * 0.15;
      }
      // both layers' fields + per-corner nudges, sampled at a lattice corner (integer coords)
      const float F2 = 0.36602540378; // (sqrt(3) - 1) / 2
      const float G2 = 0.21132486540; // (3 - sqrt(3)) / 6
      vec2 corner(vec2 i) {
        vec2 w = (i - (i.x + i.y) * G2) * uTooth; // unskew → world
        vec2 nudge = vec2(hash2(i + 0.37), hash2(i + 5.71)) - 0.5;
        return vec2(field(w, 0.0), field(w, 1.0)) + nudge * 2.0 * uRagged;
      }
      // piecewise-linear fields over an equilateral triangle grid (simplex lattice)
      vec2 facetField(vec2 p) {
        vec2 q = p / uTooth;
        vec2 i = floor(q + (q.x + q.y) * F2);
        vec2 x0 = q - (i - (i.x + i.y) * G2);
        vec2 i1 = x0.x > x0.y ? vec2(1, 0) : vec2(0, 1);
        vec2 x1 = x0 - i1 + G2;
        vec2 x2 = x0 - 1.0 + 2.0 * G2;
        // barycentric weights: corners 1 and 2 relative to corner 0, then solve x0 = wb·b + wc·c
        vec2 b = x0 - x1, c = x0 - x2;
        float area = b.x * c.y - b.y * c.x;
        float wb = (x0.x * c.y - x0.y * c.x) / area;
        float wc = (b.x * x0.y - b.y * x0.x) / area;
        float wa = 1.0 - wb - wc;
        return corner(i) * wa + corner(i + i1) * wb + corner(i + 1.0) * wc;
      }

      // flower colour at p, or alpha 0. Cells are big enough that a flower never
      // leaves its own cell, so only one cell needs checking.
      const float CELL = 0.5; // fits flowers up to ~0.1 (radius × 1.2 jitter)
      vec4 flower(vec2 p) {
        vec2 cell = floor(p / CELL);
        float dens = smoothstep(0.42, 0.72, vnoise(p / 5.0 + vec2(71.3, 19.1))) * uFlowers;
        if (hash2(cell + 3.1) > dens) return vec4(0.0);
        vec2 jitter = vec2(hash2(cell + 9.7), hash2(cell + 4.4));
        vec2 centre = (cell + 0.25 + 0.5 * jitter) * CELL;
        float r1 = uFlowerSize * (0.8 + 0.4 * hash2(cell + 6.6));
        vec2 d = p - centre;
        if (dot(d, d) > r1 * r1) return vec4(0.0);
        // fold into one petal's 120° wedge, petal axis along +x
        const float WEDGE = 2.09439510239;
        float a = atan(d.y, d.x) - hash2(cell + 2.2) * WEDGE;
        a = mod(a + WEDGE * 0.5, WEDGE) - WEDGE * 0.5;
        vec2 l = length(d) * vec2(cos(a), sin(a));
        // triangle: tip near the centre, widening outward
        float r0 = r1 * 0.15;
        if (l.x < r0 || abs(l.y) > (l.x - r0) * 0.75) return vec4(0.0);
        vec3 col = mix(uPink, uLilac, hash2(cell + 8.8));
        col *= 0.92 + 0.16 * hash2(cell + 1.3);
        return vec4(col, 1.0);
      }

      void main() {
        float haze = fogAmount();
        float ndl = dot(normalize(vN), uLightView);
        float u = clamp((ndl + uWrap) / (1.0 + uWrap), 0.001, 0.999);
        vec3 c = texture2D(uAtlas, vec2(u, uRow)).rgb;
        // how lit the ground is relative to full sun, so flowers dim along with it
        vec3 lit = c / max(texture2D(uAtlas, vec2(0.999, uRow)).rgb, vec3(1e-3));

        vec2 p = vWorld.xz;
        vec2 f = facetField(p); // x: dark layer, y: light layer
        vec3 k = f.y > 0.6 ? uLight : f.x > 0.6 ? uDark : vec3(1.0);
        c *= mix(vec3(1.0), k, uContrast);
        vec4 fl = flower(p);
        c = mix(c, fl.rgb * lit, fl.a);
        c *= uTint;
        // the lamp: the ground as full light has it (patches, flowers and all)
        vec3 full = texture2D(uAtlas, vec2(0.999, uRow)).rgb * mix(vec3(1.0), k, uContrast);
        full = mix(full, fl.rgb, fl.a);
        c += full * uLampColor * lampK(normalize(vN));

        gl_FragColor = vec4(mix(c, uHaze, haze), 1.0);
      }
    `,
  });
}
