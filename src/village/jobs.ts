import * as THREE from 'three';
import type { Actor } from '../actions';
import type { Forest, Tree } from './forest';
import { type Basket, type Bench, type CiderMill, type Crate, type Item, type KegRack, LOG_L, LOG_R, type Log, type Rack, type Sawhorse, type Spot, type Stack, type Store, type Woodpile } from './things';
import type { Apple, Orchard } from './orchard';
import type { InnTable, Seat } from './inn';
import type { Pond } from '../pond';
import type { ItemPose } from '../armful';
import { PIECE_L, PIECE_R } from '../firewood';
import { type Obstacle, type Walker, wrap } from './walk';

/**
 * The jobs. Each person runs a small routine of steps (walk somewhere, do
 * an action there, pick something up, put it down), and between routines
 * looks at the world to decide what's needed:
 *
 *   lumberjack: if the woodpile (counting logs on their way, and logs lying
 *     in the forest) is short of PILE_WANT, claim the nearest standing tree,
 *     walk up to it side-on, fell it (it leaves two logs), then carry each
 *     log to the pile on the shoulder.
 *   woodworker: if there's a log in the pile, carry it to the sawhorse, put
 *     it on, and saw it. Otherwise wait by the sawhorse.
 *
 * Claims (on trees and logs) keep two people from going for the same thing.
 * If an action gets interrupted (someone falls over), whatever they were
 * carrying is dropped where they are and the claims are let go.
 */

export const PILE_WANT = 4;
/** The inn wants at least this much firewood in its stack. */
export const INN_WANT = 8;
/** Pieces of firewood a sawn log makes. */
export const PIECES_PER_LOG = 4;
/** Pieces in an armful. */
export const ARMFUL = 4;
/** Fish caught before taking them to the rack. */
export const CATCH = 3;
/** The inn's larder wants at least this many dried fish. */
export const LARDER_WANT = 8;
/** Apples in a basketful. */
export const BASKET = 5;
/** Apples the mill turns into a keg. */
export const MILL_BATCH = 12;
/** Tankards of cider in a keg. */
export const SERVINGS = 8;
/** The inn wants this many kegs on hand. */
export const INN_KEGS = 2;
/** The day: work from WAKE, supper at the inn from SUPPER, everyone home by NIGHT (hours). */
export const WAKE = 6.5;
export const SUPPER = 17;
export const NIGHT = 21.5;
export type Phase = 'work' | 'supper' | 'night';
export const phaseAt = (h: number): Phase => (h >= WAKE && h < SUPPER ? 'work' : h >= SUPPER && h < NIGHT ? 'supper' : 'night');

export interface Village {
  forest: Forest;
  pile: Woodpile;
  horse: Sawhorse;
  logs: Log[];
  newLog(): Log;
  removeLog(l: Log): void;
  treeObstacle(t: Tree): Obstacle | null;
  horseObstacle: Obstacle;
  /** Somewhere to sit (with the obstacle to step past onto it, and whose it is: −1 = anyone's). */
  benches: { bench: Bench; obstacle: Obstacle; owner: number }[];
  time: number;
  /** Firewood: the stack by the sawhorse, the inn's stack by the kitchen, every piece. */
  yard: Stack;
  inn: Stack;
  /** Fish: the pond, the drying rack, the inn's larder crate. */
  pond: Pond;
  rack: Rack;
  larder: Crate;
  /** Apples and cider: the orchard, the picker's basket, the mill, kegs at the mill and at the inn. */
  orchard: Orchard;
  basket: Basket;
  mill: CiderMill;
  millKegs: KegRack;
  innKegs: KegRack;
  /** The inn's table: where the regular's tankard stands (a one-slot store), where they sit. */
  tankardSpot: Spot;
  seat: { x: number; z: number; yaw: number; via: { x: number; z: number }; obstacle: Obstacle };
  /** A full tankard has just been set down at the regular's place. */
  served(): void;
  /** Is anyone at the table who needs a refill? */
  wantsRefill(): boolean;
  /** This simulation step's length. */
  dt: number;
  /** The time of day (hours) and what that means for everyone. */
  hours: number;
  phase: Phase;
  /** The inn's tables and their seats. */
  tables: InnTable[];
  seats: Seat[];
  /** The kitchen hatch: where the innkeeper stands to cook, and the counter. */
  hatch: { stand: { x: number; z: number; yaw: number }; counter: THREE.Vector3 };
  /** A plate of supper has just been put down at this seat. */
  mealServed(seat: Seat): void;
  /** Someone's just got home (their lamps go on for a while). */
  cameHome(i: number): void;
  /** Everyone (but the innkeeper) has had supper or gone to bed. */
  everyoneFed(): boolean;
  /** Bookkeeping for the overlay and the tests. */
  stats: {
    felled: number; sawn: number; delivered: number; burned: number;
    caught: number; dried: number; fishIn: number; eaten: number;
    picked: number; milled: number; kegs: number; kegsIn: number; poured: number; drunk: number;
    meals: number; hungry: number; slept: number;
  };
  /** Every item (firewood, fish, apples, kegs, tankards). */
  items: Item[];
  newItem(kind: Item['kind']): Item;
  removeItem(it: Item): void;
}

export interface Worker {
  i: number;
  actor: Actor;
  walker: Walker;
  root: THREE.Object3D;
  /** What they play when they've time on their hands. */
  instrument: 'fiddle' | 'banjo' | null;
  /** Their own front door (where they go in at night and come out in the morning). */
  home: { x: number; z: number; yaw: number };
}

/** Steps that aren't work: sitting about and playing. */
const LEISURE = new Set(['to bench', 'sitting', 'playing', 'getting up']);
/** Steps of moving an armful from one place to a stack. */
const DELIVERY = new Set(['fetching', 'gathering', 'delivering', 'stacking']);
/** Steps of the evening: supper at the inn, home, sleep. */
const EVENING = new Set(['to supper', 'waiting for supper', 'eating', 'leaving the table', 'going home']);

type Step = { kind: string; [k: string]: unknown };

const _v = new THREE.Vector3();
const facing = (fromX: number, fromZ: number, toX: number, toZ: number) => Math.atan2(toX - fromX, toZ - fromZ);

/** Logs lying on the ground that nobody is fetching. */
const looseLogs = (v: Village) => v.logs.filter((l) => l.place.at === 'ground' && l.claimedBy < 0);

