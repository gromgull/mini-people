import * as THREE from 'three';
import { ROWS } from '../palette';
import type { Stage } from '../stage';
import { type Part, bake } from '../trees';
import { CALM } from './wind';
import { convexHull } from '../houses';

/**
 * A post mill: a timber body with a pitched roof up on a trestle and a
 * central post, the whole body turned round on the post to face into the
 * wind (slowly, as a tail pole would), and four lattice sails on an axle at
 * its front. The sails turn with the wind once it's more than CALM, and
 * coast to a stop when it drops. While they turn the stones grind: grain
 * (threshed from the sheaves) goes in, and every so often a sack of flour
 * is ready (`grind` says when).
 *
 * The threshing floor and the sack rack stand on the ground by the steps,
 * which don't turn with the body. (`bag`: there's room on the rack for
 * another sack; if not, the stones wait.) Out of working hours the brake's
 * on (`working`): no mill runs unattended, so the sails come to a stop at
 * the end of the day and start again in the morning.
 *
 * Its shadow is cast like the houses': the trestle and body, and each sail,
 * projected along the light onto the ground and filled (so the sails'
 * shadows turn with them).
 */

/** How much grain makes a sack of flour, and how long it takes with the sails at full speed (s). */
export const GRAIN_PER_SACK = 2;
const SACK_TIME = 18;
/** Most grain it holds waiting to be ground. */
export const GRAIN_MAX = 8;

const BODY_Y = 1.15; // the body's floor, up on the trestle
const BODY_H = 1.5;
const SAIL_L = 1.65;

export class Windmill {
  readonly group = new THREE.Group();
  private body = new THREE.Group();
  private sails = new THREE.Group();
  /** The sails' turn (radians) and how fast (rad/s). */
  angle = 0;
  spin = 0;
  /** Grain waiting to be ground; how far through the current sack. */
  grain = 0;
  private ground = 0;
  private facing: number;
  /** Whole turns of the sails so far (for a creak each time round). */
  turns = 0;
  private shadowGeo = new THREE.BufferGeometry();

