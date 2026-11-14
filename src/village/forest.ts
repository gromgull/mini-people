import * as THREE from 'three';
import { mulberry32 } from '../rng';
import type { Stage } from '../stage';
import { type Caster, type PineSpec, bake, pineHeight, pineParts, scaleSpec, scatter, stumpPart, villagePine } from '../trees';

/**
 * The village forest: pines that can be chopped down, leave a stump, and
 * grow back. A handful of pine shapes are drawn instanced (each tree is one
 * shape at its own size and turn), so a forest costs a few draw calls but any
 * single tree can still disappear, be a stump, or be a sapling.
 *
 *   standing → felling (the chop draws the tree while it falls)
 *            → stump → growing (a sapling that grows back) → standing
 */

export type TreeState = 'standing' | 'felling' | 'stump' | 'growing';

export interface Tree {
  id: number;
  x: number;
  z: number;
  yaw: number;
  k: number; // size
  variant: number;
  state: TreeState;
  /** When the current state ends (stump → sapling, sapling → grown), in sim seconds. */
  until: number;
  grow: number; // sapling size 0..1
  stumpH: number; // cut height
  /** The person who has claimed it (−1 = free). */
  claimedBy: number;
  caster: Caster;
}

const VARIANTS = 4;
const STUMP_TIME = 60; // seconds a stump stands before a sapling appears
const GROW_TIME = 120; // seconds from sapling to full tree
const SAPLING = 0.2; // a sapling's starting size

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export class Forest {
  readonly group = new THREE.Group();
  readonly trees: Tree[] = [];
  readonly specs: PineSpec[] = [];
  private bodies: THREE.InstancedMesh[] = []; // per variant: toon, outline
  private stumps: THREE.InstancedMesh[] = [];
  private stumpSpec: PineSpec;
  private dirty = true;

  constructor(private stage: Stage, cx: number, cz: number, R: number, n: number, seed = 31) {
    const r = mulberry32(seed);
    for (let v = 0; v < VARIANTS; v++) this.specs.push(villagePine(r));
    const spots = scatter(r, cx, cz, R, n, 1.05);
    spots.forEach((p, id) => {
      const k = 0.85 + r() * 0.35;
      const tree: Tree = {
        id, x: p.x, z: p.z, yaw: r() * Math.PI * 2, k, variant: Math.floor(r() * VARIANTS),
        state: 'standing', until: 0, grow: 1, stumpH: 0, claimedBy: -1,
        caster: stage.makeCaster(0, 0),
      };
      tree.caster.pivot.position.set(p.x, 0.002, p.z);
      this.group.add(tree.caster.pivot);
      this.trees.push(tree);
    });
    // one instanced toon + outline mesh per shape, sized for every tree
    for (let v = 0; v < VARIANTS; v++) {
      const { flat, smooth } = bake(pineParts(this.specs[v]));
      for (const [geo, mat] of [[flat, stage.toon], [smooth, stage.outline]] as const) {
        const m = new THREE.InstancedMesh(geo, mat, this.trees.length);
        m.raycast = () => {};
        m.frustumCulled = false;
        this.bodies.push(m);
        this.group.add(m);
      }
    }
    // stumps: a unit-height stump, stretched to each cut height
    this.stumpSpec = { ...this.specs[0], trunkTop: 1, rt: 1 };
    const { flat, smooth } = bake([stumpPart(this.stumpSpec, 1)]);
    for (const [geo, mat] of [[flat, stage.toon], [smooth, stage.outline]] as const) {
      const m = new THREE.InstancedMesh(geo, mat, this.trees.length);
      m.raycast = () => {};
      m.frustumCulled = false;
      this.stumps.push(m);
      this.group.add(m);
    }
  }

  /** The tree's shape at its size (for the chop to rebuild exactly this tree). */
  specOf(t: Tree) {
    return scaleSpec(this.specs[t.variant], t.k);
  }

  /** The chop has taken over drawing everything above the cut; the stump (cut at cutH) is still ours. */
  fell(t: Tree, cutH: number) {
    t.state = 'felling';
    t.stumpH = cutH;
    this.dirty = true;
  }

  /** It's down: a stump of this height stays. */
  felled(t: Tree, cutH: number, now: number) {
    t.state = 'stump';
    t.stumpH = cutH;
    t.until = now + STUMP_TIME * (0.8 + Math.random() * 0.4);
    t.claimedBy = -1;
    this.dirty = true;
  }

  standing() {
    return this.trees.filter((t) => t.state === 'standing');
  }

  /** Regrowth, and the instance matrices when anything changed. */
  update(now: number) {
    for (const t of this.trees) {
      if (t.state === 'stump' && now >= t.until) {
        t.state = 'growing';
        t.grow = SAPLING;
        t.until = now + GROW_TIME * (0.8 + Math.random() * 0.4);
        this.dirty = true;
      } else if (t.state === 'growing') {
        const left = Math.max(0, t.until - now);
        const g = SAPLING + (1 - SAPLING) * (1 - left / GROW_TIME);
        if (Math.abs(g - t.grow) > 0.005 || left === 0) {
          t.grow = Math.min(1, g);
          this.dirty = true;
        }
        if (left === 0) {
          t.state = 'standing';
          t.grow = 1;
        }
      }
    }
    if (!this.dirty) return;
    this.dirty = false;
    for (const t of this.trees) {
      const showTree = t.state === 'standing' || t.state === 'growing';
      const size = t.k * (t.state === 'growing' ? t.grow : 1);
      _q.setFromAxisAngle(_Y, t.yaw);
      for (let v = 0; v < VARIANTS; v++) {
        const on = showTree && v === t.variant;
        const m = on ? _m.compose(_p.set(t.x, 0, t.z), _q, _s.setScalar(size)) : HIDDEN;
        this.bodies[v * 2].setMatrixAt(t.id, m);
        this.bodies[v * 2 + 1].setMatrixAt(t.id, m);
      }
      const stump = t.state === 'stump' || t.state === 'felling';
      const rt = this.specs[t.variant].rt * t.k;
      const sm = stump && t.stumpH > 0 ? _m.compose(_p.set(t.x, 0, t.z), _q, _s.set(rt, t.stumpH, rt)) : HIDDEN;
      for (const s of this.stumps) s.setMatrixAt(t.id, sm);
      // shadows follow what's there
      const spec = this.specs[t.variant];
      if (showTree) {
        t.caster.r = spec.tiers[0].rad * size * 0.75;
        t.caster.h = pineHeight(spec) * size;
      } else {
        t.caster.r = t.state === 'stump' ? rt * 1.2 : 0;
        t.caster.h = t.stumpH;
      }
      t.caster.pivot.visible = t.caster.r > 0;
    }
    for (const m of [...this.bodies, ...this.stumps]) m.instanceMatrix.needsUpdate = true;
  }

  /** Point every tree's shadow away from the light. */
  orientShadows() {
    for (const t of this.trees) if (t.caster.pivot.visible) this.stage.orient(t.caster, 0);
  }
}
