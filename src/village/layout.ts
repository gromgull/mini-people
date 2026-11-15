import { mulberry32 } from '../rng';
import type { Site } from '../houses';

/**
 * Where everything in the village goes, from its seed.
 *
 * The village is a woodyard in the middle (woodpile, sawhorse, the yard's
 * stack, the woodworker's bench) with four districts around it, each a
 * little arrangement that works together:
 *   forest  – the pines, the lumberjack's cabin
 *   pond    – the pond, the fisher's cabin, the fisher's bench
 *   inn     – the inn (facing the yard), its three tables, its kegs, the
 *             street-lamp, two flags, and the green in front where they dance of an evening
 *   orchard – the apple trees, the cider mill and its kegs, the pickers'
 *             baskets and ladders, the picker's and cider maker's cabin and the other picker's
 *
 * Each district is laid out once (TEMPLATE, in the village's original
 * hand-placed coordinates) and carried rigidly to wherever the seed puts it:
 * the order round the yard is shuffled, each gets its own direction and
 * distance and a little turn of its own, and the yard turns too. The
 * woodworker's cabin goes in the widest gap between districts, and the
 * drying rack on the way from the pond to the inn (the innkeeper fetches
 * dried fish from it, sometimes in the middle of supper), and the cooperage
 * (the cooper lives with the woodworker) between their cabin and the yard. A layout
 * where anything overlaps (with a margin to walk through) is thrown away
 * and another drawn.
 */

export interface Pose {
  x: number;
  z: number;
  yaw: number;
}
export interface Round {
  x: number;
  z: number;
  R: number;
}

export interface Layout {
  /** Lumberjack's, woodworker's, fisher's cabins, the inn, the picker's and cider maker's cabin, the other picker's. */
  sites: Site[];
  forest: Round;
  orchard: Round;
  pond: Round;
  mill: Pose;
  millKegs: Pose;
  baskets: Pose[];
  ladders: Pose[];
  pile: Pose;
  horse: Pose;
  yard: Pose;
  bench: Pose;
  pondBench: Pose;
  rack: Pose;
  innKegs: Pose;
  /** The cooperage: its shaving horse, block, staves and empty kegs are laid out round it (local +z toward the yard). */
  cooperage: Pose;
  /** The inn's three tables (the first is the regular's). */
  tables: Pose[];
  /** Two flagpoles by the inn. */
  flags: Pose[];
  /** The street-lamp by the tables (its arm and lantern out along its yaw). */
  lamp: Pose;
  /** The green, where the band plays and everyone dances after supper; the band stands toward `yaw`. */
  green: Round & { yaw: number };
  /** No layout of this seed worked out, so this is the original hand-placed village (the test fails on it). */
  fromTemplate: boolean;
  /** Seeds for the things that grow their own shapes. */
  seeds: { houses: number; forest: number; orchard: number; pond: number };
}

type District = 'yard' | 'forest' | 'pond' | 'inn' | 'orchard';

/** One placed thing: its district, where it is, and how much room it needs (for the overlap check). */
interface Piece {
  d: District;
  x: number;
  z: number;
  yaw: number;
  /** Footprint radius; 0 = not checked. */
  r: number;
  R?: number;
}

