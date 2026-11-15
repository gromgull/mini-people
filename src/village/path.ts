import { type Obstacle, nearest } from './walk';

/**
 * A route round the obstacles: A* on a grid of CELL-sized squares over the
 * stretch of ground between here and there (and a margin round it), every
 * square closer than `clear` to an obstacle blocked, then pulled straight
 * wherever there's a clear line. The walker still steers round people and
 * whatever's changed since on its own; this is so nobody paces about in a
 * pocket between a wall and a table, sure the goal is just through there.
 */

const CELL = 0.2;
/** Ground round the start and end that's searched too (m). */
const MARGIN = 6;
/** No bigger than this many cells a side. */
const MAX_SIDE = 320;
/** Right next to where they stand and where they're going is never blocked (they're there, or have to get there). */
const FREE_R = 0.3;

export interface Waypoint {
  x: number;
  z: number;
}

/** Plan from (sx, sz) to (tx, tz); null if there's no way through. The last waypoint is (tx, tz) itself. */
export function planPath(sx: number, sz: number, tx: number, tz: number, obstacles: readonly Obstacle[], ignore: Obstacle | null, clear: number): Waypoint[] | null {
  const x0 = Math.min(sx, tx) - MARGIN, z0 = Math.min(sz, tz) - MARGIN;
  const nx = Math.min(MAX_SIDE, Math.ceil((Math.max(sx, tx) + MARGIN - x0) / CELL));
  const nz = Math.min(MAX_SIDE, Math.ceil((Math.max(sz, tz) + MARGIN - z0) / CELL));
  const cx = (i: number) => x0 + (i + 0.5) * CELL;
  const cz = (k: number) => z0 + (k + 0.5) * CELL;
  const ci = (x: number) => Math.max(0, Math.min(nx - 1, Math.floor((x - x0) / CELL)));
  const ck = (z: number) => Math.max(0, Math.min(nz - 1, Math.floor((z - z0) / CELL)));

  // blocked squares: each obstacle marks only those within reach of it
  const blocked = new Uint8Array(nx * nz);
  for (const o of obstacles) {
    if (o === ignore) continue;
    const R = (o.kind === 'circle' ? o.r : o.kind === 'radial' ? o.maxR : Math.hypot(o.hx, o.hz)) + clear + CELL;
    const i0 = Math.floor((o.x - R - x0) / CELL), i1 = Math.ceil((o.x + R - x0) / CELL);
    const k0 = Math.floor((o.z - R - z0) / CELL), k1 = Math.ceil((o.z + R - z0) / CELL);
    if (i1 < 0 || k1 < 0 || i0 >= nx || k0 >= nz) continue;
    for (let k = Math.max(0, k0); k <= Math.min(nz - 1, k1); k++)
      for (let i = Math.max(0, i0); i <= Math.min(nx - 1, i1); i++) {
        const c = k * nx + i;
        if (!blocked[c] && nearest(o, cx(i), cz(k)).gap < clear) blocked[c] = 1;
      }
  }
  for (const [px, pz] of [[sx, sz], [tx, tz]]) {
    const r = Math.ceil(FREE_R / CELL);
    for (let k = ck(pz) - r; k <= ck(pz) + r; k++)
      for (let i = ci(px) - r; i <= ci(px) + r; i++) if (i >= 0 && k >= 0 && i < nx && k < nz && Math.hypot(cx(i) - px, cz(k) - pz) <= FREE_R) blocked[k * nx + i] = 0;
  }

  // A*, eight ways (no cutting a blocked corner)
  const start = ck(sz) * nx + ci(sx), goal = ck(tz) * nx + ci(tx);
  const g = new Float32Array(nx * nz).fill(Infinity);
  const from = new Int32Array(nx * nz).fill(-1);
  const done = new Uint8Array(nx * nz);
  const gi = goal % nx, gk = Math.floor(goal / nx);
  const h = (c: number) => {
    const di = Math.abs((c % nx) - gi), dk = Math.abs(Math.floor(c / nx) - gk);
    return Math.max(di, dk) + (Math.SQRT2 - 1) * Math.min(di, dk);
  };
  const heap = new Heap();
  g[start] = 0;
  heap.push(start, h(start));
  let found = false;
  while (heap.size) {
    const c = heap.pop();
    if (done[c]) continue;
    if (c === goal) {
      found = true;
      break;
    }
    done[c] = 1;
    const i = c % nx, k = Math.floor(c / nx);
    for (let dk = -1; dk <= 1; dk++)
      for (let di = -1; di <= 1; di++) {
        if (!di && !dk) continue;
        const ni = i + di, nk = k + dk;
        if (ni < 0 || nk < 0 || ni >= nx || nk >= nz) continue;
        const n = nk * nx + ni;
        if (blocked[n] || done[n]) continue;
        if (di && dk && (blocked[k * nx + ni] || blocked[nk * nx + i])) continue;
        const cost = g[c] + (di && dk ? Math.SQRT2 : 1);
        if (cost < g[n]) {
          g[n] = cost;
          from[n] = c;
          heap.push(n, cost + h(n));
        }
      }
  }
  if (!found) return null;

  // back from the goal, then pull it straight: from each point, on to the furthest one in clear sight
  const cells: number[] = [];
  for (let c = goal; c !== -1; c = from[c]) cells.push(c);
  cells.reverse();
  const pts: Waypoint[] = cells.map((c) => ({ x: cx(c % nx), z: cz(Math.floor(c / nx)) }));
  pts[0] = { x: sx, z: sz };
  pts[pts.length - 1] = { x: tx, z: tz };
  const sees = (a: Waypoint, b: Waypoint) => {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (CELL * 0.5));
    for (let s = 1; s < n; s++) {
      const x = a.x + ((b.x - a.x) * s) / n, z = a.z + ((b.z - a.z) * s) / n;
      if (blocked[ck(z) * nx + ci(x)]) return false;
    }
    return true;
  };
  const out: Waypoint[] = [];
  let at = 0;
  while (at < pts.length - 1) {
    let next = pts.length - 1;
    while (next > at + 1 && !sees(pts[at], pts[next])) next--;
    out.push(pts[next]);
    at = next;
  }
  return out;
}

/** A binary min-heap of grid cells by priority. */
class Heap {
  private c: number[] = [];
  private p: number[] = [];
  get size() {
    return this.c.length;
  }
  push(cell: number, pri: number) {
    const c = this.c, p = this.p;
    let i = c.length;
    c.push(cell);
    p.push(pri);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (p[up] <= pri) break;
      c[i] = c[up];
      p[i] = p[up];
      i = up;
    }
    c[i] = cell;
    p[i] = pri;
  }
  pop() {
    const c = this.c, p = this.p;
    const top = c[0];
    const lastC = c.pop()!, lastP = p.pop()!;
    if (c.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i, mp = lastP;
        if (l < c.length && p[l] < mp) [m, mp] = [l, p[l]];
        if (r < c.length && p[r] < mp) [m, mp] = [r, p[r]];
        if (m === i) break;
        c[i] = c[m];
        p[i] = p[m];
        i = m;
      }
      c[i] = lastC;
      p[i] = lastP;
    }
    return top;
  }
}
