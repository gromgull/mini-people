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
 * One shared toon material for everything: lighting picks the column,
 * the per-vertex `aRow` attribute picks the colour ramp in the atlas.
 */
export function createToonMaterial(atlas: THREE.Texture, fog: FogUniforms = createFog(1e9)) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...fog,
      uAtlas: { value: atlas },
      uRows: { value: ROW_COUNT },
      uLightView: { value: new THREE.Vector3(0, 1, 0) },
      uWrap: { value: 0.35 },
    },
    vertexShader: /* glsl */ `
      attribute float aRow;
      varying vec3 vN;
      varying float vRow;
      varying vec3 vWorld;
      void main() {
        vN = normalize(normalMatrix * normal);
        vRow = aRow;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform float uRows;
      uniform vec3 uLightView;
      uniform float uWrap;
      varying vec3 vN;
      varying float vRow;
      ${FOG_GLSL}
      void main() {
        float haze = fogAmount();
        float ndl = dot(normalize(vN), uLightView);
        // wrapped lambert: uWrap=0 → plain lambert, 1 → half-lambert
        float u = clamp((ndl + uWrap) / (1.0 + uWrap), 0.001, 0.999);
        vec3 c = texture2D(uAtlas, vec2(u, (vRow + 0.5) / uRows)).rgb;
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
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
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