// the original village, by district
const P = (d: District, x: number, z: number, yaw: number, r: number, R?: number): Piece => ({ d, x, z, yaw, r, R });
const TEMPLATE: Record<string, Piece> = {
  pile: P('yard', -3.7, 0.9, 0.35, 1.3),
  horse: P('yard', -1.6, 1.3, -0.2, 1.0),
  yard: P('yard', -0.35, -0.25, -1.2, 0.6),
  bench: P('yard', 0.7, 2.4, Math.atan2(-1.6 - 0.7, 1.3 - 2.4) + 0.4, 0.8),
  forest: P('forest', -11.5, -1, 0, 4.5, 4.2),
  site0: P('forest', -6.5, -7, 0.35, 2.3),
  pond: P('pond', 10, 2, 0, 3.9, 3.6),
  site2: P('pond', 15.5, -4, -0.9, 2.3),
  rack: P('yard', 9.2, -4.4, 0.35, 1.1), // placed on its own, between the pond and the inn
  pondBench: P('pond', 5.2, 3.6, Math.PI / 2 + 0.25, 0.8),
  site3: P('inn', 1, -14, 0, 3.4),
  table0: P('inn', 3.0, -10.75, 0, 1.4),
  table1: P('inn', 2.8, -8.25, 0, 1.4),
  table2: P('inn', 5.6, -8.4, 0, 1.4),
  flag0: P('inn', -1.9, -9.3, 0, 0.3),
  flag1: P('inn', 7.0, -10.7, 0, 0.3),
  innKegs: P('inn', 4.9, -11.2, -Math.PI / 2, 0.6),
  innFront: P('inn', -0.7, -11.7, 0, 0.9), // (the inn's bench and the door step: room to come and go)
  lamp: P('inn', 1.0, -6.6, Math.atan2(2.0, -2.5), 0.4),
  green: P('inn', 1.2, -4.4, Math.atan2(1.7, -4.1), 2.0, 2.0), // (the band with the tables behind them)
  orchard: P('orchard', -2.8, 8.6, 0, 3.8, 3.3),
  mill: P('orchard', 2.8, 6.0, 0, 0.9),
  millKegs: P('orchard', 1.2, 6.1, Math.PI / 2, 0.5),
  basket0: P('orchard', 2.15, 6.85, 0, 0.3),
  basket1: P('orchard', 1.5, 7.35, 0, 0.3),
  ladder0: P('orchard', 0.9, 7.9, 0.5, 0.3),
  ladder1: P('orchard', 0.2, 8.7, -0.3, 0.3),
  site4: P('orchard', 7.4, 9.6, 2.7, 2.3),
  site5: P('orchard', -8.6, 9.4, 1.9, 2.3),
  site1: P('yard', 7.6, -7.6, -0.5, 2.3), // the woodworker's: placed on its own, in the widest gap
  cooperage: P('yard', 4.6, -4.9, Math.atan2(-4.6, 4.9), 1.3), // placed on its own, beside the woodworker's on the yard side
};
/** Each district's anchor: where it's carried from. */
const ANCHOR: Record<Exclude<District, 'yard'>, { x: number; z: number }> = {
  forest: { x: -11.5, z: -1 },
  pond: { x: 10, z: 2 },
  inn: { x: 1, z: -14 },
  orchard: { x: 0, z: 7.5 },
};
const KINDS: Record<string, Site['kind']> = { site0: 'cabin', site1: 'cabin', site2: 'cabin', site3: 'inn', site4: 'cabin', site5: 'cabin' };

/** Turn (x, z) about the origin by a (the same sense as THREE's applyAxisAngle about +y, so a yaw just adds a). */
const turn = (x: number, z: number, a: number) => ({ x: x * Math.cos(a) + z * Math.sin(a), z: -x * Math.sin(a) + z * Math.cos(a) });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Room to walk between things of different districts. */
const MARGIN = 1.0;

export function makeLayout(seed: number): Layout {
  const r = mulberry32(seed * 7907 + 3);
  const rr = (a: number, b: number) => a + (b - a) * r();
  let placed: Record<string, Piece> | null = null;
  for (let attempt = 0; attempt < 2000 && !placed; attempt++) placed = tryLayout(rr);
  // (shouldn't happen: the original village, as it was; said out loud, as it means something's crowding the layout)
  const fromTemplate = !placed;
  if (fromTemplate) console.warn(`village layout: nothing fitted for seed ${seed}, using the template`);
  placed ??= TEMPLATE;
  const g = (k: string) => placed![k];
  const pose = (k: string): Pose => ({ x: g(k).x, z: g(k).z, yaw: g(k).yaw });
  const round = (k: string): Round => ({ x: g(k).x, z: g(k).z, R: g(k).R! });
  return {
    sites: [0, 1, 2, 3, 4, 5].map((i) => ({ kind: KINDS[`site${i}`], ...pose(`site${i}`) })),
    forest: round('forest'),
    orchard: round('orchard'),
    pond: round('pond'),
    mill: pose('mill'),
    millKegs: pose('millKegs'),
    baskets: [pose('basket0'), pose('basket1')],
    ladders: [pose('ladder0'), pose('ladder1')],
    pile: pose('pile'),
    horse: pose('horse'),
    yard: pose('yard'),
    bench: pose('bench'),
    pondBench: pose('pondBench'),
    rack: pose('rack'),
    innKegs: pose('innKegs'),
    cooperage: pose('cooperage'),
    tables: [pose('table0'), pose('table1'), pose('table2')],
    flags: [pose('flag0'), pose('flag1')],
    lamp: pose('lamp'),
    green: { ...round('green'), yaw: g('green').yaw },
    fromTemplate,
    seeds: { houses: Math.floor(r() * 1e6), forest: Math.floor(r() * 1e6), orchard: Math.floor(r() * 1e6), pond: Math.floor(r() * 1e6) },
  };
}

