import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { withRow } from './body';
import { ROWS } from './palette';
import { mulberry32 } from './rng';

/**
 * Scenery: a little pine forest off to one side and a glade of apple trees
 * elsewhere. All trees of a kind are merged into one toon mesh and one outline
 * mesh (two draw calls per kind). The toon geometry is faceted (flat normals,
 * for the low-poly look); the outline hull uses a welded, smooth-normal copy
 * so it doesn't crack open along the facet edges.
 */

/** A drop shadow the main loop stretches away from the sun, like people's. */
export interface Caster {
  pivot: THREE.Object3D;
  shadow: THREE.Mesh;
  r: number; // footprint radius
  h: number; // height (sets how long the shadow gets)
}

export type Part = { geo: THREE.BufferGeometry; row: number };

const pick = <T>(r: () => number, a: readonly T[]) => a[Math.floor(r() * a.length)];

/** Smooth, deterministic 3D wobble: same input position → same output, so welded seams stay closed. */
export function wobble(seed: number) {
  const r = mulberry32(seed);
  const waves = Array.from({ length: 5 }, () => ({
    d: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(2 + r() * 3),
    ph: r() * Math.PI * 2,
  }));
  return (p: THREE.Vector3) => waves.reduce((s, w) => s + Math.sin(p.dot(w.d) + w.ph), 0) / waves.length;
}

function pine(r: () => number): { parts: Part[]; h: number; rad: number } {
  const s = 0.8 + r() * 0.45;
  const row = pick(r, ROWS.pine);
  const parts: Part[] = [];
  const trunkH = 0.35 * s;
  parts.push({ geo: new THREE.CylinderGeometry(0.07 * s, 0.09 * s, trunkH, 6).translate(0, trunkH / 2, 0), row: pick(r, ROWS.bark) });
  // three cones, each smaller and higher, overlapping the one below
  let y = trunkH * 0.7;
  const tiers = [
    { rad: 0.75, h: 1.0 },
    { rad: 0.58, h: 0.85 },
    { rad: 0.4, h: 0.75 },
  ];
  for (const t of tiers) {
    const h = t.h * s;
    const g = new THREE.ConeGeometry(t.rad * s, h, 7, 1);
    g.rotateY(r() * Math.PI); // facets don't line up tier to tier
    g.translate(0, y + h / 2, 0);
    parts.push({ geo: g, row });
    y += h * 0.55;
  }
  return { parts, h: y + tiers[2].h * s * 0.45, rad: tiers[0].rad * s };
}

function appleTree(r: () => number, seed: number): { parts: Part[]; h: number; rad: number } {
  const s = 0.85 + r() * 0.3;
  const parts: Part[] = [];
  const trunkH = 1.0 * s;
  const trunk = new THREE.CylinderGeometry(0.06 * s, 0.1 * s, trunkH, 6).translate(0, trunkH / 2, 0);
  parts.push({ geo: trunk, row: pick(r, ROWS.bark) });

  // crown: an icosphere pushed in and out by a smooth noise, a bit squashed
  const R = 0.7 * s;
  const cy = trunkH + R * 0.55;
  const crown = mergeVertices(new THREE.IcosahedronGeometry(R, 1)); // welded, so displacement keeps it closed
  const n = wobble(seed);
  const pos = crown.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.multiplyScalar(1 + 0.22 * n(v.clone().divideScalar(R)));
    v.y *= 0.85;
    pos.setXYZ(i, v.x, v.y + cy, v.z);
  }
  parts.push({ geo: crown, row: pick(r, ROWS.leaf) });

  // apples hang on the lower, outer part of the crown
  const apples = 5 + Math.floor(r() * 6);
  for (let k = 0; k < apples; k++) {
    const az = r() * Math.PI * 2;
    const el = -0.15 + r() * 0.75; // mostly the lower half
    const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el) * 0.85, Math.cos(el) * Math.sin(az));
    const d = R * (1 + 0.22 * n(dir)) * 1.0;
    const a = new THREE.IcosahedronGeometry(0.065 * s, 0);
    a.translate(dir.x * d, dir.y * d + cy, dir.z * d);
    parts.push({ geo: a, row: pick(r, ROWS.apple) });
  }
  return { parts, h: cy + R * 0.85, rad: R };
}

/** Faceted toon copy (flat normals) and a smooth, welded copy for the outline hull. */
export function bake(parts: Part[]) {
  const flat: THREE.BufferGeometry[] = [];
  const smooth: THREE.BufferGeometry[] = [];
  for (const { geo, row } of parts) {
    geo.deleteAttribute('uv');
    geo.deleteAttribute('normal');
    const welded = mergeVertices(geo);
    welded.computeVertexNormals();
    smooth.push(withRow(welded, row));
    const f = (geo.index ? geo.toNonIndexed() : geo.clone());
    f.computeVertexNormals();
    flat.push(withRow(f, row));
    geo.dispose();
  }
  return { flat: mergeGeometries(flat)!, smooth: mergeGeometries(smooth)! };
}

/** Poisson-ish scatter in a disc: rejection with a minimum spacing. */
function scatter(r: () => number, cx: number, cz: number, R: number, n: number, minD: number) {
  const pts: { x: number; z: number }[] = [];
  for (let tries = 0; pts.length < n && tries < n * 60; tries++) {
    const a = r() * Math.PI * 2;
    const d = R * Math.sqrt(r());
    // squash the disc a little so groups aren't perfect circles
    const x = cx + Math.cos(a) * d * 1.25;
    const z = cz + Math.sin(a) * d * 0.8;
    if (pts.every((p) => Math.hypot(p.x - x, p.z - z) >= minD)) pts.push({ x, z });
  }
  return pts;
}

export class Trees {
  readonly group = new THREE.Group();
  readonly casters: Caster[] = [];

  constructor(toon: THREE.Material, outline: THREE.Material, shadowGeo: THREE.BufferGeometry, shadowMat: THREE.Material, seed = 11) {
    const r = mulberry32(seed);
    const pines: Part[] = [];
    const apples: Part[] = [];

    const place = (built: { parts: Part[]; h: number; rad: number }, x: number, z: number, into: Part[]) => {
      for (const p of built.parts) p.geo.translate(x, 0, z);
      into.push(...built.parts);
      const shadow = new THREE.Mesh(shadowGeo, shadowMat);
      shadow.raycast = () => {};
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.002, z);
      pivot.add(shadow);
      this.group.add(pivot);
      this.casters.push({ pivot, shadow, r: built.rad * 0.75, h: built.h });
    };

    // the forest: off to the left of the default view, a little behind the crowd
    for (const p of scatter(r, -16, 1, 4.5, 34, 0.95)) place(pine(r), p.x, p.z, pines);
    // the glade: a loose ring of apple trees back and to the right
    for (const p of scatter(r, 8, -13, 3.2, 7, 2.1)) place(appleTree(r, Math.floor(r() * 1e9)), p.x, p.z, apples);

    for (const parts of [pines, apples]) {
      const { flat, smooth } = bake(parts);
      const mesh = new THREE.Mesh(flat, toon);
      const hull = new THREE.Mesh(smooth, outline);
      mesh.raycast = hull.raycast = () => {};
      this.group.add(mesh, hull);
    }
  }
}
