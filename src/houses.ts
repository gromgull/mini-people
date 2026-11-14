import * as THREE from 'three';
import { ROWS } from './palette';
import { type Rng, mulberry32 } from './rng';
import { type Part, bake } from './trees';

/**
 * Buildings: a two-storey half-timbered inn with a chimney and a kitchen
 * serving hatch, and a few log cabins that vary in size, roof, windows and
 * trim. Each is built in its own frame (front facing +z, origin at the middle
 * of its footprint on the ground), turned to face the village middle, and
 * everything is merged: one toon mesh plus one outline mesh for all the
 * buildings, and a separate mesh for the window panes (so they can light up
 * at night later).
 *
 * Shadows are the real silhouette: each building's corners, eaves, ridge and
 * chimney are projected along the sunlight onto the ground and wrapped in a
 * convex hull, every frame the sun moves.
 */

/** Where things happen at a building, in world space (for later: walking in, fetching food). */
export interface Building {
  kind: 'inn' | 'cabin';
  x: number;
  z: number;
  yaw: number;
  /** Just outside the front door, and which way you face to go in. */
  door: THREE.Vector3;
  doorFacing: number;
  /** The inn's kitchen hatch: where to stand to pick something up. */
  pickup?: THREE.Vector3;
  /** Footprint half-sizes (local x, z), for keeping people out later. */
  half: { x: number; z: number };
  /** The top of the chimney (world), if it has one: where smoke comes out. */
  chimney: THREE.Vector3 | null;
}

const T = 0.085; // timber thickness

// ---------------------------------------------------------------- geometry helpers

const box = (w: number, h: number, d: number, x: number, y: number, z: number, row: number): Part => ({ geo: new THREE.BoxGeometry(w, h, d).translate(x, y, z), row });

const _up = new THREE.Vector3(0, 1, 0);
/** A square beam from a to b. */
function beam(a: THREE.Vector3, b: THREE.Vector3, t: number, row: number): Part {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.BoxGeometry(t, d.length(), t);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return { geo: g, row };
}
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A triangular prism: the gable under a roof whose ridge runs along x. */
function gable(halfSpan: number, rise: number, len: number, y: number, row: number): Part {
  const s = new THREE.Shape([new THREE.Vector2(-halfSpan, 0), new THREE.Vector2(halfSpan, 0), new THREE.Vector2(0, rise)]);
  const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false });
  g.translate(0, 0, -len / 2).rotateY(Math.PI / 2).translate(0, y, 0); // span along z, length along x
  return { geo: g, row };
}

/** The darker row used for the courses on a roof of this colour. */
const courseRow = (row: number) => (row === ROWS.roof[0] ? ROWS.roof[4] : row === ROWS.roof[2] ? ROWS.roof[6] : ROWS.roof[5]);

/** Two roof slabs meeting at a ridge along x, with tile/shingle courses, plus a ridge cap. */
function roof(halfSpan: number, rise: number, len: number, y: number, over: number, th: number, row: number, cap: number): Part[] {
  const ang = Math.atan2(rise, halfSpan);
  const slope = Math.hypot(halfSpan, rise) + over;
  const out: Part[] = [];
  const courses = Math.max(3, Math.round(slope / 0.32));
  for (const s of [1, -1]) {
    const slab = (g: THREE.BufferGeometry, r: number) => {
      // hinged at the ridge: hangs down toward ±z
      g.rotateX(s * ang);
      g.translate(0, y + rise, 0);
      out.push({ geo: g, row: r });
    };
    slab(new THREE.BoxGeometry(len + 2 * over, th, slope).translate(0, th / 2, (s * slope) / 2), row);
    for (let k = 1; k <= courses; k++) {
      const d = (k / (courses + 0.4)) * slope;
      slab(new THREE.BoxGeometry(len + 2 * over + 0.01, th * 0.45, 0.045).translate(0, th + th * 0.2, s * d), courseRow(row));
    }
  }
  out.push(box(len + 2 * over + 0.02, th * 1.4, th * 2.2, 0, y + rise + th * 0.8, 0, cap));
  return out;
}

