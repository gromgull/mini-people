import * as THREE from 'three';
import { type Person, withRow } from './body';
import { type ActionPose, type ArmAngles, type PropKit, lerp, reachFist, smooth } from './actionkit';
import { type Chore, type ChoreOut, baked, disposeMesh, grow, mergeTwo, mixArm, pick, setArm, simpleMesh } from './chores';
import { ROWS } from './palette';
import type { Part } from './trees';

/**
 * Sitting down at a farmhouse table (two trestles, a bench either side, each
 * bench seating two), and the things people do there: eat an apple, eat a
 * fish, drink from a tankard. All conjured and fitted to the sitter for now.
 *
 * Getting in: the sitter sits down on the bench behind them like any bench,
 * then shuffles bench-and-all up to the table so their knees go under it (the
 * root slides forward, the bench with it, the table stays put). Getting out
 * is the same backwards.
 *
 * At the table, the props lead and the hands follow: each frame the apple,
 * fish or tankard is placed along a designed path (board → mouth, tilted to
 * the lips, back down), and the arms are solved with two-bone IK so the fists
 * hold it. That keeps a big-headed short-armed person and a lanky one both
 * eating cleanly without hand-tuning joint angles per body.
 */

export type Course = 'apple' | 'fish' | 'drink' | 'rest';
export type DineAsk = 'dine' | 'eat' | 'drink';

const DUR: Record<Course, number> = { apple: 6.9, fish: 7.7, drink: 5.6, rest: 3 };
// eating: hand(s) out to the board, item up to the mouth, a few bites, back down
const EAT = { reach: 0.3, grab: 0.9, up: 0.6, b0: 1.5 };
const BITES = { apple: { n: 4, len: 1.0 }, fish: { n: 5, len: 0.9 } };
// arms resting on the table (a rough FK guess for the springs; IK does the rest)
const ARMS_TABLE: ArmAngles = { x: -0.55, z: 0.15, elbow: 1.45 };
const ARMS_THIGHS: ArmAngles = { x: -0.12, z: 0.14, elbow: 1.0 };

/** ?meal=apple|fish pins what "eat" serves (for screenshots). */
const MEAL = ((m) => (m === 'apple' || m === 'fish' ? m : null))(typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('meal'));

const _a = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _u = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);

/** Two quick shuffles: 0 → 1 with a pause in the middle. */
const hitch = (u: number) => 0.5 * (smooth(u * 2.2) + smooth(u * 2.2 - 1.2));
const box = (w: number, h: number, d: number, x: number, y: number, z: number, row: number): Part => ({ geo: new THREE.BoxGeometry(w, h, d).translate(x, y, z), row });

export class Dine implements Chore {
  // furniture: the table and far bench stay put, the near bench moves with the sitter
  private table = new THREE.Group();
  private farBench = new THREE.Group();
  private nearBench = new THREE.Group();
  private built: THREE.Mesh[] = [];
  // table-ware, all in the root's frame, placed every frame
  private board: THREE.Mesh;
  private apple: THREE.Mesh;
  private core: THREE.Mesh;
  private fish = new THREE.Group();
  private fishFull: THREE.Mesh;
  private fishBones: THREE.Mesh;
  private tankard = new THREE.Group();
  private foam: THREE.Mesh;
  private grip = new THREE.Vector3(); // the tankard's handle (local)
  private rim = new THREE.Vector3(); // the rim nearest the drinker (local)
  // fitted sizes (in the seated frame F = the root once fully shuffled in)
  private g = { h: 0, crouch: 0, seatZ: 0, top: 0, edge: 0, S: 0, side: 1, s: 1, aR: 0, tankH: 0, tableZ: 0, farZ: 0 };
  private boardAt = new THREE.Vector3();
  private tankAt = new THREE.Vector3();
  private rest = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  // the meal
  private ask: DineAsk = 'dine';
  /**
   * At a real table (village): no conjured furniture, no shuffling in (the
   * table stands just clear of them), the tankard only there once someone
   * brings one, and they stay put until leave().
   */
  private world = false;
  private stay = false;
  /** At a real table someone else's size: its top height, its edge (ahead of their feet) and the bench height. */
  private realTable: { top: number; edge: number; h: number } | null = null;
  /** Meals eaten since sitting down. */
  ate = 0;
  private queue: Course[] = [];
  private cur: { kind: Course; t0: number; dur: number } | null = null;
  private tau = 0;
  private prevTau = 0;
  private leaveAt = Infinity;
  private shift = 0;
  private scooted = 0; // 0 … 1 shuffled in
  private boardOn = 0; // pop-in scale of the board (0 = not out yet)
  private tankOn = 0;
  private level = 1; // ale left
  private bites = 0;
  private onBoard: 'apple' | 'core' | 'fish' | 'bones' | null = null;
  private pop = 0;

