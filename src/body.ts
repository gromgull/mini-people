import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { type BodyDims, type Genome, MOUTH_STYLES, type MouthShape, deriveBody } from './genome';
import { ROWS } from './palette';
import { type Skin, bakeSkin } from './skin';

/**
 * Rig: a fixed hierarchy of joint nodes (plain Object3Ds). Every person has
 * exactly the same joints; only offsets differ. Meshes hang off joints and are
 * never scaled at the joint level, so rotations stay clean for animation.
 * Limbs point down their joint's local -Y.
 */
export const JOINTS = [
  'root', 'pelvis', 'spine', 'neck', 'head',
  'shoulderL', 'elbowL', 'wristL', 'shoulderR', 'elbowR', 'wristR',
  'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR',
] as const;
export type JointName = (typeof JOINTS)[number];

export interface BuildOptions {
  segments: number;
  eyes: boolean;
  /** Skinned materials: merge the body into one draw call (see skin.ts). */
  skin?: { toon: THREE.ShaderMaterial; outline: THREE.ShaderMaterial } | null;
}

/** A googly eye: `pivot` sits in the head, `pupil` is moved over the eyeball. */
export interface Eye {
  pivot: THREE.Object3D;
  pupil: THREE.Object3D;
  r: number;
}

export interface Person {
  genome: Genome;
  eyes: Eye[];
  /** Ponytail pivot (child of the head) that the animator swings, if any. */
  tail: THREE.Object3D | null;
  /** Every shape the mouth can make (one shows at a time: see setMouth), and which one's showing. */
  mouth: { shapes: Record<MouthShape, THREE.Object3D>; now: MouthShape } | null;
  dims: BodyDims;
  root: THREE.Group;
  joints: Record<JointName, THREE.Object3D>;
  /** The merged one-draw-call body, when built with `skin`. */
  skin: Skin | null;
  dispose(): void;
}

// ---------------------------------------------------------------- geometry helpers

/** Show this mouth shape (and hide the one that was showing). */
export function setMouth(p: Person, shape: MouthShape) {
  const m = p.mouth;
  if (!m || m.now === shape) return;
  m.shapes[m.now].visible = false;
  m.shapes[shape].visible = true;
  m.now = shape;
}

export function withRow(geo: THREE.BufferGeometry, row: number): THREE.BufferGeometry {
  // drop uv: we don't use it and it lets us merge freely
  geo.deleteAttribute('uv');
  const n = geo.getAttribute('position').count;
  geo.setAttribute('aRow', new THREE.BufferAttribute(new Float32Array(n).fill(row), 1));
  return geo;
}

const merge = (geos: THREE.BufferGeometry[]) => {
  const g = mergeGeometries(geos, false)!;
  geos.forEach((x) => x.dispose());
  return g;
};

/** Tapered tube hanging down from the joint (0 → -len), with a ball at the joint. */
export function limb(len: number, rTop: number, rBot: number, segs: number, row: number, cap = true) {
  const cyl = new THREE.CylinderGeometry(rTop, rBot, len, segs, 1, true);
  cyl.translate(0, -len / 2, 0);
  const parts: THREE.BufferGeometry[] = [withRow(cyl, row)];
  if (cap) parts.push(withRow(new THREE.SphereGeometry(rTop, segs, Math.max(4, segs / 2 + 1)), row));
  return merge(parts);
}

export function ball(r: number, segs: number, row: number) {
  return withRow(new THREE.SphereGeometry(r, segs, Math.max(4, segs / 2 + 1)), row);
}

/** Lathe from a (radius, y) profile; closed on the axis at both ends. */
function lathe(profile: [number, number][], segs: number, row: number) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y));
  return withRow(new THREE.LatheGeometry(pts, segs), row);
}

/**
 * Sphere cap (crown at +y) whose rim alternates between short and long
 * vertices, giving a ring of little spikes. `spike` is extra angle (radians)
 * for the tips; tip lengths jitter per vertex from `seed`.
 */
function hairCap(r: number, wSegs: number, hSegs: number, thetaLen: number, spike: number, seed: number) {
  const g = new THREE.SphereGeometry(r, wSegs, hSegs, 0, Math.PI * 2, 0, thetaLen);
  if (spike <= 0) return g;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const row0 = hSegs * (wSegs + 1); // first vertex of the rim row
  const v = new THREE.Vector3();
  for (let i = 0; i <= wSegs; i++) {
    const k = i % wSegs; // seam vertices must match
    const jit = 0.6 + 0.8 * (((Math.sin((k + 1) * 12.9898 + seed * 78.233) * 43758.5453) % 1 + 1) % 1);
    const theta = thetaLen + (k % 2 === 0 ? spike * jit : -spike * 0.25);
    const phi = (k / wSegs) * Math.PI * 2;
    v.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
    pos.setXYZ(row0 + i, v.x * r, v.y * r, v.z * r);
    nrm.setXYZ(row0 + i, v.x, v.y, v.z);
  }
  return g;
}

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------------------------------------------------------------- builder

