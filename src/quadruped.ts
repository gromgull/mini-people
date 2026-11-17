import * as THREE from 'three';
import { type Eye, ball, limb, withRow } from './body';
import { ROWS } from './palette';
import { mulberry32 } from './rng';
import { type Skin, bakeSkin } from './skin';

/**
 * A four-legged rig in the same style as the people: tapered cylinders and
 * balls, toon-shaded and outlined, merged into one draw call. A dog, or (the
 * genome's `kind`) a cat: smaller and slimmer, a round head with a flat face,
 * whiskers and a pink nose, upright triangular ears, slit pupils in amber or
 * green eyes, and a long thin tail. The same skeleton with other proportions
 * would make sheep, goats or a cow.
 *
 * Facing +z. The spine is two joints (hips and chest) so the back can flex;
 * a neck and head; ears; a tail of three segments; and four legs of two
 * long segments and a paw. The front legs bend back at the elbow; the hind
 * legs forward at the stifle and back again at the hock, onto a short raised
 * segment above the paw (so they read three-jointed, while the IK that'll
 * place them only has to solve hip → hock).
 */

export const QUAD_JOINTS = [
  'root', 'hips', 'chest', 'neck', 'head', 'earL', 'earR',
  'tail0', 'tail1', 'tail2',
  'shoulderL', 'elbowL', 'wristL', 'shoulderR', 'elbowR', 'wristR',
  'hipL', 'stifleL', 'hockL', 'pawL', 'hipR', 'stifleR', 'hockR', 'pawR',
] as const;
export type QuadJoint = (typeof QUAD_JOINTS)[number];

export const EAR_STYLES = ['pointed', 'floppy', 'round'] as const;

/** What makes this dog (or cat) this one: size and build, and its coat. */
export interface DogGenome {
  /** A dog unless it says cat. */
  kind?: 'dog' | 'cat';
  /** A cat's eyes: amber (0) or green (1). */
  eyeColour?: number;
  size: number; // overall scale, ~0.8 … 1.2
  length: number; // body length, 0 … 1
  legs: number; // leg length, 0 … 1
  girth: number; // 0 … 1
  head: number; // head size, 0 … 1
  snout: number; // snout length, 0 … 1
  ears: number; // index into EAR_STYLES
  tail: number; // tail length, 0 … 1
  curl: number; // how much the tail curls up over the back, 0 … 1
  coat: number; // fur row
  /** White points (muzzle, chest, paws, tail tip), 0 = none. */
  points: number;
  /** Ears darker than the coat. */
  darkEars: boolean;
}

export function randomDog(seed: number): DogGenome {
  const r = mulberry32(seed * 3301 + 17);
  const coat = [0, 1, 1, 2, 2, 3, 4, 5][Math.floor(r() * 8)];
  return {
    size: 0.68 + r() * 0.3,
    length: r(),
    legs: r(),
    girth: r(),
    head: r(),
    snout: r(),
    ears: Math.floor(r() * EAR_STYLES.length),
    tail: r(),
    curl: r() < 0.35 ? 0.6 + r() * 0.4 : r() * 0.3,
    coat,
    points: r() < 0.55 ? r() : 0,
    darkEars: coat <= 2 && r() < 0.5,
  };
}

/** A cat: ginger, black, grey, white, brown or cream, often with white points; a long tail held up. */
export function randomCat(seed: number): DogGenome {
  const r = mulberry32(seed * 5303 + 29);
  // fur rows: cream, tan (ginger), red-brown, choco, black, grey, white
  const coat = [1, 1, 2, 4, 4, 5, 5, 6, 0, 3][Math.floor(r() * 10)];
  return {
    kind: 'cat',
    size: 0.78 + r() * 0.2,
    length: r(),
    legs: r(),
    girth: r(),
    head: r(),
    snout: r(),
    ears: 0,
    tail: r(),
    curl: 0,
    coat,
    points: coat !== 6 && r() < 0.5 ? r() : 0,
    darkEars: false,
    eyeColour: r() < 0.55 ? 0 : 1,
  };
}