  constructor(private p: Person, private kit: PropKit) {
    const s = Math.sqrt(p.dims.height);
    // a pewter platter for the food (oval, so a fish fits)
    this.board = simpleMesh(withRow(new THREE.CylinderGeometry(0.1, 0.09, 0.014, 12).scale(1.45, 1, 1).translate(0, 0.007, 0), ROWS.stone[1]), kit);
    // an apple, and what's left of it
    const ag = withRow(new THREE.IcosahedronGeometry(0.075, 1), ROWS.apple[0]).scale(1, 0.92, 1);
    const stalk = withRow(new THREE.CylinderGeometry(0.006, 0.006, 0.04, 4).translate(0, 0.08, 0), ROWS.bark[0]);
    this.apple = simpleMesh(mergeTwo(ag, stalk), kit);
    const coreG = withRow(
      new THREE.LatheGeometry([[0, -0.062], [0.05, -0.058], [0.03, -0.035], [0.022, 0], [0.03, 0.035], [0.048, 0.058], [0, 0.062]].map(([x, y]) => new THREE.Vector2(x, y)), 8),
      ROWS.food[0],
    );
    const caps = withRow(new THREE.CylinderGeometry(0.052, 0.052, 0.02, 8), ROWS.apple[0]);
    const capB = caps.clone().translate(0, -0.058, 0);
    caps.translate(0, 0.058, 0);
    this.core = simpleMesh(mergeTwo(mergeTwo(coreG, caps), mergeTwo(capB, stalk.clone().translate(0, -0.01, 0))), kit);
    // a fish (head along +z, centred), and its skeleton
    const body = withRow(new THREE.SphereGeometry(1, 8, 6), ROWS.fish[0]).scale(0.032, 0.045, 0.1);
    const tail = withRow(new THREE.ConeGeometry(0.045, 0.06, 4).rotateX(Math.PI / 2).scale(0.3, 1, 1).translate(0, 0, -0.115), ROWS.fish[1]);
    const fin = withRow(new THREE.BoxGeometry(0.006, 0.03, 0.05).translate(0, 0.045, 0), ROWS.fish[2]);
    this.fishFull = simpleMesh(mergeTwo(mergeTwo(body, tail), fin), kit);
    const head = withRow(new THREE.SphereGeometry(1, 7, 5), ROWS.fish[0]).scale(0.03, 0.04, 0.035).translate(0, 0, 0.075);
    let bones = mergeTwo(head, tail.clone());
    bones = mergeTwo(bones, withRow(new THREE.CylinderGeometry(0.0045, 0.0045, 0.15, 4).rotateX(Math.PI / 2).translate(0, 0, -0.02), ROWS.food[1]));
    for (const z of [-0.07, -0.04, -0.01, 0.02]) bones = mergeTwo(bones, withRow(new THREE.BoxGeometry(0.004, 0.06, 0.005).translate(0, 0, z), ROWS.food[1]));
    this.fishBones = simpleMesh(bones, kit);
    this.fish.add(this.fishFull, this.fishBones);
    // a tankard: wooden staves, two iron hoops, a handle on its right, ale with a head on it
    const r = 0.055, h = 0.13;
    const tk: THREE.BufferGeometry[] = [
      withRow(new THREE.CylinderGeometry(r, r * 1.06, h, 9, 1, true).translate(0, h / 2, 0), ROWS.wood[1]),
      withRow(new THREE.CylinderGeometry(r * 1.06, r * 1.06, 0.006, 9).translate(0, 0.003, 0), ROWS.wood[1]),
      withRow(new THREE.CylinderGeometry(r * 1.08, r * 1.1, 0.012, 9).translate(0, 0.025, 0), ROWS.stone[2]),
      withRow(new THREE.CylinderGeometry(r * 1.04, r * 1.06, 0.012, 9).translate(0, 0.105, 0), ROWS.stone[2]),
      withRow(new THREE.BoxGeometry(0.014, 0.075, 0.016).translate(-r - 0.03, 0.068, 0), ROWS.wood[1]),
      withRow(new THREE.BoxGeometry(0.036, 0.014, 0.016).translate(-r - 0.014, 0.1, 0), ROWS.wood[1]),
      withRow(new THREE.BoxGeometry(0.036, 0.014, 0.016).translate(-r - 0.014, 0.036, 0), ROWS.wood[1]),
    ];
    this.tankard.add(simpleMesh(tk.reduce((a, b) => mergeTwo(a, b)), kit));
    const foamG = withRow(new THREE.SphereGeometry(r * 0.97, 9, 4, 0, Math.PI * 2, 0, Math.PI / 2), ROWS.cloud[0]).scale(1, 0.35, 1);
    const ale = withRow(new THREE.CylinderGeometry(r * 0.97, r * 0.97, 0.004, 9), ROWS.food[2]);
    this.foam = simpleMesh(mergeTwo(foamG, ale), kit);
    this.tankard.add(this.foam);
    this.grip.set(-r - 0.03, 0.068, 0).multiplyScalar(s);
    this.rim.set(0, h, -r).multiplyScalar(s);
    this.g.tankH = h * s;
    this.g.aR = 0.075 * s;

    for (const o of [this.table, this.farBench, this.nearBench, this.board, this.apple, this.core, this.fish, this.tankard]) {
      o.visible = false;
      p.root.add(o);
    }
    for (const o of [this.board, this.apple, this.core, this.tankard]) o.scale.setScalar(s);
  }