export function buildPerson(
  genome: Genome,
  toon: THREE.Material,
  outline: THREE.Material,
  opts: BuildOptions,
): Person {
  const d = deriveBody(genome);
  const segs = opts.segments;
  const geos: THREE.BufferGeometry[] = [];

  const skin = ROWS.skin[genome.skin];
  const shirt = ROWS.shirt[genome.shirt];
  const pants = ROWS.pants[genome.pants];
  const shoes = ROWS.shoes[genome.shoes];
  const hair = ROWS.hair[genome.hair];
  const eye = ROWS.eye[0];

  const joints = {} as Record<JointName, THREE.Object3D>;
  const joint = (name: JointName, parent: THREE.Object3D | null, x = 0, y = 0, z = 0) => {
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

  // --- skeleton
  const root = joint('root', null) as THREE.Group;
  const pelvis = joint('pelvis', root, 0, d.legLen, 0);
  const spine = joint('spine', pelvis, 0, d.hipAbove, 0);
  const neck = joint('neck', spine, 0, d.torsoLen * 0.96, 0);
  const head = joint('head', neck, 0, d.neckLen, 0);

  const side = (s: 1 | -1, L: 'L' | 'R') => {
    const sh = joint(`shoulder${L}`, spine, s * d.shoulderX, d.shoulderY, 0);
    const el = joint(`elbow${L}`, sh, 0, -d.upperArmLen, 0);
    const wr = joint(`wrist${L}`, el, 0, -d.foreArmLen, 0);
    const hp = joint(`hip${L}`, pelvis, s * d.hipJointX, 0, 0);
    const kn = joint(`knee${L}`, hp, 0, -d.thighLen, 0);
    const an = joint(`ankle${L}`, kn, 0, -d.shinLen, 0);

    // rest pose (animation will own these later)
    sh.rotation.z = s * d.armOut;
    el.rotation.x = -0.22;

    const elbowR = d.upperArmR * 0.9;
    part(sh, limb(d.upperArmLen, d.upperArmR, elbowR, segs, shirt));
    part(el, limb(d.foreArmLen, elbowR, d.foreArmR, segs, genome.longSleeves ? shirt : skin));
    const hand = part(wr, ball(d.handR, segs, skin));
    hand.position.y = -d.handR * 0.7;

    const kneeR = d.thighR * 0.85;
    part(hp, limb(d.thighLen, d.thighR, kneeR, segs, genome.skirt ? skin : pants));
    part(kn, limb(d.shinLen, kneeR, d.shinR, segs, genome.shorts || genome.skirt ? skin : pants));
    const foot = ball(1, segs, shoes);
    foot.scale(d.footW / 2, d.footH * 0.6, d.footLen / 2);
    foot.translate(0, -d.footH * 0.4, d.footLen * 0.2);
    part(an, foot);
  };
  side(1, 'L');
  side(-1, 'R');

  // --- trunk (lathed profiles so belly/shoulders can bulge)
  const b = genome.belly;
  const hipGeo = lathe(
    [
      [0, -d.hipBelow],
      [d.hipR * 0.75, -d.hipBelow * 0.85],
      [d.hipR, -d.hipBelow * 0.3],
      [d.hipR * (1 + 0.05 * b), d.hipAbove * 0.4],
      [d.waistR, d.hipAbove],
    ],
    segs,
    pants,
  );
  hipGeo.scale(1, 1, d.torsoDepth);
  part(pelvis, hipGeo);

  const T = d.torsoLen;
  const bulge = 1 + 0.18 * b * b;
  const torsoGeo = lathe(
    [
      [d.waistR, 0],
      [d.waistR * bulge, T * 0.25],
      [(d.waistR * bulge + d.shoulderR) * 0.5, T * 0.55],
      [d.shoulderR, T * 0.82],
      [d.shoulderR * 0.8, T * 0.96],
      [d.shoulderR * 0.45, T * 1.02],
      [0, T * 1.04],
    ],
    segs,
    shirt,
  );
  torsoGeo.scale(1, 1, d.torsoDepth);
  part(spine, torsoGeo);

  if (genome.skirt) {
    // A-line skirt from the waist to just above the knee, wide enough that
    // walking legs mostly stay inside it
    const len = d.hipBelow + d.thighLen * 0.72;
    const flare = Math.max(d.hipR * 1.3, d.hipJointX + d.thighR + d.thighLen * 0.42);
    const skirtGeo = lathe(
      [
        [0, -len + 0.004],
        [flare * 0.94, -len],
        [flare, -len * 0.9],
        [d.hipR * 1.06, -d.hipBelow * 0.2],
        [d.hipR * 1.02, d.hipAbove * 0.45],
        [d.waistR * 1.03, d.hipAbove * 1.02],
        [0, d.hipAbove * 1.03],
      ],
      segs,
      pants,
    );
    skirtGeo.scale(1, 1, lerpN(d.torsoDepth, 1, 0.5));
    part(pelvis, skirtGeo);
  }

  if (d.bustR > 0.004) {
    // where the torso front is at chest height (matches the lathe profile)
    const y = T * 0.66;
    const rAt = ((d.waistR * bulge + d.shoulderR) * 0.5 + d.shoulderR) * 0.5;
    // spacing follows the chest, not the bust size, so small ones stay apart
    const bx = rAt * lerpN(0.4, 0.47, genome.bust);
    const zSurf = d.torsoDepth * Math.sqrt(Math.max(0, rAt * rAt - bx * bx));
    const pieces = [1, -1].map((s) => {
      const g = ball(d.bustR, segs, shirt);
      g.scale(1, 0.9, 0.9);
      g.translate(s * bx, y - d.bustR * 0.3, zSurf - d.bustR * 0.02);
      return g;
    });
    part(spine, merge(pieces));
  }

  const neckGeo = withRow(new THREE.CylinderGeometry(d.neckR, d.neckR, d.neckLen + d.headR * 0.4, segs, 1, true), skin);
  neckGeo.translate(0, (d.neckLen + d.headR * 0.4) / 2 - d.headR * 0.05, 0);
  part(neck, neckGeo);

  // --- head
  const hc = d.headR * 0.9; // head centre above head joint
  const headGeo = ball(d.headR, segs + 2, skin);
  headGeo.translate(0, hc, 0);
  part(head, headGeo);

  let noseBottom = hc; // lowest point of the nose, for placing the mouth
  // nose: a slim bridge sloping out from between the eyes, ending in a wider
  // flattened tip; size, width (tip) and length (bridge) vary independently
  {
    const nr = d.noseR;
    const wk = lerpN(0.75, 1.45, genome.noseWidth);
    const lk = lerpN(0.75, 1.4, genome.noseLength);
    const ns = Math.max(6, segs - 2);
    const top = hc + d.headR * 0.05; // root of the nose, between the eyes
    const tipY = top - nr * 1.5 * lk;
    const tipZ = d.headR * 0.9 + nr * 0.55;
    const bridge = ball(1, ns, skin);
    bridge.scale(nr * 0.42, nr * 0.85 * lk, nr * 0.5);
    bridge.rotateX(-0.35); // lower end further out
    bridge.translate(0, (top + tipY) / 2, d.headR * 0.9 + nr * 0.25);
    const tip = ball(1, ns, skin);
    tip.scale(nr * 0.62 * wk, nr * 0.55, nr * 0.6);
    tip.translate(0, tipY, tipZ);
    noseBottom = tipY - nr * 0.55;
    part(head, merge([bridge, tip]));
  }

  // mouth: a small dark shape on the face, in a lip colour; full beards push
  // it out to sit on the beard. Every shape is built (all but one hidden):
  // which shows is down to mood, not genes.
  let mouth: Person['mouth'] = null;
  {
    const hr0 = d.headR;
    const nl = ROWS.lips.length;
    // darker skin gets lighter lips so the mouth still reads
    const lipRow = ROWS.lips[Math.min(nl - 1, (genome.lips % nl) + (genome.skin >= 3 ? 2 : 0))];
    const tube = 0.055 * hr0;
    const arcShape = (R: number, arc: number, up: boolean) => {
      const g = withRow(new THREE.TorusGeometry(R, tube, 4, 10, arc), lipRow);
      g.rotateZ(up ? -Math.PI / 2 - arc / 2 : Math.PI / 2 - arc / 2); // centre the arc at bottom/top
      g.translate(0, up ? R * 0.8 : -R * 0.8, 0);
      return g;
    };
    const shapeFor = (style: number): THREE.BufferGeometry => {
      switch (style) {
        case 1: return arcShape(0.34 * hr0, 1.8, true); // smile
        case 2: return arcShape(0.32 * hr0, 1.4, false); // frown
        case 3: {
          const g = arcShape(0.28 * hr0, 1.5, true); // smirk: a lopsided smile
          g.rotateZ(0.45);
          g.translate(0.05 * hr0, 0, 0);
          return g;
        }
        case 4: {
          const ring = withRow(new THREE.TorusGeometry(0.11 * hr0, tube, 4, 12), lipRow);
          ring.scale(1, 1.25, 1);
          const hole = ball(1, 8, ROWS.eye[0]);
          hole.scale(0.1 * hr0, 0.13 * hr0, 0.02 * hr0);
          return merge([ring, hole]);
        }
        default: {
          const g = ball(1, 8, lipRow); // neutral straight line
          g.scale(0.26 * hr0, tube, tube * 1.2);
          return g;
        }
      }
    };
    // a clear gap below the nose, but never off the chin
    const y = Math.max(-0.72, Math.min(-0.36, (noseBottom - hc) / hr0 - 0.14));
    const bearded = genome.beard === 1 || genome.beard === 2;
    const z = bearded ? 1.05 : Math.sqrt(1 - y * y) + 0.015;
    const place = (g: THREE.BufferGeometry) => {
      g.scale(1, 1, 0.6);
      g.rotateX(-Math.asin(y)); // follow the face as it curves under
      g.translate(0, hc + y * hr0, z * hr0);
      return g;
    };
    const shapes = {} as Record<MouthShape, THREE.Object3D>;
    MOUTH_STYLES.forEach((name, k) => {
      shapes[name] = part(head, place(shapeFor(k)));
      shapes[name].visible = name === 'line';
    });
    mouth = { shapes, now: 'line' };
  }

  // facial hair (in the hair colour; on the head, so it follows nods and turns)
  if (genome.beard > 0) {
    const hr0 = d.headR;
    const bs = Math.max(6, segs);
    const blob = (rx: number, ry: number, rz: number, x: number, y: number, z: number) => {
      const g = ball(1, bs, hair);
      g.scale(rx * hr0, ry * hr0, rz * hr0);
      g.translate(x * hr0, hc + y * hr0, z * hr0);
      return g;
    };
    const moustache = () => [1, -1].map((s) => {
      // below the nostrils, drooping a little toward the corners
      const g = ball(1, bs, hair);
      g.scale(0.3 * hr0, 0.1 * hr0, 0.15 * hr0);
      g.rotateZ(s * 0.35);
      g.translate(s * 0.2 * hr0, hc - 0.44 * hr0, 0.88 * hr0);
      return g;
    });
    const pieces: THREE.BufferGeometry[] = [];
    const style = genome.beard;
    if (style === 1 || style === 2) {
      // full: wraps jaw and chin from ear to ear, nose and eyes stay clear
      pieces.push(blob(0.86, 0.58, 0.74, 0, -0.5, 0.3), ...moustache());
      // sideburns climbing from the jaw to the hairline, so it joins the hair
      for (const s of [1, -1]) pieces.push(blob(0.2, 0.52, 0.3, s * 0.82, -0.05, 0.2));
      if (style === 2) {
        // wizard: a long tapering point down the chest
        const cone = withRow(new THREE.ConeGeometry(0.5 * hr0, 1.7 * hr0, bs), hair);
        cone.rotateX(Math.PI); // tip down
        cone.rotateX(-0.25); // tip leans forward over the chest
        cone.translate(0, hc - 1.4 * hr0, 0.62 * hr0);
        pieces.push(cone);
      }
    } else if (style === 3) {
      pieces.push(blob(0.27, 0.32, 0.24, 0, -0.78, 0.6), ...moustache());
    } else if (style === 4) {
      for (const s of [1, -1]) pieces.push(blob(0.16, 0.48, 0.22, s * 0.84, -0.08, 0.36));
    } else if (style === 5) {
      pieces.push(...moustache());
    }
    if (pieces.length) part(head, merge(pieces));
  }

  // googly eyes: an oversized white ball poking out of the face, with a
  // pupil that rides on its surface (aimed every frame by the Gaze system)
  const eyes: Eye[] = [];
  if (opts.eyes) {
    for (const s of [1, -1]) {
      const pivot = new THREE.Object3D();
      const dir = new THREE.Vector3(s * 0.4, 0.2, 0.9).normalize().multiplyScalar(d.headR * 0.82);
      pivot.position.set(dir.x, hc + dir.y, dir.z);
      pivot.rotation.y = s * 0.18; // a little splay reads friendlier
      head.add(pivot);
      part(pivot, ball(d.eyeR, segs + 2, ROWS.eyeWhite[0]));
      const pupilGeo = ball(d.eyeR * 0.56, Math.max(6, segs), eye);
      pupilGeo.scale(1, 1, 0.6); // flattened disc-ish pupil
      const pupil = part(pivot, pupilGeo, false);
      pupil.position.z = d.eyeR * 0.7;
      eyes.push({ pivot, pupil, r: d.eyeR });
    }
  }

  const hairSegs = segs + 2;
  const hr = d.headR;
  const style = genome.hairStyle;
  let tail: THREE.Object3D | null = null;
  if (style === 1 || style === 2 || style === 4 || style === 5) {
    // scalp cap: covers the crown and the back, leaves the face free
    // short hair gets a tufty zigzag edge so it doesn't read as a beanie
    const cap = withRow(hairCap(hr * 1.07, 18, hairSegs / 2 + 1, Math.PI * 0.42, style === 1 ? 0.24 : 0, genome.hair), hair);
    cap.rotateX(-0.4);
    cap.translate(0, hc, 0);
    part(head, cap);
  }
  if (style === 2) {
    // long hair: a thick open-fronted curtain falling to the shoulders,
    // lathed as a closed ring profile so it has an inside and an outline
    const gap = THREE.MathUtils.degToRad(116);
    const ring: [number, number][] = [
      [0.95, 0.3],
      [0.92, -0.5],
      [0.98, -1.25],
      [1.22, -1.36],
      [1.3, -1.1],
      [1.2, -0.4],
      [1.11, 0.3],
      [0.95, 0.3],
    ];
    const pts = ring.map(([r, y]) => new THREE.Vector2(r * hr, hc + y * hr));
    const g = withRow(new THREE.LatheGeometry(pts, hairSegs, gap / 2, Math.PI * 2 - gap), hair);
    g.scale(1, 1, 0.92);
    part(head, g);
    // a fringe so the front doesn't look bald under the cap edge
    const fringe = withRow(
      // phi = π/2 is +z (the face) in three's sphere parametrisation
      new THREE.SphereGeometry(hr * 1.09, hairSegs, 4, Math.PI * 0.05, Math.PI * 0.9, Math.PI * 0.1, Math.PI * 0.17),
      hair,
    );
    fringe.translate(0, hc, 0);
    part(head, fringe, false);
  } else if (style === 4) {
    // ponytail on a pivot so the animator can swing it
    tail = new THREE.Object3D();
    tail.position.set(0, hc + hr * 0.35, -hr * 0.95);
    head.add(tail);
    const tie = ball(hr * 0.2, Math.max(6, segs), hair);
    const tuft = ball(1, segs, hair);
    tuft.scale(hr * 0.3, hr * 0.75, hr * 0.28);
    tuft.translate(0, -hr * 0.62, -hr * 0.12);
    part(tail, merge([tie, tuft]));
  } else if (style === 5) {
    const bun = ball(hr * 0.42, segs, hair);
    bun.translate(0, hc + hr * 0.62, -hr * 0.78);
    part(head, bun);
  } else if (style === 3) {
    const hatRow = genome.hair % 2 === 0 ? ROWS.pants[(genome.pants + 3) % ROWS.pants.length] : ROWS.shoes[2];
    const brim = withRow(new THREE.CylinderGeometry(d.headR * 1.35, d.headR * 1.35, d.headR * 0.08, hairSegs), hatRow);
    brim.translate(0, hc + d.headR * 0.56, 0); // sits above the googly eyes
    const crown = withRow(new THREE.CylinderGeometry(d.headR * 0.8, d.headR * 0.9, d.headR * 0.7, hairSegs), hatRow);
    crown.translate(0, hc + d.headR * 0.89, 0);
    part(head, merge([brim, crown]));
  }

  // tilt so they look a tiny bit alive even static
  head.rotation.x = 0.05;

  const merged = opts.skin ? bakeSkin(root, toon, opts.skin, d.height) : null;

  return {
    genome,
    eyes,
    tail,
    mouth,
    dims: d,
    root,
    joints,
    skin: merged,
    dispose: () => {
      geos.forEach((g) => g.dispose());
      merged?.dispose();
    },
  };
}
