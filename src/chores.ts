import * as THREE from 'three';
import { type Person, withRow } from './body';
import { type ActionPose, type ArmAngles, type PropKit, inRoot, lerp, smooth, withFK } from './actionkit';
import { ROWS } from './palette';
import { type Part, type PineSpec, bake, pineParts, wobble } from './trees';

/**
 * Chores with conjured scenery: chopping down a pine, picking an apple, and
 * fishing. Each fits its props to the person (the trunk sits where *their* axe
 * lands, the apple where *their* hand reaches) the same way the hammer's rock
 * and the saw's log do: pose the key moment with plain FK, read where the hand
 * or tool ends up, and build the prop around that.
 */

export type ActEvent =
  | 'oof' | 'hup' | 'grunt' | 'hey' | 'thunk' | 'creak' | 'log' | 'clap'
  | 'chop' | 'crack' | 'whump' | 'rustle' | 'snap' | 'crunch' | 'whoosh' | 'plop' | 'splash' | 'tick'
  | 'munch' | 'gulp' | 'clunk' | 'scrape' | 'ahh' | 'mmm';
export type BurstKind = 'chips' | 'leaves' | 'splash' | 'crumbs';

/** What a chore reports back each frame (the Actor carries these). */
export interface ChoreOut {
  events: ActEvent[];
  bursts: { kind: BurstKind; at: THREE.Vector3 }[];
  /** World point the eyes should follow, or null. */
  focus: THREE.Vector3 | null;
  /** False lets them walk while the chore goes on (carrying something off). */
  holdSpeed: boolean;
  /** Set for one frame when they should head off somewhere (wander picks where). */
  depart: boolean;
  /** Mouth open this frame (biting, chewing). */
  mouthOpen: boolean;
  /** The shared beat clock (read). */
  readonly beatTime: number;
  /** A plucked string this frame (banjo). */
  pluck: { f: number } | null;
}

export interface Chore {
  start(): void;
  /** Before the animator: fill the pose. Return false when done. */
  pre(t: number, dt: number, P: ActionPose, tempo: number, out: ChoreOut): boolean;
  /** After the animator: place props that follow the posed body. */
  post(t: number, dt: number, out: ChoreOut): void;
  hide(): void;
  dispose(): void;
}

export const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
export const setArm = (P: ActionPose, side: 'L' | 'R', a: ArmAngles, w: number, stiff = 1) => Object.assign(P.arms[side], { w, x: a.x, z: a.z, elbow: a.elbow, stiff });
export const mixArm = (a: ArmAngles, b: ArmAngles, k: number): ArmAngles => ({ x: lerp(a.x, b.x, k), z: lerp(a.z, b.z, k), elbow: lerp(a.elbow, b.elbow, k) });
/** Pop-in scale 0 → 1 that overshoots a little (ease-out-back). */
export const grow = (k: number) => {
  const c = Math.min(1, Math.max(0, k)) - 1;
  return Math.max(1e-3, 1 + 2.7 * c ** 3 + 1.7 * c ** 2);
};

