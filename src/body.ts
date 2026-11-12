import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { type BodyDims, type Genome, deriveBody } from './genome';
import { ROWS } from './palette';

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
}

export interface Person {
  genome: Genome;
  dims: BodyDims;
  root: THREE.Group;
  joints: Record<JointName, THREE.Object3D>;
  dispose(): void;
}

// ---------------------------------------------------------------- geometry helpers

function withRow(geo: THREE.BufferGeometry, row: number): THREE.BufferGeometry {
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
function limb(len: number, rTop: number, rBot: number, segs: number, row: number, cap = true) {
  const cyl = new THREE.CylinderGeometry(rTop, rBot, len, segs, 1, true);
  cyl.translate(0, -len / 2, 0);
  const parts: THREE.BufferGeometry[] = [withRow(cyl, row)];
  if (cap) parts.push(withRow(new THREE.SphereGeometry(rTop, segs, Math.max(4, segs / 2 + 1)), row));
  return merge(parts);
}

function ball(r: number, segs: number, row: number) {
  return withRow(new THREE.SphereGeometry(r, segs, Math.max(4, segs / 2 + 1)), row);
}

/** Lathe from a (radius, y) profile; closed on the axis at both ends. */
function lathe(profile: [number, number][], segs: number, row: number) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y));
  return withRow(new THREE.LatheGeometry(pts, segs), row);
}

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
    part(hp, limb(d.thighLen, d.thighR, kneeR, segs, pants));
    part(kn, limb(d.shinLen, kneeR, d.shinR, segs, genome.shorts ? skin : pants));
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

  const neckGeo = withRow(new THREE.CylinderGeometry(d.neckR, d.neckR, d.neckLen + d.headR * 0.4, segs, 1, true), skin);
  neckGeo.translate(0, (d.neckLen + d.headR * 0.4) / 2 - d.headR * 0.05, 0);
  part(neck, neckGeo);

  // --- head
  const hc = d.headR * 0.9; // head centre above head joint
  const headGeo = ball(d.headR, segs + 2, skin);
  headGeo.translate(0, hc, 0);
  part(head, headGeo);

  const noseGeo = ball(d.noseR, Math.max(6, segs - 2), skin);
  noseGeo.translate(0, hc - d.headR * 0.12, d.headR * 0.95);
  part(head, noseGeo);

  if (opts.eyes) {
    for (const s of [1, -1]) {
      const dir = new THREE.Vector3(s * 0.36, 0.18, 0.92).normalize().multiplyScalar(d.headR * 0.96);
      const e = ball(d.headR * 0.11, 6, eye);
      e.translate(dir.x, hc + dir.y, dir.z);
      part(head, e, false);
    }
  }

  const hairSegs = segs + 2;
  if (genome.hairStyle === 1 || genome.hairStyle === 2) {
    const long = genome.hairStyle === 2;
    const g = withRow(
      new THREE.SphereGeometry(d.headR * 1.07, hairSegs, hairSegs / 2 + 1, 0, Math.PI * 2, 0, Math.PI * (long ? 0.6 : 0.42)),
      hair,
    );
    g.rotateX(long ? -0.65 : -0.4);
    g.translate(0, hc, 0);
    part(head, g);
  } else if (genome.hairStyle === 3) {
    const hatRow = genome.hair % 2 === 0 ? ROWS.pants[(genome.pants + 3) % ROWS.pants.length] : ROWS.shoes[2];
    const brim = withRow(new THREE.CylinderGeometry(d.headR * 1.35, d.headR * 1.35, d.headR * 0.08, hairSegs), hatRow);
    brim.translate(0, hc + d.headR * 0.42, 0);
    const crown = withRow(new THREE.CylinderGeometry(d.headR * 0.8, d.headR * 0.9, d.headR * 0.7, hairSegs), hatRow);
    crown.translate(0, hc + d.headR * 0.75, 0);
    part(head, merge([brim, crown]));
  }

  // tilt so they look a tiny bit alive even static
  head.rotation.x = 0.05;

  return {
    genome,
    dims: d,
    root,
    joints,
    dispose: () => geos.forEach((g) => g.dispose()),
  };
}
