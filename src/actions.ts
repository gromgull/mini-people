import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { JOINTS, type JointName, type Person, withRow } from './body';
import type { Motion } from './gait';
import type { Style } from './persona';
import { ROWS } from './palette';
import { Ragdoll } from './ragdoll';
import { twoBoneIK } from './ik';
import { type ActionPose, type PropKit, arm, envelope, lerp, mesh, smooth } from './actionkit';
import { type ActEvent, type BurstKind, Chop, type Chore, Fish, PickApple } from './chores';
import { type DineAsk, Dine } from './dine';
import { Haul, type LogSpot } from './haul';
import { Banjo } from './banjo';
import { Armful, type ItemPose } from './armful';
import { Hold, type HoldPlan } from './hold';
import type { PineSpec } from './trees';
import { FORM_SLOTS, PHRASE_SLOTS, degToHz, joinBand, leaveBand, tune } from './tune';

const isDine = (k: string): k is DineAsk => k === 'dine' || k === 'eat' || k === 'drink';

export const ACTIONS = ['wave', 'hammer', 'jump', 'fall', 'carry', 'sit', 'talk', 'saw', 'fiddle', 'dance', 'chop', 'pick', 'fish', 'dine', 'eat', 'drink', 'haul', 'banjo', 'armful', 'hold'] as const;
export type ActionKind = (typeof ACTIONS)[number];
export type { ActionPose, ArmOverride, PropKit } from './actionkit';

const JUMP_G = 14;

export const BPM = 112; // shared tempo for music and dancing
const SAW_CROUCH = 0.1;
const SAW_STROKE = 0.22; // half-stroke, × arm length
const _target = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _z = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _qU = new THREE.Quaternion();
const _qM = new THREE.Quaternion();
const BOW_LEN = 0.36;
const mergeAll = (g: THREE.BufferGeometry[]) => {
  const out = mergeGeometries(g)!;
  g.forEach((x) => x.dispose());
  return out;
};
const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _scl = new THREE.Vector3();

// ---------------------------------------------------------------- props

let hammerGeo: { handle: THREE.BufferGeometry; head: THREE.BufferGeometry; rock: THREE.BufferGeometry } | null = null;
function geos() {
  if (hammerGeo) return hammerGeo;
  const handle = withRow(new THREE.CylinderGeometry(0.011, 0.013, 0.24, 6), ROWS.shoes[2]);
  handle.rotateX(Math.PI / 2);
  handle.translate(0, 0, 0.1);
  const head = withRow(new THREE.BoxGeometry(0.045, 0.11, 0.05), ROWS.shoes[3]);
  head.translate(0, 0, 0.22);
  const rock = withRow(new THREE.DodecahedronGeometry(0.1, 0), ROWS.hair[5]);
  rock.scale(1.2, 0.7, 1);
  rock.translate(0, 0.06, 0);
  hammerGeo = { handle, head, rock };
  return hammerGeo;
}

let boxGeos: { box: THREE.BufferGeometry; tape: THREE.BufferGeometry; slab: THREE.BufferGeometry; leg: THREE.BufferGeometry } | null = null;
/** Unit-sized props, scaled per person: a cardboard box and a little bench. */
function boxGeo() {
  if (boxGeos) return boxGeos;
  const box = withRow(new THREE.BoxGeometry(1, 1, 1), ROWS.pants[6]);
  const tape = withRow(new THREE.BoxGeometry(0.22, 1.02, 1.02), ROWS.pants[3]);
  const slab = withRow(new THREE.BoxGeometry(1, 0.16, 1), ROWS.shoes[2]);
  slab.translate(0, 0.92, 0);
  const leg = withRow(new THREE.BoxGeometry(0.12, 0.86, 0.8), ROWS.shoes[0]);
  leg.translate(0, 0.43, 0);
  boxGeos = { box, tape, slab, leg };
  return boxGeos;
}

let sawGeos: { handle: THREE.BufferGeometry; blade: THREE.BufferGeometry; log: THREE.BufferGeometry; end: THREE.BufferGeometry; trestle: THREE.BufferGeometry } | null = null;
function sawGeo() {
  if (sawGeos) return sawGeos;
  // saw: handle in the fist, blade continuing down the forearm line (hand -Y),
  // flat in the hand's y-z plane so strokes slide along it
  const handle = withRow(new THREE.BoxGeometry(0.03, 0.06, 0.05), ROWS.shoes[2]);
  handle.translate(0, -0.01, 0);
  const blade = withRow(new THREE.BoxGeometry(0.005, 0.3, 0.06), ROWS.shoes[3]);
  blade.translate(0, -0.18, 0.012);
  // half a log (unit length along +x from the cut, radius 1), bark + pale end
  const log = withRow(new THREE.CylinderGeometry(1, 1, 1, 9), ROWS.bark[0]);
  log.rotateZ(Math.PI / 2);
  log.translate(0.5, 0, 0);
  const end = withRow(new THREE.CircleGeometry(0.86, 9), ROWS.pants[6]);
  end.rotateY(-Math.PI / 2);
  end.translate(-0.002, 0, 0);
  const trestle = withRow(new THREE.BoxGeometry(1, 1, 1), ROWS.shoes[2]);
  trestle.translate(0, 0.5, 0);
  sawGeos = { handle, blade, log, end, trestle };
  return sawGeos;
}

// ---------------------------------------------------------------- actor

/** Stand-in for a saw in the fist (see Actor.sawFit); one shared node, so measuring creates nothing. */
const _sawHand = new THREE.Object3D();

/**
 * Runs one action at a time for a person. `pre()` runs before the animator
 * and returns overrides that get springed like everything else (so personality
 * flavours every action); `post()` runs after it for things that replace the
 * pose outright (ragdoll, getting up).
 */
export class Actor {
  kind: ActionKind | null = null;
  t = 0;
  holdSpeed = false; // stop walking for this action
  rootLocked = false; // the action owns the root transform
  impact = false; // set on the frame a hammer blow lands
  hammerHead: THREE.Object3D | null = null;

  private pose: ActionPose = { crouch: 0, sitZ: 0, lift: 0, spineY: 0, spineZ: 0, spin: 0, fwd: 0, spineX: 0, headX: 0, headY: 0, headZ: 0, arms: { L: arm(), R: arm() } };
  private side: 'L' | 'R' = 'R';
  private push = new THREE.Vector3();
  private stopNow = false;
  private ragdoll: Ragdoll | null = null;
  private getup: { t: number; dur: number; q: Map<JointName, THREE.Quaternion>; pelvis: THREE.Vector3 } | null = null;
  private hammer: THREE.Object3D | null = null;
  private rock: THREE.Object3D | null = null;
  private lastU = 0;
  private tempo = 1;
  private box: THREE.Object3D | null = null;
  private boxHeld = new THREE.Matrix4(); // box pose in spine space while carried
  private boxGround = new THREE.Vector3(); // where it sits on the ground (root space)
  private bench: THREE.Object3D | null = null;
  private seat = { h: 0, z: 0, crouch: 0 };
  private benchScale = new THREE.Vector3();
  /** Talking: who to face (index into the crowd), set by the caller. */
  partner = -1;
  dust = false; // set on frames where a saw stroke throws sawdust
  /** Sound cues raised this frame (consumed by the audio layer). */
  events: ActEvent[] = [];
  /** Particle bursts raised this frame (world positions). */
  bursts: { kind: BurstKind; at: THREE.Vector3 }[] = [];
  /** Where this action wants the eyes, in world space (null = let the gaze pick). */
  focus: THREE.Vector3 | null = null;
  /** Set for one frame when the action wants them to walk off somewhere. */
  depart = false;
  /** Mouth open this frame (biting, chewing). */
  mouthOpen = false;
  private chore: Chore | null = null;
  private chores: Partial<Record<ActionKind, Chore>> = {};
  /** Shared beat clock (beats since start), set by the caller every frame. */
  beatTime = 0;
  /** A banjo string plucked this frame: frequency (Hz). */
  pluck: { f: number } | null = null;
  /** A fiddle note that starts this frame: frequency (Hz) and length (s). */
  note: { f: number; dur: number } | null = null;
  /** Which part of the tune this fiddler plays (0 melody, 1 harmony, 2 bass), −1 = not playing. */
  fiddleVoice = -1;
  private fiddleDur = 10;
  private bow = { dir: 1, start: 0, len: 0.25, lastSlot: -1 };
  private bowStroke = 0; // −1 … 1 along the bow
  private bowWeight = 0;
  private fiddle: THREE.Object3D | null = null;
  private bowMesh: THREE.Object3D | null = null;
  private dance = { move: 0, lastBar: -1, lastBeat: -1 };
  beat = false; // a talk gesture beat started this frame
  sawSpeed = 0; // 0…1 stroke speed while sawing
  sawPush = false;
  private prevT = 0;
  private crossed(at: number) {
    return this.prevT < at && this.t >= at;
  }
  sawTip: THREE.Object3D | null = null;
  private saw: THREE.Object3D | null = null;
  private logSet: THREE.Object3D | null = null;
  private logHalves: THREE.Object3D[] = [];
  private beats = { next: 0, L: { x: -0.5, z: 0.2, elbow: 1.2, w: 1 }, R: { x: -0.5, z: 0.2, elbow: 1.2, w: 1 }, head: 0, headUntil: 0, dur: 5 };
  private lastStroke = 0;

