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
  kind: 'wood' | 'fish' | 'apple' | 'keg' | 'mug';
  place: ItemPlace;
  mesh: THREE.Object3D;
  /** Fish: how dry, 0 fresh … 1 stockfish. Keg: servings of cider left. */
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

// ---------------------------------------------------------------- apples and cider

export const APPLE_R = 0.065;
export const KEG_R = 0.095;
export const KEG_L = 0.26;

/** An apple (item mesh). */
export function makeApple(stage: Stage) {
  return outlined(bake([
    { geo: new THREE.IcosahedronGeometry(APPLE_R, 1).scale(1, 0.92, 1), row: ROWS.apple[0] },
    { geo: new THREE.CylinderGeometry(0.006, 0.006, 0.035, 4).translate(0, APPLE_R + 0.01, 0), row: ROWS.bark[0] },
  ]), stage);
}

/** A small cider keg lying along x: bulging staves, two iron hoops, a pale end with a bung. */
export function makeKeg(stage: Stage) {
  const prof: [number, number][] = [[0.001, -KEG_L / 2], [KEG_R * 0.8, -KEG_L / 2], [KEG_R, 0], [KEG_R * 0.8, KEG_L / 2], [0.001, KEG_L / 2]];
  const body = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 10).rotateZ(Math.PI / 2);
  const parts: Part[] = [{ geo: body, row: ROWS.log[0] }];
  for (const x of [-0.32, 0.32]) parts.push({ geo: new THREE.CylinderGeometry(KEG_R * 0.94, KEG_R * 0.94, 0.014, 10).rotateZ(Math.PI / 2).translate(x * KEG_L, 0, 0), row: ROWS.stone[2] });
  parts.push({ geo: new THREE.CylinderGeometry(0.012, 0.012, 0.03, 5).translate(0, KEG_R, 0), row: ROWS.log[1] }); // bung
  return outlined(bake(parts), stage);
}

/** A tankard of cider (item mesh), upright, its handle to its right (−x). */
export function makeMug(stage: Stage) {
  const r = 0.055, h = 0.13;
  return outlined(bake([
    { geo: new THREE.CylinderGeometry(r, r * 1.06, h, 9).translate(0, h / 2, 0), row: ROWS.wood[1] },
    { geo: new THREE.CylinderGeometry(r * 1.08, r * 1.1, 0.012, 9).translate(0, 0.025, 0), row: ROWS.stone[2] },
    { geo: new THREE.SphereGeometry(r * 0.97, 9, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.35, 1).translate(0, h, 0), row: ROWS.cloud[0] },
    { geo: new THREE.BoxGeometry(0.014, 0.075, 0.016).translate(-r - 0.03, 0.068, 0), row: ROWS.wood[1] },
  ]), stage);
}

/**
 * A wicker basket for apples: a store that moves (it's carried about in an
 * armful), five apples inside. Its group is the basket itself.
 */
export class Basket extends Store {
  constructor(stage: Stage, x: number, z: number) {
    super('basket', x, z, 0);
    const r = 0.16, h = 0.16;
    const parts: Part[] = [
      { geo: new THREE.CylinderGeometry(r, r * 0.8, h, 10, 1, true).translate(0, h / 2, 0), row: ROWS.wood[2] },
      { geo: new THREE.CylinderGeometry(r * 0.8, r * 0.8, 0.01, 10).translate(0, 0.005, 0), row: ROWS.wood[1] },
      { geo: new THREE.CylinderGeometry(r * 1.02, r * 1.02, 0.02, 10, 1, true).translate(0, h, 0), row: ROWS.wood[1] },
      { geo: new THREE.TorusGeometry(r * 0.9, 0.012, 4, 10, Math.PI).translate(0, h, 0), row: ROWS.wood[1] }, // handle
    ];
    for (const [px, pz, py] of [[0.06, 0.05, 0], [-0.06, 0.05, 0], [0, -0.07, 0], [0.02, 0.0, 1], [-0.04, -0.02, 1]] as const)
      this.slots.push({ pos: new THREE.Vector3(px, 0.06 + py * 0.08, pz), quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), px * 20) });
    this.reach = 0.4;
    this.place(stage, parts);
  }

  /** Stand here (facing it) to work with it, from where it lies now. */
  workSpot() {
    const p = this.group.position;
    const yaw = this.group.rotation.y;
    return { x: p.x + Math.sin(yaw) * this.reach, z: p.z + Math.cos(yaw) * this.reach, yaw: yaw + Math.PI };
  }
}

/** The mill's hopper: apples heaped in it. */
class Hopper extends Store {
  constructor(stage: Stage, x: number, z: number, yaw: number, top: number) {
    super('hopper', x, z, yaw);
    for (let k = 0; k < 15; k++) {
      const ring = k < 7 ? 0 : k < 12 ? 1 : 2;
      const n = [7, 5, 3][ring], i = k - [0, 7, 12][ring];
      const a = (i / n) * Math.PI * 2 + ring * 0.5;
      const rr = [0.15, 0.09, 0.04][ring];
      this.slots.push({ pos: new THREE.Vector3(Math.cos(a) * rr, top - 0.11 + ring * 0.07, Math.sin(a) * rr), quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a) });
    }
    this.reach = 0.62;
    this.place(stage, []);
  }
}

/** Kegs waiting, lying side by side on a low cradle. */
export class KegRack extends Store {
  constructor(stage: Stage, name: string, x: number, z: number, yaw: number, n = 4) {
    super(name, x, z, yaw);
    const w = KEG_R * 2.15;
    for (let i = 0; i < n; i++) this.slots.push({ pos: new THREE.Vector3(0, 0.05 + KEG_R, (i - (n - 1) / 2) * w), quat: new THREE.Quaternion() });
    const parts: Part[] = [];
    for (const sx of [-1, 1]) parts.push({ geo: new THREE.BoxGeometry(0.05, 0.06, n * w + 0.06).translate(sx * KEG_L * 0.3, 0.03, 0), row: ROWS.log[1] });
    this.reach = 0.5;
    this.place(stage, parts);
  }
}