  /** What they sat down for (set before start). */
  plan(ask: DineAsk, opts: { world?: boolean; table?: { top: number; edge: number; h: number } | null } = {}) {
    this.world = !!opts.world || !!opts.table;
    this.realTable = opts.table ?? null;
    this.stay = this.world;
    this.ask = ask;
  }

  /** Asked for something else while already sitting: do that next. */
  want(ask: DineAsk) {
    if (this.leaveAt !== Infinity) return false;
    const c = this.courseFor(ask);
    if (this.queue[0] !== c) this.queue.unshift(c);
    if (this.queue.at(-1) !== 'rest') this.queue.push('rest');
    // (no need to sit out the rest of a rest first)
    if (this.cur?.kind === 'rest') this.cur.dur = Math.min(this.cur.dur, this.tau + 0.05);
    return true;
  }

  /** Get up and go (after whatever course is on; no more sitting about). */
  leave() {
    this.stay = false;
    this.queue = this.queue.filter((k) => k !== 'rest');
    if (this.cur?.kind === 'rest') this.cur.dur = Math.min(this.cur.dur, this.tau + 0.05);
  }

  /** The tankard's empty (or there isn't one yet). */
  get needsRefill() {
    return this.tankOn === 0 || this.level < 0.05;
  }

  /** Busy with a drink right now. */
  get drinking() {
    return this.cur?.kind === 'drink';
  }

  /** A full tankard set down in front of them (the empty one goes). */
  serve() {
    this.tankOn = 1;
    this.level = 1;
  }

  /** A plate set down in front of them: eat it next. */
  serveMeal(kind: 'fish' | 'apple') {
    this.boardOn = 1;
    this.onBoard = kind;
    if (this.queue[0] !== kind) this.queue.unshift(kind);
    if (this.cur?.kind === 'rest') this.cur.dur = Math.min(this.cur.dur, this.tau + 0.05);
  }

  /** Where the tankard stands (world), once seated. */
  tankWorld() {
    this.p.root.updateMatrixWorld(true);
    return this.p.root.localToWorld(this.tankAt.clone());
  }

  /** Where the plate goes (world), once seated. */
  boardWorld() {
    this.p.root.updateMatrixWorld(true);
    return this.p.root.localToWorld(this.boardAt.clone());
  }

  /**
   * For a real table: the fit for this person (as start() will make it at a
   * real table), and the table and both benches built to it, in their seated
   * frame (where their feet are once sat, facing +z). Also the tankard's
   * spot, and a box round the lot.
   */
  worldFurniture() {
    this.world = true;
    this.fit();
    const group = new THREE.Group();
    const t = new THREE.Group(), f = new THREE.Group(), n = new THREE.Group();
    // (build() throws away what it built last time: keep this table's own, so a
    // second table, or a conjured one later, doesn't take this one with it)
    const conjured = this.built;
    this.built = [];
    this.build(t, f, n);
    this.built = conjured;
    group.add(t, f, n);
    const G = this.g, H = this.p.dims.height;
    const L = 2 * 0.44 * H + 0.16 * H;
    const nearZ = n.position.z;
    return {
      group,
      tankAt: this.tankAt.clone(),
      side: G.side,
      box: { x: t.position.x, z: (nearZ + G.farZ) / 2, hx: L / 2 + 0.02, hz: (G.farZ - nearZ) / 2 + 0.12 },
      /** The table in its own frame: top height, near edge (z), depth, bench height, bench middles (z), seat spacing, middle (x), length. */
      dims: { top: G.top, edge: G.edge, W: 0.6 * H, h: G.h, nearZ, farZ: G.farZ, seatW: 0.44 * H, cx: t.position.x, L },
    };
  }

  private courseFor(ask: DineAsk): Course {
    if (ask === 'drink') return 'drink';
    if (ask === 'eat') return MEAL ?? (Math.random() < 0.5 ? 'apple' : 'fish');
    return pick(['apple', 'fish', 'drink'] as const);
  }