/** A toon mesh from a faceted geometry, outlined by its smooth twin (see trees.ts `bake`). */
export function baked(parts: Part[], kit: PropKit) {
  const { flat, smooth: hullGeo } = bake(parts);
  const m = new THREE.Mesh(flat, kit.toon);
  const o = new THREE.Mesh(hullGeo, kit.outline);
  m.raycast = o.raycast = () => {};
  m.add(o);
  return m;
}
export function disposeMesh(m: THREE.Object3D | null) {
  m?.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  m?.removeFromParent();
}
export function simpleMesh(geo: THREE.BufferGeometry, kit: PropKit) {
  const m = new THREE.Mesh(geo, kit.toon);
  const o = new THREE.Mesh(geo, kit.outline);
  m.raycast = o.raycast = () => {};
  m.add(o);
  return m;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

// ================================================================ chop

const CHOP_CROUCH = 0.06;
const CHOPS = 5;
const CHOP_TURN = -1.2;
// a level, two-handed swing driven by the chest twist: wind up over the right
// shoulder, swing through to the left, the blade biting the trunk on the way
const AXE_READY = { spineY: -0.15, R: { x: -1.15, z: -0.2, elbow: 0.5 }, L: { x: -1.1, z: -0.3, elbow: 0.65 } };
const AXE_WIND = { spineY: -1.05, R: { x: -1.6, z: -0.05, elbow: 1.15 }, L: { x: -1.5, z: -0.35, elbow: 1.3 } };
// the left hand just stays low on the handle; the chest twist carries it round
const AXE_LEFT: ArmAngles = { x: -0.95, z: -0.2, elbow: 0.7 };
const AXE_STRIKE = { spineY: 0.35, R: { x: -1.12, z: -0.2, elbow: 0.2 }, L: { x: -1.08, z: -0.32, elbow: 0.4 } };

export class Chop implements Chore {
  private axe = new THREE.Group();
  private edge = new THREE.Object3D(); // the blade's cutting edge
  private tree = new THREE.Group(); // at the trunk's base
  private top = new THREE.Group(); // everything above the cut, pivoting there
  private stump: THREE.Mesh | null = null;
  private upper: THREE.Mesh | null = null;
  private cutY = 0;
  private axis = new THREE.Vector3(); // the fall's hinge
  private away = new THREE.Vector3(); // the way it falls
  private rt = 0.05; // trunk radius
  private theta = 0;
  private omega = 0;
  private felled = false;
  private landedAt = -1;
  private shake = 0;
  private lastU = -1;
  private chops = 0;
  private end = Infinity;
  private t = 0;
  /** A real tree to fell (village): set with aim() before start. */
  private world: PineSpec | null = null;

  constructor(private p: Person, private kit: PropKit) {
    const s = Math.sqrt(p.dims.height);
    // handle runs on down the forearm line from the fist; the head's edge faces
    // the hand's +x, which is the way the swing travels
    const handle = withRow(new THREE.CylinderGeometry(0.011, 0.013, 0.34, 6), ROWS.shoes[2]);
    handle.translate(0, -0.14, 0);
    const head = withRow(new THREE.BoxGeometry(0.075, 0.055, 0.018), ROWS.shoes[3]);
    head.translate(0.022, -0.29, 0);
    const bit = withRow(new THREE.BoxGeometry(0.012, 0.075, 0.012), ROWS.shoes[3]);
    bit.translate(0.062, -0.29, 0);
    for (const g of [handle, head, bit]) this.axe.add(simpleMesh(g, kit));
    this.edge.position.set(0.068, -0.29, 0);
    this.axe.add(this.edge);
    this.axe.scale.setScalar(s);
    this.axe.position.y = -p.dims.handR * 0.6;
    this.axe.visible = false;
    p.joints.wristR.add(this.axe);
    this.tree.add(this.top);
    this.tree.visible = false;
    p.root.add(this.tree);
  }

  /** Fell this real tree (its shape) on the next start, instead of conjuring one. */
  aim(spec: PineSpec | null) {
    this.world = spec;
  }

  /**
   * Where a trunk of radius rt has to stand (this person's root frame) for
   * the axe to bite it, and how high the cut is: the edge at the strike pose
   * (plain FK), moved on along the swing by half the trunk.
   */
  fit(rt: number) {
    const p = this.p;
    const d = p.dims;
    const H = d.height;
    // where the edge bites, and which way it's travelling then
    const at = (spineY: number) => withFK(p, { ...AXE_STRIKE, spineX: 0.2, spineY }, () => inRoot(p, this.edge, _v.set(0, 0, 0), new THREE.Vector3()));
    const hit = at(AXE_STRIKE.spineY);
    const dir = hit.clone().sub(at(AXE_STRIKE.spineY - 0.25)).setY(0).normalize();
    const cutY = Math.max(0.15 * H, hit.y - CHOP_CROUCH * d.legLen);
    const c = hit.clone().addScaledVector(dir, rt * 0.55).setY(0);
    if (c.length() < 0.22 * H) c.setLength(0.22 * H); // never through the chopper's own belly
    return { c, cutY };
  }

  /** Once the felled tree starts to go (shrinking away), where its trunk lies: world point and direction. */
  fallen() {
    if (this.landedAt < 0 || this.t <= this.end) return null;
    this.p.root.updateMatrixWorld(true);
    const base = this.tree.localToWorld(this.top.position.clone());
    const dir = this.away.clone().transformDirection(this.p.root.matrixWorld).setY(0).normalize();
    return { base, dir, cutY: this.cutY };
  }

  start() {
    const p = this.p;
    const d = p.dims;
    const H = d.height;
    const spec = this.world;
    const rt = spec ? spec.rt : 0.05 * H;
    const { c, cutY } = this.fit(rt);
    this.cutY = cutY;

    // build the pine: a stump, and the rest of it hinged at the cut
    disposeMesh(this.stump);
    disposeMesh(this.upper);
    let parts: Part[];
    if (spec) {
      // a real tree: exactly its shape above the cut (the forest draws the stump)
      parts = pineParts(spec, this.cutY);
      this.stump = baked([{ geo: new THREE.CylinderGeometry(rt, rt, 0.01, 5), row: spec.bark }], this.kit);
      this.stump.visible = false;
    } else {
      const bark = pick(ROWS.bark), needles = pick(ROWS.pine);
      const stumpG = new THREE.CylinderGeometry(rt * 0.96, rt * 1.1, this.cutY, 7).translate(0, this.cutY / 2, 0);
      this.stump = baked([{ geo: stumpG, row: bark }], this.kit);
      const trunkTop = Math.max(this.cutY + 0.3 * H, 0.62 * H);
      parts = [{ geo: new THREE.CylinderGeometry(rt * 0.75, rt * 0.96, trunkTop - this.cutY + 0.1 * H, 7).translate(0, (trunkTop - this.cutY + 0.1 * H) / 2, 0), row: bark }];
      let y = trunkTop - this.cutY;
      for (const [rad, h] of [[0.52, 0.72], [0.4, 0.62], [0.27, 0.55]]) {
        const g = new THREE.ConeGeometry(rad * H, h * H, 7, 1).rotateY(Math.random() * Math.PI).translate(0, y + (h * H) / 2, 0);
        parts.push({ geo: g, row: needles });
        y += h * H * 0.55;
      }
    }
    this.upper = baked(parts, this.kit);
    this.tree.add(this.stump);
    this.top.add(this.upper);
    this.top.position.set(0, this.cutY, 0);
    this.top.quaternion.identity();
    this.tree.position.copy(c);
    this.tree.scale.setScalar(spec ? 1 : 1e-3);
    this.tree.visible = true;
    // it falls away from the chopper
    const away = c.clone().normalize();
    this.axis.set(away.z, 0, -away.x);
    this.away.copy(away);
    this.rt = rt;
    this.theta = this.omega = 0;
    this.felled = false;
    this.landedAt = -1;
    this.shake = 0;
    this.lastU = -1;
    this.chops = 0;
    this.end = Infinity;
    this.axe.visible = true;
  }

  pre(t: number, dt: number, P: ActionPose, tempo: number, out: ChoreOut) {
    const lead = 0.5;
    const T = 1.0 / tempo;
    this.t = t;
    if (t > this.end + 0.7) return false;
    // turn side-on to the tree first (the whole root turns, tree and all), so
    // from the front you see the chopper, not a trunk in their face (a real
    // tree stays put: the chopper walked up side-on already)
    if (!this.world) P.spin = CHOP_TURN * smooth(t / 0.4) * (1 - smooth((t - this.end - 0.35) / 0.35));
    const pop = t < 0.4 && !this.world ? grow(t / 0.4) : t > this.end ? Math.max(1e-3, 1 - smooth((t - this.end) / 0.35)) : 1;
    this.tree.scale.setScalar(pop);
    this.axe.scale.setScalar(Math.sqrt(this.p.dims.height) * Math.max(0.001, Math.min(1, t / 0.25, pop)));

    if (!this.felled) {
      const raw = (t - lead) / T;
      const u = raw < 0 ? -1 : raw % 1;
      let pose = AXE_READY;
      let stiff = 1.5;
      if (u >= 0) {
        if (u < 0.5) pose = mix(AXE_STRIKE, AXE_WIND, smooth(u / 0.5));
        else if (u < 0.6) {
          pose = mix(AXE_WIND, AXE_STRIKE, ((u - 0.5) / 0.1) ** 2); // accelerating swing
          stiff = 3.2;
        } else if (u < 0.8) {
          pose = AXE_STRIKE; // blade stuck in the wood a moment
          stiff = 3.2;
        } else pose = mix(AXE_STRIKE, AXE_READY, smooth((u - 0.8) / 0.2) * 0.5); // wrench it out
      }
      const e = smooth(t / lead);
      setArm(P, 'R', pose.R, e, stiff);
      setArm(P, 'L', AXE_LEFT, e, 1.2);
      P.spineY = pose.spineY * e;
      P.spineX = 0.2 * e;
      P.crouch = CHOP_CROUCH * e;
      P.headX = 0.15 * e;
      const HIT = 0.64; // when the springed swing actually arrives
      if (u >= 0 && this.lastU < HIT && u >= HIT) {
        this.chops++;
        out.events.push('chop');
        this.p.root.updateMatrixWorld(true);
        out.bursts.push({ kind: 'chips', at: this.edge.getWorldPosition(new THREE.Vector3()) });
        this.shake = 1;
        if (this.chops >= CHOPS) {
          this.felled = true; // the last blow goes through
          this.omega = 0.15;
          out.events.push('crack');
        }
      }
      this.lastU = u;
      out.focus = this.tree.localToWorld(new THREE.Vector3(0, this.cutY, 0));
    } else {
      // step back from it: axe down, lean away, watch it go
      const k = smooth((t - (lead + CHOPS * T - T * 0.36)) / 0.6);
      setArm(P, 'R', mixArm(AXE_STRIKE.R, { x: -0.35, z: 0.1, elbow: 0.4 }, k), 1, 1.2);
      setArm(P, 'L', AXE_LEFT, 1 - k);
      P.spineY = AXE_STRIKE.spineY * (1 - k);
      P.spineX = lerp(0.2, -0.08, k);
      P.headX = this.landedAt < 0 ? -0.1 : 0.2;
      const tipLocal = new THREE.Vector3(0, 1.1 * this.p.dims.height, 0).applyQuaternion(this.top.quaternion).add(this.top.position);
      out.focus = this.tree.localToWorld(tipLocal);

      // topple: an inverted pendulum, slow to start, quick at the end, one small bounce
      const END = Math.PI / 2 - 0.02;
      this.omega += 5.5 * Math.sin(this.theta + 0.04) * dt;
      this.theta += this.omega * dt;
      if (this.theta >= END) {
        this.theta = END;
        if (this.landedAt < 0) {
          this.landedAt = t;
          this.end = t + 1.5;
          out.events.push('whump');
          for (const f of [0.55, 0.9, 1.25]) {
            const at = new THREE.Vector3(0, f * this.p.dims.height, 0).applyQuaternion(this.top.quaternion).add(this.top.position);
            out.bursts.push({ kind: 'leaves', at: this.tree.localToWorld(at) });
          }
        }
        this.omega = this.omega > 0.4 ? -this.omega * 0.18 : 0;
      }
    }
    this.shake *= Math.exp(-dt * 7);
    const quiver = this.shake * 0.035 * Math.sin(t * 45);
    this.top.quaternion.setFromAxisAngle(this.axis, this.theta + quiver);
    // past halfway the butt kicks off the stump and the trunk comes down flat
    // on the ground beside it, instead of staying hinged at the cut
    const off = smooth((this.theta - 0.7) / (Math.PI / 2 - 0.02 - 0.7));
    this.top.position.set(0, lerp(this.cutY, this.rt * 1.1, off), 0).addScaledVector(this.away, off * this.rt * 3);
    return true;
  }

  post() {}

  hide() {
    this.axe.visible = false;
    this.tree.visible = false;
  }

  dispose() {
    this.hide();
    disposeMesh(this.stump);
    disposeMesh(this.upper);
    this.axe.removeFromParent();
    this.tree.removeFromParent();
  }
}

function mix<T extends { spineY: number; R: ArmAngles; L: ArmAngles }>(a: T, b: T, k: number) {
  return { spineY: lerp(a.spineY, b.spineY, k), R: mixArm(a.R, b.R, k), L: mixArm(a.L, b.L, k) };
}

// ================================================================ pick an apple

const REACH: ArmAngles = { x: -2.3, z: 0.2, elbow: 0.1 }; // up and out, toward the crown's edge
const APPLE_CARRY: ArmAngles = { x: -0.4, z: 0.12, elbow: 1.2 }; // held out in front, forearm level
/** How long they walk around with what they've got before it vanishes (for now). */
const CARRY_TIME = 6;
const TIPTOE = 0.03; // × height

export class PickApple implements Chore {
  private tree = new THREE.Group(); // at the trunk's base
  private crown = new THREE.Group(); // leaves and the other apples; shakes on the tug
  private apple: THREE.Mesh;
  private appleAt = new THREE.Vector3(); // its spot in the crown
  private built: THREE.Mesh[] = [];
  private picked = false;
  private times = { reach: 0.45, grab: 1.3, tug: 1.35, snap: 1.95, down: 2.7 };

  constructor(private p: Person, private kit: PropKit) {
    const g = withRow(new THREE.IcosahedronGeometry(0.075, 1), ROWS.apple[0]);
    g.scale(1, 0.92, 1);
    const stalk = withRow(new THREE.CylinderGeometry(0.006, 0.006, 0.04, 4).translate(0, 0.08, 0), ROWS.bark[0]);
    this.apple = simpleMesh(mergeTwo(g, stalk), kit);
    this.tree.add(this.crown);
    this.tree.visible = false;
    p.root.add(this.tree);
  }

  start() {
    const p = this.p;
    const d = p.dims;
    const H = d.height;
    const s = Math.sqrt(H);
    // the hand at full stretch (on tiptoe), and the apple just above the fingers
    const hand = withFK(p, { spineX: -0.1, R: REACH }, () => inRoot(p, p.joints.wristR, _v.set(0, -d.handR * 1.6, d.handR * 0.3), new THREE.Vector3()));
    hand.y += TIPTOE * H + 0.06 * s;

    // the crown: a lumpy ball like the glade's apple trees, sized to the picker
    for (const m of this.built) disposeMesh(m);
    this.built = [];
    const R = 0.47 * H;
    const crownG = new THREE.IcosahedronGeometry(R, 1);
    const n = wobble(Math.floor(Math.random() * 1e9));
    const pos = crownG.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i);
      _v.multiplyScalar(1 + 0.2 * n(_w.copy(_v).divideScalar(R)));
      pos.setXYZ(i, _v.x, _v.y * 0.85, _v.z);
    }
    const surface = (dir: THREE.Vector3, out: THREE.Vector3) => {
      const r = R * (1 + 0.2 * n(dir)) * 0.98;
      return out.set(dir.x * r, dir.y * r * 0.85, dir.z * r);
    };
    // our apple hangs at the crown's lower front, facing the picker
    surface(_w.set(0, -0.12, -1).normalize(), this.appleAt);
    this.appleAt.y -= 0.05 * s;
    const C = hand.clone().sub(this.appleAt); // crown centre
    const parts: Part[] = [{ geo: crownG, row: pick(ROWS.leaf) }];
    for (let k = 0; k < 7; k++) {
      const az = Math.random() * Math.PI * 2;
      const el = -0.2 + Math.random() * 0.8;
      const dir = _w.set(Math.cos(el) * Math.sin(az), Math.sin(el) * 0.85, Math.cos(el) * Math.cos(az)).normalize();
      if (dir.z < -0.6 && dir.y < 0) continue; // keep clear of ours
      const at = surface(dir, new THREE.Vector3());
      parts.push({ geo: new THREE.IcosahedronGeometry(0.06 * s, 0).translate(at.x, at.y, at.z), row: pick(ROWS.apple) });
    }
    const crown = baked(parts, this.kit);
    const trunkTop = C.y - R * 0.3;
    const trunk = baked([{ geo: new THREE.CylinderGeometry(0.045 * H, 0.07 * H, trunkTop, 6).translate(0, trunkTop / 2, 0), row: pick(ROWS.bark) }], this.kit);
    this.built.push(crown, trunk);
    this.tree.add(trunk);
    this.crown.add(crown);
    this.crown.position.set(0, C.y, 0);
    this.tree.position.set(C.x, 0, C.z);
    this.crown.add(this.apple);
    this.apple.position.copy(this.appleAt);
    this.apple.rotation.set(0, 0, 0);
    this.apple.scale.setScalar(s);
    this.tree.scale.setScalar(1e-3);
    this.tree.visible = true;
    this.picked = false;
  }

  pre(t: number, dt: number, P: ActionPose, tempo: number, out: ChoreOut) {
    const T = this.times;
    const H = this.p.dims.height;
    const s = Math.sqrt(H);
    const slow = 1 / Math.sqrt(tempo);
    const at = (k: keyof typeof T) => T[k] * slow;
    const done = at('down') + CARRY_TIME;
    if (t > done + 0.4) return false;
    // side-on to the tree while picking (so the crown isn't over the face),
    // square again once the tree has gone and they set off
    P.spin = -0.85 * smooth(t / 0.4) * (1 - smooth((t - at('snap') - 0.2) / (at('down') - at('snap') - 0.2)));
    const pop = t < 0.4 ? grow(t / 0.4) : Math.max(1e-3, 1 - smooth((t - at('snap') - 0.25) / 0.35));
    this.tree.scale.setScalar(pop);
    this.tree.visible = pop > 2e-3;

    // the arm: up to the apple, a couple of tugs, then down to carry it
    let a: ArmAngles = REACH;
    let w = 1;
    let lift = 0;
    if (t < at('reach')) w = 0;
    else if (t < at('grab')) {
      const k = smooth((t - at('reach')) / (at('grab') - at('reach')));
      w = k;
      lift = TIPTOE * H * k;
    } else if (t < at('snap')) {
      lift = TIPTOE * H;
      const tug = Math.max(0, Math.sin(((t - at('tug')) / (at('snap') - at('tug'))) * Math.PI * 2)); // two tugs
      a = { ...REACH, x: REACH.x + 0.18 * tug, elbow: REACH.elbow + 0.25 * tug };
      if (Math.floor((t - at('tug')) * 4) !== Math.floor((t - dt - at('tug')) * 4) && t > at('tug')) out.events.push('rustle');
      this.crown.rotation.set(0.04 * tug, 0, 0.03 * Math.sin(t * 30) * tug);
    } else if (t < at('down')) {
      const k = smooth((t - at('snap')) / (at('down') - at('snap')));
      a = mixArm(REACH, APPLE_CARRY, k);
      lift = TIPTOE * H * (1 - k);
      this.crown.rotation.set(0.05 * Math.sin((t - at('snap')) * 18) * (1 - k), 0, 0); // springs back
    } else {
      // off they go with it (eating comes later)
      a = APPLE_CARRY;
      out.holdSpeed = false;
      if (t - dt < at('down')) out.depart = true;
      if (t > done) w = 1 - smooth((t - done) / 0.4);
    }
    setArm(P, 'R', a, w, 1.6);
    P.lift = lift;
    const up = t < at('snap') ? smooth((t - 0.2) / 0.5) : 1 - smooth((t - at('snap')) / 0.6);
    P.headX = -0.45 * up;
    P.spineX = -0.1 * up;

    if (!this.picked && t >= at('snap')) {
      this.picked = true;
      out.events.push('snap');
      this.p.root.updateMatrixWorld(true);
      out.bursts.push({ kind: 'leaves', at: this.apple.getWorldPosition(new THREE.Vector3()) });
      // into the hand
      const d = this.p.dims;
      this.p.joints.wristR.add(this.apple);
      this.apple.position.set(0, -d.handR * 1.5, d.handR * 0.6);
      this.apple.scale.setScalar(s);
    }
    if (t > done) this.apple.scale.setScalar(s * Math.max(1e-3, 1 - smooth((t - done) / 0.3)));
    // eyes on the apple until they're on their way
    if (t < at('down') + 0.8) out.focus = this.apple.getWorldPosition(new THREE.Vector3());
    return true;
  }

  post() {}

  hide() {
    this.tree.visible = false;
    if (this.apple.parent !== this.crown) this.crown.add(this.apple);
  }

  dispose() {
    this.hide();
    for (const m of this.built) disposeMesh(m);
    disposeMesh(this.apple);
    this.tree.removeFromParent();
  }
}

