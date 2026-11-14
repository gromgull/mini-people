import * as THREE from 'three';
import { withRow } from './body';
import { ROWS } from './palette';
import { mulberry32 } from './rng';
import { type Part, bake, wobble } from './trees';

/**
 * A pond at a fixed spot: a noise-wobbled blob outline, drawn as three flat
 * layers (a sandy shore rim, the water, a deeper middle) like the ground's
 * patches, with a few clumps of lumpy stones along the edge.
 */
export class Pond {
  readonly group = new THREE.Group();
  private layers: { mesh: THREE.Mesh; outer: () => THREE.Vector2[]; hole: (() => THREE.Vector2[]) | null }[] = [];
  private waterScale = 1;
  private deepScale = 0.55;
  private radius: (t: number) => number;

  constructor(toon: THREE.Material, outline: THREE.Material, readonly x = 10, readonly z = 5, readonly R = 2.6, seed = 5) {
    const r = mulberry32(seed);
    // outline radius as a sum of a few low harmonics: a blob, never a star
    const harm = [2, 3, 4, 5].map((k) => ({ k, a: (0.22 / k) * (0.5 + r()), ph: r() * Math.PI * 2 }));
    const radius = (this.radius = (t: number) => R * (1 + harm.reduce((s, h) => s + h.a * Math.sin(h.k * t + h.ph), 0)) * (1 + 0.25 * Math.cos(t))); // a bit oblong
    const N = 30; // few enough segments that the edge reads as low-poly facets

    const ring = (grow: number, scale: number) => {
      const pts: THREE.Vector2[] = [];
      for (let i = 0; i < N; i++) {
        const t = (i / N) * Math.PI * 2;
        const d = radius(t) * scale + grow;
        pts.push(new THREE.Vector2(Math.cos(t) * d, Math.sin(t) * d));
      }
      return pts;
    };
    // Layers are rings that don't overlap (each has a hole where the next one
    // goes): stacked flat layers z-fight at grazing angles. Drawn after the
    // ground (renderOrder) so they win ties with it, and slightly above the
    // drop shadows (0.002) so shadows don't draw on the water.
    const layer = (outer: () => THREE.Vector2[], hole: (() => THREE.Vector2[]) | null, row: number) => {
      const m = new THREE.Mesh(withRow(this.shapeGeo(outer, hole), row), toon);
      m.position.set(x, 0.004, z);
      m.renderOrder = 1;
      m.raycast = () => {};
      this.group.add(m);
      this.layers.push({ mesh: m, outer, hole });
    };
    // the shore's outer edge is fixed; the water edge and the deep middle pulse
    const shore = () => ring(0.22, 1), water = () => ring(0, this.waterScale), deep = () => ring(0, this.deepScale);
    layer(shore, water, ROWS.shore[0]);
    layer(water, deep, ROWS.water[0]);
    layer(deep, null, ROWS.water[1]);

    // stones: a few clumps at random spots along the rim, straddling the edge
    const parts: Part[] = [];
    const clumps = 4 + Math.floor(r() * 3);
    for (let c = 0; c < clumps; c++) {
      const t0 = r() * Math.PI * 2;
      const n = 2 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        const t = t0 + (r() - 0.5) * 0.5;
        const d = radius(t) + (r() - 0.35) * 0.35;
        const size = 0.07 + r() * r() * 0.22;
        const g = new THREE.IcosahedronGeometry(size, 1);
        const n3 = wobble(Math.floor(r() * 1e9));
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const v = new THREE.Vector3();
        for (let k = 0; k < pos.count; k++) {
          v.fromBufferAttribute(pos, k);
          v.multiplyScalar(1 + 0.3 * n3(v.clone().divideScalar(size)));
          pos.setXYZ(k, v.x, v.y * 0.55, v.z); // flattened
        }
        g.rotateY(r() * Math.PI);
        g.translate(x + Math.cos(t) * d, size * 0.2, z - Math.sin(t) * d); // sunk a little into the ground (outline angle t is world (cos t, −sin t))
        parts.push({ geo: g, row: ROWS.stone[Math.floor(r() * ROWS.stone.length)] });
      }
    }
    const { flat, smooth } = bake(parts);
    const mesh = new THREE.Mesh(flat, toon);
    const hull = new THREE.Mesh(smooth, outline);
    mesh.raycast = hull.raycast = () => {};
    this.group.add(mesh, hull);
  }

  /** How far the water reaches from the middle in a world direction (dx, dz); the sandy shore goes 0.22 further. */
  edge(dx: number, dz: number) {
    return this.radius(Math.atan2(-dz, dx)) * this.waterScale;
  }

  /** The widest the water gets. */
  get maxR() {
    let m = 0;
    for (let i = 0; i < 64; i++) m = Math.max(m, this.radius((i / 64) * Math.PI * 2));
    return m;
  }

  private shapeGeo(outer: () => THREE.Vector2[], hole: (() => THREE.Vector2[]) | null) {
    const shape = new THREE.Shape(outer());
    if (hole) shape.holes.push(new THREE.Path(hole()));
    return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
  }

  /**
   * Slow breathing: the water's edge and the deep middle swell and shrink on
   * their own unhurried cycles. The outlines keep their vertex order, so the
   * first triangulation stays valid and only positions are copied over.
   */
  update(t: number) {
    if (!this.group.visible) return;
    this.waterScale = 1 - 0.03 + 0.03 * Math.sin((t * Math.PI * 2) / 7);
    this.deepScale = 0.55 + 0.06 * Math.sin((t * Math.PI * 2) / 9 + 1.3);
    for (const l of this.layers) {
      const fresh = this.shapeGeo(l.outer, l.hole);
      const dst = l.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      dst.copyArray(fresh.getAttribute('position').array as Float32Array);
      dst.needsUpdate = true;
      fresh.dispose();
    }
  }
}
