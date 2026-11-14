import type { ActionKind } from './actions';

/**
 * Free-roaming crowd: everyone owns a position and heading, walks to random
 * spots in a disc, steers around neighbours, and on arrival idles, does an
 * action or heads off again.
 */

export interface WanderState {
  x: number;
  z: number;
  yaw: number;
  tx: number; // current walk target
  tz: number;
  walking: boolean;
  face: number | null; // turn to this heading while standing (e.g. a conversation)
  until: number; // idle until this sim time
}

export interface WanderBody {
  busy: boolean; // an action is running
  holdSpeed: boolean; // the action wants them standing still
  speed: number; // current ground speed
  prefSpeed: number; // preferred walking speed
}

const ARRIVE = 0.18;
const TURN_RATE = 3.2; // rad/s
const TURN_FIRST = 0.6; // further off than this → turn on the spot before walking
const PERSONAL = 0.55;
const MIN_GAP = 0.36; // hard minimum distance a walker keeps from anyone // neighbours closer than this push us away
const ACTIONS: ActionKind[] = ['wave', 'jump', 'hammer', 'carry', 'carry', 'sit', 'sit', 'fall', 'talk', 'talk', 'talk', 'saw', 'saw', 'fiddle', 'dance', 'chop', 'pick', 'pick', 'fish'];

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Area radius for a crowd; `spread` scales it (1 = default density). */
export const wanderRadius = (count: number, spread = 1) => Math.max(1.6, Math.sqrt(count) * 0.85) * spread;

/** Scatter people in the disc without overlaps (best effort). */
export function scatter(count: number, rnd: () => number, spread = 1): WanderState[] {
  const R = wanderRadius(count, spread);
  const gap = 0.45 * Math.max(0.7, spread);
  const out: WanderState[] = [];
  for (let i = 0; i < count; i++) {
    let x = 0, z = 0;
    for (let tries = 0; tries < 30; tries++) {
      const a = rnd() * Math.PI * 2;
      const r = R * Math.sqrt(rnd());
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      if (out.every((o) => (o.x - x) ** 2 + (o.z - z) ** 2 > gap ** 2)) break;
    }
    out.push({ x, z, yaw: rnd() * Math.PI * 2, tx: x, tz: z, walking: false, face: null, until: rnd() * 3 });
  }
  return out;
}

export class Wander {
  spread = 1; // scales the roaming area (from the spacing slider)
  constructor(private rnd: () => number) {}

  /** Is (x, z) free of other people and of where they're heading? */
  private free(all: WanderState[], self: WanderState, x: number, z: number, r: number) {
    for (const o of all) {
      if (o === self) continue;
      if ((o.x - x) ** 2 + (o.z - z) ** 2 < r * r) return false;
      if (o.walking && (o.tx - x) ** 2 + (o.tz - z) ** 2 < r * r) return false;
    }
    return true;
  }

  private pickTarget(s: WanderState, all: WanderState[], R: number) {
    // mostly a nearby spot, sometimes across the square; never onto someone
    const far = this.rnd() < 0.3;
    let bx = 0, bz = 0;
    for (let tries = 0; tries < 16; tries++) {
      let tx: number, tz: number;
      if (far || tries > 8) {
        const a = this.rnd() * Math.PI * 2;
        const r = R * Math.sqrt(this.rnd());
        tx = Math.cos(a) * r;
        tz = Math.sin(a) * r;
      } else {
        const a = this.rnd() * Math.PI * 2;
        const d = 0.8 + this.rnd() * 1.8;
        tx = s.x + Math.cos(a) * d;
        tz = s.z + Math.sin(a) * d;
        if (tx * tx + tz * tz > R * R) continue;
      }
      bx = tx;
      bz = tz;
      if (this.free(all, s, tx, tz, 0.6)) break;
    }
    s.tx = bx;
    s.tz = bz;
    s.walking = true;
    s.face = null;
  }