  start() {
    this.fit();
    if (!this.world) this.build(this.table, this.farBench, this.nearBench);
    this.queue =
      this.world ? ['rest']
      : this.ask === 'eat' ? [this.courseFor('eat'), 'rest']
      : this.ask === 'drink' ? ['drink', 'rest']
      : ['rest', this.courseFor('dine'), Math.random() < 0.6 ? 'drink' : 'rest', 'rest'];
    this.cur = null;
    this.leaveAt = Infinity;
    this.shift = this.scooted = 0;
    this.boardOn = this.tankOn = 0;
    this.level = this.world ? 0 : 1;
    this.ate = 0;
    this.onBoard = null;
    this.pop = 0;
    for (const o of [this.table, this.farBench, this.nearBench]) {
      o.scale.setScalar(1e-3);
      o.visible = !this.world;
    }
  }

  /** Size the seat and table to this person, and where things go on the table. */
  private fit() {
    const p = this.p;
    const d = p.dims;
    const H = d.height;
    const s = Math.sqrt(H);
    const G = this.g;
    G.s = s;
    // the seat: knee height, far enough back that the thighs lie on it
    const standY = d.footH + (d.thighLen + d.shinLen) * 0.997;
    G.h = d.footH + d.shinLen * 0.92;
    G.seatZ = d.thighLen * 0.85;
    G.crouch = (standY - (G.h + d.hipBelow * 0.9)) / d.legLen;
    // table top a little under the elbows, but always clear of the thighs
    const shoulderY = G.h + d.hipBelow * 0.9 + d.hipAbove + d.shoulderY;
    G.top = Math.max(shoulderY - d.upperArmLen - 0.025 * H, G.h + 2.4 * d.thighR + 0.03 * H);
    // the near edge just off the belly once sat; how far to shuffle in so it
    // also clears them while standing
    const front = Math.max(d.waistR, d.hipR) * d.torsoDepth + d.bustR * 0.5;
    G.edge = -G.seatZ + front + 0.03 * H;
    G.S = Math.max(0.03 * H, front + 0.05 * H - G.edge);
    if (this.world) {
      // a real table doesn't shuffle: it stands just clear of them standing
      G.edge = front + 0.03 * H;
      G.S = 0;
      G.side = 1;
      if (this.realTable) {
        // someone else's table: sit to its bench and reach to its top
        G.h = this.realTable.h;
        G.crouch = (standY - (G.h + d.hipBelow * 0.9)) / d.legLen;
        G.top = this.realTable.top;
        G.edge = this.realTable.edge;
      }
    } else G.side = Math.random() < 0.5 ? 1 : -1; // which end of the bench they take

    // where things go on the table: the board in front, the tankard to the right
    const shZ = -G.seatZ;
    const A = d.upperArmLen + d.foreArmLen;
    const dy = shoulderY - G.top;
    const reach = Math.sqrt(Math.max(0.01 * H * H, (0.92 * A) ** 2 - dy * dy));
    const zNear = (r: number) => Math.max(G.edge + r + 0.012 * H, Math.min(shZ + reach * 0.85, G.edge + 0.25 * H));
    this.boardAt.set(0, G.top, zNear(0.09 * s));
    this.tankAt.set(-(d.shoulderX + 0.05 * H), G.top, zNear(0.06 * s));
    // fists resting on the table, forearms on it
    for (const sd of [-1, 1]) {
      const r = sd < 0 ? this.rest.R : this.rest.L;
      r.set(sd * d.shoulderX * 0.75, G.top + d.handR * 0.85, Math.min(shZ + d.foreArmLen * 1.05, G.edge + 0.2 * H));
      r.z = Math.max(r.z, G.edge + d.handR);
    }
  }