/** Where to stand to pick up a log lying on the ground: beside its middle, on the near side, facing it. */
function besideLog(l: Log, fromX: number, fromZ: number) {
  const pl = l.place as { x: number; z: number; yaw: number };
  // the log's axis is its local x turned by yaw: (cos, −sin); either normal works
  let nx = Math.sin(pl.yaw), nz = Math.cos(pl.yaw);
  if ((fromX - pl.x) * nx + (fromZ - pl.z) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  const d = 0.42;
  const x = pl.x + nx * d, z = pl.z + nz * d;
  return { x, z, yaw: facing(x, z, pl.x, pl.z) };
}

/** A person's routine and what they're up to (for the overlay). */
export abstract class Job {
  step: Step = { kind: 'idle' };
  carrying: Log | null = null;
  /** What's in their arms. */
  armful: Item[] = [];
  protected waitUntil = 0;

  constructor(readonly w: Worker, readonly role: string) {}

  get doing() {
    return this.step.kind;
  }

  /** Asleep at home (hidden indoors). */
  asleep = false;
  /** Had supper today. */
  ateToday = false;
  protected seat: Seat | null = null;

  /** Called every simulation step, before walking. */
  tick(v: Village) {
    if (this.asleep) {
      if (v.phase === 'work') this.wake();
      return;
    }
    if (EVENING.has(this.step.kind)) {
      this.eveningStep(v);
      return;
    }
    // evening: supper (if not had it), else home; started between tasks
    if (this.step.kind === 'idle' && v.phase !== 'work' && this.eveningStarts(v)) return;
    if (LEISURE.has(this.step.kind)) this.leisureStep(v);
    else if (DELIVERY.has(this.step.kind)) this.deliveryStep(v);
    else this.run(v);
    const a = this.w.actor;
    // an armful interrupted the same way: down it goes, where they stand
    if (this.armful.length && a.kind !== 'armful' && this.step.kind !== 'stacking') {
      const to = this.step.to as Store | undefined;
      if (to) to.incoming = Math.max(0, to.incoming - this.armful.length);
      for (const p of this.armful) p.place = { at: 'ground', pos: p.mesh.position.clone().setY(PIECE_R * 0.5), quat: p.mesh.quaternion.clone() };
      this.armful = [];
      this.step = { kind: 'idle' };
      this.w.walker.stop();
    }
    // interrupted while carrying (tripped, shoved): drop it here (but a
    // carry that just ended because it was put down is the routine's to handle)
    if (this.carrying && a.kind !== 'haul' && this.step.kind !== 'dropping' && this.step.kind !== 'loading') {
      const l = this.carrying;
      const r = this.w.root;
      l.place = { at: 'ground', x: r.position.x + Math.sin(r.rotation.y) * 0.4, z: r.position.z + Math.cos(r.rotation.y) * 0.4, yaw: r.rotation.y + Math.PI / 2 };
      l.claimedBy = -1;
      this.carrying = null;
      this.dropped(v);
      this.step = { kind: 'idle' };
      this.w.walker.stop();
    }
  }

  protected abstract run(v: Village): void;
  /** Is there something for them to do right now? (Leisure ends when there is.) */
  protected abstract hasWork(v: Village): boolean;

  // ------------------------------------------------------------ moving things in armfuls

  /**
   * Go and fetch n pieces from one stack and stack them on another: a job
   * anyone can take. Promises them on both ends straight away (the source's
   * pieces are spoken for, the destination's room is taken).
   */
  protected fetch(from: Store, to: Store, n: number, ok: (it: Item) => boolean = () => true) {
    from.reserved += n;
    to.incoming += n;
    const at = from.workSpot();
    this.go(at.x, at.z, at.yaw);
    this.step = { kind: 'fetching', from, to, n, ok };
  }

  /** Gather these items (lying at these poses) into an armful and take them to a store (room there already promised). */
  protected gather(pieces: Item[], from: ItemPose[], to: Store) {
    for (const p of pieces) p.place = { at: 'carried', by: this.w.i };
    this.armful = pieces;
    this.w.actor.start('armful', { items: { meshes: pieces.map((p) => p.mesh), from } });
    this.step = { kind: 'gathering', to };
  }

  private deliveryStep(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const to = s.to as Store;
    switch (s.kind) {
      case 'fetching': {
        if (!this.arrived) return;
        const from = s.from as Store;
        const n = s.n as number;
        const slots = from.top(n, s.ok as (it: Item) => boolean);
        from.reserved = Math.max(0, from.reserved - n);
        if (slots.length < n) to.incoming = Math.max(0, to.incoming - (n - slots.length));
        if (!slots.length) {
          this.step = { kind: 'idle' };
          return;
        }
        const pieces = slots.map((i) => from.items[i]!);
        const poses = slots.map((i) => from.slotWorld(i));
        for (const i of slots) from.items[i] = null;
        this.gather(pieces, poses, to);
        return;
      }
      case 'gathering': {
        if (!(a.kind === 'armful' && a.choreOf('armful').carrying)) return;
        const at = to.workSpot();
        this.go(at.x, at.z, at.yaw);
        this.step = { kind: 'delivering', to };
        return;
      }
      case 'delivering': {
        if (!this.arrived) return;
        const slots = to.free(this.armful.length);
        // (room was promised, so there's a slot for each)
        slots.forEach((i, k) => (to.items[i] = this.armful[k]));
        a.choreOf('armful').putDown(slots.map((i) => to.slotWorld(i)));
        this.step = { kind: 'stacking', to, slots };
        return;
      }
      case 'stacking': {
        if (a.kind === 'armful') return;
        const slots = s.slots as number[];
        this.armful.forEach((p, k) => (p.place = { at: 'stack', stack: to, slot: slots[k] }));
        to.incoming = Math.max(0, to.incoming - this.armful.length);
        if (to === v.inn) v.stats.delivered += this.armful.length;
        if (to === v.larder) v.stats.fishIn += this.armful.length;
        if (to === v.innKegs) v.stats.kegsIn += this.armful.length;
        if (to === v.tankardSpot) {
          this.armful = [];
          this.step = { kind: 'idle' };
          v.served();
          return;
        }
        const plateOf = v.seats.find((st) => st.plate === to);
        if (plateOf) {
          this.armful = [];
          this.step = { kind: 'idle' };
          v.mealServed(plateOf);
          return;
        }
        this.armful = [];
        this.step = { kind: 'idle' };
        return;
      }
    }
  }

  // ------------------------------------------------------------ evenings

  /** Head for supper or home, if it's time; returns whether they did. */
  protected eveningStarts(v: Village) {
    if (v.phase === 'supper' && !this.ateToday) {
      const me = this.w.walker;
      const free = v.seats.filter((s) => s.state === 'free');
      if (free.length) {
        const seat = free.reduce((b, s) => (s.table.world(s.x, 0).distanceTo(new THREE.Vector3(me.x, 0, me.z)) < b.table.world(b.x, 0).distanceTo(new THREE.Vector3(me.x, 0, me.z)) ? s : b));
        seat.state = 'claimed';
        seat.diner = this.w.i;
        this.seat = seat;
        const at = seat.table.sitFor(seat, this.w.actor);
        this.w.walker.go({ x: at.x, z: at.z, yaw: at.yaw, ignore: seat.table.obstacle, via: at.via });
        this.step = { kind: 'to supper', table: at.table };
        return true;
      }
    }
    this.goHome();
    return true;
  }

  protected goHome() {
    const h = this.w.home;
    this.w.actor.stop();
    this.go(h.x, h.z, h.yaw);
    this.step = { kind: 'going home' };
  }

  /** Sat down at a seat (supper or not): make the plate's spot fit them. */
  protected seated(seat: Seat) {
    const d = this.w.actor.choreOf('dine');
    const at = d.boardWorld();
    seat.plate.set(at, seat.table.yaw, seat.table.serveFrom(at));
    seat.state = 'seated';
  }

  private eveningStep(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const seat = this.seat;
    switch (s.kind) {
      case 'to supper': {
        if (!this.arrived) return;
        a.start('dine', { atTable: s.table as { top: number; edge: number; h: number } });
        this.seated(seat!);
        this.step = { kind: 'waiting for supper' };
        return;
      }
      case 'waiting for supper':
      case 'eating': {
        const d = a.choreOf('dine');
        if (seat!.state === 'served') this.step = { kind: 'eating' };
        const late = v.phase === 'night' && seat!.state !== 'served';
        if (d.ate > 0 || late || !a.busy) {
          if (d.ate > 0) {
            this.ateToday = true;
          } else if (late) v.stats.hungry++;
          d.leave();
          seat!.state = 'done';
          this.step = { kind: 'leaving the table' };
        }
        return;
      }
      case 'leaving the table': {
        if (a.busy) return;
        if (seat) {
          seat.state = 'free';
          seat.diner = -1;
          this.seat = null;
        }
        this.goHome();
        return;
      }
      case 'going home': {
        if (!this.arrived) return;
        // in they go
        this.asleep = true;
        this.w.root.visible = false;
        v.cameHome(this.w.i);
        v.stats.slept++;
        this.step = { kind: 'asleep' };
        return;
      }
    }
  }

  /** Morning: out of the door, a new day. */
  protected wake() {
    this.asleep = false;
    this.ateToday = false;
    this.w.root.visible = true;
    this.step = { kind: 'idle' };
    this.waitUntil = 0;
  }

  // ------------------------------------------------------------ time on their hands

  private restAfter = 0;
  private nextTune = 0;
  private wasPlaying = false;

  /**
   * Nothing to do: now and then go and sit on a free bench (and maybe play
   * there), or play standing where they are. Returns whether they started
   * something. Any of it stops as soon as there's work.
   */
  protected leisure(v: Village) {
    if (v.time < this.restAfter || v.phase !== 'work') return false;
    this.restAfter = v.time + 5 + Math.random() * 6;
    const r = Math.random();
    const me = this.w.walker;
    // their own bench if they have one, else any free one that's nobody's
    const mine = v.benches.filter((b) => b.owner === this.w.i);
    const free = (mine.length ? mine : v.benches.filter((b) => b.owner < 0)).filter((b) => b.bench.claimedBy < 0);
    if (free.length && r < 0.6) {
      const b = free.reduce((a, b) => (Math.hypot(b.bench.x - me.x, b.bench.z - me.z) < Math.hypot(a.bench.x - me.x, a.bench.z - me.z) ? b : a));
      b.bench.claimedBy = this.w.i;
      const at = b.bench.sitSpot(0.22);
      this.go(at.x, at.z, at.yaw, b.obstacle, 'ahead');
      this.step = { kind: 'to bench', bench: b };
      return true;
    }
    if (this.w.instrument && r < 0.85) {
      this.play();
      this.step = { kind: 'playing' };
      return true;
    }
    return false;
  }

  private play() {
    this.w.actor.start(this.w.instrument!, { phrases: 2 + Math.floor(Math.random() * 2) }); // (the rest of this phrase, then one or two more)
    this.wasPlaying = true;
  }

  private leisureStep(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const bench = (s.bench as { bench: Bench } | undefined)?.bench;
    const work = this.hasWork(v) || v.phase !== 'work'; // (and supper is work, of a kind)
    switch (s.kind) {
      case 'to bench':
        if (work) {
          bench!.claimedBy = -1;
          this.w.walker.stop();
          this.step = { kind: 'idle' };
        } else if (this.arrived) {
          a.sitDown();
          this.nextTune = v.time + 2 + Math.random() * 4;
          this.step = { ...s, kind: 'sitting' };
        }
        return;
      case 'sitting':
        if (work) {
          if (a.busy) a.stopPlaying(true);
          a.getUp();
          this.step = { ...s, kind: 'getting up' };
          return;
        }
        if (this.wasPlaying && !a.busy) {
          // a tune done: sit a while before the next
          this.wasPlaying = false;
          this.nextTune = v.time + 4 + Math.random() * 10;
        }
        if (!a.busy && a.seated && this.w.instrument && v.time >= this.nextTune) this.play();
        return;
      case 'playing':
        if (work && a.busy) a.stopPlaying(true);
        if (!a.busy) {
          this.wasPlaying = false;
          this.restAfter = v.time + 6 + Math.random() * 8; // a breather before anything else
          this.step = { kind: 'idle' };
        }
        return;
      case 'getting up':
        if (a.busy) a.stopPlaying(true);
        if (!a.busy) a.getUp(); // (a tune that was still being put away)
        if (!a.busy && !a.onSeat) {
          bench!.claimedBy = -1;
          this.wasPlaying = false;
          this.step = { kind: 'idle' };
        }
        return;
    }
  }
  /** Undo bookkeeping after an interrupted carry. */
  protected dropped(_v: Village) {}

  /**
   * Walk to (x, z) and face yaw. With `ignore`, approach from 0.55 behind
   * (or ahead, for a bench you back onto) and step in, ignoring that obstacle
   * only for the last step.
   */
  protected go(x: number, z: number, yaw: number | null, ignore: Obstacle | null = null, from: 'behind' | 'ahead' = 'behind') {
    const k = from === 'behind' ? -0.55 : 0.55;
    const via = ignore && yaw !== null ? { x: x + Math.sin(yaw) * k, z: z + Math.cos(yaw) * k } : null;
    this.w.walker.go({ x, z, yaw, ignore, via });
  }

  protected get arrived() {
    return this.w.walker.arrived;
  }

  /** Lift a log (wherever it lies) onto the shoulder. */
  protected lift(l: Log, from: { pos: THREE.Vector3; yaw: number }) {
    l.place = { at: 'carried', by: this.w.i };
    this.carrying = l;
    this.w.actor.start('haul', { log: { mesh: l.mesh, from, r: LOG_R } });
  }

  protected get haulCarrying() {
    return this.w.actor.kind === 'haul' && this.w.actor.choreOf('haul').carrying;
  }
}

export class Lumberjack extends Job {
  private tree: Tree | null = null;
  private spawned = false;

  constructor(w: Worker) {
    super(w, 'lumberjack');
  }

  protected dropped(v: Village) {
    v.pile.incoming = Math.max(0, v.pile.incoming - 1);
  }

  protected hasWork(v: Village) {
    const loose = looseLogs(v);
    const room = v.pile.count + v.pile.incoming < v.pile.slots.length;
    if (room && loose.length) return true;
    return v.pile.count + v.pile.incoming + loose.length < PILE_WANT && v.forest.trees.some((t) => t.state === 'standing' && t.claimedBy < 0);
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const me = this.w.walker;
    switch (s.kind) {
      case 'idle': {
        if (v.time < this.waitUntil) return;
        // a log lying about and room for it: fetch it
        const room = v.pile.count + v.pile.incoming < v.pile.slots.length;
        const loose = looseLogs(v);
        if (room && loose.length) {
          const l = loose.reduce((b, l) => (dist(l, me) < dist(b, me) ? l : b));
          l.claimedBy = this.w.i;
          v.pile.incoming++;
          const at = besideLog(l, me.x, me.z);
          this.go(at.x, at.z, at.yaw);
          this.step = { kind: 'to log', log: l };
          return;
        }
        // the pile wants more than is coming: fell a tree
        if (v.pile.count + v.pile.incoming + loose.length < PILE_WANT) {
          const t = this.pickTree(v);
          if (t) {
            t.claimedBy = this.w.i;
            this.tree = t;
            const spot = this.standFor(t, v);
            this.go(spot.x, spot.z, spot.yaw, v.treeObstacle(t));
            this.step = { kind: 'to tree' };
            return;
          }
        }
        if (this.leisure(v)) return;
        this.waitUntil = v.time + 1.5;
        return;
      }
      case 'to tree': {
        if (!this.arrived) return;
        const t = this.tree!;
        const spec = v.forest.specOf(t);
        v.forest.fell(t, a.choreOf('chop').fit(spec.rt).cutY);
        this.spawned = false;
        a.start('chop', { tree: spec });
        this.step = { kind: 'chopping' };
        return;
      }
      case 'chopping': {
        const fallen = a.kind === 'chop' ? a.choreOf('chop').fallen() : null;
        if (fallen && !this.spawned) {
          // the trunk is down: two logs where it lies, a stump where it stood
          this.spawned = true;
          for (let k = 0; k < 2; k++) {
            const l = v.newLog();
            const at = fallen.base.clone().addScaledVector(fallen.dir, LOG_L * 0.6 + k * LOG_L * 1.1);
            l.place = { at: 'ground', x: at.x, z: at.z, yaw: Math.atan2(-fallen.dir.z, fallen.dir.x) };
          }
          v.forest.felled(this.tree!, fallen.cutY, v.time);
          v.stats.felled++;
        }
        if (!a.busy) {
          if (!this.spawned) v.forest.felled(this.tree!, 0.3, v.time); // (interrupted: call it felled anyway)
          this.tree = null;
          this.step = { kind: 'idle' };
        }
        return;
      }
      case 'to log': {
        if (!this.arrived) return;
        const l = s.log as Log;
        const pl = l.place as { x: number; z: number; yaw: number };
        this.lift(l, { pos: new THREE.Vector3(pl.x, LOG_R, pl.z), yaw: pl.yaw });
        this.step = { kind: 'lifting' };
        return;
      }
      case 'lifting': {
        if (!this.haulCarrying) return;
        const spot = v.pile.workSpot(_v, -0.3);
        this.go(spot.x, spot.z, facing(spot.x, spot.z, v.pile.x, v.pile.z));
        this.step = { kind: 'to pile' };
        return;
      }
      case 'to pile': {
        if (!this.arrived) return;
        const slot = v.pile.freeSlot();
        const l = this.carrying!;
        if (slot < 0) {
          // full after all: put it down beside the pile
          const r = this.w.root;
          a.choreOf('haul').putDown({ pos: new THREE.Vector3(r.position.x + Math.sin(r.rotation.y) * 0.45, LOG_R, r.position.z + Math.cos(r.rotation.y) * 0.45), yaw: r.rotation.y + Math.PI / 2 });
          this.step = { kind: 'dropping', slot: -1 };
        } else {
          v.pile.logs[slot] = l; // spoken for already, so nobody takes the slot meanwhile
          a.choreOf('haul').putDown({ pos: v.pile.slotWorld(slot, new THREE.Vector3()), yaw: v.pile.yaw });
          this.step = { kind: 'dropping', slot };
        }
        return;
      }
      case 'dropping': {
        if (a.kind === 'haul') return;
        const l = this.carrying!;
        const slot = s.slot as number;
        if (slot >= 0) l.place = { at: 'pile', slot };
        else {
          const r = this.w.root;
          l.place = { at: 'ground', x: r.position.x + Math.sin(r.rotation.y) * 0.45, z: r.position.z + Math.cos(r.rotation.y) * 0.45, yaw: r.rotation.y + Math.PI / 2 };
        }
        l.claimedBy = -1;
        this.carrying = null;
        v.pile.incoming = Math.max(0, v.pile.incoming - 1);
        this.step = { kind: 'idle' };
        return;
      }
    }
  }

  /** The nearest standing tree nobody else has claimed. */
  private pickTree(v: Village) {
    const me = this.w.walker;
    let best: Tree | null = null;
    let bestD = Infinity;
    for (const t of v.forest.trees) {
      if (t.state !== 'standing' || t.claimedBy >= 0) continue;
      const d = Math.hypot(t.x - me.x, t.z - me.z);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  /**
   * Where to stand so the axe bites this trunk: the chop's fit gives where a
   * trunk must be relative to the chopper (c); stand on the circle of that
   * radius around the tree, on the side nearest us but clear of other trunks,
   * and face so the trunk lands at c.
   */
  private standFor(t: Tree, v: Village) {
    const spec = v.forest.specOf(t);
    const { c } = this.w.actor.choreOf('chop').fit(spec.rt);
    const rad = Math.hypot(c.x, c.z);
    const phiC = Math.atan2(c.x, c.z);
    const me = this.w.walker;
    const toMe = Math.atan2(me.x - t.x, me.z - t.z);
    let best = { x: 0, z: 0, yaw: 0 };
    let bestScore = -Infinity;
    for (let k = 0; k < 16; k++) {
      const ang = toMe + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
      const x = t.x + Math.sin(ang) * rad, z = t.z + Math.cos(ang) * rad;
      let clear = Infinity;
      for (const o of v.forest.trees) if (o !== t && o.state !== 'felling') clear = Math.min(clear, Math.hypot(o.x - x, o.z - z));
      const score = Math.min(clear, 0.6) * 3 - Math.abs(wrap(ang - toMe)) * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z, yaw: ang + Math.PI - phiC };
      }
    }
    return best;
  }
}

export class Woodworker extends Job {
  constructor(w: Worker) {
    super(w, 'woodworker');
  }

  /** A log to saw, and room on the yard stack for what it makes. */
  private canSaw(v: Village) {
    return !v.horse.log && !v.horse.pieces.length && v.pile.ready > 0 && v.yard.room >= PIECES_PER_LOG;
  }

  /** How many pieces the inn could do with right now (and we have to bring). */
  private innWants(v: Village) {
    const short = INN_WANT - v.inn.count - v.inn.incoming;
    return short > 0 ? Math.min(ARMFUL, v.yard.available, v.inn.room) : 0;
  }

  protected hasWork(v: Village) {
    return this.canSaw(v) || this.innWants(v) > 0;
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const horse = v.horse;
    switch (s.kind) {
      case 'idle': {
        if (v.time < this.waitUntil) return;
        // the inn nearly out of firewood: that comes before sawing more
        const urgent = v.inn.count + v.inn.incoming < 3 ? this.innWants(v) : 0;
        if (urgent > 0) {
          this.fetch(v.yard, v.inn, urgent);
          return;
        }
        if (this.canSaw(v)) {
          v.yard.incoming += PIECES_PER_LOG; // room for what it'll make
          const spot = v.pile.workSpot(_v, 0.3);
          this.go(spot.x, spot.z, facing(spot.x, spot.z, v.pile.x, v.pile.z));
          this.step = { kind: 'to pile' };
          return;
        }
        const n = this.innWants(v);
        if (n > 0) {
          this.fetch(v.yard, v.inn, n);
          return;
        }
        if (this.leisure(v)) return;
        // otherwise wait at the sawhorse
        const at = horse.sawSpot();
        const w = this.w.walker;
        if (Math.hypot(w.x - at.x, w.z - at.z) > 0.3 && (!w.goal || w.arrived)) this.go(at.x, at.z, at.yaw, v.horseObstacle);
        this.waitUntil = v.time + 1;
        return;
      }
      case 'to pile': {
        if (!this.arrived) return;
        const slot = v.pile.topSlot();
        if (slot < 0) {
          v.yard.incoming = Math.max(0, v.yard.incoming - PIECES_PER_LOG);
          this.step = { kind: 'idle' };
          return;
        }
        const l = v.pile.logs[slot]!;
        v.pile.logs[slot] = null;
        this.lift(l, { pos: v.pile.slotWorld(slot, new THREE.Vector3()), yaw: v.pile.yaw });
        this.step = { kind: 'lifting' };
        return;
      }
      case 'lifting': {
        if (!this.haulCarrying) return;
        const at = horse.sawSpot();
        this.go(at.x, at.z, at.yaw, v.horseObstacle);
        this.step = { kind: 'to sawhorse' };
        return;
      }
      case 'to sawhorse': {
        if (!this.arrived) return;
        a.choreOf('haul').putDown({ pos: horse.logAt.clone(), yaw: horse.yaw });
        this.step = { kind: 'loading' };
        return;
      }
      case 'loading': {
        if (a.kind === 'haul') return;
        const l = this.carrying!;
        this.carrying = null;
        l.place = { at: 'horse' };
        horse.log = l;
        a.start('saw', { sawLog: { r: LOG_R, len: LOG_L / 2.05 } });
        l.mesh.visible = false; // the saw's own log halves take over
        this.step = { kind: 'sawing' };
        return;
      }
      case 'sawing': {
        if (a.busy) return;
        // sawn through: the log is now firewood lying on the sawhorse; gather
        // it up and stack it in the yard (room was kept for it)
        const l = horse.log!;
        horse.log = null;
        v.removeLog(l);
        v.stats.sawn++;
        const axis = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), horse.yaw);
        const poses: ItemPose[] = [];
        const pieces: Item[] = [];
        for (let k = 0; k < PIECES_PER_LOG; k++) {
          const p = v.newItem('wood');
          p.place = { at: 'horse' };
          const pos = horse.logAt.clone().addScaledVector(axis, (k - 1.5) * PIECE_L * 0.7);
          pos.y += (k % 2) * PIECE_R * 0.4;
          const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), horse.yaw + Math.PI / 2 + (k - 1.5) * 0.25);
          p.mesh.position.copy(pos);
          p.mesh.quaternion.copy(quat);
          poses.push({ pos, quat });
          pieces.push(p);
        }
        horse.pieces = pieces;
        this.gather(pieces, poses, v.yard);
        horse.pieces = [];
        return;
      }
    }
  }
}

