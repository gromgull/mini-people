import * as THREE from 'three';
import type { Actor } from '../actions';
import type { Forest, Tree } from './forest';
import { type Bench, LOG_L, LOG_R, type Log, type Sawhorse, type Woodpile } from './things';
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

export interface Village {
  forest: Forest;
  pile: Woodpile;
  horse: Sawhorse;
  logs: Log[];
  newLog(): Log;
  removeLog(l: Log): void;
  treeObstacle(t: Tree): Obstacle | null;
  horseObstacle: Obstacle;
  /** Somewhere to sit (with the obstacle to step past onto it). */
  benches: { bench: Bench; obstacle: Obstacle }[];
  time: number;
  /** Bookkeeping for the overlay and the tests. */
  stats: { felled: number; sawn: number };
}

export interface Worker {
  i: number;
  actor: Actor;
  walker: Walker;
  root: THREE.Object3D;
  /** What they play when they've time on their hands. */
  instrument: 'fiddle' | 'banjo' | null;
}

/** Steps that aren't work: sitting about and playing. */
const LEISURE = new Set(['to bench', 'sitting', 'playing', 'getting up']);

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
  protected waitUntil = 0;

  constructor(readonly w: Worker, readonly role: string) {}

  get doing() {
    return this.step.kind;
  }

  /** Called every simulation step, before walking. */
  tick(v: Village) {
    if (LEISURE.has(this.step.kind)) this.leisureStep(v);
    else this.run(v);
    const a = this.w.actor;
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
    if (v.time < this.restAfter) return false;
    this.restAfter = v.time + 5 + Math.random() * 6;
    const r = Math.random();
    const me = this.w.walker;
    const free = v.benches.filter((b) => b.bench.claimedBy < 0);
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
    const work = this.hasWork(v);
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

  protected hasWork(v: Village) {
    return !v.horse.log && v.pile.count > 0;
  }

  protected run(v: Village) {
    const s = this.step;
    const a = this.w.actor;
    const horse = v.horse;
    switch (s.kind) {
      case 'idle': {
        if (v.time < this.waitUntil) return;
        if (this.hasWork(v)) {
          const spot = v.pile.workSpot(_v, 0.3);
          this.go(spot.x, spot.z, facing(spot.x, spot.z, v.pile.x, v.pile.z));
          this.step = { kind: 'to pile' };
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
        // sawn through (firewood comes later): the log is used up
        const l = horse.log!;
        horse.log = null;
        v.removeLog(l);
        v.stats.sawn++;
        this.step = { kind: 'idle' };
        return;
      }
    }
  }
}

const dist = (l: Log, w: Walker) => {
  const p = l.place as { x: number; z: number };
  return Math.hypot(p.x - w.x, p.z - w.z);
};