export function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry) {
  const ai = a.index ? a.toNonIndexed() : a;
  const bi = b.index ? b.toNonIndexed() : b;
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'aRow']) {
    const A = ai.getAttribute(name) as THREE.BufferAttribute;
    const B = bi.getAttribute(name) as THREE.BufferAttribute;
    const arr = new Float32Array(A.array.length + B.array.length);
    arr.set(A.array as Float32Array);
    arr.set(B.array as Float32Array, A.array.length);
    g.setAttribute(name, new THREE.BufferAttribute(arr, A.itemSize));
  }
  g.computeVertexNormals();
  return g;
}

// ================================================================ fishing

const ROD_HOLD: ArmAngles = { x: -0.72, z: 0.12, elbow: 0.95 };
const ROD_BACK: ArmAngles = { x: -2.7, z: 0.15, elbow: 0.55 };
const ROD_FLICK: ArmAngles = { x: -1.3, z: 0.12, elbow: 0.3 };
const ROD_STRIKE: ArmAngles = { x: -1.55, z: 0.12, elbow: 0.6 };
const ROD_LIFT: ArmAngles = { x: -1.75, z: 0.1, elbow: 1.35 }; // the catch held up to look at
const FISH_CARRY: ArmAngles = { x: -0.7, z: 0.16, elbow: 1.4 }; // both hands round the fish, in front
const ROD_ANGLE = 0.7; // rod tilt up from the forearm line (rad)
const G = 6; // gravity for the dangling end (lighter than real: slower, readable swings)
const lineMat = new THREE.LineBasicMaterial({ color: '#1a1410' });
const LINE_N = 18;