const dist = (l: Log, w: Walker) => {
  const p = l.place as { x: number; z: number };
  return Math.hypot(p.x - w.x, p.z - w.z);
};

/**
 * The fisher: while the drying rack has room for a catch, walk to the
 * water's edge (somewhere on the side toward the rack), cast, and keep
 * fishing until there are CATCH fish lying on the grass beside them; then
 * gather them up and hang them on the rack.
 */
export class Fisher extends Job {
  private caught: { item: Item; pose: ItemPose }[] = [];
  private lastCatch: ItemPose | null = null;

  constructor(w: Worker) {
    super(w, 'fisher');
  }

  protected hasWork(v: Village) {
    return v.rack.room >= CATCH;
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    switch (s.kind) {
      case 'idle': {
        if (v.time < this.waitUntil) return;
        if (this.hasWork(v)) {
          v.rack.incoming += CATCH; // room on the rack for this catch
          const at = this.waterSpot(v);
          this.go(at.x, at.z, at.yaw);
          this.step = { kind: 'to the water' };
          return;
        }
        if (this.leisure(v)) return;
        this.waitUntil = v.time + 2;
        return;
      }
      case 'to the water': {
        if (!this.arrived) return;
        a.start('fish', { water: true });
        this.step = { kind: 'fishing' };
        return;
      }
      case 'fishing': {
        if (a.kind === 'fish') {
          this.lastCatch = a.choreOf('fish').catchPose();
          return;
        }
        // one more: off the hook and onto the grass beside them
        const k = this.caught.length;
        const r = this.w.root;
        const yaw = r.rotation.y;
        const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
        const back = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
        const pos = r.position.clone().addScaledVector(right, 0.32 + k * 0.08).addScaledVector(back, 0.05 + k * 0.1).setY(0.035);
        const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + 0.4 * (k - 1)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2));
        const item = v.newItem('fish');
        item.place = { at: 'ground', pos, quat };
        if (this.lastCatch) item.tween = { pos: this.lastCatch.pos.clone(), quat: this.lastCatch.quat.clone(), t0: v.time, dur: 0.45 };
        this.caught.push({ item, pose: { pos, quat } });
        v.stats.caught++;
        if (this.caught.length < CATCH) {
          a.start('fish', { water: true });
          return;
        }
        // enough: up they go, onto the rack
        this.gather(this.caught.map((c) => c.item), this.caught.map((c) => c.pose), v.rack);
        this.caught = [];
        return;
      }
    }
  }

  /**
   * Where to stand to fish: on the shore facing the middle of the pond, about
   * 0.6 of their height back from the water (where the cast's 'bank' falls),
   * on the side toward the rack, give or take.
   */
  private waterSpot(v: Village) {
    const pond = v.pond;
    const ang = Math.atan2(v.rack.x - pond.x, v.rack.z - pond.z) + (Math.random() - 0.5) * 1.6;
    const dx = Math.sin(ang), dz = Math.cos(ang);
    const H = (this.w.root.userData.height as number) ?? 1;
    const d = pond.edge(dx, dz) + 0.62 * H - 0.05;
    return { x: pond.x + dx * d, z: pond.z + dz * d, yaw: Math.atan2(-dx, -dz) };
  }
}