/** Lengths and sizes, in metres, from the genome. */
export function dogDims(g: DogGenome) {
  const s = g.size;
  const L = (a: number, b: number, t: number) => (a + (b - a) * t) * s;
  if (g.kind === 'cat') {
    const upper = L(0.07, 0.082, g.legs);
    const lower = L(0.066, 0.078, g.legs);
    return {
      s,
      bodyLen: L(0.22, 0.28, g.length),
      girth: L(0.058, 0.07, g.girth),
      upper,
      lower,
      thigh: upper * 1.1,
      shank: lower * 1.05,
      meta: lower * 0.45,
      pawR: L(0.018, 0.021, g.girth),
      neckLen: L(0.05, 0.065, g.length),
      headR: L(0.07, 0.078, g.head),
      snoutLen: L(0.008, 0.015, g.snout),
      tailLen: L(0.26, 0.32, g.tail),
    };
  }
  const upper = L(0.11, 0.16, g.legs);
  const lower = L(0.1, 0.15, g.legs);
  const pawR = L(0.028, 0.034, g.girth);
  const girth = L(0.085, 0.125, g.girth);
  return {
    s,
    bodyLen: L(0.24, 0.38, g.length), // hips → chest
    girth,
    upper,
    lower,
    // the hind leg: thigh, shank, and the short raised segment over the paw
    thigh: upper * 1.05,
    shank: lower * 1.0,
    meta: lower * 0.42,
    pawR,
    neckLen: L(0.1, 0.14, g.length),
    headR: L(0.085, 0.11, g.head),
    snoutLen: L(0.04, 0.1, g.snout),
    tailLen: L(0.12, 0.28, g.tail),
  };
}
export type DogDims = ReturnType<typeof dogDims>;

export interface Quadruped {
  genome: DogGenome;
  dims: DogDims;
  root: THREE.Group;
  joints: Record<QuadJoint, THREE.Object3D>;
  eyes: Eye[];
  /** Standing height at the shoulder (for shadows, framing). */
  height: number;
  skin: Skin | null;
  dispose(): void;
}

// the standing pose's leg angles (radians about x; positive swings the lower end back)
export const DOG_STAND = { shoulder: 0.12, elbow: -0.12, hip: -0.38, stifle: 0.85, hock: -0.47 };

