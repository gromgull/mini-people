import * as THREE from 'three';
import { ROW_COUNT } from './palette';

/**
 * One shared toon material for everything: lighting picks the column,
 * the per-vertex `aRow` attribute picks the colour ramp in the atlas.
 */
export function createToonMaterial(atlas: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlas },
      uRows: { value: ROW_COUNT },
      uLightView: { value: new THREE.Vector3(0, 1, 0) },
      uWrap: { value: 0.35 },
    },
    vertexShader: /* glsl */ `
      attribute float aRow;
      varying vec3 vN;
      varying float vRow;
      void main() {
        vN = normalize(normalMatrix * normal);
        vRow = aRow;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform float uRows;
      uniform vec3 uLightView;
      uniform float uWrap;
      varying vec3 vN;
      varying float vRow;
      void main() {
        float ndl = dot(normalize(vN), uLightView);
        // wrapped lambert: uWrap=0 → plain lambert, 1 → half-lambert
        float u = clamp((ndl + uWrap) / (1.0 + uWrap), 0.001, 0.999);
        vec3 c = texture2D(uAtlas, vec2(u, (vRow + 0.5) / uRows)).rgb;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
}

/**
 * Inverted-hull outline with a constant width in (render-target) pixels:
 * the vertex is pushed along its screen-space normal direction.
 */
export function createOutlineMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      uColor: { value: new THREE.Color('#1a1410') },
      uPx: { value: 1.0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      uniform float uPx;
      uniform vec2 uResolution;
      void main() {
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
      void main() { gl_FragColor = vec4(uColor, 1.0); }
    `,
  });
}
