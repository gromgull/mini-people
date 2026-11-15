import * as THREE from 'three';
import type { Actor } from '../actions';
import type { Forest, Tree } from './forest';
import { setMeal, type Basket, type Bench, type BreadOven, type CiderMill, SHEAF_L, type Trough, type Stook, type Crate, type HoopBlock, type Item, type KegRack, type ShavingHorse, LADDER_H, LOG_L, LOG_R, type Log, type Rack, type Sawhorse, type Spot, type Stack, StepLadder, type Store, type StreetLamp, type Woodpile } from './things';
import type { Apple, Orchard } from './orchard';
import type { InnTable, Seat } from './inn';
import type { Pond } from '../pond';
import type { ItemPose } from '../armful';
import { PIECE_L, PIECE_R } from '../firewood';
import { restY } from './things';
import { type Obstacle, type Walker, wrap } from './walk';
import type { Wind } from './wind';
import { Field } from './field';
import { GRAIN_MAX, GRAIN_PER_SACK, type Windmill } from './windmill';

/**
 * The jobs. Each person runs a small routine of steps (walk somewhere, do
 * an action there, pick something up, put it down), and between routines
 * looks at the world to decide what's needed:
 *
 *   lumberjack: if the woodpile (counting logs on their way, and logs lying
 *     in the forest) is short of PILE_WANT, claim the nearest standing tree,
 *     walk up to it side-on, fell it (it leaves two logs), then carry each
 *     log to the pile on the shoulder.
 *   woodworker (two of them): if there's a log in the pile and the sawhorse
 *     is free, claim it, carry the log over, put it on, and saw it. Between
 *     logs, take firewood to the inn. Otherwise wait by the sawhorse (or,
 *     while the other one's at it, by the yard's stack).
 *   farmer: when a strip of the wheat field is ripe, mows it with the
 *     scythe (a swing, a step, a swing…), binds what's cut into sheaves at
 *     the end, and stands them in the stook at the field's edge. Otherwise
 *     threshes: carries sheaves from the stook to the threshing floor by
 *     the windmill and beats the grain out with the flail; the windmill
 *     grinds it when the wind turns its sails.
 *   baker: brings flour from the windmill and firewood for the oven; fires
 *     the oven, kneads while it heats, bakes a batch of loaves with the
 *     peel, and carries bread to the inn.
 *   cooper: kegs. Collects the inn's empties and tightens their hoops; when
 *     there aren't enough empties to go round, takes firewood from the yard
 *     (if the inn can spare it), shaves it into staves and raises a new keg.
 *     The cider maker fills only kegs the cooper has ready.
 *
 * Claims (on trees and logs) keep two people from going for the same thing.
 * Anyone can trip now and then while walking (see the village's trips). An
 * armful goes down round their feet, a log beside them; once they're up
 * they pick it up again and carry on, still holding whatever room or claim
 * they had for it.
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
/** How far the step-ladder's top step stands ahead of the feet of someone about to climb it. */
const LADDER_STEP = 0.3;
/** Apples the mill turns into a keg. */
export const MILL_BATCH = 12;
/** Tankards of cider in a keg. */
export const SERVINGS = 8;
/** The inn wants this many kegs on hand. */
export const INN_KEGS = 2;
/** Sheaves a strip of wheat binds into; how far the farmer steps between swings (m). */
export const SHEAVES = 2;
const MOW_STEP = 0.45;
/** Pieces of firewood a new keg's staves are shaved from. */
export const STAVES = 2;
/** The cooper keeps this many empty kegs ready (on the rack or on the block). */
export const COOPER_EMPTIES = 2;
/** No more kegs than this in the whole village (the cooper stops making them). */
export const KEGS_MAX = 5;
/** The oven and the cooper take no firewood while the inn's stack (with what's on its way) is lower than this. */
export const INN_LOW = 4;
/** A batch of bread: loaves, firewood to heat the oven for it, how long it bakes (s). */
export const LOAVES = 4;
export const OVEN_WOOD = 2;
const BAKE_TIME = 25;
/** The inn wants this much bread in. */
export const INN_BREAD = 8;

/**
 * How much firewood from the yard someone other than the inn may take now
 * (up to `want`). The inn's fire comes first: nobody takes any while its
 * stack is low or the woodworkers are stocking it for the evening. Then the
 * oven; the cooper's staves only once the oven has wood for a firing.
 */
/** Who's sat waiting for supper with nothing coming yet: whoever's waited longest. */
export function waitingSeat(v: Village) {
  let best: Seat | null = null;
  for (const st of v.seats) if (st.state === 'seated' && st.plate.incoming === 0 && st.plate.count === 0 && (!best || (st.since ?? 0) < (best.since ?? 0))) best = st;
  return best;
}

export function firewoodFor(v: Village, user: 'oven' | 'staves', want: number) {
  if (want <= 0) return 0;
  if (v.inn.count + v.inn.incoming < INN_LOW || v.hours >= SUPPER - 2) return 0;
  if (user === 'staves' && v.bakery.wood.count + v.bakery.wood.incoming < OVEN_WOOD) return 0;
  return Math.min(want, v.yard.available);
}
/** Hammer blows: hooping a new keg, tightening an old one's hoops. */
const BLOWS_NEW = 12;
const BLOWS_OLD = 5;

export const isFullKeg = (it: Item) => it.kind === 'keg' && it.dry > 0;
export const isEmptyKeg = (it: Item) => it.kind === 'keg' && it.dry <= 0;
/** How many items in a store pass `ok`. */
export const countIn = (st: Store, ok: (it: Item) => boolean) => st.items.reduce((n, it) => n + (it && ok(it) ? 1 : 0), 0);
/**
 * The day: work from WAKE, supper at the inn from SUPPER (then music and a
 * dance on the green), everyone home by NIGHT (hours). The innkeeper lights
 * the street-lamp at LAMP_AT.
 */
export const WAKE = 6.5;
export const SUPPER = 16;
export const NIGHT = 22;
export const LAMP_AT = 17.6;
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
  /** Apples and cider: the orchard, the pickers' baskets (and step-ladders), the mill, kegs at the mill and at the inn. */
  orchard: Orchard;
  baskets: Basket[];
  ladders: StepLadder[];
  mill: CiderMill;
  millKegs: KegRack;
  innKegs: KegRack;
  /** Where the keg stands under the mill's spout to be filled (one slot). */
  spout: Spot;
  /** The wheat field, the stook its sheaves stand in, the windmill and its threshing floor and sack rack. */
  field: Field;
  stook: Stook;
  windmill: Windmill;
  floor: Store;
  sacks: Store;
  /** The bakery: the oven, the trough, the shelf the loaves cool on, flour and firewood; the inn's bread basket. */
  bakery: { oven: BreadOven; trough: Trough; shelf: Store; flour: Store; wood: Store };
  innBread: Store;
  /** The cooper's: the shaving horse, the block, firewood waiting to be staves, empty kegs ready for the mill. */
  cooperage: { horse: ShavingHorse; horseObstacle: Obstacle; block: HoopBlock; staves: Stack; empties: KegRack };
  /** The inn's table: where the regular's tankard stands (a one-slot store), where they sit. */
  tankardSpot: Spot;
  /** A full tankard has just been set down at the regular's place. */
  served(): void;
  /** Is anyone at the table who needs a refill? */
  wantsRefill(): boolean;
  /** This simulation step's length. */
  dt: number;
  /** The time of day (hours) and what that means for everyone; which day it is (the first is 1). */
  hours: number;
  phase: Phase;
  day: number;
  /** The wind (today's: see wind.ts). */
  wind: Wind;
  /** The inn's tables and their seats. */
  tables: InnTable[];
  seats: Seat[];
  /** The regular's place (their tankard's spot is in front of it); diners use it at supper too, around them. */
  regularSeat: Seat;
  /** The kitchen hatch: where the innkeeper stands to cook, and the counter. */
  hatch: { stand: { x: number; z: number; yaw: number }; counter: THREE.Vector3 };
  /** A plate of supper has just been put down at this seat. */
  mealServed(seat: Seat): void;
  /** Someone's just got home (their lamps go on for a while). */
  cameHome(i: number): void;
  /** Everyone (but the innkeeper) has had supper or gone to bed. */
  everyoneFed(): boolean;
  /** The street-lamp by the tables. */
  lamp: StreetLamp;
  /** Where this person stands on the green of an evening (the band in an arc at one side, dancers in the middle). */
  greenSpot(i: number): { x: number; z: number; yaw: number };
  /** Is anyone playing right now (fiddle, banjo or bass)? */
  bandPlaying(): boolean;
  /** Waiting on the green: strike up a chat with someone else there who's free for one (if anyone is). */
  chatOnGreen(i: number): void;
  /** Stood about: a chat with someone free for one within `near` metres (if anyone is). */
  chatNear(i: number, near: number): void;
  /** Somewhere to stroll to and look at (one of the sights, not where they are now). */
  sight(i: number): { x: number; z: number; yaw: number };
  /** Two people have a word: they stop where they are (if walking) and talk for a while. */
  chat(i: number, j: number, seconds: number): void;
  /** Bookkeeping for the overlay and the tests. */
  stats: {
    felled: number; sawn: number; delivered: number; burned: number;
    caught: number; dried: number; fishIn: number; eaten: number; breadEaten: number;
    picked: number; milled: number; kegs: number; kegsIn: number; poured: number; drunk: number;
    /** The cooper: firewood shaved into staves, new kegs raised, empties brought back, hoops tightened. */
    shaved: number; kegsMade: number; kegsBack: number; hooped: number;
    /** Strips of wheat mown, sheaves stood in the stook. */
    mown: number; sheaves: number;
    /** Sheaves threshed, sacks of flour milled, seconds the sails turned. */
    threshed: number; flour: number; sailing: number;
    /** Batches baked, loaves taken to the inn. */
    baked: number; breadIn: number;
    /** Trips (falls while walking), and things picked up again after one. */
    trips: number; pickedUp: number;
    meals: number; hungry: number; slept: number;
    /** Tunes struck up and dances begun on the green; times the lamp was lit. */
    evening: number; lamps: number;
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
  instrument: 'fiddle' | 'banjo' | 'bass' | null;
  /** Do they smoke a pipe (now and then, with nothing to do)? */
  pipe: boolean;
  /** Their own front door (where they go in at night and come out in the morning). */
  home: { x: number; z: number; yaw: number };
  /** A picker's own basket and step-ladder. */
  gear?: { basket: Basket; ladder: StepLadder };
}

