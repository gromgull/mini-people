import * as THREE from 'three';
import { ROWS } from '../palette';
import type { Stage } from '../stage';
import { type Part, bake } from '../trees';
import { PIECE_L, PIECE_R } from '../firewood';

/**
 * The things the woodcutting chain moves around: logs, the woodpile they
 * wait on, and the sawhorse they're cut on. Each log is a real object with an
 * id and a place (on the ground, carried by someone, in the pile, on the
 * sawhorse), so the village can check none are lost or duplicated.
 */

export const LOG_R = 0.065;
export const LOG_L = 0.8;

export type LogPlace = { at: 'ground'; x: number; z: number; yaw: number } | { at: 'carried'; by: number } | { at: 'pile'; slot: number } | { at: 'horse' };

export interface Log {
  id: number;
  place: LogPlace;
  mesh: THREE.Object3D;
  /** Someone's on their way to pick it up (−1 = nobody). */
  claimedBy: number;
}

let logGeo: { flat: THREE.BufferGeometry; smooth: THREE.BufferGeometry } | null = null;
/** A short pine log along x, bark with pale cut ends. */
function logGeometry() {
  if (logGeo) return logGeo;
  const parts: Part[] = [{ geo: new THREE.CylinderGeometry(LOG_R, LOG_R, LOG_L, 7).rotateZ(Math.PI / 2), row: ROWS.bark[0] }];
  for (const e of [-1, 1]) parts.push({ geo: new THREE.CylinderGeometry(LOG_R * 0.82, LOG_R * 0.82, 0.006, 7).rotateZ(Math.PI / 2).translate((e * LOG_L) / 2, 0, 0), row: ROWS.food[0] });
  logGeo = bake(parts);
  return logGeo;
}

function outlined(g: { flat: THREE.BufferGeometry; smooth: THREE.BufferGeometry }, stage: Stage) {
  const m = new THREE.Mesh(g.flat, stage.toon);
  const o = new THREE.Mesh(g.smooth, stage.outline);
  m.raycast = o.raycast = () => {};
  m.add(o);
  return m;
}

/** Logs stacked in a little pyramid between two stakes, along the pile's x. */
export class Woodpile {
  readonly group = new THREE.Group();
  readonly slots: THREE.Vector3[] = [];
  readonly logs: (Log | null)[];
  /** Logs promised to the pile (on their way). */
  incoming = 0;

  constructor(stage: Stage, readonly x: number, readonly z: number, readonly yaw: number) {
    const d = LOG_R * 2.05;
    for (const [row, n] of [[0, 3], [1, 2], [2, 1]]) {
      for (let i = 0; i < n; i++) this.slots.push(new THREE.Vector3(0, LOG_R + row * d * 0.86, (i - (n - 1) / 2) * d));
    }
    this.logs = this.slots.map(() => null);
    // a couple of stakes and two bearers keep it off the ground
    const parts: Part[] = [];
    for (const sx of [-1, 1]) {
      parts.push({ geo: new THREE.BoxGeometry(0.05, 0.03, 4 * d).translate(sx * LOG_L * 0.3, 0.015, 0), row: ROWS.log[1] });
      for (const sz of [-1, 1]) parts.push({ geo: new THREE.BoxGeometry(0.035, 0.42, 0.035).translate(sx * LOG_L * 0.3, 0.21, sz * 1.7 * d), row: ROWS.log[0] });
    }
    for (const s of this.slots) s.y += 0.03;
    this.group.add(outlined(bake(parts), stage));
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
    stage.scene.add(this.group);
  }

  get count() {
    return this.logs.filter(Boolean).length;
  }

  /** The first free slot, bottom up. */
  freeSlot() {
    return this.logs.findIndex((l) => !l);
  }

  /** Logs actually lying on it (not still being put down). */
  get ready() {
    return this.logs.filter((l) => l && l.place.at === 'pile').length;
  }

  /** The topmost log that's settled on the pile (taken first). */
  topSlot() {
    for (let i = this.logs.length - 1; i >= 0; i--) if (this.logs[i]?.place.at === 'pile') return i;
    return -1;
  }

  /** Where slot i is, in the world. */
  slotWorld(i: number, out = new THREE.Vector3()) {
    this.group.updateMatrixWorld();
    return out.copy(this.slots[i]).applyMatrix4(this.group.matrixWorld);
  }

  /** Stand here (and face the pile) to put a log on it or take one off; `along` shifts it along the pile. */
  workSpot(out = new THREE.Vector3(), along = 0) {
    // in front of the pile's long side
    return out.set(this.x, 0, this.z).add(new THREE.Vector3(along, 0, 0.62).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw));
  }
}

/**
 * A sawhorse: two X trestles carrying a log at the height of its owner's
 * saw stroke (see Actor.sawFit), and a spot where they stand to saw.
 */