/**
 * The innkeeper: keeps the larder crate by the kitchen hatch stocked with
 * dried fish, fetched from the rack an armful at a time. Otherwise, time on
 * their hands (a bench outside the inn, a fiddle).
 */
export class Innkeeper extends Job {
  constructor(w: Worker) {
    super(w, 'innkeeper');
  }

  /** Dried fish on the rack nobody has come for yet. */
  private dryOnRack(v: Village) {
    return v.rack.items.filter((it) => it && it.place.at === 'stack' && it.dry >= 1).length - v.rack.reserved;
  }

  private larderWants(v: Village) {
    const short = LARDER_WANT - v.larder.count - v.larder.incoming;
    return short > 0 ? Math.min(ARMFUL, this.dryOnRack(v), v.larder.room) : 0;
  }

  /** Kegs at the mill nobody's come for, if the inn's short. */
  private kegsWanted(v: Village) {
    const short = INN_KEGS - v.innKegs.count - v.innKegs.incoming;
    return short > 0 ? Math.min(1, v.millKegs.available, v.innKegs.room) : 0;
  }

  /** Someone's tankard is empty, nobody's bringing one, and there's cider. */
  private refill(v: Village) {
    return v.wantsRefill() && v.tankardSpot.incoming === 0 && v.tankardSpot.count === 0 && v.innKegs.available > 0;
  }