/** A window on a wall facing +z at z = face: pane (separate), frame, cross bars, optional shutters. */
function windowAt(x: number, y: number, face: number, w: number, h: number, frameRow: number, shutterRow: number | null, panes: Part[], parts: Part[]) {
  panes.push(box(w, h, 0.02, x, y, face + 0.005, ROWS.pane[0]));
  const f = 0.05;
  parts.push(box(w + 2 * f, f, 0.05, x, y + h / 2 + f / 2, face + 0.02, frameRow));
  parts.push(box(w + 2 * f + 0.06, f * 1.3, 0.09, x, y - h / 2 - f / 2, face + 0.04, frameRow)); // sill
  for (const s of [-1, 1]) parts.push(box(f, h, 0.05, x + s * (w / 2 + f / 2), y, face + 0.02, frameRow));
  parts.push(box(0.025, h, 0.04, x, y, face + 0.02, frameRow));
  parts.push(box(w, 0.025, 0.04, x, y, face + 0.02, frameRow));
  if (shutterRow !== null) {
    for (const s of [-1, 1]) {
      // swung open, flat against the wall either side
      parts.push(box(w / 2 + 0.02, h + 0.04, 0.03, x + s * (w / 2 + f + w / 4 + 0.03), y, face + 0.025, shutterRow));
      parts.push(box(w / 2 - 0.04, 0.03, 0.035, x + s * (w / 2 + f + w / 4 + 0.03), y + h * 0.25, face + 0.04, shutterRow));
    }
  }
}

/** A plank door on a wall facing +z at z = face; returns nothing, pushes parts. */
function doorAt(x: number, face: number, w: number, h: number, doorRow: number, frameRow: number, parts: Part[], step: number | null) {
  parts.push(box(w, h, 0.05, x, h / 2, face + 0.02, doorRow));
  for (const k of [-1, 0, 1]) parts.push(box(0.012, h * 0.96, 0.02, x + k * w * 0.3, h / 2, face + 0.05, frameRow)); // plank lines
  parts.push(box(w * 0.85, 0.05, 0.03, x, h * 0.25, face + 0.055, frameRow)); // ledges
  parts.push(box(w * 0.85, 0.05, 0.03, x, h * 0.75, face + 0.055, frameRow));
  parts.push(box(0.045, 0.045, 0.04, x + w * 0.32, h * 0.5, face + 0.08, ROWS.stone[2])); // latch
  parts.push(box(w + 0.12, 0.08, 0.08, x, h + 0.04, face + 0.03, frameRow)); // lintel
  for (const s of [-1, 1]) parts.push(box(0.07, h, 0.07, x + s * (w / 2 + 0.035), h / 2, face + 0.03, frameRow));
  if (step !== null) parts.push(box(w + 0.3, 0.07, 0.3, x, 0.035, face + 0.15, step));
}

/** Move every part from a building's frame into the world. */
function place(parts: Part[], x: number, z: number, yaw: number) {
  const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, 0, z);
  for (const p of parts) p.geo.applyMatrix4(m);
}

// ---------------------------------------------------------------- the inn

interface Built {
  parts: Part[];
  panes: Part[];
  /** Silhouette points (local) for the shadow. */
  hull: THREE.Vector3[];
  door: { x: number; z: number };
  pickup?: { x: number; z: number };
  half: { x: number; z: number };
  chimney?: THREE.Vector3;
}

/**
 * Half-timbered, two storeys: stone plinth, plastered panels between dark
 * posts, rails and braces; the upper floor jutting out over the street front
 * and back; a steep tiled gable roof; a stone chimney up the kitchen end, and
 * next to it a serving hatch whose lower shutter folds down as a counter and
 * whose upper one is propped up as an awning. A sign hangs over the door.
 */