export class Sawhorse {
  readonly group = new THREE.Group();
  log: Log | null = null;
  /** Firewood just sawn, still lying on the sawhorse. */
  pieces: Piece[] = [];
  claimedBy = -1;
  /** Where the log lies (world), and its yaw (along the horse). */
  readonly logAt = new THREE.Vector3();

  constructor(
    stage: Stage,
    readonly x: number,
    readonly z: number,
    readonly yaw: number,
    /** From Actor.sawFit for the owner: the cut point (owner's root frame), log centre height and radius, trestle spots. */
    readonly fit: { cut: THREE.Vector3; y: number; r: number; len: number; trestles: { x: number; h: number }[] },
  ) {
    const parts: Part[] = [];
    const top = fit.y - fit.r * 0.6;
    for (const t of fit.trestles) {
      // an X of two legs across the log, and a short top bar
      for (const s of [-1, 1]) {
        const leg = new THREE.BoxGeometry(0.035, Math.hypot(top, 0.36) + 0.06, 0.045);
        leg.rotateX(s * Math.atan2(0.18, top)).translate(t.x, top / 2, 0);
        parts.push({ geo: leg, row: ROWS.log[2] });
      }
      parts.push({ geo: new THREE.BoxGeometry(0.06, 0.04, 0.16).translate(t.x, top - 0.01, 0), row: ROWS.log[1] });
    }
    parts.push({ geo: new THREE.BoxGeometry(fit.trestles[0].x - fit.trestles[1].x, 0.03, 0.03).translate((fit.trestles[0].x + fit.trestles[1].x) / 2, top * 0.35, 0), row: ROWS.log[1] });
    this.group.add(outlined(bake(parts), stage));
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
    stage.scene.add(this.group);
    // the log's middle sits between the trestles; the cut is fit.len·0.6… from it
    this.logAt.set((fit.len * 1.45 - fit.len * 0.6) / 2, fit.y, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).add(new THREE.Vector3(x, 0, z));
  }

  /** Where the owner stands, and which way they face, to saw. */
  sawSpot() {
    const c = new THREE.Vector3(this.fit.cut.x, 0, this.fit.cut.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    return { x: this.x - c.x, z: this.z - c.z, yaw: this.yaw };
  }
}

/**
 * A plank bench with a back, built to its owner's knee height (Actor.sitFit),
 * long enough for two. Its (x, z) is the middle of the seat; yaw is the way a
 * sitter faces.
 */
export class Bench {
  readonly group = new THREE.Group();
  claimedBy = -1;

  constructor(
    stage: Stage,
    readonly x: number,
    readonly z: number,
    readonly yaw: number,
    readonly fit: { h: number; benchZ: number; depth: number },
  ) {
    const { h, depth } = fit;
    const L = 1.05;
    const t = 0.035;
    const parts: Part[] = [{ geo: new THREE.BoxGeometry(L, t, depth).translate(0, h - t / 2, 0), row: ROWS.log[2] }];
    for (const s of [-1, 1]) {
      parts.push({ geo: new THREE.BoxGeometry(0.035, h - t, depth * 0.85).translate(s * (L / 2 - 0.1), (h - t) / 2, 0), row: ROWS.log[1] });
      // back posts rising from behind the seat
      parts.push({ geo: new THREE.BoxGeometry(0.04, 0.42, 0.035).translate(s * (L / 2 - 0.1), h + 0.17, -depth / 2 + 0.01), row: ROWS.log[1] });
    }
    parts.push({ geo: new THREE.BoxGeometry(L - 0.06, 0.09, 0.025).translate(0, h + 0.28, -depth / 2 - 0.005), row: ROWS.log[2] });
    parts.push({ geo: new THREE.BoxGeometry(L - 0.06, 0.06, 0.025).translate(0, h + 0.12, -depth / 2 - 0.005), row: ROWS.log[2] });
    this.group.add(outlined(bake(parts), stage));
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
    stage.scene.add(this.group);
  }