  protected hasWork(v: Village) {
    return this.refill(v) || this.larderWants(v) > 0 || this.kegsWanted(v) > 0;
  }

  /** The innkeeper doesn't sit down to supper: they cook it, then go to bed once everyone's fed. */
  protected eveningStarts(v: Village) {
    if (v.phase === 'night' || (v.hours >= SUPPER + 1 && v.everyoneFed() && !this.seatWaiting(v))) {
      this.ateToday = true; // (a bite in the kitchen)
      this.goHome();
      return true;
    }
    return false;
  }

  /** Someone sat down to supper who's not been served (and nobody's cooking for). */
  private seatWaiting(v: Village) {
    return v.seats.find((st) => st.state === 'seated' && st.plate.incoming === 0 && st.plate.count === 0) ?? null;
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    switch (s.kind) {
      case 'to the hatch': {
        if (!this.arrived) return;
        const seat = s.seat as Seat;
        const slot = v.larder.top(1)[0];
        if (slot === undefined) {
          // no fish after all
          seat.plate.incoming = 0;
          this.step = { kind: 'idle' };
          return;
        }
        v.removeItem(v.larder.items[slot]!);
        v.larder.items[slot] = null;
        // cook it: hands busy at the counter a while
        const c = v.hatch.counter;
        const side = new THREE.Vector3(Math.cos(v.hatch.stand.yaw), 0, -Math.sin(v.hatch.stand.yaw)).multiplyScalar(0.12);
        a.start('hold', { hold: { right: () => c.clone().sub(side), left: () => c.clone().add(side), lean: 0.2, bob: () => 0.02 * Math.sin(v.time * 9) } });
        this.step = { kind: 'cooking', seat, until: v.time + 3 };
        return;
      }
      case 'cooking': {
        if (v.time < (s.until as number)) return;
        if (a.kind === 'hold') {
          a.choreOf('hold').release();
          return;
        }
        if (a.busy) return;
        const meal = v.newItem('meal');
        const pos = v.hatch.counter.clone().setY(v.hatch.counter.y + 0.02);
        const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), v.hatch.stand.yaw);
        meal.place = { at: 'ground', pos, quat };
        this.gather([meal], [{ pos, quat }], (s.seat as Seat).plate);
        return;
      }
      case 'to the kegs': {
        if (!this.arrived) return;
        // draw a tankard from the top keg: hands at its tap a moment
        const slot = v.innKegs.top(1)[0];
        if (slot === undefined) {
          v.tankardSpot.incoming = 0;
          this.step = { kind: 'idle' };
          return;
        }
        const tap = v.innKegs.slotWorld(slot).pos;
        const front = new THREE.Vector3(Math.sin(v.innKegs.yaw), 0, Math.cos(v.innKegs.yaw)).multiplyScalar(0.12);
        a.start('hold', { hold: { right: () => tap.clone().add(front).setY(tap.y + 0.02), left: () => tap.clone().add(front).setY(tap.y - 0.05), lean: 0.35 } });
        this.step = { kind: 'drawing cider', slot, until: v.time + 1.6 };
        return;
      }
      case 'drawing cider': {
        if (v.time < (s.until as number)) return;
        if (a.kind === 'hold') {
          a.choreOf('hold').release();
          return;
        }
        if (a.busy) return;
        const slot = s.slot as number;
        const keg = v.innKegs.items[slot];
        if (keg) {
          keg.dry -= 1;
          if (keg.dry <= 0) {
            // that's the keg empty
            v.innKegs.items[slot] = null;
            v.removeItem(keg);
          }
        }
        const r = this.w.root;
        const mug = v.newItem('mug');
        const pos = r.position.clone().add(new THREE.Vector3(Math.sin(r.rotation.y) * 0.3, 0.55, Math.cos(r.rotation.y) * 0.3));
        mug.place = { at: 'ground', pos, quat: r.quaternion.clone() };
        this.gather([mug], [{ pos, quat: r.quaternion.clone() }], v.tankardSpot);
        v.stats.poured++;
        return;
      }
    }
    if (s.kind !== 'idle' || v.time < this.waitUntil) return;
    // supper: cook for whoever's sat down, one plate at a time
    if (v.phase !== 'work') {
      const seat = this.seatWaiting(v);
      if (seat && v.larder.available > 0) {
        seat.plate.incoming += 1;
        const at = v.hatch.stand;
        this.go(at.x, at.z, at.yaw);
        this.step = { kind: 'to the hatch', seat };
        return;
      }
    }
    if (this.refill(v)) {
      v.tankardSpot.incoming += 1;
      const at = v.innKegs.workSpot();
      this.go(at.x, at.z, at.yaw);
      this.step = { kind: 'to the kegs' };
      return;
    }
    const n = this.larderWants(v);
    if (n > 0) {
      this.fetch(v.rack, v.larder, n, (it) => it.dry >= 1);
      return;
    }
    if (this.kegsWanted(v) > 0) {
      this.fetch(v.millKegs, v.innKegs, 1);
      return;
    }
    if (this.leisure(v)) return;
    this.waitUntil = v.time + 2;
  }
}