function inn(r: Rng): Built {
  const parts: Part[] = [];
  const panes: Part[] = [];
  const W = 4.4, D = 3.0, h1 = 1.75, h2 = 1.5, jut = 0.2, rise = 1.75;
  const plaster = ROWS.plaster[Math.floor(r() * 2)];
  const timber = ROWS.timber[0];
  const tiles = ROWS.roof[0];
  const stone = ROWS.stone[1];
  const y2 = h1 + 0.14; // upper floor starts
  const eave = y2 + h2;
  const D2 = D / 2 + jut;

  parts.push(box(W + 0.1, 0.22, D + 0.1, 0, 0.11, 0, stone)); // plinth
  parts.push(box(W, h1, D, 0, h1 / 2, 0, plaster));
  parts.push(box(W + 0.12, 0.14, D + 2 * jut + 0.08, 0, h1 + 0.07, 0, timber)); // jetty beam
  for (const s of [-1, 1]) for (let k = -2; k <= 2; k++) parts.push(box(0.1, 0.1, 0.14, k * W * 0.24, h1 - 0.02, s * (D / 2 + 0.05), timber)); // joist ends
  parts.push(box(W, h2, D + 2 * jut, 0, y2 + h2 / 2, 0, plaster));
  parts.push(gable(D2, rise, W, eave, plaster));
  parts.push(...roof(D2, rise, W, eave, 0.32, 0.1, tiles, ROWS.roof[1]));

  // timber framing on a long wall (front +z / back −z): posts, rails, braces
  const frameLong = (face: number, sign: 1 | -1, y0: number, h: number, len: number, panels: ('door' | 'win' | 'brace' | 'x' | 'hatch')[]) => {
    const z = sign * (face + 0.025);
    const pw = len / panels.length;
    for (let i = 0; i <= panels.length; i++) parts.push(box(T, h, 0.05, -len / 2 + i * pw, y0 + h / 2, z, timber));
    parts.push(box(len + T, T, 0.05, 0, y0 + T / 2, z, timber));
    parts.push(box(len + T, T, 0.05, 0, y0 + h - T / 2, z, timber));
    panels.forEach((kind, i) => {
      const x0 = -len / 2 + i * pw, x1 = x0 + pw, xm = (x0 + x1) / 2;
      const zz = z + sign * 0.005;
      if (kind === 'brace') {
        const lean = (i % 2 === 0 ? 1 : -1) * sign;
        parts.push(beam(v(lean > 0 ? x0 : x1, y0 + T, zz), v(lean > 0 ? x1 : x0, y0 + h - T, zz), T * 0.85, timber));
      } else if (kind === 'x') {
        parts.push(beam(v(x0, y0 + T, zz), v(x1, y0 + h - T, zz), T * 0.8, timber));
        parts.push(beam(v(x1, y0 + T, zz), v(x0, y0 + h - T, zz), T * 0.8, timber));
      } else if (kind === 'win') {
        parts.push(box(pw, T, 0.05, xm, y0 + h * 0.3, z, timber));
      }
    });
    return pw;
  };
  // ground floor front: door, window, brace, the hatch, window
  const front: ('door' | 'win' | 'brace' | 'x' | 'hatch')[] = ['win', 'door', 'brace', 'hatch', 'win'];
  const pw = frameLong(D / 2, 1, 0.22, h1 - 0.22, W, front);
  const px = (i: number) => -W / 2 + (i + 0.5) * pw;
  doorAt(px(1), D / 2 + 0.03, 0.7, 1.3, ROWS.paint[1], timber, parts, stone);
  windowAt(px(0), 1.1, D / 2 + 0.03, 0.5, 0.5, timber, null, panes, parts);
  windowAt(px(4), 1.1, D / 2 + 0.03, 0.5, 0.5, timber, null, panes, parts);
  // the kitchen hatch: an opening with a counter below and an awning above
  {
    const x = px(3), y = 0.95, w = 0.62, h = 0.48, f = D / 2;
    panes.push(box(w, h, 0.02, x, y + h / 2, f + 0.005, ROWS.pane[0]));
    parts.push(box(w + 0.14, 0.05, 0.36, x, y - 0.02, f + 0.18, ROWS.log[2])); // counter (the lower shutter, folded down)
    for (const s of [-1, 1]) parts.push(beam(v(x + s * (w / 2 + 0.02), y - 0.32, f + 0.03), v(x + s * (w / 2 + 0.02), y - 0.04, f + 0.32), 0.04, timber)); // brackets
    const aw = new THREE.BoxGeometry(w + 0.16, 0.04, 0.4).translate(0, 0, 0.2).rotateX(-0.45).translate(x, y + h + 0.06, f + 0.03);
    parts.push({ geo: aw, row: ROWS.log[2] }); // awning (the upper shutter, propped)
    for (const s of [-1, 1]) parts.push(beam(v(x + s * (w / 2 + 0.03), y + 0.02, f + 0.3), v(x + s * (w / 2 + 0.03), y + h + 0.2, f + 0.34), 0.03, timber)); // props
    parts.push(box(w + 0.1, 0.06, 0.06, x, y + h + 0.02, f + 0.03, timber));
  }
  // upper floor front: windows between braces
  const up: ('door' | 'win' | 'brace' | 'x' | 'hatch')[] = ['brace', 'win', 'x', 'win', 'brace'];
  frameLong(D2, 1, y2, h2, W, up);
  for (const i of [1, 3]) windowAt(px(i), y2 + h2 * 0.58, D2 + 0.03, 0.46, 0.46, timber, ROWS.paint[0], panes, parts);
  // back walls: simpler
  frameLong(D / 2, -1, 0.22, h1 - 0.22, W, ['brace', 'win', 'brace', 'brace']);
  frameLong(D2, -1, y2, h2, W, ['x', 'win', 'win', 'x']);
  // gable ends (±x): posts, rail, braces on the walls, king post in the gable
  for (const sx of [-1, 1]) {
    const x = sx * (W / 2 + 0.025);
    for (const [y0, h, half] of [[0.22, h1 - 0.22, D / 2], [y2, h2, D2]] as const) {
      for (const zz of [-half, 0, half]) parts.push(box(0.05, h, T, x, y0 + h / 2, zz, timber));
      parts.push(box(0.05, T, 2 * half, x, y0 + T / 2, 0, timber));
      parts.push(box(0.05, T, 2 * half, x, y0 + h - T / 2, 0, timber));
    }
    parts.push(box(0.05, rise * 0.9, T, x, eave + rise * 0.45, 0, timber));
    parts.push(beam(v(x, eave, -D2 * 0.75), v(x, eave + rise * 0.6, -0.04), T * 0.85, timber));
    parts.push(beam(v(x, eave, D2 * 0.75), v(x, eave + rise * 0.6, 0.04), T * 0.85, timber));
  }
  // a window on the far gable end, both floors (rotated onto the −x wall)
  {
    const side: Part[] = [];
    const sidePanes: Part[] = [];
    windowAt(0.75, 1.1, 0, 0.46, 0.46, timber, null, sidePanes, side);
    windowAt(-0.75, 1.1, 0, 0.46, 0.46, timber, null, sidePanes, side);
    windowAt(0.75, y2 + h2 * 0.55, 0, 0.42, 0.42, timber, ROWS.paint[0], sidePanes, side);
    const m = new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(-W / 2 - 0.03, 0, 0);
    for (const p of [...side, ...sidePanes]) p.geo.applyMatrix4(m);
    parts.push(...side);
    panes.push(...sidePanes);
  }
  // chimney up the kitchen end (+x), outside the wall, past the ridge
  // (a wide hearth at the bottom, stepping in at the first floor to a slimmer stack)
  const cx = W / 2 + 0.26, chTop = eave + rise + 0.5;
  parts.push(box(0.56, h1 + 0.2, 0.9, cx, (h1 + 0.2) / 2, 0, stone));
  const shoulder = gable(0.45, 0.35, 0.56, h1 + 0.2, stone); // sloped shoulder where it steps in
  shoulder.geo.translate(cx, 0, 0);
  parts.push(shoulder);
  parts.push(box(0.34, chTop - h1, 0.4, cx - 0.06, h1 + (chTop - h1) / 2, 0, ROWS.stone[0]));
  parts.push(box(0.44, 0.09, 0.5, cx - 0.06, chTop + 0.045, 0, ROWS.stone[2]));
  for (const [y, z] of [[0.45, 0.25], [1.2, -0.2], [2.6, 0.1], [3.5, -0.08]] as const) parts.push(box(y > h1 ? 0.36 : 0.58, 0.09, 0.2, cx - (y > h1 ? 0.05 : 0) + 0.01, y, z, ROWS.stone[2])); // a few proud stones
  // the sign over the door: a bracket and a board with a tankard painted on
  {
    const x = px(1) - 0.55, y = 2.0, f = D2 + 0.05;
    parts.push(box(0.06, 0.06, 0.6, x, y, f + 0.25, timber));
    parts.push(beam(v(x, y - 0.4, f), v(x, y, f + 0.35), 0.05, timber));
    parts.push(box(0.05, 0.4, 0.5, x, y - 0.28, f + 0.32, ROWS.log[2]));
    parts.push(box(0.07, 0.17, 0.15, x, y - 0.28, f + 0.33, ROWS.food[2]));
    parts.push(box(0.075, 0.05, 0.16, x, y - 0.17, f + 0.33, ROWS.cloud[0]));
  }

  const hull = [
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => v(sx * (W / 2 + 0.32), 0, sz * (D / 2)))),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => v(sx * (W / 2 + 0.32), eave - 0.1, sz * (D2 + 0.32)))),
    v(-W / 2 - 0.32, eave + rise + 0.1, 0), v(W / 2 + 0.32, eave + rise + 0.1, 0),
    v(cx - 0.25, chTop, -0.3), v(cx + 0.25, chTop, 0.3), v(cx + 0.25, 0, 0.3), v(cx + 0.25, 0, -0.3),
  ];
  return { parts, panes, hull, door: { x: px(1), z: D / 2 + 0.55 }, pickup: { x: px(3), z: D / 2 + 0.6 }, half: { x: W / 2 + 0.6, z: D2 }, chimney: v(cx - 0.06, chTop + 0.1, 0) };
}