type EndMode = 'dangle' | 'fly' | 'float' | 'reel' | 'catch';

export class Fish implements Chore {
  private rod = new THREE.Group();
  private segs: THREE.Group[] = [];
  private tip = new THREE.Object3D();
  private line: THREE.Line;
  private bobber: THREE.Group;
  private fish: THREE.Group;
  private pool = new THREE.Group();
  private poolMeshes: THREE.Mesh[] = [];
  private ripples: { m: THREE.Mesh; age: number }[] = [];
  private bend = 0;
  private bendTarget = 0;
  // the line's end (hook / bobber / fish), in root space
  private end = new THREE.Vector3();
  private prevEnd = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private mode: EndMode = 'dangle';
  private len = 0.2; // free line length while dangling
  private flyT = 0;
  private flyDur = 0.7;
  private target = new THREE.Vector3(); // where the cast lands
  private bank = new THREE.Vector3(); // where the fish is lifted out
  private tipRoot = new THREE.Vector3();
  private sched = { back: 0.45, flick: 1.05, release: 1.2, settle: 2.0, bite: 5, reel: 5.3, out: 7.8, grab: 9.6, held: 10.1, done: 16 };
  private heldAt = new THREE.Matrix4(); // the fish between the hands, in the chest's frame
  private _m = new THREE.Matrix4();
  private _p = new THREE.Vector3();
  private _q = new THREE.Quaternion();
  private _s = new THREE.Vector3();
  private nibbles: number[] = [];
  private lastTick = 0;
  private bitten = false;
  private caught = false;
  private H = 1;
  /** Fishing real water (village): no conjured pool, and done once the fish is off the hook. */
  private world = false;