/**
 * The cider mill: a stout wooden frame with a hopper on top for apples, a
 * big flywheel with a crank handle on its side, and a spout in front where
 * a keg stands to fill. Turning the crank feeds the apples down one by one.
 */
export class CiderMill {
  readonly group = new THREE.Group();
  readonly hopper: Hopper;
  readonly wheel = new THREE.Group();
  /** The crank's turn (radians). */
  angle = 0;
  private readonly crankR = 0.24;
  private readonly axleY = 0.62;
  private readonly side = 0.36; // the wheel sits this far out on the +x side

  constructor(stage: Stage, readonly x: number, readonly z: number, readonly yaw: number) {
    const top = 1.0;
    const parts: Part[] = [];
    // four corner posts, rails, side planks
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push({ geo: new THREE.BoxGeometry(0.07, top - 0.2, 0.07).translate(sx * 0.24, (top - 0.2) / 2, sz * 0.2), row: ROWS.log[1] });
    parts.push({ geo: new THREE.BoxGeometry(0.5, 0.36, 0.42).translate(0, 0.42, 0), row: ROWS.log[2] });
    parts.push({ geo: new THREE.BoxGeometry(0.56, 0.05, 0.48).translate(0, 0.62, 0), row: ROWS.log[1] });
    // the hopper: a wide-mouthed open box above
    const hop = new THREE.CylinderGeometry(0.26, 0.13, 0.3, 4, 1, true).rotateY(Math.PI / 4).translate(0, top - 0.15, 0);
    parts.push({ geo: hop, row: ROWS.log[0] });
    parts.push({ geo: new THREE.CylinderGeometry(0.27, 0.27, 0.03, 4, 1, true).rotateY(Math.PI / 4).translate(0, top, 0), row: ROWS.log[1] });
    // the spout, front middle, over where the keg stands
    parts.push({ geo: new THREE.BoxGeometry(0.06, 0.04, 0.16).translate(0, 0.38, 0.27), row: ROWS.log[1] });
    // the axle stub out to the wheel
    parts.push({ geo: new THREE.CylinderGeometry(0.025, 0.025, 0.16, 6).rotateZ(Math.PI / 2).translate(0.29, this.axleY, 0), row: ROWS.stone[2] });
    this.group.add(outlined(bake(parts), stage));
    // the flywheel (spokes and rim) with its handle, turning about x
    const wp: Part[] = [{ geo: new THREE.TorusGeometry(0.3, 0.022, 4, 16).rotateY(Math.PI / 2), row: ROWS.log[2] }];
    for (let k = 0; k < 4; k++) wp.push({ geo: new THREE.BoxGeometry(0.02, 0.6, 0.03).rotateX((k * Math.PI) / 4), row: ROWS.log[1] });
    wp.push({ geo: new THREE.CylinderGeometry(0.015, 0.015, 0.16, 5).rotateZ(Math.PI / 2).translate(0.08, 0, this.crankR), row: ROWS.log[0] }); // handle
    this.wheel.add(outlined(bake(wp), stage));
    this.wheel.position.set(this.side, this.axleY, 0);
    this.group.add(this.wheel);
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
    stage.scene.add(this.group);
    // the hopper's apples (a store at the mill's spot)
    this.hopper = new Hopper(stage, x, z, yaw, top);
  }

  private local(v: THREE.Vector3) {
    this.group.updateMatrixWorld();
    return v.applyMatrix4(this.group.matrixWorld);
  }

  /** Turn the crank to this angle. */
  turn(angle: number) {
    this.angle = angle;
    this.wheel.rotation.x = angle;
  }

  /** The handle's grip (world), and a point on the frame for the other hand. */
  handle() {
    const a = this.angle;
    return this.local(new THREE.Vector3(this.side + 0.13, this.axleY + Math.sin(a) * -this.crankR + 0, Math.cos(a) * this.crankR));
  }
  steady() {
    return this.local(new THREE.Vector3(0.27, 0.66, 0.16));
  }

  /** Where to stand (facing the wheel) to turn the crank. */
  crankSpot() {
    const p = this.local(new THREE.Vector3(this.side + 0.62, 0, 0));
    return { x: p.x, z: p.z, yaw: this.yaw - Math.PI / 2 };
  }

  /** Where a keg stands to fill (world pose, lying under the spout's mouth). */
  spout() {
    const pos = this.local(new THREE.Vector3(0, KEG_R + 0.005, 0.38));
    return { pos, quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw) };
  }

  /** Stand here, facing the mill's front, to take the keg from under the spout. */
  frontSpot() {
    const p = this.local(new THREE.Vector3(0, 0, 0.85));
    return { x: p.x, z: p.z, yaw: this.yaw + Math.PI };
  }
}

/** A single spot (where a tankard goes on a table), with a place to stand to put it there. */
export class Spot extends Store {
  constructor(stage: Stage, name: string, at: THREE.Vector3, yaw: number, private stand: { x: number; z: number; yaw: number }) {
    super(name, at.x, at.z, yaw);
    this.slots.push({ pos: new THREE.Vector3(0, at.y, 0), quat: new THREE.Quaternion() });
    this.place(stage, []);
  }

  workSpot() {
    return this.stand;
  }
}

/** Make a log mesh (added to the scene by the caller). */
export function makeLog(stage: Stage) {
  return outlined(logGeometry(), stage);
}
