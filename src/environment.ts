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
  private _right = new THREE.Vector3();

  constructor(toon: THREE.Material, outline: THREE.Material, count = 9, seed = 7) {
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
   * Keep every cloud in the sky band for the current view. `halfW/halfH` are
   * the ortho half-extents in world units; `far` is the horizon distance.
   */
  update(camera: THREE.OrthographicCamera, target: THREE.Vector3, far: number, dt: number) {
    const halfH = (camera.top - camera.bottom) / 2 / camera.zoom;
    const halfW = (camera.right - camera.left) / 2 / camera.zoom;
    const fwd = this._fwd.subVectors(target, camera.position).setY(0).normalize();
    const right = this._right.set(-fwd.z, 0, fwd.x);
    const viewAz = Math.atan2(fwd.x, fwd.z);
    const el = Math.asin(Math.min(0.999, Math.max(0.001, (camera.position.y - target.y) / camera.position.distanceTo(target))));
    const horizonY = far * Math.sin(el); // screen-space height of the horizon above the view centre
    const skyVisible = horizonY < halfH * 0.98;
    for (const c of this.clouds) {
      c.az += dt * 0.004; // a slow drift
      const rel = Math.atan2(Math.sin(c.az - viewAz), Math.cos(c.az - viewAz));
      c.mesh.visible = skyVisible && Math.abs(rel) < 1.4;
      if (!c.mesh.visible) continue;
      // screen position: x from the angle, y inside the band above the horizon
      const x = Math.sin(rel) * halfW * 1.9;
      // keep the whole cloud on screen: a thin sky strip gets smaller, lower clouds
      const band = halfH - horizonY;
      const scale = c.size * Math.min(halfH * 0.11, band * 0.32);
      const y = horizonY + Math.max(scale * 0.4, (band - scale * 1.3) * (0.1 + c.band * 0.75));
      // put it just beyond the horizon, then lift it so it lands at y on screen
      const D = far * 1.05;
      const H = (y - D * Math.sin(el)) / Math.cos(el);
      c.mesh.position.copy(target).addScaledVector(fwd, D).addScaledVector(right, x);
      c.mesh.position.y = target.y + H;
      c.mesh.rotation.y = viewAz; // face the camera side-on (long axis across the screen)
      c.mesh.scale.setScalar(scale);
    }
    return horizonY;
  }
}
