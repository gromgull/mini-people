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
    },
    vertexShader: /* glsl */ `
      void main() { gl_Position = vec4(position.xy, 0.9999, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHaze;
      uniform vec3 uTop;
      uniform float uHorizon;
      uniform vec2 uRes;
      void main() {
        float y = gl_FragCoord.y / uRes.y * 2.0 - 1.0;
        // a quick haze band at the horizon, then plain blue
        float t = clamp((y - uHorizon) / 0.3, 0.0, 1.0);
        t = floor(t * 4.0 + 0.5) / 4.0; // a few flat bands, pixel-art style
        gl_FragColor = vec4(mix(uHaze, uTop, t), 1.0);
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