  constructor(private p: Person, private kit: PropKit) {}

  get busy() {
    return this.kind !== null;
  }

  /** Sawing a real log on a real sawhorse (village): its size; no conjured trestles. */
  private sawLog: { r: number; len: number; y?: number } | null = null;
  private sawExtra = 0;
  private phrases: number | undefined;

  /** This person's chore of a kind (made on first use): for fitting props before starting it. */
  choreOf(kind: 'chop'): Chop;
  choreOf(kind: 'haul'): Haul;
  choreOf(kind: 'banjo'): Banjo;
  choreOf(kind: 'armful'): Armful;
  choreOf(kind: 'fish'): Fish;
  choreOf(kind: 'pick'): PickApple;
  choreOf(kind: 'hold'): Hold;
  choreOf(kind: 'dine'): Dine;
  choreOf(kind: 'chop' | 'haul' | 'banjo' | 'armful' | 'fish' | 'pick' | 'hold' | 'dine'): Chore {
    const C = { chop: Chop, haul: Haul, banjo: Banjo, armful: Armful, fish: Fish, pick: PickApple, hold: Hold, dine: Dine }[kind];
    return (this.chores[kind] ??= new C(this.p, this.kit));
  }

  start(
    kind: ActionKind,
    opts: {
      push?: THREE.Vector3;
      side?: 'L' | 'R';
      /** Sawing: a real log's size (no conjured trestles). */
      sawLog?: { r: number; len: number; y?: number };
      /** Chopping: a real tree's shape (stands where it is; no conjured tree). */
      tree?: PineSpec;
      /** Picking: a real apple, where it hangs (world); no conjured tree; ends once it's in the hand. */
      apple?: THREE.Vector3;
      /** Picking: climb onto this first (its height, how far ahead it stands). */
      standOn?: { h: number; fwd: number };
      /** Fishing: real water ahead (no conjured pool; ends once the fish is off the hook). */
      water?: boolean;
      /** Hauling: a real log's mesh, where it lies, its radius. */
      log?: { mesh: THREE.Object3D; from: LogSpot; r: number };
      /** Dining: at a real table (built from this person's worldFurniture()), staying till told to leave. */
      atTable?: boolean | { top: number; edge: number; h: number };
      /** Hold: where the hands go each frame. */
      hold?: HoldPlan;
      /** Armful: the things to gather (their meshes) and where each lies. */
      items?: { meshes: THREE.Object3D[]; from: ItemPose[] };
      /** Music: how many phrases to play (default: to the end of the next full one). */
      phrases?: number;
      /** Sit down for it (on a conjured seat) and get up after. */
      seated?: boolean;
    } = {},
  ) {
    if (this.kind === 'fall') return; // let them finish falling/getting up
    // already at the table: have that next instead of getting up and sitting down again
    if (isDine(kind) && this.kind && isDine(this.kind) && (this.chore as Dine).want(kind)) return;
    this.stop();
    this.kind = kind;
    this.t = 0;
    this.side = opts.side ?? (Math.random() < 0.7 ? 'R' : 'L');
    this.push.copy(opts.push ?? new THREE.Vector3());
    this.holdSpeed = kind !== 'wave' && kind !== 'jump';
    this.stopNow = kind === 'fall';
    this.sawLog = opts.sawLog ?? null;
    this.phrases = opts.phrases;
    if (kind === 'fall') this.dropSeat(); // no staying seated through that
    if (opts.seated && kind !== 'fall') {
      this.sitDown({ conjure: true });
      this.posture.autoUp = true;
    }
    this.lastU = 0;
    this.lastStroke = -1;
    if (kind === 'hammer') this.showHammer(true);
    if (kind === 'carry') this.makeBox();
    if (kind === 'sit') this.makeBench();
    if (kind === 'talk') {
      this.beats.next = 0;
      this.beats.headUntil = 0;
      this.beats.dur = 4 + Math.random() * 3;
    }
    if (kind === 'saw') this.makeSaw();
    if (kind === 'fiddle') this.makeFiddle();
    if (kind === 'chop' || kind === 'pick' || kind === 'fish') {
      const C = kind === 'chop' ? Chop : kind === 'pick' ? PickApple : Fish;
      this.chore = this.chores[kind] ??= new C(this.p, this.kit);
      if (kind === 'chop') (this.chore as Chop).aim(opts.tree ?? null);
      if (kind === 'fish') (this.chore as Fish).aimWater(!!opts.water);
      if (kind === 'pick') (this.chore as PickApple).aimAt(opts.apple ?? null, opts.standOn ?? null);
      this.chore.start();
    }
    if (kind === 'banjo') {
      const b = this.choreOf('banjo');
      b.plan(this.beatTime, this.playLength(0.6, this.phrases));
      this.chore = b;
      b.start();
    }
    if (kind === 'hold') {
      const h = this.choreOf('hold');
      if (opts.hold) h.aim(opts.hold);
      this.chore = h;
      h.start();
    }
    if (kind === 'armful') {
      const a = this.choreOf('armful');
      a.aim(opts.items?.meshes ?? [], opts.items?.from ?? []);
      this.chore = a;
      a.start();
    }
    if (kind === 'haul') {
      const h = this.choreOf('haul');
      if (opts.log) h.aim(opts.log.mesh, opts.log.from, opts.log.r);
      this.chore = h;
      h.start();
    }
    if (isDine(kind)) {
      // one table for all three: it's the same sitting down, just a different meal
      const d = (this.chores.dine ??= new Dine(this.p, this.kit)) as Dine;
      d.plan(kind, { world: !!opts.atTable, table: typeof opts.atTable === 'object' ? opts.atTable : null });
      this.chore = d;
      d.start();
    }
    if (kind === 'dance') {
      this.dance.lastBar = -1;
      this.dance.lastBeat = -1;
      this.beats.dur = 9 + Math.random() * 5; // (reuses the talk duration slot)
    }
  }

  stop() {
    this.showHammer(false);
    this.chore?.hide();
    this.chore = null;
    this.focus = null;
    if (this.box) this.box.visible = false;
    if (this.bench) this.bench.visible = false;
    if (this.saw) {
      this.saw.visible = false;
      this.saw.rotation.x = 0;
    }
    if (this.logSet) this.logSet.visible = false;
    if (this.fiddle) this.fiddle.visible = false;
    if (this.bowMesh) this.bowMesh.visible = false;
    leaveBand(this.fiddleVoice);
    this.fiddleVoice = -1;
    this.partner = -1;
    this.kind = null;
    this.ragdoll = null;
    this.getup = null;
    this.holdSpeed = false;
    this.rootLocked = false;
  }

  dispose() {
    this.stop();
    this.hammer?.removeFromParent();
    this.rock?.removeFromParent();
    this.box?.removeFromParent();
    this.bench?.removeFromParent();
    this.saw?.removeFromParent();
    this.logSet?.removeFromParent();
    this.fiddle?.removeFromParent();
    this.bowMesh?.removeFromParent();
    for (const c of Object.values(this.chores)) c.dispose();
  }