// ---------------------------------------------------------------- log cabins

/**
 * Stacked round logs with the ends crossing past the corners, a plank gable,
 * a shingle or turf roof with a deep overhang, a plank door, one or two
 * shuttered windows, and sometimes a stone chimney or a woodpile.
 */
function cabin(r: Rng): Built {
  const parts: Part[] = [];
  const panes: Part[] = [];
  const W = 2.2 + r() * 0.8; // along x (the front)
  const D = 1.8 + r() * 0.5;
  const H = 1.5 + r() * 0.25; // wall height
  const rise = (D / 2 + 0.2) * (0.55 + r() * 0.35);
  const lr = 0.085; // log radius
  const logRow = ROWS.log[Math.floor(r() * 3)];
  const endRow = ROWS.food[0]; // pale cut ends
  const roofRow = ROWS.roof[1 + Math.floor(r() * 3)];
  const paint = ROWS.paint[Math.floor(r() * ROWS.paint.length)];
  const dark = ROWS.timber[1];

  // a filler box inside the logs closes the gaps between them
  parts.push(box(W - 0.06, H, D - 0.06, 0, H / 2, 0, ROWS.timber[1]));
  const courses = Math.round(H / (lr * 1.8));
  const step = H / courses;
  const stick = 0.16; // how far log ends poke past the corners
  for (let c = 0; c < courses; c++) {
    const along = c % 2 === 0; // even courses: front/back walls; odd: the sides (half a log higher)
    const y = step * (c + 0.5);
    const len = (along ? W : D) + 2 * stick;
    for (const s of [-1, 1]) {
      const g = new THREE.CylinderGeometry(lr, lr, len, 6).rotateZ(Math.PI / 2);
      if (!along) g.rotateY(Math.PI / 2);
      g.translate(along ? 0 : s * (W / 2 - lr * 0.4), y, along ? s * (D / 2 - lr * 0.4) : 0);
      parts.push({ geo: g, row: logRow });
      // pale cut ends
      for (const e of [-1, 1]) {
        const cap = new THREE.CylinderGeometry(lr * 0.8, lr * 0.8, 0.01, 6).rotateZ(Math.PI / 2);
        if (!along) cap.rotateY(Math.PI / 2);
        const ex = along ? e * (len / 2 + 0.003) : s * (W / 2 - lr * 0.4);
        const ez = along ? s * (D / 2 - lr * 0.4) : e * (len / 2 + 0.003);
        cap.translate(ex, y, ez);
        parts.push({ geo: cap, row: endRow });
      }
    }
  }
  // plank gables and the roof (ridge along x)
  const D2 = D / 2 + lr * 0.5;
  parts.push(gable(D2, rise, W - lr, H, ROWS.log[2]));
  for (const sx of [-1, 1]) for (let k = -2; k <= 2; k++) {
    const zz = k * D2 * 0.33;
    const hh = rise * (1 - Math.abs(zz) / D2) * 0.92;
    if (hh > 0.05) parts.push(box(0.03, hh, 0.02, sx * (W / 2 - lr / 2 + 0.01), H + hh / 2, zz, dark));
  }
  parts.push(...roof(D2, rise, W, H, 0.3, 0.09, roofRow, roofRow === ROWS.roof[2] ? ROWS.roof[1] : dark));

  // the door, somewhere along the front; a window or two
  const face = D / 2 + lr * 0.6;
  const dx = (r() - 0.5) * (W - 1.2);
  doorAt(dx, face, 0.6, 1.2, r() < 0.5 ? paint : ROWS.log[1], dark, parts, ROWS.stone[0]);
  const winSide = dx > 0 ? -1 : 1;
  const wx = winSide * Math.min(W / 2 - 0.45, Math.abs(dx) + 0.75);
  windowAt(wx, 1.0, face, 0.42, 0.4, dark, paint, panes, parts);
  if (r() < 0.6) {
    // another on a side wall
    const side: Part[] = [];
    const sp: Part[] = [];
    windowAt((r() - 0.5) * 0.4, 1.0, 0, 0.4, 0.38, dark, paint, sp, side);
    const sx = r() < 0.5 ? -1 : 1;
    const m = new THREE.Matrix4().makeRotationY((sx * Math.PI) / 2).setPosition(sx * (W / 2 + lr * 0.6), 0, 0);
    for (const p of [...side, ...sp]) p.geo.applyMatrix4(m);
    parts.push(...side);
    panes.push(...sp);
  }
  let chimney: THREE.Vector3 | null = null;
  if (r() < 0.55) {
    const sx = r() < 0.5 ? -1 : 1;
    const x = sx * (W / 2 - 0.3), top = H + rise + 0.35;
    parts.push(box(0.36, top - H * 0.6, 0.36, x, H * 0.6 + (top - H * 0.6) / 2, -D * 0.12, ROWS.stone[r() < 0.5 ? 0 : 2]));
    parts.push(box(0.44, 0.08, 0.44, x, top, -D * 0.12, ROWS.stone[2]));
    chimney = v(x, top, -D * 0.12);
  }
  if (r() < 0.6) {
    // a woodpile against a side wall
    const sx = r() < 0.5 ? -1 : 1;
    const n = 3 + Math.floor(r() * 2);
    for (let row = 0; row < n; row++) for (let k = 0; k < n + 1 - row; k++) {
      const g = new THREE.CylinderGeometry(0.06, 0.06, 0.42, 6).rotateX(Math.PI / 2);
      g.translate(sx * (W / 2 + stick + 0.08), 0.06 + row * 0.105, (k - (n - row) / 2) * 0.125 - D * 0.15);
      parts.push({ geo: g, row: ROWS.log[(row + k) % 3] });
    }
  }

  const ox = W / 2 + 0.3, oz = D2 + 0.3;
  const hull = [
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => v(sx * (W / 2 + stick), 0, sz * (D / 2 + stick)))),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => v(sx * ox, H - 0.1, sz * oz))),
    v(-ox, H + rise + 0.05, 0), v(ox, H + rise + 0.05, 0),
    ...(chimney ? [chimney] : []),
  ];
  return { parts, panes, hull, door: { x: dx, z: face + 0.5 }, half: { x: W / 2 + stick, z: D / 2 + stick }, chimney: chimney ? chimney.clone().setY(chimney.y + 0.05) : undefined };
}

