import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { withRow } from './body';
import { ROWS } from './palette';
import type { FogUniforms } from './materials';
import { mulberry32 } from './rng';

/**
 * Sky and clouds behind the hazy horizon.
 *
 * The camera is orthographic, so "the horizon" is simply where the ground
 * fades out (FogUniforms.uFogFar along the view direction). The sky is a
 * screen-space gradient that starts at that line; the clouds are real toon
 * meshes kept in the sky band, sliding past as the camera orbits.
 */


export function createSky(fog: FogUniforms) {
  const mat = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uHaze: fog.uHaze,
      // (created here, not at module load: main turns colour management off first)
      uTop: { value: new THREE.Color('#5aa0e2') },
      uHorizon: { value: 0 }, // NDC y of the horizon line
      uRes: { value: new THREE.Vector2(1, 1) },
      uGlow: { value: new THREE.Color('#f08a3a') }, // sunset glow around the sun
      uGlowAmt: { value: 0 },
      uSunX: { value: 0 }, // NDC x of the sun
      uStars: { value: 0 }, // 0 = day … 1 = full night
      uStarShift: { value: 0 }, // pixels: stars slide sideways as the view turns
      uStarWrap: { value: 1 }, // pixels: once round the sky (the star field repeats after a full turn)
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      void main() { gl_Position = vec4(position.xy, 0.9999, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHaze;
      uniform vec3 uTop;
      uniform float uHorizon;
      uniform vec2 uRes;
      uniform vec3 uGlow;
      uniform float uGlowAmt;
      uniform float uSunX;
      uniform float uStars;
      uniform float uStarShift;
      uniform float uStarWrap;
      uniform float uTime;
      // (no sin(): the classic sin hash falls apart into stripes and tiles once
      // its argument gets large, which pixel coordinates easily make it)
      float hash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      void main() {
        vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
        // a quick haze band at the horizon, then the sky colour
        float t = clamp((ndc.y - uHorizon) / 0.3, 0.0, 1.0);
        t = floor(t * 4.0 + 0.5) / 4.0; // a few flat bands, pixel-art style
        vec3 c = mix(uHaze, uTop, t);

        // sunset glow: a wide, low lens of the glow colour centred on the sun
        float dx = (ndc.x - uSunX) * uRes.x / uRes.y;
        float dy = max(ndc.y - uHorizon, 0.0);
        float g = exp(-dx * dx / 0.9 - dy * dy / 0.08) * uGlowAmt;
        g = floor(g * 4.0 + 0.3) / 4.0; // banded too
        c = mix(c, uGlow, g * 0.85);

        // stars: single pixels on a hashed grid, only above the haze, gently twinkling
        if (uStars > 0.0 && t > 0.2) {
          vec2 px = floor(gl_FragCoord.xy + vec2(uStarShift, 0.0));
          px.x = mod(px.x, uStarWrap); // seamless all the way round
          float h = hash(px);
          if (h > 0.992) {
            float tw = 0.65 + 0.35 * sin(uTime * (1.0 + 3.0 * hash(px + 7.0)) + h * 400.0);
            float b = uStars * smoothstep(0.2, 0.6, t) * tw * (0.55 + 0.45 * hash(px + 3.0));
            c = mix(c, vec3(1.0, 0.98, 0.9), b);
          }
        }
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -10; // drawn first; everything else paints over it
  return sky;
}

interface Cloud {
  mesh: THREE.Object3D;
  az: number; // world azimuth it sits toward
  band: number; // 0 just above the horizon … 1 top of the screen
  size: number;
}

export class Clouds {
  readonly group = new THREE.Group();
  private clouds: Cloud[] = [];
  private _fwd = new THREE.Vector3();

  constructor(toon: THREE.Material, outline: THREE.Material, count = 26, seed = 7) {
    const r = mulberry32(seed);
    for (let k = 0; k < count; k++) {
      // a cloud: a row of overlapping puffs, biggest in the middle, flat-ish bottom
      const n = 4 + Math.floor(r() * 4);
      const puffs: THREE.BufferGeometry[] = [];
      for (let i = 0; i < n; i++) {
        const u = n > 1 ? i / (n - 1) - 0.5 : 0;
        const rad = (0.55 + 0.45 * Math.cos(u * Math.PI)) * (0.8 + r() * 0.4);
        const g = withRow(new THREE.SphereGeometry(rad, 10, 7), ROWS.cloud[0]);
        g.scale(1, 0.8, 0.8);
        g.translate(u * n * 0.7, rad * 0.45 + r() * 0.15, (r() - 0.5) * 0.4);
        puffs.push(g);
      }
      const geo = mergeGeometries(puffs)!;
      puffs.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(geo, toon);
      const o = new THREE.Mesh(geo, outline);
      o.raycast = () => {};
      mesh.add(o);
      mesh.raycast = () => {};
      this.group.add(mesh);
      this.clouds.push({ mesh, az: (k / count) * Math.PI * 2 + r() * 0.5, band: 0.2 + r() * 0.65, size: 0.6 + r() * 0.6 });
    }
  }

  /**
   * Clouds are real objects in the world, just beyond the horizon at fixed
   * heights and sizes, so zooming and orbiting treat them like everything
   * else. Only their ring follows the view centre and the horizon distance.
   */
  update(camera: THREE.OrthographicCamera, target: THREE.Vector3, far: number, dt: number) {
    const fwd = this._fwd.subVectors(target, camera.position).setY(0).normalize();
    const viewAz = Math.atan2(fwd.x, fwd.z);
    for (const c of this.clouds) {
      c.az += dt * 0.004; // a slow drift
      const rel = Math.atan2(Math.sin(c.az - viewAz), Math.cos(c.az - viewAz));
      c.mesh.visible = Math.cos(rel) > 0.15; // only the ones on the far side
      if (!c.mesh.visible) continue;
      const D = far * 1.12;
      c.mesh.position.set(target.x + Math.sin(c.az) * D, 0.4 + c.band * 1.7, target.z + Math.cos(c.az) * D);
      c.mesh.rotation.y = viewAz; // long axis across the view
      c.mesh.scale.setScalar(0.4 + c.size * 0.5);
    }
  }
}

/**
 * A flat pixel-art sun (or moon) on the far side of the horizon, in its
 * direction. It sits just past the horizon (in an ortho view anything further
 * back is drawn higher up) and is drawn before everything else, so clouds pass
 * in front of it and, once it dips below the horizon, the hazy ground does too.
 * Like the clouds it's only shown when it's on the far side of the view: with
 * it behind the camera, it's behind you too.
 */
export class Sun {
  readonly group = new THREE.Group();
  /** World position it's drawn at, even when hidden (for the sky's glow). */
  readonly at = new THREE.Vector3();
  /** How much it faces the view direction (−1…1). */
  facing = 0;
  private _fwd = new THREE.Vector3();
  private core: THREE.MeshBasicMaterial;

  constructor(kind: 'sun' | 'moon' = 'sun') {
    // Drawn in the opaque pass right after the sky, without depth: everything
    // else (clouds, ground, people) paints over it. The halo rings glow additively,
    // because blending only happens in the transparent pass, which runs last.
    const disc = (r: number, color: string, glow: number, order: number) => {
      const mat = new THREE.MeshBasicMaterial({
        color, depthTest: false, depthWrite: false, fog: false,
        ...(glow < 1 ? { blending: THREE.AdditiveBlending, opacity: glow } : {}),
      });
      const m = new THREE.Mesh(new THREE.CircleGeometry(r, 24), mat);
      m.renderOrder = order;
      m.frustumCulled = false;
      m.raycast = () => {};
      this.group.add(m);
      return m;
    };
    if (kind === 'sun') {
      // stepped halo rings, then the disc: flat bands, no gradients
      disc(1.25, '#fff2c8', 0.07, -9);
      disc(0.95, '#fff2c8', 0.1, -8);
      this.core = disc(0.62, '#fff4c4', 1, -7).material as THREE.MeshBasicMaterial;
    } else {
      disc(0.85, '#9fb4e0', 0.08, -9);
      this.core = disc(0.42, '#e8ecf2', 1, -7).material as THREE.MeshBasicMaterial;
      // a few darker "seas"
      for (const [x, y, r] of [[-0.12, 0.1, 0.12], [0.13, -0.05, 0.09], [0.02, -0.2, 0.07]]) disc(r, '#c3cad8', 1, -6).position.set(x, y, 0);
    }
  }

  setColor(c: THREE.Color) {
    this.core.color.copy(c);
  }

  /** `dir`: unit vector towards it (world); may point below the horizon. */
  update(camera: THREE.OrthographicCamera, target: THREE.Vector3, far: number, dir: THREE.Vector3) {
    const fwd = this._fwd.subVectors(target, camera.position).setY(0).normalize();
    const h = Math.hypot(dir.x, dir.z);
    const el = Math.atan2(dir.y, h);
    this.facing = h > 0.05 ? (dir.x * fwd.x + dir.z * fwd.z) / h : 0;
    const D = far * 1.02;
    // el 0° puts the disc's centre a little above the horizon line; below that it
    // sinks quickly into the haze (the ground paints over it) and is gone by −8°
    const deg = THREE.MathUtils.radToDeg(el);
    const y = deg >= 0 ? 0.15 + (deg / 90) * 2.6 : 0.15 + deg * 0.12;
    this.at.set(target.x + (h > 1e-4 ? dir.x / h : 0) * D, y, target.z + (h > 1e-4 ? dir.z / h : 0) * D);
    this.group.visible = h > 0.05 && this.facing > 0.15 && deg > -8;
    if (!this.group.visible) return;
    this.group.position.copy(this.at);
    this.group.quaternion.copy(camera.quaternion); // billboard
  }
}