function tryLayout(rr: (a: number, b: number) => number): Record<string, Piece> | null {
  // the districts in a shuffled order round the yard, a quarter turn apart give or take
  const order: Exclude<District, 'yard'>[] = ['forest', 'pond', 'inn', 'orchard'];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rr(0, i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const start = rr(-Math.PI, Math.PI);
  const move: Record<District, { turn: number; out: number; spin: number }> = {
    yard: { turn: rr(-Math.PI, Math.PI), out: 1, spin: 0 },
  } as never;
  order.forEach((d, k) => {
    const a = ANCHOR[d];
    const want = start + (k * Math.PI) / 2 + rr(-0.3, 0.3);
    move[d] = { turn: wrap(want - Math.atan2(a.x, a.z)), out: rr(0.92, 1.25), spin: rr(-0.3, 0.3) };
  });
  const out: Record<string, Piece> = {};
  for (const [k, t] of Object.entries(TEMPLATE)) {
    if (k === 'site1' || k === 'rack' || k === 'cooperage') continue;
    const m = move[t.d];
    let x = t.x, z = t.z, yaw = t.yaw;
    if (t.d !== 'yard') {
      // a little turn about its own anchor, then out (or in) along its direction
      const a = ANCHOR[t.d];
      const s = turn(x - a.x, z - a.z, m.spin);
      x = a.x * m.out + s.x;
      z = a.z * m.out + s.z;
      yaw += m.spin;
    }
    const p = turn(x, z, m.turn);
    out[k] = { ...t, x: p.x, z: p.z, yaw: yaw + m.turn };
  }
  // the woodworker's cabin: in the widest gap between districts, facing the yard
  const dirs = order.map((d) => Math.atan2(out[d === 'inn' ? 'site3' : d === 'orchard' ? 'mill' : d].x, out[d === 'inn' ? 'site3' : d === 'orchard' ? 'mill' : d].z)).sort((a, b) => a - b);
  let best = 0, gap = -1;
  dirs.forEach((a, i) => {
    const b = i + 1 < dirs.length ? dirs[i + 1] : dirs[0] + Math.PI * 2;
    if (b - a > gap) {
      gap = b - a;
      best = a + (b - a) / 2;
    }
  });
  const ang = best + rr(-0.15, 0.15);
  const dist = rr(9.5, 12);
  const wx = Math.sin(ang) * dist, wz = Math.cos(ang) * dist;
  out.site1 = { ...TEMPLATE.site1, x: wx, z: wz, yaw: Math.atan2(-wx, -wz) + rr(-0.35, 0.35) };
  if (!clear(out)) return null;
  // the drying rack: on the way from the pond to the inn, along that way
  const pond = out.pond, inn = out.site3;
  const along = Math.atan2(inn.x - pond.x, inn.z - pond.z);
  for (let k = 0; k < 12; k++) {
    const f = rr(0.35, 0.5), side = rr(-1.5, 1.5);
    const x = pond.x + (inn.x - pond.x) * f + Math.cos(along) * side;
    const z = pond.z + (inn.z - pond.z) * f - Math.sin(along) * side;
    out.rack = { ...TEMPLATE.rack, x, z, yaw: along + rr(-0.3, 0.3) };
    if (clear(out)) return placeCooperage(out, rr);
  }
  return null;
}

/** The cooperage: beside the woodworker's cabin, somewhere on the side toward the yard, facing the yard. */
function placeCooperage(out: Record<string, Piece>, rr: (a: number, b: number) => number) {
  const w = out.site1;
  const inward = Math.atan2(-w.x, -w.z); // from the cabin toward the yard
  const near = w.r + TEMPLATE.cooperage.r + MARGIN; // as close as the overlap check allows
  for (let k = 0; k < 24; k++) {
    const a = inward + rr(-1.9, 1.9), f = near + rr(0.05, 1.2);
    const x = w.x + Math.sin(a) * f, z = w.z + Math.cos(a) * f;
    out.cooperage = { ...TEMPLATE.cooperage, x, z, yaw: Math.atan2(-x, -z) };
    if (clear(out)) return out;
  }
  return null;
}

/** Nothing from different districts (or the woodworker's cabin) overlapping, with room to walk between. */
function clear(out: Record<string, Piece>) {
  const all = Object.entries(out).filter(([, p]) => p.r > 0);
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const [ka, a] = all[i], [kb, b] = all[j];
      const loose = (k: string) => k === 'site1' || k === 'rack' || k === 'cooperage'; // (placed on their own: checked against everything)
      const same = a.d === b.d && !loose(ka) && !loose(kb);
      if (same) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r + MARGIN) return false;
    }
  return true;
}