  /** The table and both benches, sized to the sitter, into these groups. */
  private build(tableG: THREE.Group, farG: THREE.Group, nearG: THREE.Group) {
    for (const m of this.built) disposeMesh(m);
    this.built = [];
    const d = this.p.dims;
    const H = d.height;
    const G = this.g;
    const wood = ROWS.wood[0];
    const dark = ROWS.wood[1];
    const seatW = 0.44 * H; // one sitter's share of a bench
    const L = 2 * seatW + 0.16 * H;
    const W = 0.6 * H;
    const th = 0.035 * H;
    const cx = (G.side * seatW) / 2; // the other half of the bench is free
    // table: top, a trestle at each end (foot, post, cleat), a stretcher between
    const parts: Part[] = [box(L, th, W, 0, G.top - th / 2, 0, wood)];
    const tx = L / 2 - 0.13 * H;
    const postH = G.top - th - 0.035 * H - 0.04 * H;
    for (const e of [-1, 1]) {
      parts.push(box(0.06 * H, 0.04 * H, W * 0.78, e * tx, 0.02 * H, 0, dark));
      parts.push(box(0.05 * H, postH, 0.09 * H, e * tx, 0.04 * H + postH / 2, 0, dark));
      parts.push(box(0.05 * H, 0.035 * H, W * 0.82, e * tx, G.top - th - 0.0175 * H, 0, dark));
    }
    parts.push(box(2 * tx, 0.045 * H, 0.03 * H, 0, G.top * 0.3, 0, dark));
    const table = baked(parts, this.kit);
    tableG.clear();
    tableG.add(table);
    G.tableZ = G.edge + W / 2;
    tableG.position.set(cx, 0, G.tableZ);
    // benches: a plank on two slab legs
    const bd = Math.max(0.13 * H, d.thighLen * 1.05);
    const bt = 0.03 * H;
    const bench = (): THREE.Mesh => {
      const bl = L - 0.06 * H;
      const ps: Part[] = [box(bl, bt, bd, 0, G.h - bt / 2, 0, wood)];
      for (const e of [-1, 1]) ps.push(box(0.035 * H, G.h - bt, bd * 0.8, e * (bl / 2 - 0.08 * H), (G.h - bt) / 2, 0, dark));
      const m = baked(ps, this.kit);
      this.built.push(m);
      return m;
    };
    const nearZ = -G.seatZ - d.thighLen * 0.05;
    nearG.clear();
    nearG.add(bench());
    nearG.position.set(cx, 0, nearZ);
    farG.clear();
    farG.add(bench());
    G.farZ = G.edge + W + (G.edge - nearZ);
    farG.position.set(cx, 0, G.farZ);
    this.built.push(table);
  }

  pre(t: number, dt: number, P: ActionPose, tempo: number, out: ChoreOut) {
    const G = this.g;
    const slow = 1 / Math.sqrt(tempo);
    const T0 = 0.45; // furniture appears
    const tDown = 0.9 * slow;
    const tIn = 0.75; // shuffle up to the table
    const seatedAt = T0 + tDown + tIn;
    const tOut = 0.6;
    const tUp = 0.8 * slow;

    // what's on: next course, or time to go
    if (this.leaveAt === Infinity && t >= seatedAt) {
      if (this.cur && t - this.cur.t0 >= this.cur.dur) {
        if (this.cur.kind === 'apple' || this.cur.kind === 'fish') this.ate++;
        this.cur = null;
      }
      if (!this.cur) {
        const k = this.queue.shift();
        if (k) {
          this.cur = { kind: k, t0: t, dur: k === 'rest' ? 2 + Math.random() * 2 : DUR[k] };
          this.prevTau = this.tau = 0;
        } else if (this.stay) this.cur = { kind: 'rest', t0: t, dur: 1e9 };
        else this.leaveAt = t;
      }
    }
    const end = this.leaveAt + tOut + tUp + 0.35;
    if (t > end) return false;

    // sitting down / standing up, and shuffling in / out
    const lt = t - this.leaveAt;
    let k = 0;
    if (t >= T0 && t < T0 + tDown) k = smooth((t - T0) / tDown);
    else if (t >= T0 + tDown) k = lt < tOut ? 1 : 1 - smooth((lt - tOut) / tUp);
    const sc = lt >= 0 ? 1 - hitch(lt / tOut) : t > T0 + tDown ? hitch((t - T0 - tDown) / tIn) : 0;
    const crossed = (a: number) => t - dt < a && t >= a;
    if (crossed(T0 + tDown * 0.85)) out.events.push('creak');
    for (const a of [T0 + tDown, T0 + tDown + tIn * 0.55, this.leaveAt, this.leaveAt + tOut * 0.55]) if (crossed(a)) out.events.push('scrape');
    this.scooted = sc;
    this.shift = G.S * sc;
    P.fwd = this.shift;
    const moving = k > 0 && k < 1 ? Math.sin(Math.PI * k) : 0;
    const back = smooth(Math.min(1, k * 1.6));
    P.sitZ = G.seatZ * back;
    P.crouch = G.crouch * smooth(Math.max(0, (k - 0.15) / 0.85));
    // each shuffle: weight forward, hips up a touch
    const shuffling = (t > T0 + tDown && t < seatedAt) || (lt > 0 && lt < tOut);
    const hop = shuffling ? Math.abs(Math.sin((sc * 2) * Math.PI)) : 0;
    P.crouch -= 0.02 * hop;
    P.spineX = 0.45 * moving - 0.04 * k + 0.15 * hop;
    P.headX = -0.2 * moving;
    this.pop = t < T0 ? grow(t / T0) : t > end - 0.35 ? Math.max(1e-3, 1 - smooth((t - end + 0.35) / 0.35)) : 1;

    // arms: hands on the thighs while getting in and out; on the table once in
    for (const sd of ['L', 'R'] as const) setArm(P, sd, mixArm(ARMS_THIGHS, ARMS_TABLE, sc), k, 1);
    out.focus = null;

    const c = this.cur;
    if (!c || lt >= 0) return true;
    this.prevTau = this.tau;
    this.tau = t - c.t0;
    const u = this.tau;
    const at = (a: number) => this.prevTau < a && u >= a;
    if (c.kind === 'apple' || c.kind === 'fish') {
      const B = BITES[c.kind];
      const bEnd = EAT.b0 + B.n * B.len;
      const reach = smooth((u - EAT.reach) / (EAT.grab - EAT.reach)) * (1 - smooth((u - bEnd - 0.6) / 0.5));
      const up = smooth((u - EAT.grab) / EAT.up) * (1 - smooth((u - bEnd) / 0.6));
      P.spineX += 0.2 * reach * (1 - up); // lean in to reach the board
      const bu = (u - EAT.b0) / B.len;
      const bi = Math.floor(bu);
      const f = bu - bi;
      if (bi >= 0 && bi < B.n) {
        P.headX += 0.12 * (f < 0.25 ? smooth(f / 0.25) : 1 - smooth((f - 0.25) / 0.25)); // into the bite
        out.mouthOpen = (f > 0.1 && f < 0.27) || (f > 0.5 && Math.sin((f - 0.5) * Math.PI * 2 * 3.5) > 0.4);
        if (at(EAT.b0 + (bi + 0.6) * B.len)) out.events.push('munch');
      }
      if (at(bEnd + 0.55)) out.events.push('thunk');
      if (at(bEnd + 0.9)) out.events.push('mmm');
    } else if (c.kind === 'drink') {
      const { lift, drink, reach } = this.drinkK(u);
      P.spineX += 0.15 * reach * (1 - lift) - 0.06 * drink;
      P.headX += -0.12 * lift - 0.38 * drink;
      for (const a of [2.05, 2.5, 2.95]) if (at(a)) out.events.push('gulp');
      if (at(4.02)) out.events.push('clunk');
      if (at(4.35)) out.events.push('ahh');
    }
    return true;
  }