// ---------------------------------------------------------------- the village

export type Site = { kind: 'inn' | 'cabin'; x: number; z: number; yaw?: number };

/** The demo's layout. */
export const DEMO_SITES: Site[] = [
  { kind: 'inn', x: -5, z: -13 },
  { kind: 'cabin', x: -13, z: -7.5 },
  { kind: 'cabin', x: -0.5, z: -19 },
  { kind: 'cabin', x: 15, z: -5.5 },
];

export class Houses {
  readonly group = new THREE.Group();
  readonly buildings: Building[] = [];
  private shadows: { hull: THREE.Vector3[] }[] = [];
  private shadowGeo = new THREE.BufferGeometry();
  private lastLight = new THREE.Vector3(NaN, 0, 0);
  private lastLen = NaN;

  constructor(toon: THREE.Material, outline: THREE.Material, shadowMat: THREE.Material, seed = 23, sites = DEMO_SITES) {
    const r = mulberry32(seed);
    const all: Part[] = [];
    const panes: Part[] = [];
    for (const s of sites) {
      const b = s.kind === 'inn' ? inn(r) : cabin(r);
      // face the village middle, give or take (unless told which way)
      const wobble = (r() - 0.5) * 0.35;
      const yaw = s.yaw ?? Math.atan2(-s.x, -s.z) + wobble;
      place(b.parts, s.x, s.z, yaw);
      place(b.panes, s.x, s.z, yaw);
      all.push(...b.parts);
      panes.push(...b.panes);
      const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(s.x, 0, s.z);
      this.shadows.push({ hull: b.hull.map((p) => p.clone().applyMatrix4(m)) });
      const toWorld = (p: { x: number; z: number }) => v(p.x, 0, p.z).applyMatrix4(m);
      this.buildings.push({ kind: s.kind, x: s.x, z: s.z, yaw, door: toWorld(b.door), doorFacing: yaw + Math.PI, pickup: b.pickup && toWorld(b.pickup), half: b.half, chimney: b.chimney ? b.chimney.clone().applyMatrix4(m) : null });
    }
    const { flat, smooth } = bake(all);
    const mesh = new THREE.Mesh(flat, toon);
    const hull = new THREE.Mesh(smooth, outline);
    const glass = new THREE.Mesh(bake(panes).flat, toon);
    for (const m of [mesh, hull, glass]) m.raycast = () => {};
    this.group.add(mesh, hull, glass);
    // shadows: one dynamic mesh for all of them, rebuilt when the sun moves
    const sh = new THREE.Mesh(this.shadowGeo, shadowMat);
    sh.position.y = 0.002;
    sh.raycast = () => {};
    sh.frustumCulled = false;
    this.group.add(sh);
  }