  /** Cast into real water on the next start (the person stands facing it, ~0.6 H from the edge). */
  aimWater(on: boolean) {
    this.world = on;
  }

  /** Where the caught fish is now (world): for handing it over when the chore ends. */
  catchPose() {
    this.p.root.updateMatrixWorld(true);
    return { pos: this.fish.getWorldPosition(new THREE.Vector3()), quat: this.fish.getWorldQuaternion(new THREE.Quaternion()) };
  }

  constructor(private p: Person, private kit: PropKit) {
    const s = Math.sqrt(p.dims.height);
    const len = 1.15; // rod length (× s)
    const segLen = len / 3;
    // three segments in a chain so the rod can bend: the butt, the middle, the tip
    let parent: THREE.Object3D = this.rod;
    for (let i = 0; i < 3; i++) {
      const seg = new THREE.Group();
      const r0 = 0.012 - i * 0.0035;
      const g = withRow(new THREE.CylinderGeometry(r0 - 0.0035, r0, segLen, 5).translate(0, segLen / 2, 0), i === 0 ? ROWS.shoes[0] : ROWS.shoes[2]);
      seg.add(simpleMesh(g, kit));
      if (i > 0) seg.position.y = segLen;
      parent.add(seg);
      this.segs.push(seg);
      parent = seg;
    }
    // butt: starts a little behind the fist; reel just in front of it
    this.segs[0].position.y = -0.08;
    const reel = withRow(new THREE.CylinderGeometry(0.022, 0.022, 0.016, 8).rotateZ(Math.PI / 2).translate(0, 0.02, 0.026), ROWS.shoes[3]);
    this.segs[0].add(simpleMesh(reel, kit));
    this.tip.position.y = segLen;
    this.segs[2].add(this.tip);
    // up the forearm line, tilted toward the hand's +z (up, when the forearm is level)
    this.rod.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI - ROD_ANGLE);
    this.rod.scale.setScalar(s);
    this.rod.position.y = -p.dims.handR * 0.6;
    this.rod.visible = false;
    p.joints.wristR.add(this.rod);

