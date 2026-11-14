/**
 * Getting somewhere: walk to a point, then turn to face a given way, steering
 * around obstacles (tree trunks, buildings, the woodpile, the sawhorse) and
 * each other. Steering is local: look a little way along the path to the
 * goal, and if an obstacle sits across it, bend toward the side that clears
 * it. That's enough for a clearing with a forest at the edge; a path planner
 * comes when there are walls to get stuck behind.
 */

export type Obstacle =
  | { kind: 'circle'; x: number; z: number; r: number }
  | { kind: 'box'; x: number; z: number; yaw: number; hx: number; hz: number };

export interface Goal {
  x: number;
  z: number;
  /** Face this way on arrival (null = don't care). */
  yaw: number | null;
  /** Obstacles to ignore (the tree you're walking up to chop). */
  ignore?: Obstacle | null;
  /** Go here first (not ignoring anything), then step in to the goal: for spots tucked up against what you're working on. */
  via?: { x: number; z: number } | null;
}

const TURN_RATE = 3.2; // rad/s
const TURN_FIRST = 0.5; // further off than this → turn on the spot before walking
const BODY = 0.17; // how wide a person is, for clearing things
const AHEAD = 1.3; // how far along the path to look for obstacles
const ARRIVE = 0.06;
const PERSONAL = 0.45;

export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Closest point on an obstacle's outline (or inside it) to (x, z), and the distance to its edge (negative = inside). */
function nearest(o: Obstacle, x: number, z: number) {
  if (o.kind === 'circle') {
    const dx = x - o.x, dz = z - o.z;
    const d = Math.hypot(dx, dz) || 1e-6;
    return { nx: dx / d, nz: dz / d, gap: d - o.r };
  }
  // into the box's frame
  const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
  const dx = x - o.x, dz = z - o.z;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const qx = Math.max(-o.hx, Math.min(o.hx, lx));
  const qz = Math.max(-o.hz, Math.min(o.hz, lz));
  let ex = lx - qx, ez = lz - qz;
  let gap = Math.hypot(ex, ez);
  if (gap < 1e-6) {
    // inside: out through the nearest face
    const px = o.hx - Math.abs(lx), pz = o.hz - Math.abs(lz);
    if (px < pz) {
      ex = Math.sign(lx) || 1;
      ez = 0;
      gap = -px;
    } else {
      ex = 0;
      ez = Math.sign(lz) || 1;
      gap = -pz;
    }
  } else {
    ex /= gap;
    ez /= gap;
  }
  // back to world
  return { nx: ex * c + ez * s, nz: -ex * s + ez * c, gap };
}

export class Walker {
  goal: Goal | null = null;
  /** True once at the goal and facing its way. */
  arrived = false;
  // progress watch: if we stop getting closer, call it close enough
  private best = Infinity;
  private bestAt = 0;
  private clock = 0;

  constructor(public x: number, public z: number, public yaw: number) {}

  go(goal: Goal) {
    this.goal = goal;
    this.arrived = false;
    this.best = Infinity;
    this.bestAt = this.clock;
  }

  stop() {
    this.goal = null;
    this.arrived = false;
  }