/**
 * The apple picker: while the mill's hopper has room for a basketful, fetch
 * the basket (wherever it was left), carry it to a tree with ripe apples in
 * reach, set it down, pick into it one apple at a time (moving round the
 * tree, or on to the next), then carry the full basket to the mill and tip
 * the apples into the hopper. The basket stays there till next time.
 */
export class Picker extends Job {
  private apple: Apple | null = null;
  private lastPick: ItemPose | null = null;

  constructor(w: Worker) {
    super(w, 'picker');
  }

  /** How high this person can pick (the apple at full stretch, on tiptoe). */
  private reachY() {
    return this.w.actor.choreOf('pick').reach().y + 0.04;
  }

  protected hasWork(v: Village) {
    return v.mill.hopper.room >= BASKET && v.orchard.ripe(this.reachY()).length >= 2;
  }

  /** Take up the basket (from wherever it lies) in both arms. */
  private takeBasket(v: Village) {
    const b = v.basket.group;
    this.w.actor.start('armful', { items: { meshes: [b], from: [{ pos: b.position.clone(), quat: b.quaternion.clone() }] } });
  }

  /** Set it down beside us (right and a little ahead). */
  private setDownBasket() {
    const r = this.w.root;
    const yaw = r.rotation.y;
    const pos = r.position.clone().add(new THREE.Vector3(-Math.cos(yaw) * 0.38 + Math.sin(yaw) * 0.1, 0, Math.sin(yaw) * 0.38 + Math.cos(yaw) * 0.1));
    this.w.actor.choreOf('armful').putDown([{ pos, quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw) }]);
  }

  private get carryingBasket() {
    return this.w.actor.kind === 'armful' && this.w.actor.choreOf('armful').carrying;
  }

  /** The nearest ripe apple in reach (on this tree first, if there's one left). */
  private nextApple(v: Village, tree = -1) {
    const me = this.w.walker;
    const ripe = v.orchard.ripe(this.reachY());
    const near = (a: Apple) => Math.hypot(a.pos.x - me.x, a.pos.z - me.z) - (a.tree === tree ? 10 : 0);
    return ripe.length ? ripe.reduce((b, a) => (near(a) < near(b) ? a : b)) : null;
  }

  /** Where to stand so the apple is right where a full stretch puts the hand, facing the tree. */
  private standFor(a: Apple, v: Village) {
    const t = v.orchard.trees[a.tree];
    const out = Math.atan2(a.pos.x - t.x, a.pos.z - t.z);
    const yaw = out + Math.PI;
    const h = this.w.actor.choreOf('pick').reach();
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // root frame (h.x, h.z) turned by yaw: (x c + z s, −x s + z c)
    return { x: a.pos.x - (h.x * c + h.z * s), z: a.pos.z - (-h.x * s + h.z * c), yaw };
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const basket = v.basket;
    switch (s.kind) {
      case 'idle': {
        if (v.time < this.waitUntil) return;
        if (this.hasWork(v)) {
          v.mill.hopper.incoming += BASKET; // room in the hopper for this basketful
          const at = basket.workSpot();
          this.go(at.x, at.z, at.yaw);
          this.step = { kind: 'to basket' };
          return;
        }
        if (this.leisure(v)) return;
        this.waitUntil = v.time + 2;
        return;
      }
      case 'to basket': {
        if (!this.arrived) return;
        this.takeBasket(v);
        this.step = { kind: 'taking the basket' };
        return;
      }
      case 'taking the basket': {
        if (!this.carryingBasket) return;
        this.toNextApple(v, -1);
        return;
      }
      case 'to the tree': {
        if (!this.arrived) return;
        this.setDownBasket();
        this.step = { kind: 'setting down', then: 'pick' };
        return;
      }
      case 'setting down': {
        if (a.kind === 'armful') return;
        if (s.then === 'pick') this.pickNext(v);
        else this.step = { kind: 'idle' };
        return;
      }
      case 'to apple': {
        if (!this.arrived) return;
        a.start('pick', { apple: this.apple!.pos });
        this.step = { kind: 'picking' };
        return;
      }
      case 'picking': {
        if (a.kind === 'pick') {
          this.lastPick = a.choreOf('pick').catchPose();
          return;
        }
        // into the basket with it
        const ap = this.apple!;
        v.orchard.picked(ap, v.time);
        v.stats.picked++;
        const slot = basket.free(1)[0];
        const it = v.newItem('apple');
        it.place = { at: 'stack', stack: basket, slot };
        basket.items[slot] = it;
        if (this.lastPick) it.tween = { pos: this.lastPick.pos.clone(), quat: this.lastPick.quat.clone(), t0: v.time, dur: 0.4 };
        this.apple = null;
        if (basket.count >= BASKET) {
          // full: take it to the mill
          const at = basket.workSpot();
          this.go(at.x, at.z, at.yaw);
          this.step = { kind: 'to full basket' };
          return;
        }
        this.pickNext(v, ap.tree);
        return;
      }
      case 'to full basket': {
        if (!this.arrived) return;
        this.takeBasket(v);
        this.step = { kind: 'lifting the basket' };
        return;
      }
      case 'lifting the basket': {
        if (!this.carryingBasket) return;
        const at = v.mill.hopper.workSpot();
        this.go(at.x, at.z, at.yaw);
        this.step = { kind: 'to the mill' };
        return;
      }
      case 'to the mill': {
        if (!this.arrived) return;
        this.setDownBasket();
        this.step = { kind: 'tipping' };
        return;
      }
      case 'tipping': {
        if (a.kind === 'armful') return;
        // the apples go into the hopper one after another
        const hop = v.mill.hopper;
        const slots = hop.free(basket.count);
        const from = basket.top(BASKET);
        from.forEach((bi, k) => {
          const it = basket.items[bi]!;
          const w = basket.slotWorld(bi);
          basket.items[bi] = null;
          hop.items[slots[k]] = it;
          it.place = { at: 'stack', stack: hop, slot: slots[k] };
          it.tween = { pos: w.pos, quat: w.quat, t0: v.time + k * 0.22, dur: 0.45 };
        });
        hop.incoming = Math.max(0, hop.incoming - BASKET);
        a.events.push('thunk');
        this.waitUntil = v.time + 1.5;
        this.step = { kind: 'idle' };
        return;
      }
    }
  }

  /** Walk (with the basket) to the next apple's tree, or pick it if it's on this one. */
  private toNextApple(v: Village, tree: number) {
    const ap = this.nextApple(v, tree);
    if (!ap) {
      // nothing in reach after all: put the basket down and call it a day
      this.setDownBasket();
      v.mill.hopper.incoming = Math.max(0, v.mill.hopper.incoming - BASKET);
      this.step = { kind: 'setting down', then: 'idle' };
      return;
    }
    ap.claimedBy = this.w.i;
    this.apple = ap;
    const at = this.standFor(ap, v);
    this.go(at.x, at.z, at.yaw);
    this.step = { kind: 'to the tree' };
  }

  /** The next apple: on this tree if one's left (the basket stays put), else carry the basket on. */
  private pickNext(v: Village, tree = -1) {
    const ap = this.apple ?? this.nextApple(v, tree);
    if (!ap) {
      this.step = { kind: 'idle' };
      return;
    }
    if (tree >= 0 && ap.tree !== tree) {
      // on to another tree: basket and all
      this.apple = null;
      const at = v.basket.workSpot();
      this.go(at.x, at.z, at.yaw);
      this.step = { kind: 'to basket' };
      return;
    }
    ap.claimedBy = this.w.i;
    this.apple = ap;
    const at = this.standFor(ap, v);
    this.go(at.x, at.z, at.yaw);
    this.step = { kind: 'to apple' };
  }
}