  /** A fiddle (placed every frame between chin and left hand), a bow in the right hand, and a tune. */
  private makeFiddle() {
    const p = this.p;
    const s = Math.sqrt(p.dims.height);
    if (!this.fiddle) {
      const wood = ROWS.shoes[2];
      const dark = ROWS.shoes[1];
      // body: two overlapping flattened balls (an hourglass), neck + scroll toward +z
      const lower = withRow(new THREE.SphereGeometry(0.06, 10, 6), wood);
      lower.scale(1, 0.38, 1.1);
      const upper = withRow(new THREE.SphereGeometry(0.048, 10, 6), wood);
      upper.scale(1, 0.38, 1.1);
      upper.translate(0, 0, 0.075);
      const neck = withRow(new THREE.BoxGeometry(0.016, 0.014, 0.11), dark);
      neck.translate(0, 0.012, 0.16);
      const scroll = withRow(new THREE.SphereGeometry(0.014, 6, 4), dark);
      scroll.translate(0, 0.012, 0.22);
      const geo = mergeAll([lower, upper, neck, scroll]);
      this.fiddle = new THREE.Group();
      const body = mesh(geo, this.kit);
      this.fiddle.add(body);
      this.fiddle.scale.setScalar(s * 1.6);
      p.root.add(this.fiddle);
      // bow: a long thin stick held across the hand
      // bow: frog at the origin, stick along +x
      const stick = withRow(new THREE.CylinderGeometry(0.004, 0.004, BOW_LEN, 4), dark);
      stick.rotateZ(Math.PI / 2);
      stick.translate(BOW_LEN / 2, 0.01, 0);
      const hair = withRow(new THREE.BoxGeometry(BOW_LEN * 0.9, 0.003, 0.008), ROWS.cloud[0]);
      hair.translate(BOW_LEN / 2, 0, 0);
      const frog = withRow(new THREE.BoxGeometry(0.02, 0.022, 0.012), dark);
      this.bowMesh = new THREE.Group();
      this.bowMesh.add(mesh(mergeAll([stick, hair, frog]), this.kit));
      this.bowMesh.scale.setScalar(s);
      p.root.add(this.bowMesh); // placed across the strings every frame; the arm follows it
    }
    this.fiddle.visible = this.bowMesh!.visible = true;
    // join the band: take a free part of the shared tune, and play to the end
    // of the next full phrase so we stop on a cadence, not mid-line
    this.fiddleVoice = joinBand('fiddle');
    this.fiddleDur = this.playLength(0.5, this.phrases); // (0.5 s getting the fiddle up)
    this.bow.lastSlot = -1;
  }

  /**
   * The bow crosses the strings just above the fiddle body, square to the
   * neck, and slides along its own length; the right arm is then solved
   * (two-bone IK in the chest's frame) so the hand holds the frog.
   */
  private placeBow() {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    const f = this.fiddle!;
    const bow = this.bowMesh!;
    f.updateMatrix();
    // contact point (between bridge and fingerboard) and "across the strings"
    const contact = _a.set(0, 0.03, 0.06).applyMatrix4(f.matrix);
    const across = _c.set(1, 0, 0).transformDirection(f.matrix);
    if (across.x < 0) across.negate(); // the frog end is on the player's right (−x)
    const len = BOW_LEN * Math.sqrt(d.height);
    const along = 0.5 + 0.38 * this.bowStroke; // where on the bow the strings are
    const frogPos = _b.copy(contact).addScaledVector(across, -along * len);
    bow.position.copy(frogPos);
    bow.quaternion.setFromUnitVectors(_z.set(1, 0, 0), across);
    bow.visible = true;

    // right arm: wrist to the frog, elbow out and down
    p.root.updateMatrixWorld(true);
    const wristTarget = J.spine.worldToLocal(p.root.localToWorld(frogPos.clone()));
    wristTarget.y += d.handR * 0.4;
    twoBoneIK(J.shoulderR.position, wristTarget, _pole.set(-1, -0.7, -0.4), d.upperArmLen, d.foreArmLen, _qU, _qM);
    const w = this.bowWeight;
    J.shoulderR.quaternion.slerp(_qU, w);
    J.elbowR.quaternion.slerp(_qM, w);
  }

  /** Put the fiddle between the chin and the left hand (after posing). */
  private placeFiddle() {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    p.root.updateMatrixWorld(true);
    const chin = p.root.worldToLocal(J.head.localToWorld(_a.set(d.headR * 0.35, d.headR * 0.1, d.headR * 0.35)));
    const hand = p.root.worldToLocal(J.wristL.localToWorld(_b.set(0, -d.handR * 0.6, 0)));
    const dir = _c.subVectors(hand, chin).normalize();
    this.fiddle!.position.copy(chin).addScaledVector(dir, -0.02);
    // neck along chin→hand; top face roughly up and a little toward the player
    this.fiddle!.quaternion.setFromUnitVectors(_z.set(0, 0, 1), dir);
    this.fiddle!.rotateZ(0.12); // a slight tilt; more would stand the bow up steeply
  }

  /** Saw in the right hand; log on a sawhorse where the blade meets it. */
  private makeSaw() {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    const s = Math.sqrt(d.height);
    const g = sawGeo();
    if (!this.saw) {
      this.saw = new THREE.Group();
      this.saw.add(mesh(g.handle, this.kit), mesh(g.blade, this.kit));
      this.sawTip = new THREE.Object3D();
      this.sawTip.position.set(0, -0.2, 0.04);
      this.saw.add(this.sawTip);
      this.saw.scale.setScalar(s);
      this.saw.position.y = -d.handR * 0.7;
      J.wristR.add(this.saw);
      this.logSet = new THREE.Group();
      this.logHalves = [1, -1].map((side) => {
        const h = new THREE.Group();
        h.add(mesh(g.log, this.kit), mesh(g.end, this.kit));
        h.scale.x = side; // mirrored half
        this.logSet!.add(h);
        return h;
      });
      for (const x of [-1, 1]) {
        const t = mesh(g.trestle, this.kit);
        t.userData.side = x;
        this.logSet.add(t);
      }
      p.root.add(this.logSet);
    }
    this.saw.visible = true;

    const { cut, r, len, y: ownY, trestles } = this.sawFit(this.sawLog ?? undefined);
    // a real log at its own height: crouch the difference, so the blade meets it there
    const y = this.sawLog?.y ?? ownY;
    this.sawExtra = this.sawLog?.y !== undefined ? THREE.MathUtils.clamp((ownY - y) / p.dims.legLen, -0.06, 0.3) : 0;
    this.logSet!.position.set(cut.x, 0, cut.z);
    this.logHalves.forEach((h, i) => {
      h.position.set(0, y, 0);
      h.rotation.set(0, 0, 0);
      // the cut sits near the right-hand end; the long piece runs under the left hand
      h.scale.set(i === 0 ? len * 1.45 : -len * 0.6, r, r);
    });
    this.logSet!.children.forEach((c) => {
      if (c.userData.side === undefined) return;
      const tr = trestles[c.userData.side > 0 ? 0 : 1];
      c.position.set(tr.x, 0, 0);
      c.scale.set(0.025 * s, tr.h, r * 2.6);
      // (a sawhorse that's really there replaces the conjured trestles)
      c.visible = tr.show && !this.sawLog;
    });
    this.logSet!.visible = true;
  }