  /** Decide heading and speed toward the goal (call before the gait advances). */
  think(dt: number, obstacles: Obstacle[], others: Walker[], prefSpeed: number): number {
    const g = this.goal;
    this.clock += dt;
    if (!g) return 0;
    if (g.via && Math.hypot(g.via.x - this.x, g.via.z - this.z) < 0.15) {
      g.via = null;
      this.best = Infinity;
      this.bestAt = this.clock;
    }
    const tx = g.via ? g.via.x : g.x, tz = g.via ? g.via.z : g.z;
    let dx = tx - this.x;
    let dz = tz - this.z;
    const dist = Math.hypot(dx, dz);
    if (dist < this.best - 0.03) {
      this.best = dist;
      this.bestAt = this.clock;
    }
    // blocked just short of it (the spot is up against something): stop
    // trying to get closer, and settle where we are
    if (g.via && this.clock - this.bestAt > 2) g.via = null; // can't get to the approach point: just go in
    else if (dist >= ARRIVE && dist < 0.7 && this.clock - this.bestAt > 2) {
      g.x = this.x;
      g.z = this.z;
      dx = dz = 0;
    }
    if (!g.via && Math.hypot(dx, dz) < ARRIVE) {
      // there: slide the last few centimetres in and turn to face the work
      const k = Math.min(1, dt * 6);
      this.x += (g.x - this.x) * k;
      this.z += (g.z - this.z) * k;
      if (g.yaw === null) {
        this.arrived = true;
        return 0;
      }
      const err = wrap(g.yaw - this.yaw);
      const step = TURN_RATE * 0.8 * dt;
      this.yaw = wrap(this.yaw + Math.max(-step, Math.min(step, err)));
      if (Math.abs(err) < 0.03 && dist < 0.01) this.arrived = true;
      return 0;
    }
    dx /= dist;
    dz /= dist;

    // obstacles across the path: bend toward whichever side clears them
    let sx = 0, sz = 0;
    const look = Math.min(AHEAD, dist);
    for (const o of obstacles) {
      if (o === g.ignore && !g.via) continue;
      const cx = o.x - this.x, cz = o.z - this.z;
      const along = cx * dx + cz * dz;
      const size = o.kind === 'circle' ? o.r : Math.max(o.hx, o.hz);
      if (along < -size || along > look + size) continue;
      // where the path passes the obstacle, how close does it come?
      const px = this.x + dx * Math.max(0, along), pz = this.z + dz * Math.max(0, along);
      const n = nearest(o, px, pz);
      const clear = n.gap - BODY;
      if (clear > 0.12) continue;
      const w = Math.min(2.5, (0.12 - clear) / 0.12) * (1 - Math.max(0, along) / (look + size + 1e-3));
      // push sideways (perpendicular to the path), away from the obstacle
      let side = -n.nx * dz + n.nz * dx; // which side of the path the obstacle's outward normal points
      if (Math.abs(side) < 0.05) side = 1; // dead ahead: pick a side and stick to it
      sx += -dz * Math.sign(side) * w;
      sz += dx * Math.sign(side) * w;
    }
    // and keep out of each other's way
    for (const o of others) {
      if (o === this) continue;
      const ox = this.x - o.x, oz = this.z - o.z;
      const d = Math.hypot(ox, oz);
      if (d < PERSONAL && d > 1e-5) {
        const k = ((PERSONAL - d) / PERSONAL) * 2;
        sx += (ox / d) * k;
        sz += (oz / d) * k;
      }
    }
    const want = Math.atan2(dx + sx, dz + sz);
    const err = wrap(want - this.yaw);
    const step = TURN_RATE * dt;
    this.yaw = wrap(this.yaw + Math.max(-step, Math.min(step, err)));
    if (Math.abs(err) > TURN_FIRST) return 0; // turn first, then go
    const slow = Math.min(1, dist / 0.6) * 0.65 + 0.35; // ease into the arrival
    return prefSpeed * slow * Math.cos(err);
  }

  /** Step along the heading at the gait's actual speed; never end up inside anything. */
  move(speed: number, dt: number, obstacles: Obstacle[], others: Walker[]) {
    if (speed > 0) {
      this.x += Math.sin(this.yaw) * speed * dt;
      this.z += Math.cos(this.yaw) * speed * dt;
    }
    for (const o of obstacles) {
      if (o === this.goal?.ignore && !this.goal.via) continue;
      const n = nearest(o, this.x, this.z);
      if (n.gap < BODY) {
        this.x += n.nx * (BODY - n.gap);
        this.z += n.nz * (BODY - n.gap);
      }
    }
    for (const o of others) {
      if (o === this) continue;
      const ox = this.x - o.x, oz = this.z - o.z;
      const d = Math.hypot(ox, oz);
      if (d < BODY * 2 && d > 1e-5 && speed > 0) {
        this.x = o.x + (ox / d) * BODY * 2;
        this.z = o.z + (oz / d) * BODY * 2;
      }
    }
  }
}
