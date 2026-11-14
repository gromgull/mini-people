import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { withRow } from '../body';
import { ROWS } from '../palette';
import { mulberry32 } from '../rng';
import type { Stage } from '../stage';
import { type Caster, type Part, bake, scatter, wobble } from '../trees';

/**
 * The orchard: low apple trees (the crown starts about waist high, so the
 * apples hang within reach) and every apple a thing of its own that can be
 * picked, leaving a gap that grows back. Trees are one merged mesh; the
 * apples are instanced, each shown, hidden, or growing.
 */

export type AppleState = 'ripe' | 'gone' | 'growing';

export interface Apple {
  id: number;
  tree: number;
  pos: THREE.Vector3; // world, its middle
  state: AppleState;
  until: number;
  grow: number;
  claimedBy: number;
}

const REGROW = 90; // seconds before a new one shows
const RIPEN = 60; // seconds it takes to grow
const APPLE_R = 0.065;

export class Orchard {
  readonly group = new THREE.Group();
  readonly trees: { x: number; z: number; R: number; cy: number; caster: Caster }[] = [];
  readonly apples: Apple[] = [];
  private inst: THREE.InstancedMesh[] = [];
  private dirty = true;

  constructor(stage: Stage, cx: number, cz: number, R: number, n: number, seed = 41) {
    const r = mulberry32(seed);
    const parts: Part[] = [];
    for (const spot of scatter(r, cx, cz, R, n, 2.5)) {
      const s = 0.9 + r() * 0.2;
      const trunkH = 0.72 * s;
      const CR = 0.5 * s;
      const cy = trunkH + CR * 0.45;
      parts.push({ geo: new THREE.CylinderGeometry(0.05 * s, 0.085 * s, trunkH + CR * 0.3, 6).translate(spot.x, (trunkH + CR * 0.3) / 2, spot.z), row: ROWS.bark[Math.floor(r() * 2)] });
      // a lumpy crown, a little squashed
      const crown = mergeVertices(new THREE.IcosahedronGeometry(CR, 1));
      const wob = wobble(Math.floor(r() * 1e9));
      const pos = crown.getAttribute('position') as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        v.multiplyScalar(1 + 0.2 * wob(v.clone().divideScalar(CR)));
        pos.setXYZ(i, v.x + spot.x, v.y * 0.85 + cy, v.z + spot.z);
      }
      parts.push({ geo: crown, row: ROWS.leaf[Math.floor(r() * 3)] });
      const ti = this.trees.length;
      // apples round the lower, outer crown, just proud of the leaves
      for (let k = 0; k < 9; k++) {
        const az = r() * Math.PI * 2;
        const el = -0.55 + r() * 0.8; // the lower half, in reach
        const dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
        const d = CR * (1 + 0.2 * wob(dir)) + APPLE_R * 0.4;
        const p = new THREE.Vector3(spot.x + dir.x * d, cy + dir.y * d * 0.85, spot.z + dir.z * d);
        this.apples.push({ id: this.apples.length, tree: ti, pos: p, state: 'ripe', until: 0, grow: 1, claimedBy: -1 });
      }
      const caster = stage.makeCaster(CR * 0.8, cy + CR * 0.8);
      caster.pivot.position.set(spot.x, 0.002, spot.z);
      this.group.add(caster.pivot);
      this.trees.push({ x: spot.x, z: spot.z, R: CR, cy, caster });
    }
    const { flat, smooth } = bake(parts);
    const trees = new THREE.Mesh(flat, stage.toon);
    const hull = new THREE.Mesh(smooth, stage.outline);
    trees.raycast = hull.raycast = () => {};
    this.group.add(trees, hull);
    // apples: one instanced toon + outline mesh
    const ag = withRow(new THREE.IcosahedronGeometry(APPLE_R, 1).scale(1, 0.92, 1), ROWS.apple[0]);
    const { flat: af, smooth: as } = bake([{ geo: ag, row: ROWS.apple[0] }]);
    for (const [g, m] of [[af, stage.toon], [as, stage.outline]] as const) {
      const im = new THREE.InstancedMesh(g, m, this.apples.length);
      im.frustumCulled = false;
      im.raycast = () => {};
      this.inst.push(im);
      this.group.add(im);
    }
    stage.scene.add(this.group);
  }

  /** It's been picked (the picker holds it now). */
  picked(a: Apple, now: number) {
    a.state = 'gone';
    a.until = now + REGROW * (0.8 + Math.random() * 0.4);
    a.claimedBy = -1;
    this.dirty = true;
  }

  /** Ripe apples nobody has claimed, hanging no higher than `maxY`. */
  ripe(maxY: number) {
    return this.apples.filter((a) => a.state === 'ripe' && a.claimedBy < 0 && a.pos.y <= maxY);
  }

  update(now: number) {
    for (const a of this.apples) {
      if (a.state === 'gone' && now >= a.until) {
        a.state = 'growing';
        a.grow = 0.15;
        a.until = now + RIPEN;
        this.dirty = true;
      } else if (a.state === 'growing') {
        const g = Math.min(1, 1 - (a.until - now) / RIPEN);
        if (g - a.grow > 0.02 || g >= 1) {
          a.grow = g;
          this.dirty = true;
        }
        if (g >= 1) a.state = 'ripe';
      }
    }
    if (!this.dirty) return;
    this.dirty = false;
    const m = new THREE.Matrix4();
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const a of this.apples) {
      const s = a.state === 'gone' ? 0 : a.state === 'growing' ? Math.max(0.15, a.grow) : 1;
      const mat = s > 0 ? m.makeScale(s, s, s).setPosition(a.pos) : zero;
      for (const im of this.inst) im.setMatrixAt(a.id, mat);
    }
    for (const im of this.inst) im.instanceMatrix.needsUpdate = true;
  }

  orientShadows(stage: Stage) {
    for (const t of this.trees) stage.orient(t.caster, 0);
  }
}