  /** Sat at the table with nothing in hand to do (between courses, waiting): free to talk with them. */
  get handsIdle() {
    return this.scooted >= 1 && this.leaveAt === Infinity && (!this.cur || this.cur.kind === 'rest');
  }

  private drinkK(u: number) {
    const lift = smooth((u - 0.9) / 0.7);
    const drink = smooth((u - 1.6) / 0.5) * (1 - smooth((u - 3.0) / 0.4));
    const lower = smooth((u - 3.4) / 0.65);
    const reach = smooth((u - 0.3) / 0.6) * (1 - smooth((u - 4.1) / 0.5));
    const wipe = u > 4.4 && u < 5.3 ? (u - 4.4) / 0.9 : -1;
    return { lift: lift * (1 - lower), drink, lower, reach, wipe };
  }

  post(_time: number, dt: number, out: ChoreOut) {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    const G = this.g;
    const H = d.height;
    const s = G.s;
    const off = G.S - this.shift; // the seated frame F, seen from the root
    const F = (v: THREE.Vector3, o = new THREE.Vector3()) => o.set(v.x, v.y, v.z + off);
    this.table.position.z = G.tableZ + off;
    this.farBench.position.z = G.farZ + off;
    for (const o of [this.table, this.farBench, this.nearBench]) o.scale.setScalar(this.pop);
    p.root.updateMatrixWorld(true);

    // the mouth and which way the face points (root frame)
    const hr = d.headR;
    const mouth = p.root.worldToLocal(J.head.localToWorld(new THREE.Vector3(0, hr * 0.42, hr * 0.92)));
    const fwd = p.root.worldToLocal(J.head.localToWorld(new THREE.Vector3(0, hr * 0.42, hr * 1.92))).sub(mouth).normalize();
    const restR = F(this.rest.R);
    const restL = F(this.rest.L);
    const fistR = restR.clone();
    const fistL = restL.clone();

    // the board and the tankard stay out once fetched, until the table goes
    const c = this.cur;
    const u = this.tau;
    const boardPos = F(this.boardAt);
    const tankPos = F(this.tankAt);
    if (c && (c.kind === 'apple' || c.kind === 'fish') && this.leaveAt === Infinity && u < 0.35) {
      if (this.onBoard !== c.kind) {
        this.onBoard = c.kind;
        this.boardOn = Math.max(this.boardOn, 1e-3);
      }
    }
    if (c?.kind === 'drink' && this.tankOn === 0) this.tankOn = 1e-3;
    if (this.boardOn > 0) this.boardOn = Math.min(1, this.boardOn + dt / 0.35);
    if (this.tankOn > 0) this.tankOn = Math.min(1, this.tankOn + dt / 0.35);
    const fade = Math.min(this.pop, 1);
    this.board.visible = this.boardOn > 0;
    this.board.position.copy(boardPos);
    this.board.scale.setScalar(s * Math.min(fade, grow(this.boardOn)));
    this.tankard.visible = this.tankOn > 0;
    const tankScale = s * Math.min(fade, grow(this.tankOn));

    // the food: on the board, or on its way to and from the mouth
    this.apple.visible = this.core.visible = this.fish.visible = false;
    const fs = s * 1.15; // fish scale
    const bit = (n: number) => Math.min(fade, grow(n));
    if (c && (c.kind === 'apple' || c.kind === 'fish')) {
      const B = BITES[c.kind];
      const bEnd = EAT.b0 + B.n * B.len;
      const isApple = c.kind === 'apple';
      const reach = smooth((u - EAT.reach) / (EAT.grab - EAT.reach)) * (1 - smooth((u - bEnd - 0.6) / 0.5));
      const up = smooth((u - EAT.grab) / EAT.up) * (1 - smooth((u - bEnd) / 0.6));
      const bu = (u - EAT.b0) / B.len;
      const bi = Math.floor(bu);
      const f = bu - bi;
      const into = bi >= 0 && bi < B.n ? (f < 0.25 ? smooth(f / 0.25) : 1 - smooth((f - 0.25) / 0.2)) : 0;
      // chomp: crumbs, and the food gets smaller
      if (u < EAT.b0) this.bites = 0;
      for (let i = 0; i < B.n; i++) {
        const tc = EAT.b0 + (i + 0.25) * B.len;
        if (this.prevTau < tc && u >= tc) {
          this.bites = i + 1;
          out.events.push(isApple ? 'crunch' : 'munch');
          out.bursts.push({ kind: 'crumbs', at: p.root.localToWorld(mouth.clone().addScaledVector(fwd, hr * 0.3)) });
        }
      }
      const done = this.bites >= B.n;
      const pos = new THREE.Vector3();
      const q = new THREE.Quaternion();
      if (isApple) {
        const aR = G.aR;
        const onB = _c.copy(boardPos).setY(boardPos.y + 0.014 * s + aR * 0.92);
        // held just below and in front of the mouth; a bite pushes it in
        const hold = _t.copy(mouth).addScaledVector(fwd, aR + hr * 0.35).setY(mouth.y - hr * 0.25);
        const bite = _u.copy(mouth).addScaledVector(fwd, aR * 0.55);
        pos.lerpVectors(onB, hold, up).lerp(bite, into * up);
        pos.y += 0.06 * H * Math.sin(Math.PI * up);
        const m = done ? this.core : this.apple;
        m.visible = true;
        m.position.copy(pos);
        m.quaternion.setFromAxisAngle(_Y, 0.4 * up);
        m.scale.setScalar(s * bit(this.boardOn) * (done ? 1 : 1 - 0.12 * this.bites));
        // right fist under and to the right of it
        const gripR = _c.copy(pos).add(_a.set(-0.65, -0.55, -0.25).normalize().multiplyScalar(aR + d.handR * 0.55));
        fistR.lerp(gripR, reach);
      } else {
        const L = 0.22 * fs;
        const onB = _c.copy(boardPos).setY(boardPos.y + 0.014 * s + 0.032 * fs);
        // across the face like a cob of corn, sliding along between bites
        const n = B.n;
        const slide = bi < 0 ? 0.5 : bi >= n ? -0.5 : 0.5 - (bi + smooth(Math.max(0, f - 0.45) / 0.55) * (bi < n - 1 ? 1 : 0)) / (n - 1);
        const across = _t.set(1, 0, 0).applyQuaternion(_q.setFromUnitVectors(_Z, _a.copy(fwd).setY(0).normalize())); // the face's left
        const hold = _u.copy(mouth).addScaledVector(fwd, 0.032 * fs + hr * 0.3).setY(mouth.y - hr * 0.15).addScaledVector(across, slide * L * 0.7);
        const bite = hold.clone().addScaledVector(fwd, -hr * 0.28);
        pos.lerpVectors(onB, hold, up).lerp(bite, into * up);
        pos.y += 0.06 * H * Math.sin(Math.PI * up);
        // head to the right (−x): lying on its side on the board, upright to eat
        q.setFromAxisAngle(_Y, -Math.PI / 2).multiply(_q.setFromAxisAngle(_Z, (Math.PI / 2) * (1 - up)));
        this.fish.visible = true;
        this.fish.position.copy(pos);
        this.fish.quaternion.copy(q);
        this.fish.scale.setScalar(fs * bit(this.boardOn));
        this.fishFull.visible = !done;
        this.fishBones.visible = done;
        const ends = _a.set(0, 0, 1).applyQuaternion(q).multiplyScalar(L * 0.45); // toward the head
        fistR.lerp(_c.copy(pos).add(ends).setY(pos.y - d.handR * 0.7), reach);
        fistL.lerp(_c.copy(pos).sub(ends).setY(pos.y - d.handR * 0.7), reach);
      }
      if (u >= bEnd + 0.6) this.onBoard = done ? (isApple ? 'core' : 'bones') : this.onBoard;
      if (up > 0.5) out.focus = p.root.localToWorld(mouth.clone().addScaledVector(fwd, 3 * H).setY(mouth.y));
      else if (reach > 0.05) out.focus = p.root.localToWorld(pos.clone());
    } else if (this.onBoard && this.boardOn > 0) {
      // leftovers (or an uneaten something) stay on the board
      const left = this.onBoard;
      if (left === 'core' || left === 'apple') {
        const m = left === 'core' ? this.core : this.apple;
        m.visible = true;
        m.position.copy(boardPos).setY(boardPos.y + 0.014 * s + (left === 'core' ? 0.062 * s : G.aR * 0.92));
        m.scale.setScalar(s * fade);
        m.quaternion.identity();
      } else {
        this.fish.visible = true;
        this.fish.position.copy(boardPos).setY(boardPos.y + 0.014 * s + 0.032 * fs);
        this.fish.quaternion.setFromAxisAngle(_Y, -Math.PI / 2).multiply(_q.setFromAxisAngle(_Z, Math.PI / 2));
        this.fish.scale.setScalar(fs * fade);
        this.fishFull.visible = left === 'fish';
        this.fishBones.visible = left === 'bones';
      }
    }

    // the tankard: up to the lips, tipped, back down
    this.tankard.position.copy(tankPos);
    this.tankard.quaternion.identity();
    this.tankard.scale.setScalar(tankScale);
    if (c?.kind === 'drink') {
      const { lift, drink, reach, wipe } = this.drinkK(u);
      const theta = 0.45 * lift + 0.85 * drink;
      _q.setFromAxisAngle(_X, -theta);
      // rim against the lips
      const atLips = _c.copy(mouth).addScaledVector(fwd, hr * 0.06).sub(_t.copy(this.rim).applyQuaternion(_q));
      this.tankard.position.lerpVectors(tankPos, atLips, lift);
      this.tankard.position.y += 0.05 * H * Math.sin(Math.PI * lift) * (1 - drink);
      this.tankard.quaternion.copy(_q);
      if (drink > 0) this.level = Math.max(this.world ? 0 : 0.15, this.level - dt * 0.12 * drink);
      const handle = _t.copy(this.grip).applyQuaternion(_q).add(this.tankard.position);
      fistR.lerp(handle.addScaledVector(_a.set(-1, 0, 0), d.handR * 0.2), reach);
      if (lift > 0.5) out.focus = p.root.localToWorld(mouth.clone().addScaledVector(fwd, 3 * H).setY(mouth.y));
      else if (reach > 0.05) out.focus = p.root.localToWorld(tankPos.clone().setY(tankPos.y + G.tankH));
      // then the back of the left hand across the mouth
      if (wipe >= 0) {
        const e = Math.sin(Math.PI * wipe);
        const across = lerp(0.9, -0.5, smooth(wipe * 1.3 - 0.15));
        const wipeAt = _c.copy(mouth).addScaledVector(fwd, d.handR * 1.1 + hr * 0.1).add(_a.set(across * hr, -hr * 0.12, 0));
        fistL.lerp(wipeAt, e);
      }
    }
    this.foam.position.y = 0.13 * this.level - 0.002;

    // arms: two-bone IK so the fists land where the props want them (never
    // through the table top)
    for (const f of [fistR, fistL]) f.y = Math.max(f.y, G.top + d.handR * 0.8);
    this.reachTo('R', fistR, this.scooted * (1 - out.gesturing.R));
    this.reachTo('L', fistL, this.scooted * (1 - out.gesturing.L));
  }

  private reachTo(side: 'L' | 'R', fist: THREE.Vector3, w: number) {
    reachFist(this.p, side, fist, w);
  }

  hide() {
    for (const o of [this.table, this.farBench, this.nearBench, this.board, this.apple, this.core, this.fish, this.tankard]) o.visible = false;
  }

  dispose() {
    this.hide();
    for (const m of this.built) disposeMesh(m);
    for (const o of [this.board, this.apple, this.core, this.fish, this.tankard]) disposeMesh(o);
    for (const o of [this.table, this.farBench, this.nearBench]) o.removeFromParent();
  }
}