  /**
   * Where this person's saw cuts, in their root frame, and the log and
   * trestles that fit it: the blade's mid-stroke point (plain FK of the
   * stroke pose, minus the crouch), a log centred just under it, trestles
   * either side. `log` overrides the log's radius and half-length (a real
   * log off the pile instead of a conjured one).
   */
  sawFit(log?: { r: number; len: number }) {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    const s = Math.sqrt(d.height);
    // a stand-in for the saw in the fist, to read the blade point through
    const hand = _sawHand;
    hand.position.y = -d.handR * 0.7;
    hand.scale.setScalar(s);
    J.wristR.add(hand);
    const joints = [J.spine, J.shoulderR, J.elbowR];
    const saved = joints.map((j) => j.quaternion.clone());
    const mid = this.sawStroke(0.5);
    J.spine.rotation.set(0.45, 0, 0);
    J.shoulderR.rotation.set(mid.x, 0, -mid.z, 'ZYX');
    J.elbowR.rotation.set(-mid.elbow, 0, 0);
    p.root.updateMatrixWorld(true);
    const cut = p.root.worldToLocal(hand.localToWorld(new THREE.Vector3(0, -0.2, 0.012)));
    joints.forEach((j, i) => j.quaternion.copy(saved[i]));
    hand.removeFromParent();
    p.root.updateMatrixWorld(true);
    cut.y -= SAW_CROUCH * d.legLen; // the crouch lowers everything

    const r = log?.r ?? 0.055 * s;
    const len = log?.len ?? 0.24 * s; // per half
    const y = Math.max(r, cut.y - r * 0.1); // blade runs through the log, not over it
    const h = Math.max(0.001, y - r * 0.6);
    const trestles = [len * 1.15, -len * 0.4].map((x) => ({ x, h, show: y > r * 1.5 }));
    return { cut, r, len, y, trestles };
  }