  /** Where to stand (facing away from the bench) to sit down on it; `along` picks a place along it. */
  sitSpot(along = 0) {
    const fwd = -this.fit.benchZ; // the bench is this far behind the sitter's feet
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    // local (along, 0, fwd) turned by yaw
    return { x: this.x + along * c + fwd * s, z: this.z - along * s + fwd * c, yaw: this.yaw };
  }
}

/** Something small that gets moved about in armfuls: firewood or fish. */
export type ItemPlace =
  | { at: 'stack'; stack: Store; slot: number }
  | { at: 'carried'; by: number }
  | { at: 'horse' }
  | { at: 'ground'; pos: THREE.Vector3; quat: THREE.Quaternion };

export interface Item {
  id: number;
  kind: 'wood' | 'fish';
  place: ItemPlace;
  mesh: THREE.Object3D;
  /** Fish: how dry, 0 fresh … 1 stockfish. */
  dry: number;
  /** Easing into its place from somewhere else (dropped, tossed), started at t0 (sim seconds). */
  tween?: { pos: THREE.Vector3; quat: THREE.Quaternion; t0: number; dur: number };
}
/** (firewood was the first kind of item) */
export type Piece = Item;

/**
 * A place that holds items in numbered slots: a firewood stack, a drying
 * rack, a crate. It keeps count of items on their way to it (incoming) and
 * items someone has come to take (reserved), so two people never plan around
 * the same things.
 */
export class Store {
  readonly group = new THREE.Group();
  readonly slots: { pos: THREE.Vector3; quat: THREE.Quaternion }[] = [];
  items: (Item | null)[] = [];
  incoming = 0;
  reserved = 0;
  /** How far in front of it (local +z) to stand to work at it. */
  protected reach = 0.5;

  constructor(readonly name: string, readonly x: number, readonly z: number, readonly yaw: number) {}

  /** Call once the slots are made. */
  protected place(stage: Stage, parts: Part[]) {
    this.items = this.slots.map(() => null);
    if (parts.length) this.group.add(outlined(bake(parts), stage));
    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = this.yaw;
    stage.scene.add(this.group);
  }

  get count() {
    return this.items.filter(Boolean).length;
  }

  /** Items not already promised to someone. */
  get available() {
    return this.count - this.reserved;
  }

  /** Room not already promised to someone. */
  get room() {
    return this.slots.length - this.count - this.incoming;
  }

  /** The last n filled slots (taken first) whose items pass `ok`. */
  top(n: number, ok: (it: Item) => boolean = () => true) {
    const out: number[] = [];
    for (let i = this.items.length - 1; i >= 0 && out.length < n; i--) {
      const it = this.items[i];
      if (it && it.place.at === 'stack' && ok(it)) out.push(i);
    }
    return out;
  }

  /** The first n free slots (filled first). */
  free(n: number) {
    const out: number[] = [];
    for (let i = 0; i < this.items.length && out.length < n; i++) if (!this.items[i]) out.push(i);
    return out;
  }

  /** Slot i in the world. */
  slotWorld(i: number) {
    this.group.updateMatrixWorld();
    const s = this.slots[i];
    return {
      pos: s.pos.clone().applyMatrix4(this.group.matrixWorld),
      quat: this.group.getWorldQuaternion(new THREE.Quaternion()).multiply(s.quat),
    };
  }

  /** Stand here, facing it, to take from it or add to it. */
  workSpot() {
    const d = this.reach;
    return { x: this.x + Math.sin(this.yaw) * d, z: this.z + Math.cos(this.yaw) * d, yaw: this.yaw + Math.PI };
  }
}

/** A stack of firewood: layers of pieces side by side on two bearers. */
export class Stack extends Store {
  constructor(stage: Stage, name: string, x: number, z: number, yaw: number, layers = 3, perLayer = 4) {
    super(name, x, z, yaw);
    const w = PIECE_R * 1.85;
    // a fixed jumble per slot (the same every run): each piece turned its own
    // way about its length so split faces and bark mix, ends not quite in line,
    // every other layer shifted half a piece (like brickwork)
    const jit = (k: number) => (((Math.sin(k * 12.9898 + x * 3.1 + z * 7.7) * 43758.5453) % 1) + 1) % 1;
    for (let l = 0; l < layers; l++) {
      for (let i = 0; i < perLayer; i++) {
        const k = l * perLayer + i;
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), jit(k) * Math.PI * 2);
        q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (jit(k + 50) - 0.5) * 0.18));
        const along = (i - (perLayer - 1) / 2 + (l % 2 ? 0.45 : 0) - 0.22) * w;
        this.slots.push({ pos: new THREE.Vector3((jit(k + 100) - 0.5) * 0.06, 0.035 + PIECE_R * 0.55 + l * PIECE_R * 1.15, along), quat: q });
      }
    }
    const parts: Part[] = [];
    for (const sx of [-1, 1]) parts.push({ geo: new THREE.BoxGeometry(0.045, 0.035, perLayer * w + 0.08).translate(sx * PIECE_L * 0.32, 0.0175, 0), row: ROWS.log[1] });
    this.place(stage, parts);
  }
}

/** Where a fish hangs from its tail (its local frame: mouth at the origin, body along −z, tail at −0.24). */
export const FISH_TAIL = 0.24;

/**
 * A drying rack (a hjell): two A-frames carrying a pole at about shoulder
 * height, fish hung over it in pairs by their tails, one either side.
 */