    this.line = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINE_N * 3), 3)), lineMat);
    this.line.frustumCulled = false;
    this.line.raycast = () => {};

    // a red-and-white float
    const br = 0.022;
    const topH = withRow(new THREE.SphereGeometry(br, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), ROWS.apple[1]);
    const botH = withRow(new THREE.SphereGeometry(br, 8, 4, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), ROWS.cloud[0]);
    this.bobber = new THREE.Group();
    this.bobber.add(simpleMesh(topH, kit), simpleMesh(botH, kit));
    this.bobber.scale.setScalar(s);

    // the catch: body, tail and fin, hung by the mouth (the origin), body along −z
    const body = withRow(new THREE.SphereGeometry(1, 8, 6), ROWS.fish[0]);
    body.scale(0.032, 0.045, 0.1).translate(0, 0, -0.1);
    const tail = withRow(new THREE.ConeGeometry(0.045, 0.06, 4).rotateX(Math.PI / 2).scale(0.3, 1, 1).translate(0, 0, -0.215), ROWS.fish[1]);
    const fin = withRow(new THREE.BoxGeometry(0.006, 0.03, 0.05).translate(0, 0.045, -0.1), ROWS.fish[2]);
    const fishInner = new THREE.Group();
    for (const g of [body, tail, fin]) fishInner.add(simpleMesh(g, kit));
    this.fish = new THREE.Group();
    this.fish.add(fishInner);
    this.fish.scale.setScalar(s);

    for (const o of [this.line, this.bobber, this.fish, this.pool]) {
      o.visible = false;
      p.root.add(o);
    }
  }

  /** A little conjured pool, so there's water to cast into (the real pond comes later). */
  private buildPool() {
    for (const m of this.poolMeshes) disposeMesh(m);
    this.poolMeshes = [];
    for (const r of this.ripples) disposeMesh(r.m);
    this.ripples = [];
    const H = this.H;
    const mid = this.target.clone().add(this.bank).multiplyScalar(0.5);
    const a = this.target.distanceTo(this.bank) / 2 + 0.38 * H; // along the cast
    const b = 0.55 * H;
    const harm = [2, 3, 5].map((k) => ({ k, amp: (0.12 / k) * (0.5 + Math.random()), ph: Math.random() * Math.PI * 2 }));
    const ring = (grow: number) => {
      const pts: THREE.Vector2[] = [];
      for (let i = 0; i < 22; i++) {
        const t = (i / 22) * Math.PI * 2;
        const f = 1 + harm.reduce((s, h) => s + h.amp * Math.sin(h.k * t + h.ph), 0);
        // (shape space y = −z after the rotation below)
        pts.push(new THREE.Vector2(Math.cos(t) * (b * f + grow), -(Math.sin(t) * (a * f + grow))));
      }
      return pts;
    };
    const layer = (outer: THREE.Vector2[], hole: THREE.Vector2[] | null, row: number) => {
      const shape = new THREE.Shape(outer);
      if (hole) shape.holes.push(new THREE.Path(hole));
      const g = withRow(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2), row);
      const m = new THREE.Mesh(g, this.kit.toon);
      m.renderOrder = 1;
      m.raycast = () => {};
      m.position.y = 0.004;
      this.pool.add(m);
      this.poolMeshes.push(m);
    };
    const edge = ring(0), deep = ring(-0.22 * H);
    layer(ring(0.06 * H), edge, ROWS.shore[0]);
    layer(edge, deep, ROWS.water[0]);
    layer(deep, null, ROWS.water[1]);
    this.pool.position.set(mid.x, 0, mid.z);
  }

  private ripple(at: THREE.Vector3, big = 1) {
    const mat = new THREE.MeshBasicMaterial({ color: '#e4f4ff', transparent: true, depthWrite: false });
    const m = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 18).rotateX(-Math.PI / 2), mat);
    m.position.set(at.x, 0.007, at.z);
    m.renderOrder = 2;
    m.raycast = () => {};
    m.userData.big = big;
    this.p.root.add(m);
    this.ripples.push({ m, age: 0 });
  }

  start() {
    const p = this.p;
    const H = (this.H = p.dims.height);
    const side = (Math.random() - 0.5) * 0.5 * H;
    this.target.set(side, 0, 1.85 * H);
    this.bank.set(side * 0.3, 0, 0.62 * H);
    if (!this.world) this.buildPool();
    const wait = 2.2 + Math.random() * 2.6;
    const S = this.sched;
    S.bite = S.settle + wait;
    S.reel = S.bite + 0.35;
    S.out = S.reel + 2.4;
    S.grab = S.out + 1.8;
    S.held = S.grab + 0.5;
    S.done = this.world ? S.held + 0.1 : S.held + CARRY_TIME;
    // where the fish sits once it's off the hook: between the hands of the
    // carrying pose, lying across the body
    const d = p.dims;
    const J = p.joints;
    const mid = withFK(p, { R: FISH_CARRY, L: FISH_CARRY }, () => {
      const hand = (w: THREE.Object3D) => J.spine.worldToLocal(w.localToWorld(new THREE.Vector3(0, -d.handR * 0.8, d.handR * 0.4)));
      return hand(J.wristL).add(hand(J.wristR)).multiplyScalar(0.5);
    });
    // (the mouth is the fish's origin and its body runs back along −z, here the
    // carrier's right: put the mouth by the left hand so the body spans the two)
    mid.x += 0.11 * Math.sqrt(H);
    this.heldAt.compose(mid, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)), new THREE.Vector3(1, 1, 1));
    this.nibbles = [S.settle + wait * (0.35 + 0.2 * Math.random()), S.settle + wait * (0.7 + 0.15 * Math.random())];
    this.mode = 'dangle';
    this.len = 0.22 * H;
    this.bitten = this.caught = false;
    this.bend = this.bendTarget = 0;
    this.rod.visible = this.line.visible = this.bobber.visible = true;
    this.pool.visible = !this.world;
    this.fish.visible = false;
    this.rod.scale.setScalar(1e-3);
    this.pool.scale.set(1e-3, 1, 1e-3);
    // start the float hanging under the (not yet posed) tip
    this.end.set(0.1 * H, 0.6 * H, 0.6 * H);
    this.prevEnd.copy(this.end);
  }

  pre(t: number, dt: number, P: ActionPose, _tempo: number, out: ChoreOut) {
    const S = this.sched;
    if (t > S.done + (this.world ? 0 : 0.4)) return false;
    const s = Math.sqrt(this.H);
    // rod and pool go once the fish is off the hook
    const pop = t < 0.35 ? grow(t / 0.35) : Math.max(1e-3, 1 - smooth((t - S.grab) / 0.3));
    this.rod.scale.setScalar(s * pop);
    this.pool.scale.set(pop, 1, pop);
    this.rod.visible = pop > 2e-3;
    this.pool.visible = pop > 2e-3 && !this.world;

    let a: ArmAngles = ROD_HOLD;
    let stiff = 1.2;
    let w = smooth(t / 0.35);
    P.spineX = 0.08;
    if (t < S.back) a = ROD_HOLD;
    else if (t < S.flick) {
      a = mixArm(ROD_HOLD, ROD_BACK, smooth((t - S.back) / (S.flick - S.back)));
      P.spineY = -0.3 * smooth((t - S.back) / 0.4);
      P.spineX = -0.06;
    } else if (t < S.settle) {
      const k = Math.min(1, (t - S.flick) / 0.16);
      a = t < S.flick + 0.16 ? mixArm(ROD_BACK, ROD_FLICK, k * k) : mixArm(ROD_FLICK, ROD_HOLD, smooth((t - S.flick - 0.16) / (S.settle - S.flick - 0.16)));
      stiff = 3;
      P.spineY = -0.3 * (1 - smooth(k));
      P.spineX = 0.08 + 0.12 * Math.sin(Math.PI * k);
      if (t - dt < S.flick && t >= S.flick) out.events.push('whoosh');
    } else if (t < S.bite) {
      a = ROD_HOLD;
      P.spineX = 0.14; // leaning in, watching the float
      P.headX = 0.12;
    } else if (t < S.reel) {
      a = mixArm(ROD_HOLD, ROD_STRIKE, smooth((t - S.bite) / 0.15));
      stiff = 3;
      P.spineX = -0.06;
    } else if (t < S.out) {
      a = ROD_STRIKE;
      P.spineX = -0.04 + 0.04 * Math.sin(t * 9);
      // the left hand winds the reel
      const ph = t * 14;
      setArm(P, 'L', { x: -0.95 + 0.14 * Math.sin(ph), z: -0.18, elbow: 1.55 + 0.22 * Math.cos(ph) }, 1, 2.5);
      if (t - this.lastTick > 0.09) {
        this.lastTick = t;
        out.events.push('tick');
      }
    } else if (t < S.grab) {
      a = mixArm(ROD_STRIKE, ROD_LIFT, smooth((t - S.out) / 0.6));
      P.spineX = -0.1;
      P.headZ = 0.14 * smooth((t - S.out - 0.6) / 0.5);
      if (t - dt < S.out + 0.9 && t >= S.out + 0.9) out.events.push('hey');
    } else if (t < S.held) {
      // take it off the line in both hands
      const k = smooth((t - S.grab) / (S.held - S.grab));
      a = mixArm(ROD_LIFT, FISH_CARRY, k);
      setArm(P, 'L', FISH_CARRY, k, 1.5);
      P.headX = 0.25 * k;
    } else {
      // and off they go with it (on real water, whoever sent them takes it from here)
      a = FISH_CARRY;
      out.holdSpeed = this.world;
      if (t - dt < S.held && !this.world) out.depart = true;
      const fade = t > S.done ? 1 - smooth((t - S.done) / 0.4) : 1;
      w = fade;
      setArm(P, 'L', FISH_CARRY, fade, 1.5);
      P.headX = 0.15 * (1 - smooth((t - S.held) / 1.2));
    }
    setArm(P, 'R', a, w, stiff);

    // rod bend: a whip on the cast, a deep bow while the fish fights
    this.bendTarget =
      t > S.flick && t < S.flick + 0.25 ? -0.25
      : this.mode === 'reel' ? 0.45 + 0.15 * Math.sin(t * 11)
      : this.mode === 'catch' ? 0.25
      : t > S.bite && t < S.reel ? 0.5
      : 0.04;

    // events on the timeline
    if (t - dt < S.release && t >= S.release) this.release();
    for (const n of this.nibbles) if (t - dt < n && t >= n) this.ripple(this.end, 0.6);
    if (!this.bitten && t >= S.bite) {
      this.bitten = true;
      out.events.push('plop');
      out.bursts.push({ kind: 'splash', at: this.p.root.localToWorld(this.end.clone()) });
      this.ripple(this.end);
    }
    if (this.mode === 'float' && t >= S.reel) this.mode = 'reel';
    if (this.mode === 'reel' && t >= S.out) {
      // up and out of the water, on the end of the line
      this.mode = 'catch';
      this.caught = true;
      this.fish.visible = true;
      this.vel.set(0, 2.2, -1.0);
      this.prevEnd.copy(this.end).addScaledVector(this.vel, -dt);
      this.len = this.tipRoot.distanceTo(this.end);
      out.events.push('splash');
      out.bursts.push({ kind: 'splash', at: this.p.root.localToWorld(this.end.clone()) });
      this.ripple(this.end, 1.4);
    }
    // the eyes follow the float, then the fish (until they're walking off with it)
    if (t < S.held + 0.8) out.focus = this.fish.visible ? this.fish.getWorldPosition(new THREE.Vector3()) : this.p.root.localToWorld(this.end.clone());
    return true;
  }

  private release() {
    // ballistic from the tip to the landing spot, timed to arrive in flyDur
    this.mode = 'fly';
    this.flyT = 0;
    const from = this.end;
    const T = this.flyDur;
    this.vel.set((this.target.x - from.x) / T, (this.target.y - from.y) / T + 0.5 * G * T, (this.target.z - from.z) / T);
  }

  post(t: number, dt: number, out: ChoreOut) {
    const p = this.p;
    const S = this.sched;
    const H = this.H;
    // bend the rod first: the tip moves with it
    this.bend += (this.bendTarget - this.bend) * (1 - Math.exp(-dt * 10));
    this.segs[1].rotation.x = this.bend * 0.35;
    this.segs[2].rotation.x = this.bend * 0.65;
    p.root.updateMatrixWorld(true);
    inRoot(p, this.tip, _v.set(0, 0, 0), this.tipRoot);
    const tip = this.tipRoot;

    switch (this.mode) {
      case 'dangle':
      case 'catch': {
        // a weight on a string: Verlet, then keep it within the line's length
        if (this.mode === 'catch') this.len = Math.max(0.24 * H, this.len - dt * 1.4 * H);
        const v = _v.subVectors(this.end, this.prevEnd).multiplyScalar(0.985);
        this.prevEnd.copy(this.end);
        this.end.add(v).y -= G * dt * dt;
        const d = _w.subVectors(this.end, tip);
        if (d.length() > this.len) this.end.copy(tip).addScaledVector(d.normalize(), this.len);
        if (this.end.y < 0.02) this.end.y = 0.02;
        break;
      }
      case 'fly': {
        this.flyT += dt;
        this.vel.y -= G * dt;
        this.end.addScaledVector(this.vel, dt);
        if (this.flyT >= this.flyDur || this.end.y <= 0) {
          this.end.copy(this.target);
          this.mode = 'float';
          out.events.push('plop');
          out.bursts.push({ kind: 'splash', at: p.root.localToWorld(this.end.clone()) });
          this.ripple(this.end);
        }
        break;
      }
      case 'float': {
        // bobbing; a quick dip on each nibble; pulled under on the bite
        let y = 0.006 + 0.004 * Math.sin(t * 3.1);
        for (const n of this.nibbles) if (t > n && t < n + 0.18) y -= 0.012 * Math.sin(((t - n) / 0.18) * Math.PI);
        if (t > S.bite) y = -0.03;
        this.end.set(this.target.x, y, this.target.z);
        break;
      }
      case 'reel': {
        // dragged in across the pool, zigzagging as it fights
        const k = smooth((t - S.reel) / (S.out - S.reel));
        this.end.lerpVectors(this.target, this.bank, k);
        const across = _v.subVectors(this.bank, this.target).normalize();
        this.end.x += -across.z * Math.sin(t * 5.5) * 0.14 * H * (1 - k * 0.6);
        this.end.z += across.x * Math.sin(t * 5.5) * 0.14 * H * (1 - k * 0.6);
        this.end.y = -0.004;
        if (Math.floor(t * 3) !== Math.floor((t - dt) * 3)) {
          out.bursts.push({ kind: 'splash', at: p.root.localToWorld(this.end.clone()) });
          this.ripple(this.end, 0.7);
          if (Math.random() < 0.5) out.events.push('splash');
        }
        break;
      }
    }

    // the line: a sagging curve while slack, straight when taut
    const slack = this.mode === 'float' && t < S.bite ? 0.12 : this.mode === 'fly' ? 0.04 : 0;
    const dist = tip.distanceTo(this.end);
    const arr = (this.line.geometry.getAttribute('position') as THREE.BufferAttribute);
    for (let i = 0; i < LINE_N; i++) {
      const u = i / (LINE_N - 1);
      _v.lerpVectors(tip, this.end, u);
      _v.y -= slack * dist * 4 * u * (1 - u);
      arr.setXYZ(i, _v.x, Math.max(0.006, _v.y), _v.z);
    }
    arr.needsUpdate = true;

    // the float sits on the end of the line, or a little up it once there's a fish
    if (this.caught) {
      this.bobber.position.copy(this.end).addScaledVector(_v.subVectors(tip, this.end).normalize(), 0.1 * H);
      // the fish hangs from the line, wriggling
      this.fish.position.copy(this.end);
      this.fish.quaternion.setFromUnitVectors(_w.set(0, 0, 1), _v.subVectors(tip, this.end).normalize());
      this.fish.children[0].rotation.y = 0.5 * Math.sin(t * 17) * Math.max(0.3, 1 - (t - S.out) / 2.5);
      if (t > S.grab) {
        // from the line into the hands, then carried there (it flops now and then)
        const k = smooth((t - S.grab) / (S.held - S.grab));
        this._m.copy(p.root.matrixWorld).invert().multiply(p.joints.spine.matrixWorld).multiply(this.heldAt);
        this._m.decompose(this._p, this._q, this._s);
        this.fish.position.lerp(this._p, k);
        this.fish.quaternion.slerp(this._q, k);
        const flop = Math.max(0, Math.sin(t * 1.7)) ** 6;
        this.fish.children[0].rotation.y = lerp(this.fish.children[0].rotation.y, 0.35 * Math.sin(t * 16) * flop, k);
      }
    } else {
      this.bobber.position.copy(this.end);
      if (this.mode === 'float' || this.mode === 'reel') this.bobber.position.y = Math.max(this.bobber.position.y, -0.012);
    }
    this.bobber.quaternion.identity();
    if (this.mode === 'reel') {
      // just under the surface: a fin cutting the water
      this.fish.visible = true;
      this.fish.position.set(this.end.x, -0.03 * Math.sqrt(H), this.end.z);
      this.fish.quaternion.setFromUnitVectors(_w.set(0, 0, 1), _v.subVectors(this.bank, this.target).normalize());
      this.fish.children[0].rotation.y = 0.45 * Math.sin(t * 16);
    }
    const pop = t > S.done ? Math.max(1e-3, 1 - smooth((t - S.done) / 0.35)) : 1;
    this.fish.scale.setScalar(Math.sqrt(H) * pop);
    this.bobber.scale.setScalar(Math.sqrt(H));
    // the line and float go with the rod
    this.line.visible = this.bobber.visible = t < S.grab + 0.15;

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += dt;
      const k = r.age / 1.1;
      r.m.scale.setScalar((0.02 + 0.16 * k) * H * r.m.userData.big);
      (r.m.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k);
      if (k >= 1) {
        disposeMesh(r.m);
        (r.m.material as THREE.Material).dispose();
        this.ripples.splice(i, 1);
      }
    }
  }

  hide() {
    for (const o of [this.rod, this.line, this.bobber, this.fish, this.pool]) o.visible = false;
    for (const r of this.ripples) {
      disposeMesh(r.m);
      (r.m.material as THREE.Material).dispose();
    }
    this.ripples = [];
  }

  dispose() {
    this.hide();
    for (const m of this.poolMeshes) disposeMesh(m);
    for (const o of [this.rod, this.line, this.bobber, this.fish, this.pool]) {
      o.traverse((c) => (c as THREE.Mesh).geometry?.dispose());
      o.removeFromParent();
    }
  }
}