  /** Arm angles for a saw stroke, u = 0 (pulled back) … 1 (pushed through). */
  private sawStroke(u: number) {
    // The hand slides in a straight line along the blade (= the mid-stroke
    // forearm direction), solved as a planar two-bone chain in the spine's
    // sagittal plane. Angles: θ = shoulder pitch forward from hanging, e = elbow.
    const d = this.p.dims;
    const a = d.upperArmLen;
    const b = d.foreArmLen + d.handR * 0.7;
    const th0 = 0.3;
    const e0 = 1.25;
    const dir = th0 + e0; // blade / stroke direction, from "down"
    const f0 = a * Math.sin(th0) + b * Math.sin(dir);
    const h0 = a * Math.cos(th0) + b * Math.cos(dir);
    const k = (u - 0.5) * 2 * SAW_STROKE * (a + b);
    const f = f0 + k * Math.sin(dir);
    const h = h0 + k * Math.cos(dir);
    const D = Math.min(Math.hypot(f, h), (a + b) * 0.985);
    const e = Math.PI - Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - D * D) / (2 * a * b))));
    const th = Math.atan2(f, h) - Math.atan2(b * Math.sin(e), a + b * Math.cos(e));
    return { x: -th, z: 0.05, elbow: e, blade: dir };
  }

  /** The carry pose's arm angles (shared by the FK fit and the animation). */
  private carryArms() {
    const d = this.p.dims;
    return { x: -0.7, z: d.armOut * 0.6 + 0.02, elbow: 1.1 };
  }

  /**
   * Size a box to fit between the hands: pose the carry arms with plain FK,
   * read the hands in spine space, then restore the pose.
   */
  private makeBox() {
    const p = this.p;
    const J = p.joints;
    const d = p.dims;
    if (!this.box) {
      const g = boxGeo();
      this.box = new THREE.Group();
      this.box.add(mesh(g.box, this.kit), new THREE.Mesh(g.tape, this.kit.toon)); // tape: no outline of its own
      p.root.add(this.box);
    }
    const joints = [J.spine, J.shoulderL, J.shoulderR, J.elbowL, J.elbowR];
    const saved = joints.map((j) => j.quaternion.clone());
    const a = this.carryArms();
    J.spine.rotation.set(0, 0, 0);
    J.shoulderL.rotation.set(a.x, 0, a.z, 'ZYX');
    J.shoulderR.rotation.set(a.x, 0, -a.z, 'ZYX');
    J.elbowL.rotation.set(-a.elbow, 0, 0);
    J.elbowR.rotation.set(-a.elbow, 0, 0);
    p.root.updateMatrixWorld(true);
    const hand = (w: THREE.Object3D) => J.spine.worldToLocal(w.localToWorld(new THREE.Vector3(0, -d.handR * 0.7, 0)));
    const hl = hand(J.wristL);
    const hr = hand(J.wristR);
    joints.forEach((j, i) => j.quaternion.copy(saved[i]));
    p.root.updateMatrixWorld(true);

    const w = Math.max(0.08, hl.distanceTo(hr) - d.handR * 0.9);
    const front = d.shoulderR * d.torsoDepth; // keep the box clear of the chest/belly
    const mid = hl.add(hr).multiplyScalar(0.5);
    const depth = Math.min(w * 0.85, Math.max(0.05, (mid.z - front * 1.05) * 2));
    const h = w * 0.7;
    this.box.scale.set(w, h, depth);
    this.boxHeld.compose(mid.setY(mid.y + h * 0.15), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    this.boxGround.set(0, h / 2, d.legLen * 0.36 + depth / 2);
    this.box.position.copy(this.boxGround);
    this.box.quaternion.identity();
    this.box.visible = true;
  }

  /**
   * The seat that fits this person: knee height, far enough behind their feet
   * that the thighs lie on it; how far the hips go back (z) and down (crouch,
   * × leg length) to sit on it; where the bench's middle is (root frame), and
   * its depth.
   */
  sitFit() {
    const d = this.p.dims;
    const standY = d.footH + (d.thighLen + d.shinLen) * 0.997;
    const h = d.footH + d.shinLen * 0.92;
    const z = d.thighLen * 0.85;
    return { h, z, crouch: (standY - (h + d.hipBelow * 0.9)) / d.legLen, benchZ: -z - d.thighLen * 0.05, depth: d.thighLen * 1.1 };
  }

  // ------------------------------------------------------------ seated or standing
  //
  // Sitting can also be a state that outlasts actions: sitDown() lowers them
  // onto a seat (a real bench that's behind them, or a conjured one) and they
  // stay seated through whatever they do next (play, talk, …) until getUp().
  // Each frame the seat is layered onto whatever pose the action asks for.

  private posture = { want: false, k: 0, conjured: false, autoUp: false, creaked: false };

  /** Sit down on a seat behind them: a real one, or (conjure) one that appears. */
  sitDown(opts: { conjure?: boolean; seatH?: number } = {}) {
    const f = this.sitFit();
    Object.assign(this.seat, { h: f.h, z: f.z, crouch: f.crouch });
    if (opts.seatH !== undefined) {
      // a real seat, whatever height it is: lower by however far their legs need
      const d = this.p.dims;
      const standY = d.footH + (d.thighLen + d.shinLen) * 0.997;
      this.seat.h = opts.seatH;
      this.seat.crouch = (standY - (opts.seatH + d.hipBelow * 0.9)) / d.legLen;
    }
    if (!this.posture.want && this.posture.k === 0) this.posture.creaked = false;
    this.posture.want = true;
    if (opts.conjure && this.posture.k === 0) {
      this.makeBench();
      this.posture.conjured = true;
    }
  }

  getUp() {
    this.posture.want = false;
    this.posture.autoUp = false;
  }

  /** Fully down on the seat. */
  get seated() {
    return this.posture.want && this.posture.k >= 1;
  }

  /** On the seat, or on the way down or up. */
  get onSeat() {
    return this.posture.want || this.posture.k > 0;
  }

  private dropSeat() {
    this.posture.want = false;
    this.posture.k = 0;
    this.posture.autoUp = false;
    if (this.posture.conjured && this.bench) this.bench.visible = false;
    this.posture.conjured = false;
  }

  /** Layer the seat (and its transitions) onto this frame's pose. */
  private applyPosture(dt: number, pose: ActionPose | null, tempo: number): ActionPose | null {
    const ps = this.posture;
    if (ps.autoUp && !this.kind) this.getUp();
    if (!ps.want && ps.k === 0) return pose;
    const tDown = 0.9 / Math.sqrt(tempo);
    const tUp = 0.8 / Math.sqrt(tempo);
    const was = ps.k;
    ps.k = ps.want ? Math.min(1, ps.k + dt / tDown) : Math.max(0, ps.k - dt / tUp);
    if (ps.want && was < 0.85 && ps.k >= 0.85 && !ps.creaked) {
      ps.creaked = true;
      this.events.push('creak');
    }
    const P = pose ?? this.pose;
    if (!pose) {
      P.crouch = P.sitZ = P.lift = P.spineY = P.spineZ = P.spin = P.fwd = P.spineX = P.headX = P.headY = P.headZ = 0;
      Object.assign(P.arms.L, arm());
      Object.assign(P.arms.R, arm());
    }
    const k = smooth(ps.k);
    const moving = ps.k > 0 && ps.k < 1 ? Math.sin(Math.PI * k) : 0;
    // push the hips back first, then drop: reads as lowering onto a seat
    P.sitZ = this.seat.z * smooth(Math.min(1, k * 1.6));
    P.crouch += this.seat.crouch * smooth(Math.max(0, (k - 0.15) / 0.85));
    P.spineX += 0.45 * moving - 0.04 * k;
    P.headX -= 0.2 * moving;
    for (const sd of ['L', 'R'] as const) {
      // hands on the thighs unless the action has them busy
      if (P.arms[sd].w < 0.01) Object.assign(P.arms[sd], { w: k, x: -0.12 - 0.3 * moving, z: 0.14, elbow: 1.0, stiff: 1 });
    }
    if (ps.conjured && this.bench) {
      this.bench.scale.copy(this.benchScale).multiplyScalar(Math.max(1e-3, smooth(Math.min(1, ps.k * 2.5))));
      this.bench.visible = true;
    }
    if (!ps.want && ps.k === 0) this.dropSeat();
    // seated (or getting there): going nowhere; once up, an idle person may walk again
    this.holdSpeed = this.kind ? this.holdSpeed || this.onSeat : this.onSeat;
    return P;
  }

  // ------------------------------------------------------------ music

  /** The playing window for an instrument starting now: to the end of the `phrases`-th full phrase from here. */
  private playLength(lead: number, phrases = 2) {
    const eighth = 30 / BPM;
    const startSlot = this.beatTime * 2 + lead / eighth;
    const endSlot = (Math.floor(startSlot / PHRASE_SLOTS) + phrases) * PHRASE_SLOTS;
    return lead + (endSlot - startSlot) * eighth + 0.6;
  }

  /** Stop playing: at the end of this phrase, or (now) right away. */
  stopPlaying(now = false) {
    const eighth = 30 / BPM;
    const slot = this.beatTime * 2;
    const toPhrase = (Math.ceil(slot / PHRASE_SLOTS + 1e-6) * PHRASE_SLOTS - slot) * eighth;
    const end = this.t + (now ? 0.5 : toPhrase + 0.6);
    if (this.kind === 'fiddle') this.fiddleDur = Math.min(this.fiddleDur, end);
    if (this.kind === 'banjo') this.choreOf('banjo').stopAt(end);
  }

  private makeBench() {
    const p = this.p;
    const d = p.dims;
    if (!this.bench) {
      const g = boxGeo();
      this.bench = new THREE.Group();
      const legs = [-0.4, 0.4].map((x) => {
        const m = mesh(g.leg, this.kit);
        m.position.x = x;
        return m;
      });
      this.bench.add(mesh(g.slab, this.kit), ...legs);
      p.root.add(this.bench);
    }
    // seat at knee height, far enough back that the thighs lie on it
    const standY = d.footH + (d.thighLen + d.shinLen) * 0.997;
    const h = d.footH + d.shinLen * 0.92;
    this.seat.h = h;
    this.seat.z = d.thighLen * 0.85;
    this.seat.crouch = (standY - (h + d.hipBelow * 0.9)) / d.legLen;
    this.benchScale.set(d.hipR * 3.2, h, d.thighLen * 1.1);
    this.bench.scale.setScalar(1e-3);
    this.bench.position.set(0, 0, -this.seat.z - d.thighLen * 0.05);
    this.bench.visible = true;
  }

  private showHammer(on: boolean) {
    if (on && !this.hammer) {
      const g = geos();
      const s = Math.sqrt(this.p.dims.height);
      this.hammer = new THREE.Group();
      this.hammer.add(mesh(g.handle, this.kit));
      this.hammer.add(mesh(g.head, this.kit));
      // marker at the striking face (the head mesh's origin is at the fist)
      this.hammerHead = new THREE.Object3D();
      this.hammerHead.position.set(0, -0.05, 0.22);
      this.hammer.add(this.hammerHead);
      this.hammer.scale.setScalar(s);
      this.hammer.position.y = -this.p.dims.handR * 0.7;
      this.hammer.rotation.x = 0.95; // handle angled down from the fist: head meets the ground on the strike
      this.p.joints.wristR.add(this.hammer);
      this.rock = mesh(g.rock, this.kit);
      this.rock.scale.setScalar(s);
      this.p.root.add(this.rock);
    }
    if (on && this.rock) this.placeRock();
    if (this.hammer) this.hammer.visible = on;
    if (this.rock) this.rock.visible = on;
  }

  /**
   * Put the rock where the hammer will land: pose the strike with plain FK,
   * read the hammer head position in root space, then restore the pose.
   */
  private placeRock() {
    const J = this.p.joints;
    const saved = [J.spine, J.shoulderR, J.elbowR].map((j) => j.quaternion.clone());
    J.spine.rotation.set(0.42, 0, 0);
    J.shoulderR.rotation.set(-0.4, 0, -0.12, 'ZYX');
    J.elbowR.rotation.set(-0.1, 0, 0);
    this.p.root.updateMatrixWorld(true);
    const at = this.p.root.worldToLocal(this.hammerHead!.getWorldPosition(new THREE.Vector3()));
    [J.spine, J.shoulderR, J.elbowR].forEach((j, i) => j.quaternion.copy(saved[i]));
    this.rock!.position.set(at.x, 0, at.z);
  }

  /** Before the animator: returns overrides (or null when idle). */
  pre(dt: number, m: Motion, st: Style): ActionPose | null {
    this.clock += dt;
    return this.applyChat(dt, this.applyPosture(dt, this.preAction(dt, m, st), st.tempo), st.tempo);
  }

  // ------------------------------------------------------------ chatting
  //
  // Talking can go on over whatever else they're doing (waiting at a table,
  // stood in the lane): beats of a free hand, nods and shakes, a voice, and
  // eyes on whoever they're talking to. The talk action is the same thing
  // done standing with both hands.

  private clock = 0;
  private chat = { partner: -1, until: 0, next: 0, side: 'R' as 'L' | 'R', x: -0.5, z: 0.3, elbow: 1.2, k: { L: 0, R: 0 }, e: 0, head: 0, headUntil: 0 };
  /** How far each arm is given over to a chat gesture (0…1): a chore's own hand-work yields that much. */
  gesturing = { L: 0, R: 0 };

  /** Chat with someone (crowd index) for a while, over whatever else is going on. */
  chatWith(partner: number, seconds: number) {
    const c = this.chat;
    if (c.partner !== partner || this.clock >= c.until) c.next = this.clock + 0.2 + Math.random() * 0.4;
    c.partner = partner;
    c.until = this.clock + seconds;
  }

  stopChat() {
    this.chat.until = Math.min(this.chat.until, this.clock);
  }

  /** Who they're talking to (talk action or a chat), −1 = nobody. */
  get talkingTo() {
    if (this.kind === 'talk') return this.partner;
    return this.chat.partner >= 0 && this.clock < this.chat.until ? this.chat.partner : -1;
  }

  /** Can this arm gesture now? (Free, resting on the thighs, or on the table between courses.) */
  private armFree(P: ActionPose, sd: 'L' | 'R') {
    if (this.kind === null) return true;
    if (isDine(this.kind)) return (this.chore as Dine).handsIdle;
    return P.arms[sd].w < 0.01;
  }

  private applyChat(dt: number, pose: ActionPose | null, tempo: number): ActionPose | null {
    const c = this.chat;
    const on = this.kind !== 'talk' && c.partner >= 0 && this.clock < c.until;
    c.e = on ? Math.min(1, c.e + dt / 0.35) : Math.max(0, c.e - dt / 0.5);
    if (c.e === 0 && c.k.L === 0 && c.k.R === 0) {
      this.gesturing.L = this.gesturing.R = 0;
      if (!on && c.partner >= 0 && this.clock >= c.until) c.partner = -1;
      return pose;
    }
    const P = pose ?? this.pose;
    if (!pose) {
      P.crouch = P.sitZ = P.lift = P.spineY = P.spineZ = P.spin = P.fwd = P.spineX = P.headX = P.headY = P.headZ = 0;
      Object.assign(P.arms.L, arm());
      Object.assign(P.arms.R, arm());
    }
    const t = this.clock;
    if (on && t >= c.next) {
      c.next = t + (0.45 + Math.random() * 0.6) / tempo;
      this.beat = true;
      // mostly one hand, now and then nothing but a look
      if (Math.random() < 0.8) {
        c.side = Math.random() < 0.6 ? 'R' : 'L';
        c.x = -0.3 - Math.random() * 0.55;
        c.z = 0.12 + Math.random() * 0.4;
        c.elbow = 1.0 + Math.random() * 0.9;
      } else c.side = c.side === 'R' ? 'L' : 'R';
      if (t > c.headUntil && Math.random() < 0.6) {
        c.head = Math.floor(Math.random() * 3) + 1;
        c.headUntil = t + 0.5 + Math.random() * 0.5;
      }
    }
    const ph = t * Math.PI * 2;
    for (const sd of ['L', 'R'] as const) {
      const want = on && sd === c.side && this.armFree(P, sd) ? 1 : 0;
      c.k[sd] = want > c.k[sd] ? Math.min(1, c.k[sd] + dt / 0.3) : Math.max(0, c.k[sd] - dt / 0.4);
      const g = smooth(c.k[sd]) * c.e;
      this.gesturing[sd] = g;
      if (g <= 0) continue;
      const A = P.arms[sd];
      const flick = 0.12 * Math.sin(ph * 2.3 * tempo + (sd === 'L' ? 0 : 1.7));
      const tw = A.w; // whatever the arm was doing, blended out under the gesture
      A.x = lerp(tw > 0 ? A.x : c.x, c.x + flick * 0.5, g);
      A.z = lerp(tw > 0 ? A.z : c.z, c.z, g);
      A.elbow = lerp(tw > 0 ? A.elbow : c.elbow, c.elbow + flick, g);
      A.stiff = lerp(tw > 0 ? (A.stiff ?? 1) : 1.6, 1.6, g);
      A.w = Math.max(tw, g);
    }
    const headOn = t < c.headUntil ? Math.sin(Math.PI * (1 - (c.headUntil - t) / 0.9)) : 0;
    const hk = Math.max(0, headOn) * c.e;
    if (c.head === 1) P.headX += 0.2 * Math.sin(ph * 2.6) * hk;
    if (c.head === 2) P.headY += 0.35 * Math.sin(ph * 2.2) * hk;
    if (c.head === 3) P.headZ += 0.18 * hk;
    P.spineX += 0.03 * Math.sin(ph * 0.7) * c.e;
    return P;
  }

  private preAction(dt: number, m: Motion, st: Style): ActionPose | null {
    this.impact = false;
    this.dust = false;
    this.beat = false;
    this.note = null;
    this.pluck = null;
    this.sawSpeed = 0;
    this.events.length = 0;
    this.bursts.length = 0;
    this.focus = null;
    this.mouthOpen = false;
    this.depart = false;
    m.lockPhase = false;
    if (!this.kind) return null;
    if (this.stopNow) {
      m.speed = 0;
      this.stopNow = false;
    }
    this.prevT = this.t;
    this.t += dt;
    const P = this.pose;
    P.crouch = P.sitZ = P.lift = P.spineY = P.spineZ = P.spin = P.fwd = P.spineX = P.headX = P.headY = P.headZ = 0;
    Object.assign(P.arms.L, arm());
    Object.assign(P.arms.R, arm());
    const d = this.p.dims;
    const tempo = st.tempo;
    this.tempo = tempo;
    const t = this.t;

    if (this.chore) return this.chore.pre(t, dt, P, tempo, this) ? P : this.finish();

    switch (this.kind) {
      case 'wave': {
        const dur = 2.6;
        if (this.crossed(0.25) && this.side === 'R') this.events.push('hey');
        if (t >= dur) return this.finish();
        const e = envelope(t, dur, 0.3, 0.45);
        const ph = Math.PI * 2 * 2.2 * tempo * t;
        Object.assign(P.arms[this.side], {
          w: e,
          x: -0.25,
          z: 2.45 + 0.3 * Math.sin(ph),
          elbow: 0.55 + 0.35 * Math.sin(ph + 0.8),
          stiff: 1.8,
        });
        P.headX = -0.12 * e;
        P.headZ = (this.side === 'R' ? -0.12 : 0.12) * e;
        P.spineX = -0.05 * e;
        return P;
      }

      case 'hammer': {
        const lead = 0.35;
        const T = 0.85 / tempo;
        const blows = 3;
        const dur = lead + T * blows + 0.3;
        if (t >= dur) return this.finish();
        const e = envelope(t, dur, lead, 0.4);
        const raw = Math.max(0, t - lead) / T;
        const u = raw >= blows ? 0.9 : raw % 1;
        let x: number, el: number;
        let z = 0.12;
        // wind-up → fast strike → *hold* (springs catch up, the blow reads) → rebound
        if (u < 0.5) {
          const k = smooth(u / 0.5);
          x = lerp(-0.6, -2.5, k);
          el = lerp(0.3, 1.7, k);
          z = 0.12 + 0.4 * k; // swing wide so the hammer clears the head
        } else if (u < 0.6) {
          const k = ((u - 0.5) / 0.1) ** 2; // accelerating strike
          x = lerp(-2.5, -0.4, k);
          el = lerp(1.7, 0.1, k);
          z = lerp(0.52, 0.12, k);
        } else if (u < 0.78) {
          x = -0.4;
          el = 0.1;
        } else {
          const k = (u - 0.78) / 0.22;
          x = lerp(-0.4, -0.6, k) - 0.15 * Math.sin(Math.PI * k);
          el = lerp(0.1, 0.3, k);
        }
        const HIT = 0.66; // when the springed arm actually arrives
        if (raw < blows && this.lastU < HIT && u >= HIT) this.impact = true;
        this.lastU = u;
        Object.assign(P.arms.R, { w: e, x, z, elbow: el, stiff: 3.2 });
        Object.assign(P.arms.L, { w: e, x: -0.75, z: 0.2, elbow: 1.2, stiff: 1 });
        const strike = u >= 0.5 && u < 0.8 ? Math.sin(((u - 0.5) / 0.3) * Math.PI) : 0;
        P.crouch = (0.07 + 0.03 * strike) * e;
        P.spineX = (0.3 + 0.12 * strike) * e;
        P.headX = 0.3 * e;
        return P;
      }

      case 'jump': {
        const tA = 0.24 / Math.sqrt(tempo); // anticipation
        const h = d.legLen * 0.7 * st.hop;
        const v0 = Math.sqrt(2 * JUMP_G * h);
        const tAir = (2 * v0) / JUMP_G;
        const tL = 0.32;
        if (t < tA) {
          const k = smooth(t / tA);
          P.crouch = 0.32 * k;
          P.spineX = 0.3 * k;
          P.headX = -0.1 * k;
          for (const s of ['L', 'R'] as const) Object.assign(P.arms[s], { w: k, x: 0.7, z: 0.3, elbow: 0.3, stiff: 2 });
        } else if (t < tA + tAir) {
          if (this.crossed(tA)) this.events.push('hup');
          const s = t - tA;
          m.lockPhase = true; // stride frozen mid-air
          const tuck = 0.25 * Math.sin((Math.PI * s) / tAir);
          P.lift = v0 * s - 0.5 * JUMP_G * s * s + tuck * d.legLen;
          P.crouch = tuck;
          P.spineX = -0.12;
          P.headX = -0.2;
          for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: 1, x: -0.4, z: 2.3, elbow: 0.4, stiff: 2.2 });
        } else if (t < tA + tAir + tL) {
          const k = (t - tA - tAir) / tL;
          P.crouch = 0.34 * (1 - k) ** 2; // squash on landing
          P.spineX = 0.25 * (1 - k);
          for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: 1 - k, x: -0.5, z: 0.7, elbow: 0.5, stiff: 1.5 });
        } else return this.finish();
        return P;
      }

      case 'carry': {
        const tUp = 0.8 / Math.sqrt(tempo);
        const tCarry = 7;
        const tDown = 0.8 / Math.sqrt(tempo);
        const dur = tUp + tCarry + tDown + 0.3;
        if (t >= dur) return this.finish();
        const a = this.carryArms();
        // bend: 0 standing, 1 squatting down at the box
        let bend = 0;
        if (t < tUp) bend = Math.sin(Math.PI * (t / tUp));
        else if (t > tUp + tCarry && t < tUp + tCarry + tDown) bend = Math.sin(Math.PI * ((t - tUp - tCarry) / tDown));
        const carrying = t >= tUp * 0.5 && t < tUp + tCarry + tDown * 0.5;
        if (this.crossed(tUp + tCarry + tDown * 0.5)) this.events.push('thunk');
        this.holdSpeed = t < tUp || t > tUp + tCarry;
        const reachX = -1.0; // arms down toward the box at the bottom of the bend
        for (const sd of ['L', 'R'] as const) {
          Object.assign(P.arms[sd], {
            w: carrying || bend > 0.05 ? 1 : 0,
            x: lerp(a.x, reachX, bend),
            z: a.z,
            elbow: lerp(a.elbow, 0.35, bend),
            stiff: 2.2,
          });
        }
        if (!carrying && bend < 0.05) P.arms.L.w = P.arms.R.w = smooth(1 - (t - tUp - tCarry - tDown) / 0.3);
        P.crouch = 0.38 * bend + (carrying ? 0.025 : 0);
        P.spineX = 1.05 * bend + (carrying ? -0.07 * (1 - bend) : 0); // lean back against the load
        P.headX = -0.25 * bend + (carrying ? 0.1 : 0);
        return P;
      }

      case 'sit': {
        const tIn = 0.35; // bench appears
        const tDown = 0.9 / Math.sqrt(tempo);
        const tUp = 0.8 / Math.sqrt(tempo);
        const upAt = tIn + tDown + 6;
        const dur = upAt + tUp + 0.25;
        if (t >= dur) return this.finish();
        let k = 0; // 0 standing → 1 seated
        if (t < tIn) k = 0;
        else if (t < tIn + tDown) k = smooth((t - tIn) / tDown);
        else if (t < upAt) k = 1;
        else k = 1 - smooth((t - upAt) / tUp);
        const moving = k > 0 && k < 1 ? Math.sin(Math.PI * k) : 0;
        if (this.crossed(tIn + tDown * 0.85)) this.events.push('creak');
        // push the hips back first, then drop: reads as lowering onto a seat
        const back = smooth(Math.min(1, k * 1.6));
        P.sitZ = this.seat.z * back;
        P.crouch = this.seat.crouch * smooth(Math.max(0, (k - 0.15) / 0.85));
        P.spineX = 0.45 * moving - 0.04 * k; // lean forward to balance, then sit up
        P.headX = -0.2 * moving;
        const pop = t < tIn ? smooth(t / tIn) : t > dur - 0.25 ? smooth((dur - t) / 0.25) : 1;
        if (this.bench) this.bench.scale.copy(this.benchScale).multiplyScalar(Math.max(1e-3, pop));
        for (const sd of ['L', 'R'] as const) {
          // hands rest on the thighs; push off them when moving
          Object.assign(P.arms[sd], { w: k, x: -0.12 - 0.3 * moving, z: 0.14, elbow: 1.0, stiff: 1 });
        }
        return P;
      }

      case 'talk': {
        const B = this.beats;
        const dur = B.dur;
        if (t >= dur) return this.finish();
        const e = envelope(t, dur, 0.35, 0.5);
        // a new gesture beat every so often: one or both hands
        if (t >= B.next) {
          B.next = t + (0.45 + Math.random() * 0.6) / tempo;
          this.beat = true;
          const which = Math.random();
          for (const sd of ['L', 'R'] as const) {
            const go = which < 0.4 || (which < 0.7 ? sd === 'R' : sd === 'L');
            const b = B[sd];
            if (go) {
              b.x = -0.25 - Math.random() * 0.7;
              b.z = 0.15 + Math.random() * 0.55;
              b.elbow = 0.9 + Math.random() * 1.0;
              b.w = 1;
            } else if (Math.random() < 0.5) b.w = 0.35; // let it drop a bit
          }
          // head: nod, shake, or tilt for a moment
          if (t > B.headUntil && Math.random() < 0.6) {
            B.head = Math.floor(Math.random() * 3) + 1;
            B.headUntil = t + 0.5 + Math.random() * 0.5;
          }
        }
        const ph = t * Math.PI * 2;
        for (const sd of ['L', 'R'] as const) {
          const b = B[sd];
          const flick = 0.12 * Math.sin(ph * 2.3 * tempo + (sd === 'L' ? 0 : 1.7));
          Object.assign(P.arms[sd], { w: e * b.w, x: b.x + flick * 0.5, z: b.z, elbow: b.elbow + flick, stiff: 1.6 });
        }
        const headOn = t < B.headUntil ? Math.sin(Math.PI * (1 - (B.headUntil - t) / 0.9)) : 0;
        const hk = Math.max(0, headOn) * e;
        if (B.head === 1) P.headX = 0.2 * Math.sin(ph * 2.6) * hk; // nod
        if (B.head === 2) P.headY = 0.35 * Math.sin(ph * 2.2) * hk; // shake
        if (B.head === 3) P.headZ = 0.18 * hk; // tilt
        P.spineX = 0.04 * Math.sin(ph * 0.7) * e; // lean in a little now and then
        return P;
      }

      case 'saw': {
        const lead = 0.4;
        const strokes = 7;
        const T = 0.62 / tempo;
        const dur = lead + strokes * T + 0.9;
        if (t >= dur) return this.finish();
        const e = envelope(t, dur, lead, 0.4);
        const raw = Math.max(0, t - lead) / T;
        const u = raw < strokes ? 0.5 - 0.5 * Math.cos(Math.PI * 2 * raw) : 0; // back → through → back
        // stroke speed (|du/dt| normalised) drives the saw sound
        this.sawSpeed = raw < strokes ? Math.abs(Math.sin(Math.PI * 2 * raw)) : 0;
        this.sawPush = raw % 1 < 0.5;
        if (this.crossed(lead + (strokes + 0.3) * T)) this.events.push('log');
        const a = this.sawStroke(u);
        Object.assign(P.arms.R, { w: e, x: a.x, z: a.z, elbow: a.elbow, stiff: 2.6 });
        Object.assign(P.arms.L, { w: e, x: -0.85, z: 0.0, elbow: 0.15, stiff: 1.4 }); // steadies the log
        P.crouch = (SAW_CROUCH + this.sawExtra) * e;
        P.spineX = (0.45 + 0.05 * u) * e;
        P.headX = 0.3 * e;
        P.headZ = 0.05 * e;
        // sawdust on each push
        const stroke = Math.floor(raw);
        this.dust = raw < strokes && raw % 1 > 0.45 && stroke !== this.lastStroke;
        if (this.dust) this.lastStroke = stroke;
        // the last stroke cuts through: halves drop apart
        const split = smooth((raw - strokes) / 0.4);
        this.logHalves.forEach((h, i) => {
          const sgn = i === 0 ? 1 : -1;
          h.position.x = sgn * split * 0.03;
          h.rotation.z = -sgn * split * 0.25;
        });
        if (this.logSet) this.logSet.visible = t < dur - 0.15;
        return P;
      }

      case 'fiddle': {
        const dur = this.fiddleDur;
        if (t >= dur) return this.finish();
        const e = envelope(t, dur, 0.5, 0.5);
        // play along the shared beat in eighth notes
        const slot = Math.floor(this.beatTime * 2);
        const eighth = 30 / BPM; // seconds per eighth note at the shared tempo
        if (t > 0.5 && t < dur - 0.5 && slot !== this.bow.lastSlot) {
          this.bow.lastSlot = slot;
          const n = tune().parts[Math.max(0, this.fiddleVoice)][slot % FORM_SLOTS];
          if (n.hold > 0) {
            this.note = { f: degToHz(n.deg), dur: eighth * n.hold };
            this.bow.dir = -this.bow.dir; // change bow direction on every new note
            this.bow.start = t;
            this.bow.len = eighth * n.hold;
          }
        }
        // bow arm: the hand travels across with each stroke
        const k = Math.min(1, (t - this.bow.start) / this.bow.len);
        this.bowStroke = this.bow.dir * (2 * k - 1);
        this.bowWeight = e;
        // rough bowing pose for the springs; post() solves the exact arm with IK
        Object.assign(P.arms.R, { w: e, x: -1.0, z: 0.35, elbow: 1.3, stiff: 2 });
        Object.assign(P.arms.L, { w: e, x: -1.2, z: 0.85, elbow: 0.55, stiff: 2 }); // holding the fiddle out to the side
        const sway = Math.sin(this.beatTime * Math.PI);
        P.headZ = 0.3 * e; // chin on the fiddle
        P.headY = 0.2 * e;
        P.headX = 0.12 * e;
        P.spineZ = 0.06 * sway * e;
        P.spineY = 0.08 * sway * e;
        P.crouch = 0.02 * (1 - Math.abs(Math.cos(this.beatTime * Math.PI))) * e; // a little bounce on the beat
        return P;
      }

      case 'dance': {
        const dur = this.beats.dur;
        if (t >= dur) return this.finish();
        const e = envelope(t, dur, 0.4, 0.6);
        const b = this.beatTime;
        const beat = Math.floor(b);
        const bf = b - beat; // 0 at the beat
        const bar = Math.floor(b / 8); // a move lasts two bars
        if (bar !== this.dance.lastBar) {
          this.dance.lastBar = bar;
          let mv = Math.floor(Math.random() * 4);
          if (mv === this.dance.move) mv = (mv + 1) % 4;
          this.dance.move = mv;
        }
        const onBeat = beat !== this.dance.lastBeat;
        this.dance.lastBeat = beat;
        const dip = Math.pow(1 - bf, 3); // sharp dip right on the beat
        const side = beat % 2 === 0 ? 1 : -1;
        P.crouch = (0.05 + 0.07 * dip) * e;
        P.headX = -0.05 * e + 0.1 * dip * e;
        switch (this.dance.move) {
          case 0: { // bounce, arms up taking turns
            const up = { w: e, x: -0.25, z: 2.95, elbow: 0.25, stiff: 2.5 };
            const low = { w: e, x: -0.5, z: 0.5, elbow: 1.3, stiff: 2.5 };
            Object.assign(P.arms.L, side > 0 ? up : low);
            Object.assign(P.arms.R, side > 0 ? low : up);
            P.spineZ = 0.12 * side * e;
            P.headZ = -0.12 * side * e;
            break;
          }
          case 1: { // clap on every beat
            const open = Math.min(1, bf * 3); // hands meet at the beat, then open
            for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: e, x: -1.2, z: 0.05 + 0.45 * open, elbow: 0.9, stiff: 4 });
            if (onBeat && t > 0.4) this.events.push('clap');
            P.spineX = 0.08 * dip * e;
            break;
          }
          case 2: { // hands on hips, hip sway
            for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: e, x: 0.25, z: 0.75, elbow: 1.7, stiff: 2 });
            P.spineZ = 0.18 * Math.sin(b * Math.PI) * e;
            P.spineY = 0.25 * Math.sin(b * Math.PI) * e;
            P.headZ = -0.1 * Math.sin(b * Math.PI) * e;
            break;
          }
          default: { // a hopping spin: one turn per bar (4 beats), arms out
            for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w: e, x: -0.2, z: 1.3, elbow: 0.3, stiff: 2 });
            P.spin = ((b % 4) / 4) * Math.PI * 2 * e;
            P.lift = 0.05 * Math.sin(bf * Math.PI) * e;
            m.lockPhase = true;
            break;
          }
        }
        return P;
      }

      case 'fall': {
        if (this.getup) {
          const k = this.getup.t / this.getup.dur;
          P.crouch = 0.5 * (1 - smooth(k * 1.2)); // rise through a crouch
          P.spineX = 0.5 * (1 - smooth(k));
          return P;
        }
        return null;
      }
    }
    return null;
  }

  private finish() {
    this.stop();
    return null;
  }

  /** Box follows the chest while carried, blending from/to the ground. */
  private postCarry() {
    if (!this.box) return;
    const p = this.p;
    const tUp = 0.8 / Math.sqrt(this.tempo);
    const tCarry = 7;
    const tDown = tUp;
    const t = this.t;
    // 0 = on the ground, 1 = in the hands
    let k = 0;
    if (t < tUp) k = smooth((t / tUp - 0.5) * 2);
    else if (t < tUp + tCarry) k = 1;
    else k = 1 - smooth(((t - tUp - tCarry) / tDown) * 2);
    p.root.updateMatrixWorld(true);
    _m.copy(p.root.matrixWorld).invert().multiply(p.joints.spine.matrixWorld).multiply(this.boxHeld);
    _m.decompose(_pos, _q, _scl);
    this.box.position.lerpVectors(this.boxGround, _pos, k);
    this.box.quaternion.identity().slerp(_q, k);
    const gone = Math.max(0, t - tUp - tCarry - tDown);
    this.box.visible = gone < 0.25;
  }

  /** After the animator: pose overrides that replace the animation outright. */
  post(dt: number, m: Motion, st: Style) {
    if (this.chore) return this.chore.post(this.t, dt, this);
    if (this.kind === 'fiddle' && this.fiddle) {
      this.placeFiddle();
      this.placeBow();
      return;
    }
    if (this.kind === 'saw' && this.saw) {
      // hold the blade at a constant angle: undo the forearm's swing in the fist
      const J = this.p.joints;
      const fore = -(J.shoulderR.rotation.x + J.elbowR.rotation.x);
      this.saw.rotation.x = fore - this.sawStroke(0.5).blade;
      return;
    }
    if (this.kind === 'carry') return this.postCarry();
    if (this.kind !== 'fall') return;
    const p = this.p;
    const J = p.joints;

    if (!this.ragdoll && !this.getup) {
      // start falling from whatever pose we're in, keeping momentum
      const yaw = p.root.rotation.y;
      const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const v = fwd.clone().multiplyScalar(m.speed);
      const trip = this.push.lengthSq() === 0;
      const push = trip ? fwd.clone().multiplyScalar(0.5 + 0.6 * m.speed).setY(0.1) : this.push;
      this.ragdoll = new Ragdoll(p, v, (i, vel) => {
        if (i >= 9) vel.addScaledVector(push, 1); // upper body
        else if (trip) vel.multiplyScalar(0.1); // feet caught
        else vel.addScaledVector(push, 0.4);
        // knees buckle (indices 2/6) so the body crumples instead of toppling like a plank
        if (i === 2 || i === 6) vel.addScaledVector(fwd, 0.9).y -= 0.6;
      });
      this.events.push('oof');
      // reflex: throw the hands out toward where we're falling
      this.ragdoll.reach.copy(push).setY(0).normalize().setY(-0.6);
      this.rootLocked = true;
      m.speed = 0;
    }

    if (this.ragdoll) {
      const r = this.ragdoll;
      r.step(dt);
      r.apply();
      if (r.stillTime > 0.8 || r.age > 4.5) {
        // re-root where the body lies, facing along it, then blend up
        p.root.position.set(r.centre.x, 0, r.centre.z);
        p.root.rotation.y = r.lyingYaw();
        p.root.updateMatrixWorld(true);
        r.apply();
        const q = new Map<JointName, THREE.Quaternion>();
        for (const j of JOINTS) q.set(j, J[j].quaternion.clone());
        this.getup = { t: 0, dur: 1.5 / Math.sqrt(st.tempo), q, pelvis: J.pelvis.position.clone() };
        this.events.push('grunt');
        this.ragdoll = null;
      }
      return;
    }

    if (this.getup) {
      const g = this.getup;
      g.t += dt;
      const k = smooth(g.t / g.dur);
      // (slerpQuaternions copies its first arg into `this`, so stash the target)
      // (not the root: it's already placed, and writing its quaternion would make three
      // re-derive its Euler as (180°, 180° − yaw, 180°), breaking every root.rotation.y reader)
      for (const j of JOINTS) if (j !== 'root') J[j].quaternion.slerpQuaternions(g.q.get(j)!, _target.copy(J[j].quaternion), k);
      J.pelvis.position.lerpVectors(g.pelvis, J.pelvis.position, k);
      if (g.t >= g.dur) this.stop();
    }
  }
}