  /**
   * Project each building's silhouette points along the light onto the
   * ground and fill the convex hull. `light` points at the sun; the stretch is
   * capped like the people's blob shadows.
   */
  updateShadows(light: THREE.Vector3, lengthK: number) {
    if (light.distanceToSquared(this.lastLight) < 1e-8 && lengthK === this.lastLen) return;
    this.lastLight.copy(light);
    this.lastLen = lengthK;
    const h = Math.hypot(light.x, light.z);
    const stretch = h > 1e-4 ? Math.min(h / Math.max(light.y, 1e-4), 3) * lengthK : 0;
    const ax = h > 1e-4 ? -light.x / h : 0, az = h > 1e-4 ? -light.z / h : 0;
    const pos: number[] = [];
    for (const s of this.shadows) {
      const pts = s.hull.map((p) => new THREE.Vector2(p.x + ax * p.y * stretch, p.z + az * p.y * stretch));
      const hull = convexHull(pts);
      for (let i = 1; i < hull.length - 1; i++) {
        // fan, wound to face up
        for (const q of [hull[0], hull[i + 1], hull[i]]) pos.push(q.x, 0, q.y);
      }
    }
    this.shadowGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.shadowGeo.computeBoundingSphere();
  }
}

/** Andrew's monotone chain, counter-clockwise in (x, z). */
function convexHull(p: THREE.Vector2[]) {
  const s = p.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: THREE.Vector2[] = [];
  for (const q of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: THREE.Vector2[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const q = s[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