/** Steps that aren't work: sitting about, playing, a pipe, a stroll. */
const LEISURE = new Set<StepKind>(['to bench', 'sitting', 'playing', 'smoking', 'getting up', 'strolling', 'looking about']);
/** Steps of moving an armful from one place to a stack. */
const DELIVERY = new Set<StepKind>(['fetching', 'gathering', 'delivering', 'stacking']);
/** Steps of the evening: supper at the inn, music and dancing on the green, home, sleep. */
const EVENING = new Set<StepKind>(['to supper', 'waiting for supper', 'eating', 'leaving the table', 'to the dance', 'at the dance', 'going home']);

// (named groups of steps the rest of the village asks about: the talk, the dog, the test)
/** Sat at the inn's table for supper. */
export const AT_SUPPER = new Set<StepKind>(['waiting for supper', 'eating']);
/** Out on the green of an evening, or on the way. */
export const ON_GREEN = new Set<StepKind>(['to the dance', 'at the dance']);
/** Stood (or sat) about with nothing on: up for a word. */
export const STOOD_ABOUT = new Set<StepKind>(['at the dance', 'looking about', 'sitting']);
/** Steps it's normal to stay in a long while (the rest should move on: the village test checks). */
export const LINGER = new Set<StepKind>(['idle', 'sitting', 'playing', 'smoking', 'asleep', 'waiting for supper', 'at the dance', 'waiting for a refill', 'drinking cider']);

/** Everything anyone can be doing (one name per step of every routine: a typo or a rename is a compile error). */
export type StepKind =
  | 'asleep'
  | 'at the dance'
  | 'carrying the ladder'
  | 'chopping'
  | 'cooking'
  | 'cranking'
  | 'delivering'
  | 'drawing cider'
  | 'drinking cider'
  | 'dropping'
  | 'eating'
  | 'fetching'
  | 'fishing'
  | 'gathering'
  | 'getting up'
  | 'going home'
  | 'idle'
  | 'leaving the table'
  | 'letting go'
  | 'lifting'
  | 'lifting the basket'
  | 'lighting the lamp'
  | 'loading'
  | 'looking about'
  | 'picking'
  | 'playing'
  | 'putting out the lamp'
  | 'sawing'
  | 'setting down'
  | 'setting up the ladder'
  | 'sitting'
  | 'smoking'
  | 'stacking'
  | 'strolling'
  | 'taking the basket'
  | 'taking the ladder'
  | 'tipping'
  | 'to apple'
  | 'to basket'
  | 'to bench'
  | 'to full basket'
  | 'to ladder'
  | 'to log'
  | 'to pile'
  | 'to sawhorse'
  | 'to supper'
  | 'to the crank'
  | 'to the dance'
  | 'to the hatch'
  | 'to the kegs'
  | 'to the lamp'
  | 'to the mill'
  | 'to the spout'
  | 'to the table'
  | 'to the tree'
  | 'to the water'
  | 'to the strip'
  | 'mowing'
  | 'binding'
  | 'to the floor'
  | 'to the oven'
  | 'stoking'
  | 'to the trough'
  | 'kneading'
  | 'waiting for the oven'
  | 'loading the oven'
  | 'baking'
  | 'taking out the bread'
  | 'threshing'
  | 'tripped'
  | 'picking up'
  | 'to the horse'
  | 'onto the horse'
  | 'shaving'
  | 'off the horse'
  | 'to the block'
  | 'hooping'
  | 'to tree'
  | 'waiting for a refill'
  | 'waiting for supper';
/** What they're doing, and whatever that step needs to remember. */
type Step = { kind: StepKind; [k: string]: unknown };

const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
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
/** Somewhere room can be booked in (`incoming`) and things spoken for from (`reserved`): a store, the woodpile. */
export interface Bookable {
  readonly name: string;
  incoming: number;
  reserved: number;
}
/** What one person has booked on one store (all their bookings there, one kind, added up). */
export interface Booking {
  store: Bookable;
  kind: 'incoming' | 'reserved';
  n: number;
}

export abstract class Job {
  private current: Step = { kind: 'idle' };
  /**
   * What they're doing. Going idle hands back anything they still had
   * booked (room on its way somewhere, things spoken for): an errand
   * should have settled its bookings by then, so any left over are a
   * leak, noted in `leaked` (the village test checks there are none).
   */
  get step() {
    return this.current;
  }
  set step(s: Step) {
    if (s.kind === 'idle' && this.bookings.length) {
      for (const b of [...this.bookings]) {
        this.leaked.push(`${this.role} went idle from "${this.current.kind}" still holding ${b.n} ${b.kind} on the ${b.store.name}`);
        this.unbook(b.store, b.kind, b.n);
      }
    }
    this.current = s;
  }
  /** Everything they've booked and not yet settled. */
  readonly bookings: Booking[] = [];
  /** Bookings that went wrong (left over when they went idle, or handed back twice). */
  readonly leaked: string[] = [];

  /** Book room in a store (`incoming`) or speak for things in it (`reserved`). */
  protected book(store: Bookable, kind: Booking['kind'], n: number) {
    if (n <= 0) return;
    store[kind] += n;
    const b = this.bookings.find((x) => x.store === store && x.kind === kind);
    if (b) b.n += n;
    else this.bookings.push({ store, kind, n });
  }

  /** Hand back (some of) a booking: the room's filled, the things are taken, or the errand's off. */
  protected unbook(store: Bookable, kind: Booking['kind'], n: number) {
    if (n <= 0) return;
    const i = this.bookings.findIndex((x) => x.store === store && x.kind === kind);
    const held = i >= 0 ? this.bookings[i].n : 0;
    if (n > held) this.leaked.push(`${this.role} handed back ${n} ${kind} on the ${store.name} but held ${held}`);
    const k = Math.min(n, held);
    if (k <= 0) return;
    store[kind] -= k;
    this.bookings[i].n -= k;
    if (this.bookings[i].n === 0) this.bookings.splice(i, 1);
  }

  carrying: Log | null = null;
  /** What's in their arms. */
  armful: Item[] = [];
  protected waitUntil = 0;
  /** Stopped where they are until then (simulation seconds): having a word with someone. */
  holdUntil = 0;

  constructor(readonly w: Worker, readonly role: string) {}

  get doing() {
    return this.step.kind;
  }