/**
 * The miller: when the hopper holds a batch (and there's room for a keg),
 * turn the crank, the apples going down one by one, until a keg of cider
 * stands full under the spout; then carry it to the keg rack.
 */
export class Miller extends Job {
  private fed = 0;
  private turned = 0;

  constructor(w: Worker) {
    super(w, 'miller');
  }

  private ready(v: Village) {
    return v.mill.hopper.top(MILL_BATCH).length >= MILL_BATCH;
  }

  protected hasWork(v: Village) {
    return this.ready(v) && v.millKegs.room >= 1;
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const mill = v.mill;
    switch (s.kind) {
      case 'idle': {
        if (v.time < this.waitUntil) return;
        if (this.hasWork(v)) {
          v.millKegs.incoming += 1;
          const at = mill.crankSpot();
          this.go(at.x, at.z, at.yaw, null);
          this.step = { kind: 'to the crank' };
          return;
        }
        if (this.leisure(v)) return;
        this.waitUntil = v.time + 2;
        return;
      }
      case 'to the crank': {
        if (!this.arrived) return;
        this.fed = 0;
        this.turned = 0;
        a.start('hold', { hold: { right: () => mill.handle(), left: () => mill.steady(), lean: 0.22, bob: () => 0.03 * (1 + Math.sin(mill.angle)) } });
        this.step = { kind: 'cranking' };
        return;
      }
      case 'cranking': {
        // round and round; every so often an apple goes down
        const spin = Math.min(1, a.t / 0.6) * 4.2; // rad/s
        mill.turn(mill.angle + spin * v.dt);
        this.turned += spin * v.dt;
        if (this.turned > (this.fed + 1) * 4 && this.fed < MILL_BATCH) {
          const slot = mill.hopper.top(1)[0];
          if (slot !== undefined) {
            v.removeItem(mill.hopper.items[slot]!);
            mill.hopper.items[slot] = null;
          }
          this.fed++;
          v.stats.milled++;
          a.events.push('crunch');
        }
        if (this.fed >= MILL_BATCH) {
          // full: a keg of cider under the spout
          const keg = v.newItem('keg');
          keg.dry = SERVINGS;
          const sp = mill.spout();
          keg.place = { at: 'ground', pos: sp.pos, quat: sp.quat };
          keg.tween = { pos: sp.pos.clone().setY(sp.pos.y + 0.25), quat: sp.quat.clone(), t0: v.time, dur: 0.5 };
          v.stats.kegs++;
          a.events.push('splash');
          a.choreOf('hold').release();
          this.step = { kind: 'letting go', keg };
        }
        return;
      }
      case 'letting go': {
        if (a.busy) return;
        const at = mill.frontSpot();
        this.go(at.x, at.z, at.yaw);
        this.step = { kind: 'to the spout', keg: s.keg };
        return;
      }
      case 'to the spout': {
        if (!this.arrived) return;
        const keg = s.keg as Item;
        const pl = keg.place as { pos: THREE.Vector3; quat: THREE.Quaternion };
        this.gather([keg], [{ pos: pl.pos.clone(), quat: pl.quat.clone() }], v.millKegs);
        return;
      }
    }
  }
}

