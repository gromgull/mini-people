import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { withRow } from '../body';
import { ROWS } from '../palette';
import { mulberry32 } from '../rng';
import type { Stage } from '../stage';

/**
 * The wheat field: side-by-side strips, each mown in one go (the farmer
 * walks down it swinging the scythe) and each on its own clock:
 *
 *   growing  sown, coming up green and getting taller (GROW game hours)
 *   ripe     gold, waiting for the scythe
 *   cut      stubble behind the scythe as it goes, the rest still standing
 *   stubble  all cut, resting till it's sown again (REST game hours)
 *
 * Times are in game hours since the first morning (the village's day and
 * hour), so a strip comes round again in a day and a half or so: some days
 * there's a lot to cut, some days a little. The field starts mixed.
 *
 * It's drawn as tufts (instanced): green ones, ripe ones with ears, and
 * stubble, each tuft shown in whichever its strip (and how far it's cut)
 * says; only redrawn when something's changed.
 */

export type StripState = 'growing' | 'ripe' | 'cut' | 'stubble';

export interface Strip {
  id: number;
  state: StripState;
  /** Game hours when it was sown (growing) or finished cutting (stubble). */
  since: number;
  /** How far down it's mown (0 … 1 of its length), while cut. */
  cutTo: number;
  /** Who's mowing it. */
  claimedBy: number;
}

/** Game hours to grow from sowing to ripe; to rest as stubble before it's sown again. */
const GROW = 20;
const REST = 14;
/** Tufts across a strip, and along it per metre. */
const ACROSS = 4;
const PER_M = 4;

export class Field {
  readonly group = new THREE.Group();
  readonly strips: Strip[] = [];
  /** One strip's width (m) and its length. */
  readonly stripW: number;
  private green: THREE.InstancedMesh;
  private gold: THREE.InstancedMesh;
  private stub: THREE.InstancedMesh;
  private tufts: { strip: number; x: number; z: number; along: number; h: number; yaw: number }[] = [];
  private dirty = true;
  private lastGrow = -1;

  /**
   * Centred on (x, z), turned by yaw; strips run along the field's local z
   * (its length), side by side along x.
   */
  constructor(stage: Stage, readonly x: number, readonly z: number, readonly yaw: number, readonly n = 6, readonly len = 5, width = 4.8, seed = 7) {
    this.stripW = width / n;
    const r = mulberry32(seed);
    for (let i = 0; i < n; i++) {
      // a mixed start: about half ripe, some coming up, some stubble
      const k = r();
      const state: StripState = k < 0.5 ? 'ripe' : k < 0.75 ? 'growing' : 'stubble';
      const since = state === 'growing' ? -GROW * (0.3 + 0.6 * r()) : state === 'stubble' ? -REST * (0.2 + 0.7 * r()) : 0;
      this.strips.push({ id: i, state, since, cutTo: 0, claimedBy: -1 });
    }
    for (let i = 0; i < n; i++)
      for (let a = 0; a < ACROSS; a++)
        for (let j = 0; j < len * PER_M; j++) {
          const along = (j + 0.5 + (r() - 0.5) * 0.6) / (len * PER_M);
          const lx = (i + (a + 0.5 + (r() - 0.5) * 0.5) / ACROSS) * this.stripW - width / 2;
          const lz = (along - 0.5) * len;
          this.tufts.push({ strip: i, x: lx, z: lz, along, h: 0.85 + 0.3 * r(), yaw: r() * Math.PI });
        }
    const blades = (h: number, row: number, ear: number | null) => {
      const g: THREE.BufferGeometry[] = [];
      for (let b = 0; b < 3; b++) {
        const lean = (b - 1) * 0.18;
        g.push(withRow(new THREE.BoxGeometry(0.014, h, 0.03).translate(0, h / 2, 0).rotateZ(lean).rotateY((b * Math.PI) / 3), row));
        if (ear !== null) g.push(withRow(new THREE.BoxGeometry(0.03, 0.09, 0.03).translate(0, h + 0.03, 0).rotateZ(lean).rotateY((b * Math.PI) / 3), ear));
      }
      return mergeGeometries(g)!;
    };
    const make = (geo: THREE.BufferGeometry) => {
      const m = new THREE.InstancedMesh(geo, stage.toon, this.tufts.length);
      m.raycast = () => {};
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };
    this.green = make(blades(0.32, ROWS.leaf[1], null));
    this.gold = make(blades(0.34, ROWS.food[2], ROWS.stockfish[0]));
    this.stub = make(blades(0.07, ROWS.stockfish[0], null));
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
    stage.scene.add(this.group);
  }

  /** Game hours since the first morning. */
  static clock(day: number, hours: number) {
    return (day - 1) * 24 + hours;
  }

  /** Time passes: strips grow ripe, stubble's sown again. */
  update(now: number) {
    for (const s of this.strips) {
      if (s.state === 'growing' && now - s.since >= GROW) {
        s.state = 'ripe';
        this.dirty = true;
      } else if (s.state === 'stubble' && now - s.since >= REST) {
        s.state = 'growing';
        s.since = now;
        this.dirty = true;
      }
    }
    // (growing strips get taller: redraw now and then)
    if (Math.abs(now - this.lastGrow) > 0.25) {
      this.lastGrow = now;
      if (this.strips.some((s) => s.state === 'growing')) this.dirty = true;
    }
    if (this.dirty) this.draw(now);
  }

  /** Mow strip i down to `to` (0 … 1 of its length). */
  cut(i: number, to: number) {
    const s = this.strips[i];
    if (s.state === 'ripe') s.state = 'cut';
    if (to > s.cutTo) {
      s.cutTo = Math.min(1, to);
      this.dirty = true;
    }
  }

  /** Strip i is all mown: stubble, resting from now. */
  finish(i: number, now: number) {
    const s = this.strips[i];
    s.state = 'stubble';
    s.since = now;
    s.cutTo = 0;
    s.claimedBy = -1;
    this.dirty = true;
  }

  /** A point on strip i's middle line, `along` (0 … 1) down it, in the world; and the way down it. */
  along(i: number, along: number) {
    const lx = (i + 0.5) * this.stripW - this.stripW * this.n * 0.5;
    const lz = (along - 0.5) * this.len;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return { x: this.x + lx * c + lz * s, z: this.z - lx * s + lz * c, yaw: this.yaw };
  }

  private draw(now: number) {
    this.dirty = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.tufts.forEach((t, k) => {
      const s = this.strips[t.strip];
      p.set(t.x, 0, t.z);
      q.setFromAxisAngle(up, t.yaw);
      const cut = s.state === 'stubble' || (s.state === 'cut' && t.along <= s.cutTo);
      const grow = s.state === 'growing' ? Math.max(0.08, Math.min(1, (now - s.since) / GROW)) : 1;
      m.compose(p, q, sc.set(1, t.h * grow, 1));
      this.green.setMatrixAt(k, !cut && s.state === 'growing' ? m : zero);
      this.gold.setMatrixAt(k, !cut && s.state !== 'growing' ? m : zero);
      m.compose(p, q, sc.set(1, t.h, 1));
      this.stub.setMatrixAt(k, cut ? m : zero);
    });
    for (const im of [this.green, this.gold, this.stub]) im.instanceMatrix.needsUpdate = true;
  }
}