  /** When they last tripped (simulation seconds; −∞ = never). */
  trippedAt = -Infinity;
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
    if (this.step.kind === 'tripped' || this.step.kind === 'picking up') {
      this.recoverStep(v);
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
    // tripped with an armful (nothing else cuts one short): it all goes down
    // round their feet, to be picked up again (the room it was going to stays theirs)
    if (this.armful.length && a.kind !== 'armful' && this.step.kind !== 'stacking') {
      const to = this.step.to as Store;
      const at = this.w.root.position;
      const items = this.armful;
      for (const p of items) {
        const ang = Math.random() * Math.PI * 2, d = 0.12 + Math.random() * 0.25;
        const pos = new THREE.Vector3(at.x + Math.sin(ang) * d, restY(p.kind), at.z + Math.cos(ang) * d);
        const quat = new THREE.Quaternion().setFromAxisAngle(_up, Math.random() * Math.PI * 2);
        p.tween = { pos: p.mesh.position.clone(), quat: p.mesh.quaternion.clone(), t0: v.time, dur: 0.35 };
        p.place = { at: 'ground', pos, quat };
      }
      this.armful = [];
      this.step = { kind: 'tripped', items, to };
      this.w.walker.stop();
    }
    // tripped with a log on the shoulder: down it goes beside them, still theirs
    // (but a carry that just ended because it was put down is the routine's to handle)
    if (this.carrying && a.kind !== 'haul' && this.step.kind !== 'dropping' && this.step.kind !== 'loading') {
      const l = this.carrying;
      const r = this.w.root;
      l.place = { at: 'ground', x: r.position.x + Math.sin(r.rotation.y) * 0.3, z: r.position.z + Math.cos(r.rotation.y) * 0.3, yaw: r.rotation.y + Math.PI / 2 };
      // (theirs while it lies there: a lumberjack would take an unclaimed log on the ground for a loose one)
      const claim = l.claimedBy;
      l.claimedBy = this.w.i;
      this.carrying = null;
      this.step = { kind: 'tripped', log: l, claim };
      this.w.walker.stop();
    }
  }

  /** Back up after a trip: go to whatever they dropped, pick it up, and carry on. */
  private recoverStep(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const l = s.log as Log | undefined;
    const items = s.items as Item[] | undefined;
    if (s.kind === 'tripped') {
      if (a.kind === 'fall') return; // still down, or getting up
      const me = this.w.walker;
      if (l) {
        const at = besideLog(l, me.x, me.z);
        this.go(at.x, at.z, at.yaw);
      } else {
        // stand by the middle of the spill, on the side they're on, facing it
        const c = new THREE.Vector3();
        for (const p of items!) c.add((p.place as { pos: THREE.Vector3 }).pos);
        c.divideScalar(items!.length);
        let dx = me.x - c.x, dz = me.z - c.z;
        const d = Math.hypot(dx, dz);
        if (d < 1e-3) [dx, dz] = [Math.sin(me.yaw), Math.cos(me.yaw)];
        else [dx, dz] = [dx / d, dz / d];
        const x = c.x + dx * 0.42, z = c.z + dz * 0.42;
        this.go(x, z, facing(x, z, c.x, c.z));
      }
      this.step = { ...s, kind: 'picking up' };
      return;
    }
    // picking up
    if (!this.arrived) return;
    v.stats.pickedUp++;
    if (l) {
      const pl = l.place as { x: number; z: number; yaw: number };
      this.lift(l, { pos: new THREE.Vector3(pl.x, LOG_R, pl.z), yaw: pl.yaw });
      l.claimedBy = s.claim as number; // (as it was before it was dropped)
      this.step = { kind: 'lifting' }; // (and on with their own routine from there)
      return;
    }
    const poses = items!.map((p) => {
      const pl = p.place as { pos: THREE.Vector3; quat: THREE.Quaternion };
      return { pos: pl.pos.clone(), quat: pl.quat.clone() };
    });
    this.gather(items!, poses, s.to as Store);
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
    this.book(from, 'reserved', n);
    this.book(to, 'incoming', n);
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
        this.unbook(from, 'reserved', n);
        this.unbook(to, 'incoming', n - slots.length);
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
        this.unbook(to, 'incoming', this.armful.length);
        if (to === v.inn) v.stats.delivered += this.armful.length;
        if (to === v.larder) v.stats.fishIn += this.armful.length;
        if (to === v.innKegs) v.stats.kegsIn += this.armful.length;
        if (to === v.stook) v.stats.sheaves += this.armful.length;
        if (to === v.innBread) v.stats.breadIn += this.armful.length;
        if (to === v.cooperage.block) v.stats.kegsBack += this.armful.length; // (the only thing fetched to the block: an empty from the inn)
        if (to === v.tankardSpot) {
          this.armful = [];
          this.step = { kind: 'idle' };
          v.served();
          const regular = v.regularSeat.diner;
          if (regular >= 0) v.chat(this.w.i, regular, 2 + Math.random());
          return;
        }
        const plateOf = v.seats.find((st) => st.plate === to);
        if (plateOf) {
          this.armful = [];
          this.step = { kind: 'idle' };
          v.mealServed(plateOf);
          // a word with them as it goes down
          if (plateOf.diner >= 0) v.chat(this.w.i, plateOf.diner, 2 + Math.random());
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
      if (this.claimSeat(v)) return true;
      // the tables are full: out to the green with the music till a seat comes free
      this.toDance(v);
      return true;
    }
    this.goHome();
    return true;
  }

  /** Take the nearest free seat at the inn's tables and head for it (false if they're all taken). */
  protected claimSeat(v: Village) {
    const me = this.w.walker;
    const free = v.seats.filter((s) => s.state === 'free');
    if (!free.length) return false;
    const seat = free.reduce((b, s) => (s.table.world(s.x, 0).distanceTo(new THREE.Vector3(me.x, 0, me.z)) < b.table.world(b.x, 0).distanceTo(new THREE.Vector3(me.x, 0, me.z)) ? s : b));
    seat.state = 'claimed';
    seat.diner = this.w.i;
    this.seat = seat;
    const at = seat.table.sitFor(seat, this.w.actor);
    this.w.walker.go({ x: at.x, z: at.z, yaw: at.yaw, ignore: seat.table.obstacle, via: at.via });
    this.step = { kind: 'to supper', table: at.table };
    return true;
  }

  protected goHome() {
    const h = this.w.home;
    this.w.actor.stop();
    this.go(h.x, h.z, h.yaw);
    this.step = { kind: 'going home' };
  }

  /** Sat down at a seat (supper or not): make the plate's spot fit them. */
  protected seated(seat: Seat, v: Village) {
    const d = this.w.actor.choreOf('dine');
    const at = d.boardWorld();
    seat.plate.set(at, seat.table.yaw, seat.table.serveFrom(at));
    seat.state = 'seated';
    seat.since = v.time;
  }