/**
 * The regular: no job, all the time in the world. Sits at the inn's table and
 * sips cider every so often while the tankard has any in it; when it's empty,
 * waits for the innkeeper to bring another.
 */
export class Regular extends Job {
  private nextSip = 0;

  constructor(w: Worker) {
    super(w, 'regular');
  }

  protected hasWork() {
    return false;
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    switch (s.kind) {
      case 'idle': {
        const st = v.seat;
        // in from the end of the bench (stepping between it and the table)
        this.w.walker.go({ x: st.x, z: st.z, yaw: st.yaw, ignore: st.obstacle, via: { ...st.via } });
        this.step = { kind: 'to the table' };
        return;
      }
      case 'to the table': {
        if (!this.arrived) return;
        a.start('dine', { atTable: true });
        const seat = v.seats[0]; // (theirs: the table was built to them)
        seat.state = 'claimed';
        seat.diner = this.w.i;
        this.nextSip = v.time + 4;
        this.step = { kind: 'waiting for a refill' };
        return;
      }
      default: {
        if (!a.busy) {
          // (got up somehow): back to the table
          this.step = { kind: 'idle' };
          return;
        }
        const d = a.choreOf('dine');
        if (v.phase !== 'work' && !this.ateToday) {
          // supper time: they're already sat at their place
          this.seat = v.seats[0];
          this.seated(this.seat);
          this.step = { kind: 'waiting for supper' };
          return;
        }
        this.step = { kind: d.needsRefill ? 'waiting for a refill' : 'drinking cider' };
        if (!d.needsRefill && !d.drinking && v.time >= this.nextSip) {
          a.start('drink');
          v.stats.drunk++;
          this.nextSip = v.time + 10 + Math.random() * 10;
        }
      }
    }
  }
}