export function buildDog(
  g: DogGenome,
  toon: THREE.Material,
  outline: THREE.Material,
  opts: { segments?: number; skin?: { toon: THREE.ShaderMaterial; outline: THREE.ShaderMaterial } | null } = {},
): Quadruped {
  const d = dogDims(g);
  const segs = opts.segments ?? 8;
  const coat = ROWS.fur[g.coat];
  const white = ROWS.fur[6];
  const accent = g.points > 0 ? white : coat;
  const earRow = g.darkEars ? ROWS.fur[Math.min(4, g.coat + 2)] : coat;
  const geos: THREE.BufferGeometry[] = [];
  const joints = {} as Record<QuadJoint, THREE.Object3D>;
  const joint = (name: QuadJoint, parent: THREE.Object3D | null, x = 0, y = 0, z = 0) => {
    const j = name === 'root' ? new THREE.Group() : new THREE.Object3D();
    j.name = name;
    j.position.set(x, y, z);
    parent?.add(j);
    joints[name] = j;
    return j;
  };
  const part = (parent: THREE.Object3D, geo: THREE.BufferGeometry, withOutline = true) => {
    geos.push(geo);
    const m = new THREE.Mesh(geo, toon);
    parent.add(m);
    if (withOutline) {
      const o = new THREE.Mesh(geo, outline);
      o.raycast = () => {};
      m.add(o);
    }
    return m;
  };
  /** An ellipsoid. */
  const egg = (rx: number, ry: number, rz: number, row: number) => ball(1, segs + 2, row).scale(rx, ry, rz);

  // --- how high the hips and shoulders stand, from the legs' standing angles
  const A = DOG_STAND;
  const frontH = d.upper * Math.cos(A.shoulder) + d.lower * Math.cos(A.shoulder + A.elbow) + d.pawR * 0.9;
  const hindH = d.thigh * Math.cos(A.hip) + d.shank * Math.cos(A.hip + A.stifle) + d.meta * Math.cos(A.hip + A.stifle + A.hock) + d.pawR * 0.9;
  const G = d.girth;

  // --- skeleton
  const root = joint('root', null) as THREE.Group;
  const hips = joint('hips', root, 0, hindH + G * 0.3, -d.bodyLen / 2);
  const chest = joint('chest', hips, 0, frontH - hindH + G * 0.05, d.bodyLen);
  const neck = joint('neck', chest, 0, G * 0.55, G * 0.75);
  neck.rotation.x = 0.55; // up, and a little forward: head held up
  const head = joint('head', neck, 0, d.neckLen, 0);
  head.rotation.x = -0.55; // face forward again

  // --- body: a ball at the hips, a bigger one at the chest, a belly between (a cat: a deeper chest, a slim waist)
  const isCat = g.kind === 'cat';
  part(hips, egg(G * (isCat ? 0.85 : 0.92), G * (isCat ? 0.88 : 0.9), G * 1.15, coat));
  part(chest, egg(G * 1.05, G * (isCat ? 1.15 : 1.08), G * 1.25, coat));
  {
    const belly = new THREE.CylinderGeometry(G * (isCat ? 0.8 : 0.95), G * (isCat ? 0.72 : 0.88), d.bodyLen, segs + 2, 1, true).rotateX(Math.PI / 2).translate(0, -G * 0.02, d.bodyLen / 2);
    part(hips, withRow(belly, coat));
  }
  // a pale bib on the chest
  if (g.points > 0.3) part(chest, egg(G * 0.7, G * 0.75, G * 0.5, white).translate(0, -G * 0.25, G * 0.85), false);

  // --- neck and head
  part(neck, limb(d.neckLen * 1.1, G * 0.55, G * 0.62, segs, coat).rotateX(Math.PI).translate(0, 0, 0));
  const hr = d.headR;
  part(head, egg(hr, hr * 0.95, hr * 1.05, coat));
  const cat = g.kind === 'cat';
  // the snout: a tapered tube out of the lower front of the face, the nose at its tip
  // (a cat: just whisker pads under a small pink nose, and whiskers)
  if (cat) {
    for (const sx of [-1, 1]) part(head, egg(hr * 0.2, hr * 0.16, hr * 0.15, g.points > 0.15 ? white : coat).translate(sx * hr * 0.14, -hr * 0.3, hr * 0.84), false);
    part(head, egg(hr * 0.1, hr * 0.07, hr * 0.06, ROWS.lips[6]).translate(0, -hr * 0.15, hr * 0.98), false);
    part(head, egg(hr * 0.16, hr * 0.025, hr * 0.03, ROWS.nose[0]).translate(0, -hr * 0.46, hr * 0.84), false);
    for (const sx of [-1, 1])
      for (let k = 0; k < 3; k++) {
        const w = new THREE.BoxGeometry(hr * 0.75, 0.0025, 0.0025).translate(sx * hr * 0.37, 0, 0).rotateZ(sx * (k - 1) * 0.18).translate(sx * hr * 0.22, -hr * 0.3 + (k - 1) * hr * 0.05, hr * 0.92);
        part(head, withRow(w, ROWS.cloud[0]), false);
      }
  } else {
    const sn = d.snoutLen;
    const tube = new THREE.CylinderGeometry(hr * 0.36, hr * 0.5, sn, segs + 2, 1, false).rotateX(Math.PI / 2).translate(0, -hr * 0.28, hr * 0.72 + sn / 2);
    part(head, withRow(tube, g.points > 0.15 ? white : coat));
    part(head, egg(hr * 0.2, hr * 0.15, hr * 0.14, ROWS.nose[0]).translate(0, -hr * 0.2, hr * 0.72 + sn), false);
    // a dark line of a mouth under it
    part(head, egg(hr * 0.3, hr * 0.03, hr * 0.03, ROWS.nose[0]).translate(0, -hr * 0.47, hr * 0.62 + sn * 0.7), false);
  }
  // googly eyes, as the people have, up on the front of the face
  const eyes: Eye[] = [];
  for (const sgn of [1, -1]) {
    const pivot = new THREE.Object3D();
    pivot.position.set(sgn * hr * (cat ? 0.38 : 0.42), hr * (cat ? 0.12 : 0.28), hr * (cat ? 0.8 : 0.78));
    pivot.rotation.y = sgn * 0.3;
    head.add(pivot);
    const er = hr * (cat ? 0.27 : 0.24);
    // (a cat's eyes are amber or green all over, with a slit of a pupil)
    part(pivot, ball(er, segs + 2, cat ? (g.eyeColour ? ROWS.leaf[2] : ROWS.food[2]) : ROWS.eyeWhite[0]));
    const pg = ball(er * 0.58, segs, ROWS.eye[0]);
    pg.scale(cat ? 0.32 : 1, cat ? 1.25 : 1, 0.6);
    const pupil = part(pivot, pg, false);
    pupil.position.z = er * 0.7;
    eyes.push({ pivot, pupil, r: er });
  }
  // ears
  for (const [sgn, name] of [[1, 'earL'], [-1, 'earR']] as const) {
    const style = EAR_STYLES[g.ears];
    if (cat) {
      // upright triangles, wide at the base, pink inside
      const ear = joint(name, head, sgn * hr * 0.5, hr * 0.62, -hr * 0.02);
      ear.rotation.z = -sgn * 0.28;
      part(ear, withRow(new THREE.ConeGeometry(hr * 0.36, hr * 0.62, 3).rotateY(Math.PI).scale(1, 1, 0.5).translate(0, hr * 0.25, 0), earRow));
      part(ear, withRow(new THREE.ConeGeometry(hr * 0.22, hr * 0.4, 3).rotateY(Math.PI).scale(1, 1, 0.3).translate(0, hr * 0.2, hr * 0.06), ROWS.lips[6]), false);
    } else if (style === 'pointed') {
      const ear = joint(name, head, sgn * hr * 0.5, hr * 0.7, -hr * 0.1);
      ear.rotation.z = -sgn * 0.3;
      part(ear, withRow(new THREE.ConeGeometry(hr * 0.3, hr * 0.75, 4).rotateY(Math.PI / 4).scale(1, 1, 0.55).translate(0, hr * 0.3, 0), earRow));
    } else if (style === 'floppy') {
      const ear = joint(name, head, sgn * hr * 0.78, hr * 0.45, -hr * 0.05);
      ear.rotation.z = sgn * 0.25;
      part(ear, egg(hr * 0.16, hr * 0.5, hr * 0.32, earRow).translate(sgn * hr * 0.05, -hr * 0.38, 0));
    } else {
      const ear = joint(name, head, sgn * hr * 0.62, hr * 0.68, -hr * 0.1);
      ear.rotation.z = -sgn * 0.5;
      part(ear, egg(hr * 0.26, hr * 0.3, hr * 0.12, earRow).translate(0, hr * 0.15, 0));
    }
  }

  // --- tail: three segments, out of the back of the hips, up and back
  {
    const seg = d.tailLen / 3;
    const t0 = joint('tail0', hips, 0, G * 0.55, -G * 1.0);
    t0.rotation.x = 2.3 - g.curl * 0.5;
    const t1 = joint('tail1', t0, 0, -seg, 0);
    const t2 = joint('tail2', t1, 0, -seg, 0);
    t1.rotation.x = -0.25 - g.curl * 0.6;
    t2.rotation.x = -0.2 - g.curl * 0.7;
    const r0 = G * (cat ? 0.17 : 0.22);
    part(t0, limb(seg, r0, r0 * 0.8, segs, coat));
    part(t1, limb(seg, r0 * 0.8, r0 * 0.6, segs, coat));
    part(t2, limb(seg, r0 * 0.6, r0 * 0.3, segs, g.points > 0.5 ? white : coat));
  }

  // --- legs
  const pawGeo = (row: number) => egg(d.pawR * 1.15, d.pawR * 0.75, d.pawR * (cat ? 1.25 : 1.5), row).translate(0, 0, d.pawR * 0.45);
  const lw = cat ? 0.92 : 1; // (a cat's legs are a touch slimmer)
  for (const [sgn, L] of [[1, 'L'], [-1, 'R']] as const) {
    // front: shoulder → elbow → wrist (the paw), straight down and a touch back
    const sh = joint(`shoulder${L}`, chest, sgn * G * 0.6, -G * 0.3, G * 0.3);
    const el = joint(`elbow${L}`, sh, 0, -d.upper, 0);
    const wr = joint(`wrist${L}`, el, 0, -d.lower, 0);
    sh.rotation.x = A.shoulder;
    el.rotation.x = A.elbow;
    part(sh, limb(d.upper, G * 0.36 * lw, G * 0.26 * lw, segs, coat));
    part(el, limb(d.lower, G * 0.26 * lw, G * 0.22 * lw, segs, accent === white && g.points > 0.65 ? white : coat));
    wr.rotation.x = -(A.shoulder + A.elbow); // paw flat on the ground
    part(wr, pawGeo(accent));
    // hind: hip → stifle (forward) → hock (back) → the raised segment → the paw
    const hp = joint(`hip${L}`, hips, sgn * G * 0.58, -G * 0.2, -G * 0.25);
    const st = joint(`stifle${L}`, hp, 0, -d.thigh, 0);
    const hk = joint(`hock${L}`, st, 0, -d.shank, 0);
    const pw = joint(`paw${L}`, hk, 0, -d.meta, 0);
    hp.rotation.x = A.hip;
    st.rotation.x = A.stifle;
    hk.rotation.x = A.hock;
    pw.rotation.x = -(A.hip + A.stifle + A.hock);
    part(hp, limb(d.thigh, G * 0.48 * lw, G * 0.3 * lw, segs, coat)); // a meaty thigh
    part(st, limb(d.shank, G * 0.27 * lw, G * 0.2 * lw, segs, coat));
    part(hk, limb(d.meta, G * 0.2 * lw, G * 0.19 * lw, segs, accent === white && g.points > 0.65 ? white : coat));
    part(pw, pawGeo(accent));
  }

  const height = hips.position.y + chest.position.y;
  const skin = opts.skin ? bakeSkin(root, toon, opts.skin, height + G) : null;
  return {
    genome: g,
    dims: d,
    root,
    joints,
    eyes,
    height,
    skin,
    dispose: () => {
      geos.forEach((x) => x.dispose());
      skin?.dispose();
    },
  };
}