  private eveningStep(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const seat = this.seat;
    switch (s.kind) {
      case 'to supper': {
        if (!this.arrived) return;
        a.start('dine', { atTable: s.table as { top: number; edge: number; h: number } });
        this.seated(seat!, v);
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
        // fed, and the evening's young: off to the green
        if (v.phase === 'supper') this.toDance(v);
        else this.goHome();
        return;
      }
      case 'to the dance': {
        if (v.phase === 'night') this.goHome();
        else if (this.arrived) {
          this.step = { kind: 'at the dance' };
          this.nextTune = v.time + 0.5 + Math.random() * 2;
          this.wasPlaying = false;
        }
        return;
      }
      case 'at the dance': {
        // bedtime: finish the tune (or the dance), then home
        if (v.phase === 'night') {
          if (a.busy) a.stopPlaying();
          else this.goHome();
          return;
        }
        // the band's struck up: the pipe goes away, there's dancing to be done
        if (a.kind === 'pipe' && !this.w.instrument && v.bandPlaying()) a.stopPlaying(true);
        else if (a.kind === 'pipe' && v.time >= this.nextTune) {
          v.chatOnGreen(this.w.i); // (a word round the pipe)
          this.nextTune = v.time + 1;
        }
        if (a.busy) {
          this.wasPlaying = true;
          return;
        }
        // not had supper yet (the tables were full): a seat's come free (after the tune)
        if (!this.ateToday && v.phase === 'supper' && this.claimSeat(v)) return;
        if (this.wasPlaying) {
          // a breather between tunes (hardly any once the whole village is out)
          this.wasPlaying = false;
          this.nextTune = v.time + (v.everyoneFed() ? 0.3 + Math.random() * 0.7 : 1 + Math.random() * 3);
        }
        // a chat over: back round to face the green
        if (a.talkingTo >= 0) this.chatted = true;
        else if (this.chatted) {
          this.chatted = false;
          const at = v.greenSpot(this.w.i);
          this.go(at.x, at.z, at.yaw);
        }
        // (nobody strikes up mid-sentence, or before they're facing the right way)
        if (v.time < this.nextTune || a.talkingTo >= 0 || (this.w.walker.goal && !this.arrived) || this.danceBreak(v)) return;
        if (this.w.instrument) a.start(this.w.instrument, { phrases: 2 + Math.floor(Math.random() * 2) });
        else if (v.bandPlaying()) a.start('dance');
        else {
          // no music yet: stand about till there is, chatting with whoever's
          // free, and with a pipe if they smoke
          if (this.w.pipe && Math.random() < 0.5) a.start('pipe');
          v.chatOnGreen(this.w.i);
          this.nextTune = v.time + 1;
          return;
        }
        v.stats.evening++;
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

  /** Off to the green: the band's spot in the arc if they play, else among the dancers. */
  protected toDance(v: Village) {
    const at = v.greenSpot(this.w.i);
    this.go(at.x, at.z, at.yaw);
    this.step = { kind: 'to the dance' };
  }

  /** Something to see to before the next tune (the innkeeper's lamp)? Returns whether they went off to it. */
  protected danceBreak(_v: Village) {
    return false;
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
  private chatted = false;

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
    // their own bench if they have one, else any free one (someone else's will do, for a while)
    const mine = v.benches.filter((b) => b.owner === this.w.i && b.bench.claimedBy < 0);
    const free = mine.length ? mine : v.benches.filter((b) => b.bench.claimedBy < 0);
    if (free.length && r < (mine.length ? 0.3 : 0.18)) {
      const b = free.reduce((a, b) => (Math.hypot(b.bench.x - me.x, b.bench.z - me.z) < Math.hypot(a.bench.x - me.x, a.bench.z - me.z) ? b : a));
      b.bench.claimedBy = this.w.i;
      const at = b.bench.sitSpot(0.22, this.w.actor.sitFit());
      this.go(at.x, at.z, at.yaw, b.obstacle, 'ahead');
      this.step = { kind: 'to bench', bench: b };
      return true;
    }
    if (r < 0.55) {
      // a stroll: off to one of the sights to stand and look about a while
      const at = v.sight(this.w.i);
      this.go(at.x, at.z, at.yaw);
      this.step = { kind: 'strolling' };
      return true;
    }
    if (r < 0.85) return this.pastime(false);
    return false;
  }

  /**
   * Their instrument or their pipe (whichever they have; either, if both),
   * standing or sat on a bench (no double bass sat down, though). Returns
   * whether they started one.
   */
  private pastime(seated: boolean) {
    const music = this.w.instrument && !(seated && this.w.instrument === 'bass') ? this.w.instrument : null;
    const smoke = this.w.pipe && (!music || Math.random() < 0.45);
    if (!smoke && !music) return false;
    if (smoke) this.w.actor.start('pipe');
    else this.w.actor.start(music!, { phrases: 2 + Math.floor(Math.random() * 2) }); // (the rest of this phrase, then one or two more)
    this.wasPlaying = true;
    if (!seated) this.step = { kind: smoke ? 'smoking' : 'playing' };
    return true;
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
          a.sitDown({ seatH: bench!.fit.h });
          this.nextTune = v.time + 2 + Math.random() * 4;
          // a sit, not the rest of the day
          this.step = { ...s, kind: 'sitting', until: v.time + 15 + Math.random() * 20 };
        }
        return;
      case 'sitting':
        if (work) {
          if (a.busy) a.stopPlaying(true);
          a.getUp();
          this.step = { ...s, kind: 'getting up' };
          return;
        }
        if (v.time >= (s.until as number)) {
          // that'll do: finish the tune (or the pipe), then up and on
          if (a.busy) a.stopPlaying();
          else {
            a.getUp();
            this.step = { ...s, kind: 'getting up' };
          }
          return;
        }
        if (this.wasPlaying && !a.busy) {
          // a tune done: sit a while before the next
          this.wasPlaying = false;
          this.nextTune = v.time + 4 + Math.random() * 10;
        }
        if (!a.busy && a.seated && v.time >= this.nextTune) {
          if (!this.pastime(true)) this.nextTune = v.time + 10;
        }
        return;
      case 'strolling':
        if (work) {
          this.w.walker.stop();
          this.step = { kind: 'idle' };
        } else if (this.arrived) {
          this.step = { kind: 'looking about', until: v.time + 5 + Math.random() * 7 };
          if (this.w.pipe && Math.random() < 0.4) a.start('pipe', { smoke: 6 + Math.random() * 5 });
        }
        return;
      case 'looking about':
        if (work || v.time >= (s.until as number)) {
          if (a.kind === 'pipe') a.stopPlaying(true);
          if (!a.busy) {
            this.restAfter = v.time + 2 + Math.random() * 4;
            this.step = { kind: 'idle' };
          }
          return;
        }
        // anyone else stood about nearby? a word with them
        if (Math.random() < 0.02) v.chatNear(this.w.i, 3);
        return;
      case 'playing':
      case 'smoking':
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
          this.book(v.pile, 'incoming', 1);
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
        this.unbook(v.pile, 'incoming', 1);
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

  /** Where their saw cuts (for a log off the pile). */
  private sawFit() {
    return this.w.actor.sawFit({ r: LOG_R, len: LOG_L / 2.05 });
  }

  /** The sawhorse free (no log on it, nobody else's), a log to saw, and room on the yard stack for what it makes. */
  private canSaw(v: Village) {
    const h = v.horse;
    return h.claimedBy < 0 && !h.log && !h.pieces.length && v.pile.ready > 0 && v.yard.room >= PIECES_PER_LOG;
  }

  /** Done with the sawhorse (sawn, or the log's gone or dropped): the other woodworker may have it. */
  private letGo(v: Village) {
    if (v.horse.claimedBy === this.w.i) v.horse.claimedBy = -1;
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
        // the inn nearly out of firewood, or the evening coming on (the
        // fire burns all through supper and the dance): that comes before
        // sawing more
        const stockUp = v.hours >= SUPPER - 2 || v.inn.count + v.inn.incoming < 3;
        const urgent = stockUp ? this.innWants(v) : 0;
        if (urgent > 0) {
          this.fetch(v.yard, v.inn, urgent);
          return;
        }
        if (this.canSaw(v)) {
          v.horse.claimedBy = this.w.i;
          this.book(v.yard, 'incoming', PIECES_PER_LOG); // room for what it'll make
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
        // otherwise wait at the sawhorse (by the yard's stack if the other's sawing)
        const at = horse.claimedBy >= 0 && horse.claimedBy !== this.w.i ? v.yard.workSpot() : horse.sawSpot(this.sawFit());
        const w = this.w.walker;
        if (Math.hypot(w.x - at.x, w.z - at.z) > 0.3 && (!w.goal || w.arrived)) this.go(at.x, at.z, at.yaw, v.horseObstacle);
        this.waitUntil = v.time + 1;
        return;
      }
      case 'to pile': {
        if (!this.arrived) return;
        const slot = v.pile.topSlot();
        if (slot < 0) {
          this.unbook(v.yard, 'incoming', PIECES_PER_LOG);
          this.letGo(v);
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
        const at = horse.sawSpot(this.sawFit());
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
        a.start('saw', { sawLog: { r: LOG_R, len: LOG_L / 2.05, y: horse.logAt.y } });
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
        this.letGo(v);
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
          this.book(v.rack, 'incoming', CATCH); // room on the rack for this catch
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
    // (the empties wait on the rack for the cooper: they take room, but no cider in them)
    const short = INN_KEGS - countIn(v.innKegs, isFullKeg) - v.innKegs.incoming;
    return short > 0 ? Math.min(1, v.millKegs.available, v.innKegs.room) : 0;
  }

  /** Someone's tankard is empty, nobody's bringing one, and there's cider. */
  private refill(v: Village) {
    return v.wantsRefill() && v.tankardSpot.incoming === 0 && v.tankardSpot.count === 0 && countIn(v.innKegs, isFullKeg) > 0;
  }

  protected hasWork(v: Village) {
    return this.refill(v) || this.larderWants(v) > 0 || this.kegsWanted(v) > 0;
  }

  /**
   * The innkeeper doesn't sit down to supper: they cook it, and once
   * everyone's fed they take their fiddle out to the green with the rest.
   * Bed at night (the lamp out first).
   */
  protected eveningStarts(v: Village) {
    if (v.phase === 'night') {
      this.ateToday = true; // (a bite in the kitchen)
      this.goHome();
      return true;
    }
    if (v.hours >= SUPPER + 1 && v.everyoneFed() && !this.seatWaiting(v) && !this.lampWanted(v)) {
      this.ateToday = true;
      this.toDance(v);
      return true;
    }
    return false;
  }

  private village: Village | null = null;

  tick(v: Village) {
    this.village = v;
    super.tick(v);
  }

  /** Dusk, and the lamp not lit yet. */
  private lampWanted(v: Village) {
    return v.phase === 'supper' && v.hours >= LAMP_AT && !v.lamp.lit;
  }

  /** Over to the lamp, to light it or put it out; then on to `then`. */
  private toLamp(v: Village, then: 'idle' | 'dance' | 'home') {
    const at = v.lamp.stand;
    this.go(at.x, at.z, at.yaw);
    this.step = { kind: 'to the lamp', light: !v.lamp.lit, then };
  }

  /** Between tunes on the green: if it's got dark and the lamp's not lit, go and light it. */
  protected danceBreak(v: Village) {
    if (!this.lampWanted(v)) return false;
    this.toLamp(v, 'dance');
    return true;
  }

  /** Home to bed, putting the lamp out on the way if it's still lit. */
  protected goHome() {
    const v = this.village;
    if (v?.lamp.lit) this.toLamp(v, 'home');
    else super.goHome();
  }

  /** Someone sat down to supper who's not been served (and nobody's cooking for). */
  private seatWaiting(v: Village) {
    return waitingSeat(v);
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    switch (s.kind) {
      case 'to the lamp': {
        if (!this.arrived) return;
        // reach up to the lantern (the other hand on the post)
        const lantern = v.lamp.lantern;
        const post = new THREE.Vector3(v.lamp.x, 0.75, v.lamp.z);
        a.start('hold', { hold: { right: () => lantern.clone().setY(lantern.y - 0.06), left: () => post, lean: -0.08 } });
        this.step = { ...s, kind: s.light ? 'lighting the lamp' : 'putting out the lamp', until: v.time + 1.5 };
        return;
      }
      case 'lighting the lamp':
      case 'putting out the lamp': {
        if (v.time < (s.until as number)) return;
        if (a.kind === 'hold') {
          if (s.light !== v.lamp.lit) {
            v.lamp.set(!!s.light);
            if (s.light) v.stats.lamps++;
          }
          a.choreOf('hold').release();
          return;
        }
        if (a.busy) return;
        if (s.then === 'home') super.goHome();
        else if (s.then === 'dance') this.toDance(v);
        else this.step = { kind: 'idle' };
        return;
      }
      case 'to the hatch': {
        if (!this.arrived) return;
        const seat = s.seat as Seat;
        // fish if there is (but bread often enough when there's plenty), else bread
        // (only bread nobody's spoken for: the baker may be taking a loaf round to someone)
        const fish = v.larder.top(1)[0], loaf = v.innBread.available > 0 ? v.innBread.top(1)[0] : undefined;
        const food = fish !== undefined && (loaf === undefined || v.innBread.count < 3 || Math.random() < 0.6) ? 'fish' : loaf !== undefined ? 'bread' : null;
        if (!food) {
          // nothing to cook after all
          this.unbook(seat.plate, 'incoming', 1);
          this.step = { kind: 'idle' };
          return;
        }
        const from = food === 'fish' ? v.larder : v.innBread;
        const slot = (food === 'fish' ? fish : loaf)!;
        v.removeItem(from.items[slot]!);
        from.items[slot] = null;
        // cook it: hands busy at the counter a while
        const c = v.hatch.counter;
        const side = new THREE.Vector3(Math.cos(v.hatch.stand.yaw), 0, -Math.sin(v.hatch.stand.yaw)).multiplyScalar(0.12);
        a.start('hold', { hold: { right: () => c.clone().sub(side), left: () => c.clone().add(side), lean: 0.2, bob: () => 0.02 * Math.sin(v.time * 9) } });
        this.step = { kind: 'cooking', seat, food, until: v.time + (food === 'fish' ? 3 : 1.5) };
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
        meal.food = s.food as 'fish' | 'bread';
        setMeal(meal.mesh, meal.food);
        const pos = v.hatch.counter.clone().setY(v.hatch.counter.y + 0.02);
        const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), v.hatch.stand.yaw);
        meal.place = { at: 'ground', pos, quat };
        this.gather([meal], [{ pos, quat }], (s.seat as Seat).plate);
        return;
      }
      case 'to the kegs': {
        if (!this.arrived) return;
        // draw a tankard from the top keg with cider in it: hands at its tap a moment
        const slot = v.innKegs.top(1, isFullKeg)[0];
        if (slot === undefined) {
          this.unbook(v.tankardSpot, 'incoming', 1);
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
          // (the last of it: the keg stays on the rack, empty, till the cooper comes for it)
          keg.dry = Math.max(0, keg.dry - 1);
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
    // dusk: the lamp first (it's quick), then back to the cooking
    if (this.lampWanted(v)) {
      this.toLamp(v, 'idle');
      return;
    }
    // supper: cook for whoever's sat down, one plate at a time
    if (v.phase !== 'work') {
      const seat = this.seatWaiting(v);
      if (seat && (v.larder.available > 0 || v.innBread.available > 0)) {
        this.book(seat.plate, 'incoming', 1);
        const at = v.hatch.stand;
        this.go(at.x, at.z, at.yaw);
        this.step = { kind: 'to the hatch', seat };
        return;
      }
    }
    if (this.refill(v)) {
      this.book(v.tankardSpot, 'incoming', 1);
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
  readonly basket: Basket;
  readonly ladder: StepLadder;

  constructor(w: Worker) {
    super(w, 'picker');
    this.basket = w.gear!.basket;
    this.ladder = w.gear!.ladder;
  }

  /** How high this person can pick (the apple at full stretch, on tiptoe). */
  private reachY() {
    return this.w.actor.choreOf('pick').reach().y + 0.04;
  }

  /** …and standing on the step-ladder. */
  private ladderY() {
    return this.reachY() + LADDER_H;
  }

  /** Does this apple need the ladder? */
  private high(a: Apple) {
    return a.pos.y > this.reachY();
  }

  protected hasWork(v: Village) {
    return v.mill.hopper.room >= BASKET && v.orchard.ripe(this.ladderY()).length >= 2;
  }

  /** Take up something lying about (the basket, the ladder) in both arms. */
  private takeUp(o: THREE.Object3D) {
    this.w.actor.start('armful', { items: { meshes: [o], from: [{ pos: o.position.clone(), quat: o.quaternion.clone() }] } });
  }

  /** Set the basket down beside us (right and a little ahead). */
  private setDownBasket() {
    const r = this.w.root;
    const yaw = r.rotation.y;
    const pos = r.position.clone().setY(0).add(new THREE.Vector3(-Math.cos(yaw) * 0.38 + Math.sin(yaw) * 0.1, 0, Math.sin(yaw) * 0.38 + Math.cos(yaw) * 0.1));
    this.w.actor.choreOf('armful').putDown([{ pos, quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw) }]);
  }

  private get carryingSomething() {
    return this.w.actor.kind === 'armful' && this.w.actor.choreOf('armful').carrying;
  }

  /** The nearest ripe apple we can get at (on this tree first, if there's one left; ones that need the ladder count as further). */
  private nextApple(v: Village, tree = -1) {
    const me = this.w.walker;
    const ripe = v.orchard.ripe(this.ladderY());
    const near = (a: Apple) => Math.hypot(a.pos.x - me.x, a.pos.z - me.z) - (a.tree === tree ? 10 : 0) + (this.high(a) ? 1.2 : 0);
    return ripe.length ? ripe.reduce((b, a) => (near(a) < near(b) ? a : b)) : null;
  }

  /** Where to stand (on the ground, or on the ladder) so the apple is right where a full stretch puts the hand, facing the tree. */
  private standFor(a: Apple, v: Village) {
    const t = v.orchard.trees[a.tree];
    const out = Math.atan2(a.pos.x - t.x, a.pos.z - t.z);
    const yaw = out + Math.PI;
    const h = this.w.actor.choreOf('pick').reach();
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // root frame (h.x, h.z) turned by yaw: (x c + z s, −x s + z c)
    return { x: a.pos.x - (h.x * c + h.z * s), z: a.pos.z - (-h.x * s + h.z * c), yaw };
  }

  /** At the foot of the ladder standing at `at`: a step back from it. */
  private static foot(at: { x: number; z: number; yaw: number }) {
    return { x: at.x - Math.sin(at.yaw) * LADDER_STEP, z: at.z - Math.cos(at.yaw) * LADDER_STEP, yaw: at.yaw };
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const basket = this.basket;
    switch (s.kind) {
      case 'idle': {
        if (v.time < this.waitUntil) return;
        if (this.hasWork(v)) {
          this.book(v.mill.hopper, 'incoming', BASKET); // room in the hopper for this basketful
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
        this.takeUp(basket.group);
        this.step = { kind: 'taking the basket' };
        return;
      }
      case 'taking the basket': {
        if (!this.carryingSomething) return;
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
        a.start('pick', { apple: this.apple!.pos, standOn: s.ladder ? { h: LADDER_H, fwd: LADDER_STEP } : undefined });
        this.step = { kind: 'picking' };
        return;
      }
      // a high one: the step-ladder first
      case 'to ladder': {
        if (!this.arrived) return;
        this.takeUp(this.ladder.group);
        this.step = { kind: 'taking the ladder' };
        return;
      }
      case 'taking the ladder': {
        if (!this.carryingSomething) return;
        const f = Picker.foot(this.standFor(this.apple!, v));
        this.go(f.x, f.z, f.yaw);
        this.step = { kind: 'carrying the ladder' };
        return;
      }
      case 'carrying the ladder': {
        if (!this.arrived) return;
        const at = this.standFor(this.apple!, v);
        const pose = StepLadder.pose(at.x, at.z, at.yaw);
        a.choreOf('armful').putDown([pose]);
        this.step = { kind: 'setting up the ladder' };
        return;
      }
      case 'setting up the ladder': {
        if (a.kind === 'armful') return;
        a.start('pick', { apple: this.apple!.pos, standOn: { h: LADDER_H, fwd: LADDER_STEP } });
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
        this.takeUp(basket.group);
        this.step = { kind: 'lifting the basket' };
        return;
      }
      case 'lifting the basket': {
        if (!this.carryingSomething) return;
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
        this.unbook(hop, 'incoming', BASKET);
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
      this.unbook(v.mill.hopper, 'incoming', BASKET);
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
      // none left in reach: what's in the basket goes to the mill anyway (tipping it gives back the room booked)
      if (this.basket.count > 0) {
        const at = this.basket.workSpot();
        this.go(at.x, at.z, at.yaw);
        this.step = { kind: 'to full basket' };
      } else {
        this.unbook(v.mill.hopper, 'incoming', BASKET);
        this.step = { kind: 'idle' };
      }
      return;
    }
    if (tree >= 0 && ap.tree !== tree) {
      // on to another tree: basket and all
      this.apple = null;
      const at = this.basket.workSpot();
      this.go(at.x, at.z, at.yaw);
      this.step = { kind: 'to basket' };
      return;
    }
    ap.claimedBy = this.w.i;
    this.apple = ap;
    const at = this.standFor(ap, v);
    if (!this.high(ap)) {
      this.go(at.x, at.z, at.yaw);
      this.step = { kind: 'to apple' };
      return;
    }
    // out of reach: up the ladder (fetching it over first, unless it's standing just right already)
    const l = this.ladder.at;
    if (Math.hypot(l.x - at.x, l.z - at.z) < 0.12 && Math.abs(wrap(l.yaw - at.yaw)) < 0.35) {
      const f = Picker.foot(l);
      this.go(f.x, f.z, f.yaw);
      this.step = { kind: 'to apple', ladder: true };
      return;
    }
    const w = this.ladder.workSpot();
    this.go(w.x, w.z, w.yaw);
    this.step = { kind: 'to ladder' };
  }
}

export class CiderMaker extends Job {
  private fed = 0;
  private turned = 0;

  constructor(w: Worker) {
    super(w, 'cider maker');
  }

  private ready(v: Village) {
    return v.mill.hopper.top(MILL_BATCH).length >= MILL_BATCH;
  }

  /** Apples enough, an empty keg under the spout, and room for it full. */
  private canMill(v: Village) {
    return this.ready(v) && v.spout.top(1, isEmptyKeg).length > 0 && v.millKegs.room >= 1;
  }

  /** Nothing under the spout, and an empty ready at the cooper's. */
  private kegWanted(v: Village) {
    return v.spout.count + v.spout.incoming === 0 && v.cooperage.empties.available > 0;
  }

  protected hasWork(v: Village) {
    return this.canMill(v) || this.kegWanted(v);
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const mill = v.mill;
    switch (s.kind) {
      case 'idle': {
        if (v.time < this.waitUntil) return;
        if (this.canMill(v)) {
          this.book(v.millKegs, 'incoming', 1);
          const at = mill.crankSpot();
          this.go(at.x, at.z, at.yaw, null);
          this.step = { kind: 'to the crank' };
          return;
        }
        // an empty keg from the cooper's, to stand under the spout ready
        if (this.kegWanted(v)) {
          this.fetch(v.cooperage.empties, v.spout, 1);
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
          // full: the keg under the spout is cider now
          const keg = v.spout.items[0];
          if (keg) keg.dry = SERVINGS;
          v.stats.kegs++;
          a.events.push('splash');
          a.choreOf('hold').release();
          this.step = { kind: 'letting go' };
        }
        return;
      }
      case 'letting go': {
        if (a.busy) return;
        const at = mill.frontSpot();
        this.go(at.x, at.z, at.yaw);
        this.step = { kind: 'to the spout' };
        return;
      }
      case 'to the spout': {
        if (!this.arrived) return;
        const keg = v.spout.items[0];
        if (!keg) {
          // (nothing there after all: the room kept for it at the rack goes back)
          this.unbook(v.millKegs, 'incoming', 1);
          this.step = { kind: 'idle' };
          return;
        }
        v.spout.items[0] = null;
        this.gather([keg], [v.spout.slotWorld(0)], v.millKegs);
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
        // their usual place, in from the end of the bench (between it and the table)
        const seat = v.regularSeat;
        const at = seat.table.sitFor(seat, a);
        this.w.walker.go({ x: at.x, z: at.z, yaw: at.yaw, ignore: seat.table.obstacle, via: at.via });
        this.step = { kind: 'to the table', table: at.table };
        return;
      }
      case 'to the table': {
        if (!this.arrived) return;
        a.start('dine', { atTable: s.table as { top: number; edge: number; h: number } });
        const seat = v.regularSeat;
        seat.state = 'claimed';
        seat.diner = this.w.i;
        // their tankard's spot is wherever it stands in front of them
        const tw = a.choreOf('dine').tankWorld();
        v.tankardSpot.set(tw, seat.table.yaw, seat.table.serveFrom(tw));
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
          this.seat = v.regularSeat;
          this.seated(this.seat, v);
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

/**
 * The cooper: kegs for the cider. In order:
 *   - a keg on the block: tighten its hoops (or raise a new one there), then
 *     rack it with the empties;
 *   - an empty at the inn: fetch it back to the block;
 *   - staves enough waiting: sit at the shaving horse and shave them, then
 *     raise a new keg on the block;
 *   - too few empties (and fewer kegs in the village than KEGS_MAX): fetch
 *     firewood for staves from the yard, unless the inn's fire needs it.
 * Otherwise a rest, or waiting by the block.
 */
export class Cooper extends Job {
  /** Kegs on the block whose hoops are done (they go to the rack next). */
  private done = new Set<Item>();

  constructor(w: Worker) {
    super(w, 'cooper');
  }

  /** The keg on the block, if there's one. */
  private onBlock(v: Village) {
    const c = v.cooperage;
    const slot = c.block.top(1)[0];
    return slot === undefined ? null : c.block.items[slot]!;
  }

  /** An empty at the inn nobody's come for, and the block free for it. */
  private emptyAtInn(v: Village) {
    return countIn(v.innKegs, isEmptyKeg) - v.innKegs.reserved > 0 && v.cooperage.block.room > 0;
  }

  /** Short of empties, and the village not yet at its kegs. */
  private wantNew(v: Village) {
    const c = v.cooperage;
    const kegs = v.items.filter((it) => it.kind === 'keg').length + c.block.incoming;
    const ready = c.empties.count + c.empties.incoming + c.block.count + c.block.incoming;
    return kegs < KEGS_MAX && ready < COOPER_EMPTIES;
  }

  /** Staves to shave, the block free to raise the keg on, room on the rack after. */
  private canShave(v: Village) {
    const c = v.cooperage;
    return c.staves.available >= STAVES && c.block.room > 0 && c.empties.room > 0 && this.wantNew(v);
  }

  /** Firewood to fetch for staves (as much as can be spared: see firewoodFor). */
  private stavesWanted(v: Village) {
    const c = v.cooperage;
    const short = STAVES - c.staves.count - c.staves.incoming;
    if (short <= 0 || !this.wantNew(v)) return 0;
    return firewoodFor(v, 'staves', Math.min(short, c.staves.room));
  }

  /** The keg on the block wants doing: its hoops, or carrying to the rack. */
  private blockWork(v: Village) {
    const k = this.onBlock(v);
    return !!k && (!this.done.has(k) || v.cooperage.empties.room > 0);
  }

  protected hasWork(v: Village) {
    return this.blockWork(v) || this.emptyAtInn(v) || this.canShave(v) || this.stavesWanted(v) > 0;
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const c = v.cooperage;
    switch (s.kind) {
      case 'idle': {
        if (v.time < this.waitUntil) return;
        if (this.blockWork(v)) {
          const at = c.block.workSpot();
          this.go(at.x, at.z, at.yaw);
          this.step = { kind: 'to the block', raise: false };
          return;
        }
        if (this.emptyAtInn(v)) {
          this.fetch(v.innKegs, c.block, 1, isEmptyKeg);
          return;
        }
        if (this.canShave(v)) {
          this.book(c.staves, 'reserved', STAVES);
          this.book(c.block, 'incoming', 1); // (where the new keg will be raised)
          const at = c.horse.sitSpot(this.w.actor.sitFit());
          this.go(at.x, at.z, at.yaw, c.horseObstacle);
          this.step = { kind: 'to the horse' };
          return;
        }
        const n = this.stavesWanted(v);
        if (n > 0) {
          this.fetch(v.yard, c.staves, n);
          return;
        }
        if (this.leisure(v)) return;
        // otherwise wait by the block
        const at = c.block.workSpot();
        const w = this.w.walker;
        if (Math.hypot(w.x - at.x, w.z - at.z) > 0.3 && (!w.goal || w.arrived)) this.go(at.x, at.z, at.yaw);
        this.waitUntil = v.time + 1;
        return;
      }
      case 'to the horse': {
        if (!this.arrived) return;
        a.sitDown({ seatH: c.horse.fit.h });
        this.step = { kind: 'onto the horse', until: v.time + 4 };
        return;
      }
      case 'onto the horse': {
        // (sat down, or given up waiting: shave anyway)
        if (!a.seated && v.time < (s.until as number)) return;
        // the firewood comes off the stack and becomes the stave in the clamp
        const slots = c.staves.top(STAVES);
        for (const i of slots) {
          v.removeItem(c.staves.items[i]!);
          c.staves.items[i] = null;
        }
        this.unbook(c.staves, 'reserved', STAVES);
        v.stats.shaved += slots.length;
        a.start('shave', { staves: Math.max(1, slots.length) });
        this.step = { kind: 'shaving' };
        return;
      }
      case 'shaving': {
        if (a.busy) return;
        a.getUp();
        this.step = { kind: 'off the horse' };
        return;
      }
      case 'off the horse': {
        if (a.onSeat) return;
        const at = c.block.workSpot();
        this.go(at.x, at.z, at.yaw);
        this.step = { kind: 'to the block', raise: true };
        return;
      }
      case 'to the block': {
        if (!this.arrived) return;
        let keg = this.onBlock(v);
        const raise = s.raise as boolean;
        if (raise) {
          // the new keg, gathered up from its staves on the block
          this.unbook(c.block, 'incoming', 1);
          const slot = c.block.free(1)[0];
          if (slot === undefined) {
            this.step = { kind: 'idle' };
            return;
          }
          keg = v.newItem('keg');
          keg.dry = 0;
          keg.place = { at: 'stack', stack: c.block, slot };
          c.block.items[slot] = keg;
          const p = c.block.slotWorld(slot);
          keg.mesh.position.copy(p.pos);
          keg.mesh.quaternion.copy(p.quat);
          v.stats.kegsMade++;
        }
        if (!keg) {
          this.step = { kind: 'idle' };
          return;
        }
        if (this.done.has(keg)) {
          // hooped already: onto the rack with the others
          if (c.empties.room <= 0) {
            this.step = { kind: 'idle' };
            this.waitUntil = v.time + 2;
            return;
          }
          const slot = (keg.place as { slot: number }).slot;
          c.block.items[slot] = null;
          this.done.delete(keg);
          this.book(c.empties, 'incoming', 1);
          this.gather([keg], [c.block.slotWorld(slot)], c.empties);
          return;
        }
        a.start('hoop', { hoop: { keg: keg.mesh, blows: raise ? BLOWS_NEW : BLOWS_OLD, raise } });
        this.step = { kind: 'hooping', keg };
        return;
      }
      case 'hooping': {
        if (a.busy) return;
        const keg = s.keg as Item;
        if (this.onBlock(v) === keg) {
          this.done.add(keg);
          v.stats.hooped++;
        }
        this.step = { kind: 'idle' };
        return;
      }
    }
  }
}

/**
 * The farmer: while there's a ripe strip of wheat and room in the stook for
 * what it'll make, claims the strip, walks to its end and mows down it: a
 * swing of the scythe, a step on, another swing, the wheat falling to
 * stubble behind the blade. At the far end, binds what's cut into sheaves
 * and stands them in the stook.
 */
export class Farmer extends Job {
  constructor(w: Worker) {
    super(w, 'farmer');
  }

  private ripe(v: Village) {
    return v.field.strips.filter((s) => s.state === 'ripe' && s.claimedBy < 0);
  }

  /** Ripe wheat, and room in the stook for what it'll make. */
  private canMow(v: Village) {
    return this.ripe(v).length > 0 && v.stook.room >= SHEAVES;
  }

  /** Sheaves on the threshing floor nobody's threshing. */
  private toThresh(v: Village) {
    return v.floor.available;
  }

  /** Sheaves to carry from the stook to the floor (as many as the mill has room for the grain of). */
  private toCarry(v: Village) {
    const pending = v.windmill.grain + v.floor.count + v.floor.incoming;
    return Math.max(0, Math.min(SHEAVES, v.stook.available, v.floor.room, GRAIN_MAX - pending));
  }

  protected hasWork(v: Village) {
    return this.canMow(v) || this.toThresh(v) > 0 || this.toCarry(v) > 0;
  }

  /** Where they stand to mow: `along` (0 … 1) down strip i, back from the blade's reach. */
  private mowSpot(v: Village, i: number, along: number) {
    const f = v.field;
    const back = 0.55 / f.len; // (the blade sweeps the wheat ahead of them)
    return f.along(i, Math.max(-back, along - back));
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const f = v.field;
    switch (s.kind) {
      case 'idle': {
        if (v.time < this.waitUntil) return;
        // the mill about to run out of grain, and sheaves waiting: that comes before mowing
        const millHungry = v.windmill.grain + v.floor.count + v.floor.incoming < GRAIN_PER_SACK && (v.floor.available > 0 || v.stook.available > 0);
        if (!this.canMow(v) || millHungry) {
          // threshing
          const n = this.toThresh(v);
          if (n > 0) {
            this.book(v.floor, 'reserved', n);
            const at = v.floor.workSpot();
            this.go(at.x, at.z, at.yaw);
            this.step = { kind: 'to the floor', n };
            return;
          }
          const c = this.toCarry(v);
          if (c > 0) {
            this.fetch(v.stook, v.floor, c);
            return;
          }
        }
        if (this.canMow(v)) {
          // the nearest ripe strip
          const me = this.w.walker;
          const strip = this.ripe(v).reduce((b, x) => {
            const pb = f.along(b.id, 0), px = f.along(x.id, 0);
            return Math.hypot(px.x - me.x, px.z - me.z) < Math.hypot(pb.x - me.x, pb.z - me.z) ? x : b;
          });
          strip.claimedBy = this.w.i;
          this.book(v.stook, 'incoming', SHEAVES);
          const at = this.mowSpot(v, strip.id, 0);
          this.go(at.x, at.z, at.yaw);
          this.step = { kind: 'to the strip', strip: strip.id };
          return;
        }
        if (this.leisure(v)) return;
        // otherwise wait by the stook
        const at = v.stook.workSpot();
        const w = this.w.walker;
        if (Math.hypot(w.x - at.x, w.z - at.z) > 0.4 && (!w.goal || w.arrived)) this.go(at.x, at.z, at.yaw);
        this.waitUntil = v.time + 2;
        return;
      }
      case 'to the floor': {
        if (!this.arrived) return;
        a.start('flail', { blows: 4 * (s.n as number) });
        this.step = { ...s, kind: 'threshing' };
        return;
      }
      case 'threshing': {
        if (a.busy) return;
        // the grain's out: up into the mill with it; the straw's cleared away
        const slots = v.floor.top(s.n as number);
        for (const k of slots) {
          v.removeItem(v.floor.items[k]!);
          v.floor.items[k] = null;
        }
        this.unbook(v.floor, 'reserved', s.n as number);
        v.windmill.grain += slots.length;
        v.stats.threshed += slots.length;
        this.step = { kind: 'idle' };
        return;
      }
      case 'to the strip': {
        if (!this.arrived) return;
        const swings = Math.ceil(f.len / MOW_STEP);
        a.start('scythe', { swings });
        this.step = { kind: 'mowing', strip: s.strip, done: 0, swings };
        return;
      }
      case 'mowing': {
        const i = s.strip as number;
        const sweeps = a.kind === 'scythe' ? a.choreOf('scythe').sweeps : (s.swings as number);
        // each sweep mows a step's worth ahead of them; then a step on
        if (sweeps > (s.done as number)) {
          const done = sweeps;
          f.cut(i, (done * MOW_STEP) / f.len);
          const at = this.mowSpot(v, i, (done * MOW_STEP) / f.len);
          if (done < (s.swings as number)) this.go(at.x, at.z, at.yaw);
          this.step = { ...s, done };
          return;
        }
        if (a.busy) return;
        // at the far end: bind it into sheaves (a while bent over, hands at the bundle)
        f.cut(i, 1);
        const r = this.w.root;
        const ahead = (d: number, h: number) => r.position.clone().add(new THREE.Vector3(Math.sin(r.rotation.y) * d, h, Math.cos(r.rotation.y) * d));
        const at = ahead(0.4, 0.22);
        a.start('hold', { hold: { right: () => at.clone().add(new THREE.Vector3(0, 0.03, 0)), left: () => at.clone(), lean: 0.55, bob: () => 0.05 } });
        this.step = { kind: 'binding', strip: i, until: v.time + 2.2 };
        return;
      }
      case 'binding': {
        if (v.time < (s.until as number)) return;
        if (a.kind === 'hold') {
          a.choreOf('hold').release();
          return;
        }
        if (a.busy) return;
        f.finish(s.strip as number, Field.clock(v.day, v.hours));
        v.stats.mown++;
        // the sheaves, lying at their feet side by side
        const r = this.w.root;
        const yaw = r.rotation.y;
        const sheaves: Item[] = [];
        const poses: ItemPose[] = [];
        for (let k = 0; k < SHEAVES; k++) {
          const it = v.newItem('sheaf');
          const side = (k - (SHEAVES - 1) / 2) * 0.16;
          const pos = r.position.clone().add(new THREE.Vector3(Math.sin(yaw) * 0.35 + Math.cos(yaw) * side, SHEAF_L * 0.15, Math.cos(yaw) * 0.35 - Math.sin(yaw) * side));
          const quat = new THREE.Quaternion().setFromAxisAngle(_up, yaw + Math.PI / 2);
          it.mesh.position.copy(pos);
          it.mesh.quaternion.copy(quat);
          it.place = { at: 'ground', pos, quat };
          sheaves.push(it);
          poses.push({ pos: pos.clone(), quat: quat.clone() });
        }
        // (room in the stook was booked when the strip was claimed)
        this.gather(sheaves, poses, v.stook);
        return;
      }
    }
  }
}

/**
 * The baker: keeps the bakery in flour (sacks from the windmill's rack) and
 * the oven in firewood (from the yard, when the inn can spare it), and
 * bakes when there's room for the bread: puts wood in the oven and fires
 * it, kneads at the trough while it heats, slides the loaves in with the
 * peel, and takes them out baked onto the shelf to cool. Carries bread to
 * the inn's basket whenever it's short.
 */
export class Baker extends Job {
  constructor(w: Worker) {
    super(w, 'baker');
  }

  /** Bread for the inn: how many it's short, if there's any on the shelf. */
  private breadWanted(v: Village) {
    const short = INN_BREAD - v.innBread.count - v.innBread.incoming;
    return short > 0 ? Math.min(short, v.bakery.shelf.available, ARMFUL) : 0;
  }

  /** Flour, firewood, room on the shelf, and not more bread about than the inn can use. */
  private canBake(v: Village) {
    const b = v.bakery;
    const about = b.shelf.count + b.shelf.incoming + v.innBread.count + v.innBread.incoming;
    return b.flour.available >= 1 && b.wood.available >= OVEN_WOOD && b.shelf.room >= LOAVES && about < INN_BREAD + LOAVES;
  }

  private flourWanted(v: Village) {
    const f = v.bakery.flour;
    return f.count + f.incoming < f.slots.length && v.sacks.available > 0 ? 1 : 0;
  }

  private woodWanted(v: Village) {
    const w = v.bakery.wood;
    return firewoodFor(v, 'oven', Math.min(w.room, OVEN_WOOD * 2 - w.count - w.incoming));
  }

  protected hasWork(v: Village) {
    return this.breadWanted(v) > 0 || this.canBake(v) || this.flourWanted(v) > 0 || this.woodWanted(v) > 0;
  }

  /**
   * Supper: but the day's bread to the inn first, if there's some on the
   * shelf and the inn's short; and then, while anyone's sat waiting and
   * there's bread in the basket, a loaf to them (the innkeeper can't be
   * everywhere), before sitting down to their own. Fed, back to the green
   * (and from there, between tunes, round with bread again: danceBreak).
   */
  protected eveningStarts(v: Village) {
    if (v.phase === 'supper') {
      const bread = this.ateToday ? 0 : this.breadWanted(v);
      if (bread > 0) {
        this.fetch(v.bakery.shelf, v.innBread, bread);
        return true;
      }
      if (this.serveBread(v)) return true;
      if (this.ateToday) {
        this.toDance(v);
        return true;
      }
    }
    return super.eveningStarts(v);
  }

  /** A loaf from the inn's basket to whoever's waited longest for their supper (if anyone is, and there's bread). */
  private serveBread(v: Village) {
    const seat = waitingSeat(v);
    if (!seat || v.innBread.available <= 0) return false;
    this.fetch(v.innBread, seat.plate, 1);
    return true;
  }

  protected danceBreak(v: Village) {
    return this.serveBread(v);
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const b = v.bakery;
    const oven = b.oven;
    switch (s.kind) {
      case 'idle': {
        if (v.time < this.waitUntil) return;
        const bread = this.breadWanted(v);
        if (bread > 0) {
          this.fetch(b.shelf, v.innBread, bread);
          return;
        }
        if (this.canBake(v)) {
          this.book(b.flour, 'reserved', 1);
          this.book(b.wood, 'reserved', OVEN_WOOD);
          this.book(b.shelf, 'incoming', LOAVES);
          const at = oven.stand(0.75);
          this.go(at.x, at.z, at.yaw);
          this.step = { kind: 'to the oven' };
          return;
        }
        if (this.flourWanted(v) > 0) {
          this.fetch(v.sacks, b.flour, 1);
          return;
        }
        const wood = this.woodWanted(v);
        if (wood > 0) {
          this.fetch(v.yard, b.wood, wood);
          return;
        }
        if (this.leisure(v)) return;
        const at = oven.stand(1.6);
        const w = this.w.walker;
        if (Math.hypot(w.x - at.x, w.z - at.z) > 0.4 && (!w.goal || w.arrived)) this.go(at.x, at.z, at.yaw);
        this.waitUntil = v.time + 2;
        return;
      }
      case 'to the oven': {
        if (!this.arrived) return;
        // the wood in at the mouth, and lit
        const m = oven.mouth;
        a.start('hold', { hold: { right: () => m.clone().add(new THREE.Vector3(0, -0.03, 0)), left: () => m.clone().add(new THREE.Vector3(0, 0.02, 0)), lean: 0.35 } });
        this.step = { kind: 'stoking', until: v.time + 1.6 };
        return;
      }
      case 'stoking': {
        if (v.time < (s.until as number)) return;
        if (a.kind === 'hold') {
          a.choreOf('hold').release();
          return;
        }
        if (a.busy) return;
        const slots = b.wood.top(OVEN_WOOD);
        for (const k of slots) {
          v.removeItem(b.wood.items[k]!);
          b.wood.items[k] = null;
        }
        this.unbook(b.wood, 'reserved', OVEN_WOOD);
        oven.fire();
        const at = b.trough.stand;
        this.go(at.x, at.z, at.yaw);
        this.step = { kind: 'to the trough' };
        return;
      }
      case 'to the trough': {
        if (!this.arrived) return;
        a.start('knead', { at: b.trough.top });
        this.step = { kind: 'kneading' };
        return;
      }
      case 'kneading': {
        if (a.busy) return;
        // a sack of flour's gone into that
        const slot = b.flour.top(1)[0];
        if (slot !== undefined) {
          v.removeItem(b.flour.items[slot]!);
          b.flour.items[slot] = null;
        }
        this.unbook(b.flour, 'reserved', 1);
        const at = oven.stand();
        this.go(at.x, at.z, at.yaw);
        this.step = { kind: 'waiting for the oven' };
        return;
      }
      case 'waiting for the oven': {
        if (!this.arrived) return;
        s.since ??= v.time;
        // (hot; or it's not quite, but it's been long enough: in it goes, it'll bake a bit slower)
        if (!oven.hot && (oven.firing || v.time - (s.since as number) < 60)) return;
        a.start('peel', { at: oven.mouth, loaves: 'in' });
        this.step = { kind: 'loading the oven' };
        return;
      }
      case 'loading the oven': {
        if (a.busy) return;
        this.step = { kind: 'baking', until: v.time + BAKE_TIME };
        return;
      }
      case 'baking': {
        if (v.time < (s.until as number)) return;
        a.start('peel', { at: oven.mouth, loaves: 'out' });
        this.step = { kind: 'taking out the bread' };
        return;
      }
      case 'taking out the bread': {
        if (a.busy) return;
        // the loaves out onto the shelf to cool (room was kept for them)
        const slots = b.shelf.free(LOAVES);
        const from = oven.mouth;
        for (const k of slots) {
          const loaf = v.newItem('bread');
          const p = b.shelf.slotWorld(k);
          loaf.place = { at: 'stack', stack: b.shelf, slot: k };
          loaf.tween = { pos: from.clone(), quat: p.quat.clone(), t0: v.time, dur: 0.5 };
          b.shelf.items[k] = loaf;
        }
        this.unbook(b.shelf, 'incoming', LOAVES);
        v.stats.baked++;
        this.step = { kind: 'idle' };
        return;
      }
    }
  }
}