export class Rack extends Store {
  readonly poleY = 1.05;
  constructor(stage: Stage, name: string, x: number, z: number, yaw: number, pairs = 5, scale = 1) {
    super(name, x, z, yaw);
    const L = 0.4 + pairs * 0.24;
    const y = this.poleY;
    const parts: Part[] = [];
    // A-frames at the ends, legs splayed front and back
    for (const e of [-1, 1]) {
      for (const s of [-1, 1]) {
        const leg = new THREE.CylinderGeometry(0.025, 0.03, Math.hypot(y + 0.08, 0.32), 5);
        leg.rotateX(s * Math.atan2(0.32, y + 0.08)).translate(e * L / 2, (y + 0.08) / 2, 0);
        parts.push({ geo: leg, row: ROWS.bark[1] });
      }
    }
    parts.push({ geo: new THREE.CylinderGeometry(0.022, 0.022, L + 0.16, 6).rotateZ(Math.PI / 2).translate(0, y + 0.02, 0), row: ROWS.bark[0] });
    // a lower bracing pole
    parts.push({ geo: new THREE.CylinderGeometry(0.015, 0.015, L, 5).rotateZ(Math.PI / 2).translate(0, 0.35, 0.18), row: ROWS.bark[1] });
    for (let k = 0; k < pairs; k++) {
      for (const side of [-1, 1]) {
        // tail over the pole, hanging head down a little either side of it
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, side * 0.18).normalize());
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), side > 0 ? 0 : Math.PI));
        const tail = new THREE.Vector3(0, 0, -FISH_TAIL * scale).applyQuaternion(q);
        const pos = new THREE.Vector3((k - (pairs - 1) / 2) * 0.24, y + 0.01, side * 0.03).sub(tail);
        this.slots.push({ pos, quat: q });
      }
    }
    this.reach = 0.5;
    this.place(stage, parts);
  }
}

/** An open wooden crate on the ground, things lying in it in two rows. */
export class Crate extends Store {
  constructor(stage: Stage, name: string, x: number, z: number, yaw: number, n = 6) {
    super(name, x, z, yaw);
    const W = 0.5, D = 0.36, H = 0.18, t = 0.02;
    const parts: Part[] = [{ geo: new THREE.BoxGeometry(W, t, D).translate(0, t / 2, 0), row: ROWS.log[1] }];
    for (const s of [-1, 1]) {
      parts.push({ geo: new THREE.BoxGeometry(W, H, t).translate(0, H / 2, s * (D / 2 - t / 2)), row: ROWS.log[2] });
      parts.push({ geo: new THREE.BoxGeometry(t, H, D).translate(s * (W / 2 - t / 2), H / 2, 0), row: ROWS.log[2] });
    }
    for (let k = 0; k < n; k++) {
      // lying flat across the crate, nose to tail in rows, piling up
      const row = k % 2, layer = Math.floor(k / 2);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 + (row ? 0.15 : -0.15)));
      this.slots.push({ pos: new THREE.Vector3(0.12 - (layer % 2) * 0.03, 0.05 + layer * 0.04, (row - 0.5) * 0.15), quat: q });
    }
    this.reach = 0.45;
    this.place(stage, parts);
  }
}

/**
 * A fish as a village item: fresh (silvery, an orange tail) and dried
 * (stockfish brown, a little shrunken) versions in one group; `setDry`
 * shows one or the other. Mouth at the origin, body along −z.
 */
export function makeFish(stage: Stage) {
  const variant = (dried: boolean) => {
    const parts: Part[] = [
      { geo: new THREE.SphereGeometry(1, 8, 6).scale(0.032, dried ? 0.038 : 0.045, 0.1).translate(0, 0, -0.1), row: dried ? ROWS.stockfish[0] : ROWS.fish[0] },
      { geo: new THREE.ConeGeometry(0.045, 0.06, 4).rotateX(Math.PI / 2).scale(0.3, 1, 1).translate(0, 0, -0.215), row: dried ? ROWS.stockfish[1] : ROWS.fish[1] },
      { geo: new THREE.BoxGeometry(0.006, 0.03, 0.05).translate(0, 0.045, -0.1), row: dried ? ROWS.stockfish[1] : ROWS.fish[2] },
    ];
    const g = new THREE.Group();
    g.add(outlined(bake(parts), stage));
    return g;
  };
  const group = new THREE.Group();
  const fresh = variant(false), dried = variant(true);
  dried.visible = false;
  group.add(fresh, dried);
  return group;
}

/** Fresh or dried look for a fish item's mesh. */
export function setDry(mesh: THREE.Object3D, dried: boolean) {
  mesh.children[0].visible = !dried;
  mesh.children[1].visible = dried;
}

/** Make a log mesh (added to the scene by the caller). */
export function makeLog(stage: Stage) {
  return outlined(logGeometry(), stage);
}