  /**
   * Decide what to do and steer. Returns the target speed, plus an action to
   * start (if any). Moves nothing: call `move` after the gait has advanced.
   */
  think(i: number, all: WanderState[], b: WanderBody, time: number, dt: number): { speed: number; act: ActionKind | null } {
    const s = all[i];
    const R = wanderRadius(all.length, this.spread);
    let act: ActionKind | null = null;

    // turning to face someone while standing
    if (!s.walking && s.face !== null) {
      const err = wrap(s.face - s.yaw);
      const step = TURN_RATE * 0.7 * dt;
      s.yaw = wrap(s.yaw + Math.max(-step, Math.min(step, err)));
      if (!b.busy) s.face = null;
    }
    if (b.holdSpeed) return { speed: 0, act };

    if (!s.walking) {
      // being crowded while standing around: shuffle off somewhere freer
      if (!b.busy && !this.free(all.filter((o) => !o.walking), s, s.x, s.z, 0.32)) this.pickTarget(s, all, R);
      else if (b.busy || time < s.until) return { speed: 0, act };
    }
    if (!s.walking) {
      // done idling: go somewhere, or do something right here
      const r = this.rnd();
      if (r < 0.6) this.pickTarget(s, all, R);
      else {
        act = ACTIONS[Math.floor(this.rnd() * ACTIONS.length)];
        if (act === 'carry') this.pickTarget(s, all, R); // take the box somewhere
        else s.until = time + 1 + this.rnd() * 2;
        return { speed: 0, act };
      }
    }

    let dx = s.tx - s.x;
    let dz = s.tz - s.z;
    const dist = Math.hypot(dx, dz);
    if (dist < ARRIVE) {
      s.walking = false;
      // linger a bit; often follow up with an action
      s.until = time + 0.5 + this.rnd() * 4;
      if (!b.busy && this.rnd() < 0.45) {
        act = ACTIONS[Math.floor(this.rnd() * ACTIONS.length)];
        if (act === 'carry') act = 'wave'; // (would just put it straight down)
      }
      return { speed: 0, act };
    }
    dx /= dist;
    dz /= dist;

    // separation: push away from close neighbours; yield to anyone right ahead
    let ahead = 1;
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    for (let j = 0; j < all.length; j++) {
      if (j === i) continue;
      const o = all[j];
      const ox = s.x - o.x, oz = s.z - o.z;
      const d2 = ox * ox + oz * oz;
      if (d2 > PERSONAL * PERSONAL * 4 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      if (d < PERSONAL) {
        const k = ((PERSONAL - d) / PERSONAL) * 3;
        dx += (ox / d) * k;
        dz += (oz / d) * k;
      }
      // someone in front of us (within a narrow cone) slows us down
      const front = -(ox * fx + oz * fz);
      const side = Math.abs(-ox * fz + oz * fx);
      if (front > 0 && side < 0.3) ahead = Math.min(ahead, Math.max(0, (front - 0.32) / 0.5));
    }

    const want = Math.atan2(dx, dz);
    const err = wrap(want - s.yaw);
    const step = TURN_RATE * dt;
    s.yaw = wrap(s.yaw + Math.max(-step, Math.min(step, err)));
    if (Math.abs(err) > TURN_FIRST) return { speed: 0, act }; // turn first, then go
    const slow = Math.min(1, dist / 0.5) * 0.6 + 0.4; // ease into the arrival
    return { speed: b.prefSpeed * slow * ahead * Math.cos(err), act };
  }

  /**
   * Advance position along the heading at the gait's actual speed, then make
   * sure a walker never ends up inside someone (they slide around instead).
   */
  move(i: number, all: WanderState[], speed: number, dt: number) {
    const s = all[i];
    if (speed <= 0) return;
    s.x += Math.sin(s.yaw) * speed * dt;
    s.z += Math.cos(s.yaw) * speed * dt;
    for (let j = 0; j < all.length; j++) {
      if (j === i) continue;
      const o = all[j];
      const ox = s.x - o.x, oz = s.z - o.z;
      const d = Math.hypot(ox, oz);
      if (d < MIN_GAP && d > 1e-5) {
        s.x = o.x + (ox / d) * MIN_GAP;
        s.z = o.z + (oz / d) * MIN_GAP;
      }
    }
  }
}