  constructor(stage: Stage, readonly x: number, readonly z: number, readonly yaw: number) {
    const t = ROWS.timber, w = ROWS.wood, l = ROWS.log;
    // the trestle: the post, cross-trees and quarterbars, standing on stone piers
    const base: Part[] = [{ geo: new THREE.CylinderGeometry(0.11, 0.13, BODY_Y + 0.2, 6).translate(0, (BODY_Y + 0.2) / 2, 0), row: l[1] }];
    for (const a of [0, Math.PI / 2]) {
      base.push({ geo: new THREE.BoxGeometry(1.5, 0.12, 0.12).rotateY(a).translate(0, 0.28, 0), row: t[0] });
      for (const s of [-1, 1]) {
        const dx = Math.cos(a) * s * 0.7, dz = -Math.sin(a) * s * 0.7;
        base.push({ geo: new THREE.BoxGeometry(0.22, 0.22, 0.22).translate(dx, 0.11, dz), row: ROWS.stone[0] });
        const brace = new THREE.BoxGeometry(0.07, 1.05, 0.07).rotateZ(s * 0.55).rotateY(a).translate(dx * 0.55, 0.72, dz * 0.55);
        base.push({ geo: brace, row: t[1] });
      }
    }
    this.group.add(outlined(bake(base), stage));
    // the body: a weatherboarded box with a pitched roof, a door at the back (the ladder's end), the axle at the front
    const bodyParts: Part[] = [
      { geo: new THREE.BoxGeometry(1.3, BODY_H, 1.15).translate(0, BODY_H / 2, 0), row: w[2] },
      { geo: new THREE.BoxGeometry(1.36, 0.08, 1.2).translate(0, 0.04, 0), row: t[0] },
    ];
    // weatherboard lines
    for (let k = 1; k < 6; k++) bodyParts.push({ geo: new THREE.BoxGeometry(1.32, 0.02, 1.17).translate(0, (k / 6) * BODY_H, 0), row: w[1] });
    // the roof: a curved-ish gable, ridge front to back
    for (const s of [-1, 1]) bodyParts.push({ geo: new THREE.BoxGeometry(0.82, 0.06, 1.3).rotateZ(-s * 0.62).translate(s * 0.32, BODY_H + 0.2, 0), row: ROWS.roof[3] });
    bodyParts.push({ geo: new THREE.BoxGeometry(0.3, 0.42, 0.2).translate(0, BODY_H + 0.12, 0.62), row: w[2] }); // the breast round the axle
    bodyParts.push({ geo: new THREE.CylinderGeometry(0.07, 0.07, 0.4, 7).rotateX(Math.PI / 2).translate(0, BODY_H + 0.1, 0.75), row: t[0] }); // the axle
    bodyParts.push({ geo: new THREE.BoxGeometry(0.4, 0.7, 0.04).translate(0, 0.45, -0.59), row: ROWS.paint[1] }); // the door, at the back
    // the ladder down from the door to the ground, and the tail pole
    bodyParts.push({ geo: new THREE.BoxGeometry(0.5, 0.05, 1.7).rotateX(-0.62).translate(0, -0.55, -1.15), row: t[1] });
    bodyParts.push({ geo: new THREE.BoxGeometry(0.07, 0.07, 2.0).rotateX(-0.45).translate(0, -0.25, -1.5), row: t[0] });
    this.body.add(outlined(bake(bodyParts), stage));
    // the sails: four stocks on the axle, each with a lattice frame and cloth on one side
    const sailParts: Part[] = [{ geo: new THREE.CylinderGeometry(0.12, 0.12, 0.12, 8).rotateX(Math.PI / 2), row: t[0] }];
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      const along = (g: THREE.BufferGeometry) => g.rotateZ(a);
      sailParts.push({ geo: along(new THREE.BoxGeometry(0.05, SAIL_L, 0.05).translate(0, SAIL_L / 2 + 0.05, 0)), row: t[1] });
      // the frame (two rails) and the cloth between them
      for (const s of [0.09, 0.3]) sailParts.push({ geo: along(new THREE.BoxGeometry(0.025, SAIL_L * 0.78, 0.03).translate(s, SAIL_L * 0.57, 0.02)), row: t[1] });
      for (let r = 0; r < 6; r++) sailParts.push({ geo: along(new THREE.BoxGeometry(0.24, 0.02, 0.025).translate(0.195, SAIL_L * 0.2 + (r / 5) * SAIL_L * 0.75, 0.02)), row: t[1] });
      sailParts.push({ geo: along(new THREE.BoxGeometry(0.2, SAIL_L * 0.72, 0.01).translate(0.195, SAIL_L * 0.57, 0.035)), row: ROWS.cloud[0] });
    }
    this.sails.add(outlined(bake(sailParts), stage));
    this.sails.position.set(0, BODY_H + 0.1, 0.88);
    this.body.add(this.sails);
    this.body.position.y = BODY_Y;
    this.group.add(this.body);
    this.facing = yaw;
    this.body.rotation.y = 0;
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
    stage.scene.add(this.group);
    const shadow = new THREE.Mesh(this.shadowGeo, stage.shadowMat);
    shadow.raycast = () => {};
    shadow.frustumCulled = false;
    stage.scene.add(shadow);
  }

  /** Is it turning (fast enough to grind)? */
  get turning() {
    return this.spin > 0.4;
  }

  /**
   * The wind turns it: the body comes round (slowly) to face into it, the
   * sails speed up or coast down. Returns sacks of flour finished this step.
   */
  update(dt: number, strength: number, toward: number, bag: boolean, working: boolean) {
    // face into the wind: the sails' side (+z) toward where it comes from
    const want = toward + Math.PI;
    const err = Math.atan2(Math.sin(want - this.facing), Math.cos(want - this.facing));
    this.facing += Math.sign(err) * Math.min(Math.abs(err), dt * 0.08);
    this.body.rotation.y = this.facing - this.yaw;
    const drive = working && strength > CALM ? 0.6 + 2.2 * Math.min(1, (strength - CALM) / (0.8 - CALM)) : 0;
    // (speeding up with the wind, coasting down when it drops; braked harder at the end of the day)
    this.spin += (drive - this.spin) * Math.min(1, dt * (drive > this.spin ? 0.35 : working ? 0.2 : 0.6));
    if (this.spin < 0.02 && drive === 0) this.spin = 0;
    this.angle += this.spin * dt;
    this.turns = Math.floor(this.angle / (Math.PI * 2));
    this.sails.rotation.z = -this.angle;
    // grinding: as fast as the sails turn
    let sacks = 0;
    if (this.turning && bag && this.grain >= GRAIN_PER_SACK) {
      this.ground += (dt / SACK_TIME) * Math.min(1, this.spin / 2.2);
      if (this.ground >= 1) {
        this.ground = 0;
        this.grain -= GRAIN_PER_SACK;
        sacks = 1;
      }
    }
    return sacks;
  }

  /**
   * Cast its shadow from the light (`light` points at the sun), stretched
   * like the houses' (capped, × lengthK): the trestle and body as one
   * outline, each sail as another.
   */
  updateShadow(light: THREE.Vector3, lengthK: number) {
    const h = Math.hypot(light.x, light.z);
    const stretch = h > 1e-4 && light.y > 0 ? Math.min(h / Math.max(light.y, 1e-4), 3) * lengthK : 0;
    const ax = h > 1e-4 ? -light.x / h : 0, az = h > 1e-4 ? -light.z / h : 0;
    const flat = (p: THREE.Vector3) => new THREE.Vector2(p.x + ax * p.y * stretch, p.z + az * p.y * stretch);
    this.group.updateMatrixWorld(true);
    const outlines: THREE.Vector2[][] = [];
    // the trestle's feet and the body's corners, up to the roof's ridge
    const body: THREE.Vector2[] = [];
    for (const sx of [-0.75, 0.75]) for (const sz of [-0.75, 0.75]) body.push(flat(this.group.localToWorld(_p.set(sx, 0, sz))));
    for (const sx of [-0.65, 0.65]) for (const sz of [-0.58, 0.58]) for (const y of [0, BODY_H]) body.push(flat(this.body.localToWorld(_p.set(sx, y, sz))));
    for (const sz of [-0.62, 0.62]) body.push(flat(this.body.localToWorld(_p.set(0, BODY_H + 0.45, sz))));
    outlines.push(body);
    // each sail: its stock and cloth
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2, c = Math.cos(a), s = Math.sin(a);
      const pts: THREE.Vector2[] = [];
      for (const [lx, ly] of [[-0.03, 0.05], [0.3, SAIL_L * 0.2], [0.3, SAIL_L * 0.95], [-0.03, SAIL_L * 1.05]])
        pts.push(flat(this.sails.localToWorld(_p.set(lx * c - ly * s, lx * s + ly * c, 0))));
      outlines.push(pts);
    }
    const pos: number[] = [];
    for (const o of outlines) {
      const hull = convexHull(o);
      for (let i = 1; i < hull.length - 1; i++) for (const q of [hull[0], hull[i + 1], hull[i]]) pos.push(q.x, 0.004, q.y);
    }
    this.shadowGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.shadowGeo.computeBoundingSphere();
  }

  /** Where the door's ladder comes down (world), facing the mill: where the farmer tips grain in. */
  get steps() {
    const back = -2.05;
    return { x: this.x + Math.sin(this.facing) * back, z: this.z + Math.cos(this.facing) * back, yaw: this.facing };
  }
}

const _p = new THREE.Vector3();

function outlined(g: { flat: THREE.BufferGeometry; smooth: THREE.BufferGeometry }, stage: Stage) {
  const m = new THREE.Mesh(g.flat, stage.toon);
  const o = new THREE.Mesh(g.smooth, stage.outline);
  m.raycast = o.raycast = () => {};
  m.add(o);
  return m;
}
