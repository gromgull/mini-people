import * as THREE from 'three';
import type { Quadruped } from '../quadruped';
import { QuadAnimator, type QuadMotion, dogSpeeds } from '../quadgait';
import { BODY, type Obstacle, Walker, nearest } from './walk';
import { AT_SUPPER, ON_GREEN, type StepKind } from './jobs';

/**
 * The village dog. It belongs to someone, and what it does follows them:
 *
 *   with its owner  by day: it follows them about (trotting to catch up), and
 *                   while they're stood at their work it finds things to do:
 *                   sits looking up at them, lies down once they've been at it
 *                   a while, sniffs about, goes to say hello to whoever's
 *                   near (a wag, sometimes a bark)
 *   begging         at supper: sat by its owner at the table (or the kitchen hatch, an
 *                   innkeeper's dog), looking up, wagging
 *   on the green    of an evening: trotting about among the dancers, now and
 *                   then sitting at the edge, the odd bark
 *   asleep          at night: lying at its owner's door till they come out
 */

export interface DogWorld {
  time: number;
  dt: number;
  /** Where everyone is (their walkers), and how tall (for looking at their faces). */
  people: { walker: Walker; root: THREE.Object3D; height: number; speed: number; doing: StepKind; asleep: boolean }[];
  owner: number;
  /** The owner's front door. */
  home: { x: number; z: number; yaw: number };
  green: { x: number; z: number; R: number };
  obstacles: Obstacle[];
  /** Everyone's walkers, the dog's own included (so they keep out of each other's way). */
  walkers: Walker[];
  /** Where the camera is (a dog will look up at you now and then). */
  camera: THREE.Vector3;
  /** Play a sound (a bark, a paw down). */
  sound: (kind: 'woof' | 'step') => void;
}


export class VillageDog {
  readonly anim: QuadAnimator;
  readonly walker: Walker;
  readonly m: QuadMotion = { phase: 0, speed: 0 };
  /** What it's up to (for the panel). */
  doing = 'with its owner';
  private next = 0; // when to pick something new to do
  private replan = 0;
  private until = 0;
  private task: 'none' | 'follow' | 'sit' | 'lie' | 'sniff' | 'greet' | 'roam' = 'none';
  private greeting = -1;
  private stillSince = 0;
  /** Where it's going once it's up on its feet (a pose has to be got out of first). */
  private pending: { x: number; z: number; yaw: number | null; fast: boolean } | null = null;
  private fast = false;
  private nextGlance = 0;
  private glance: (() => THREE.Vector3) | null = null;

  constructor(readonly dog: Quadruped, x: number, z: number, yaw: number) {
    this.anim = new QuadAnimator(dog);
    this.walker = new Walker(x, z, yaw);
    dog.root.position.set(x, 0, z);
    dog.root.rotation.y = yaw;
  }

  /** Off somewhere (standing up first, if it's sat or lying). */
  private go(x: number, z: number, yaw: number | null, fast: boolean) {
    this.anim.setPose('stand');
    this.anim.look = null;
    this.pending = { x, z, yaw, fast };
  }

  private settle(pose: 'sit' | 'lie' | 'sniff' | 'stand', look: THREE.Vector3 | null, wag: number, until: number) {
    this.walker.stop();
    this.pending = null;
    this.anim.setPose(pose);
    this.anim.look = look;
    this.anim.wag = wag;
    this.until = until;
  }

  step(w: DogWorld) {
    const me = this.walker;
    const o = w.people[w.owner];
    const ow = o.walker;
    const dOwner = Math.hypot(ow.x - me.x, ow.z - me.z);
    const face = (p: (typeof w.people)[number]) => p.root.position.clone().setY(p.height * 0.85);
    if (o.speed > 0.05) this.stillSince = w.time;

    if (o.asleep) {
      // night: to the door, and down for the night (beside it, wherever there's room to lie)
      const side = new THREE.Vector3(Math.cos(w.home.yaw), 0, -Math.sin(w.home.yaw)).multiplyScalar(0.7);
      const at = clearSpot(w.home.x + side.x + Math.sin(w.home.yaw) * 0.3, w.home.z + side.z + Math.cos(w.home.yaw) * 0.3, w.obstacles);
      if (this.doing !== 'asleep' && this.doing !== 'going home') {
        this.doing = 'going home';
        this.go(at.x, at.z, w.home.yaw, Math.hypot(at.x - me.x, at.z - me.z) > 4);
      } else if (this.doing === 'going home' && me.arrived && !this.pending) {
        this.doing = 'asleep';
        this.settle('lie', null, 0, Infinity);
        this.anim.eyesShut = true;
      }
    } else if (AT_SUPPER.has(o.doing) || o.doing === 'cooking') {
      // supper: sat by the owner's place begging (or by the hatch, if they're the one cooking it)
      if (this.doing !== 'begging' || (me.arrived && dOwner > 1.2)) {
        this.doing = 'begging';
        // (out past the end of their bit of bench, a little behind them)
        const side = new THREE.Vector3(Math.cos(ow.yaw), 0, -Math.sin(ow.yaw)).multiplyScalar(0.75);
        this.go(ow.x + side.x - Math.sin(ow.yaw) * 0.35, ow.z + side.z - Math.cos(ow.yaw) * 0.35, null, dOwner > 4);
        this.task = 'none';
      } else if (me.arrived && !this.pending && this.task !== 'sit') {
        this.task = 'sit';
        this.settle('sit', face(o), 0.6, Infinity);
      }
    } else if (ON_GREEN.has(o.doing)) {
      // the green: about among the dancers
      this.doing = 'on the green';
      if (w.time >= this.next && (me.arrived || !me.goal) && !this.pending) {
        if (Math.random() < 0.3) {
          this.settle('sit', null, 0.4, w.time + 4 + Math.random() * 5);
          this.next = this.until;
        } else {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * w.green.R * 0.85;
          this.go(w.green.x + Math.sin(a) * r, w.green.z + Math.cos(a) * r, null, true);
          this.anim.wag = 1;
          this.next = w.time + 2 + Math.random() * 3;
          if (Math.random() < 0.15) this.anim.bark();
        }
      }
    } else {
      // with the owner
      this.doing = 'with its owner';
      const ownerFwd = new THREE.Vector3(Math.sin(ow.yaw), 0, Math.cos(ow.yaw));
      const tooFar = dOwner > (o.speed > 0.05 ? 1.6 : 2.8);
      if (tooFar && w.time >= this.replan) {
        // follow: just behind and to one side of them
        this.replan = w.time + 0.7;
        const side = new THREE.Vector3(ownerFwd.z, 0, -ownerFwd.x).multiplyScalar(0.55);
        this.go(ow.x - ownerFwd.x * 0.8 + side.x, ow.z - ownerFwd.z * 0.8 + side.z, null, dOwner > 4 || o.speed > 0.5);
        this.task = 'follow';
        this.next = w.time + 1.5;
      } else if (!tooFar && this.task === 'follow' && me.arrived && !this.pending) {
        this.settle('stand', face(o), 0.3, w.time + 1);
        this.task = 'none';
      } else if (!tooFar && w.time >= this.next && !this.pending && (me.arrived || !me.goal)) {
        // nothing to keep up with: find something to do
        this.next = w.time + 5 + Math.random() * 7;
        const r = Math.random();
        const others = w.people.map((p, i) => ({ p, i, d: Math.hypot(p.walker.x - me.x, p.walker.z - me.z) })).filter((x) => x.i !== w.owner && !x.p.asleep && x.d < 4 && x.p.root.visible);
        if (r < 0.15 && others.length) {
          const t = others[Math.floor(Math.random() * others.length)];
          this.greeting = t.i;
          const a = Math.atan2(me.x - t.p.walker.x, me.z - t.p.walker.z);
          this.go(t.p.walker.x + Math.sin(a) * 0.7, t.p.walker.z + Math.cos(a) * 0.7, null, true);
          this.task = 'greet';
        } else if (r < 0.5) {
          this.task = 'sit';
          this.settle('sit', face(o), 0.3, 0);
        } else if (r < 0.7 && w.time - this.stillSince > 10) {
          this.task = 'lie';
          this.settle('lie', null, 0, 0);
          this.next = w.time + 10 + Math.random() * 12;
        } else {
          const a = Math.random() * Math.PI * 2, rr = 0.8 + Math.random() * 1.4;
          this.go(ow.x + Math.sin(a) * rr, ow.z + Math.cos(a) * rr, null, false);
          this.task = 'sniff';
        }
      } else if (this.task === 'greet' && me.arrived && !this.pending) {
        const t = w.people[this.greeting];
        this.settle('stand', face(t), 1, w.time + 3);
        if (Math.random() < 0.35) this.anim.bark();
        this.task = 'none';
        this.next = w.time + 3;
      } else if (this.task === 'sniff' && me.arrived && !this.pending) {
        this.settle('sniff', null, 0.2, 0);
        this.task = 'none';
        this.next = w.time + 2.5 + Math.random() * 2.5;
      }
    }

    if (this.doing !== 'asleep') this.anim.eyesShut = false;
    this.eyes(w);

    // --- moving: up on its feet first, then off
    if (this.pending && !this.anim.down) {
      const p = this.pending;
      this.pending = null;
      this.fast = p.fast;
      me.go({ x: p.x, z: p.z, yaw: p.yaw });
    }
    const sp = dogSpeeds(this.dog);
    let want = 0;
    if (!this.pending && !this.anim.down && me.goal && !me.arrived) {
      const pref = this.fast ? sp.trot : Math.max(sp.walk, o.speed * 1.05);
      want = me.think(w.dt, w.obstacles, w.walkers, pref);
    } else if (me.goal && me.arrived) me.think(w.dt, w.obstacles, w.walkers, 0); // (turn to face, if it was told a way)
    this.m.speed += (want - this.m.speed) * Math.min(1, w.dt * 5);
    if (this.m.speed < 0.01 && want === 0) this.m.speed = 0;
    me.move(this.m.speed, w.dt, w.obstacles, w.walkers);
    this.dog.root.position.set(me.x, 0, me.z);
    this.dog.root.rotation.y = me.yaw;
    this.anim.advance(this.m, w.dt);
    this.anim.update(this.m, w.dt);
    for (const e of this.anim.events) if (e === 'woof' || e === 'step') w.sound(e);
  }

  /**
   * What its eyes are on: ahead when it's going somewhere, the ground in front
   * of its nose when it's sniffing, whoever its head's turned to (its owner,
   * someone it's greeting); otherwise glances about: someone nearby, up at its
   * owner, now and then at you, or off at nothing much.
   */
  private eyes(w: DogWorld) {
    const a = this.anim;
    const root = this.dog.root;
    const fwd = new THREE.Vector3(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
    if (a.look) {
      a.gazeAt = null; // (the eyes go with the head)
      return;
    }
    if (a.pose.sniff > 0.5) {
      a.gazeAt = root.position.clone().addScaledVector(fwd, this.dog.dims.bodyLen * 0.6 + 0.3).setY(0);
      return;
    }
    if (this.m.speed > 0.1) {
      a.gazeAt = root.position.clone().addScaledVector(fwd, 2.5).setY(0.25);
      return;
    }
    if (w.time >= this.nextGlance) {
      this.nextGlance = w.time + 1 + Math.random() * 2.5;
      const me = this.walker;
      const near = w.people.filter((p) => p.root.visible && Math.hypot(p.walker.x - me.x, p.walker.z - me.z) < 4);
      const r = Math.random();
      const face = (p: (typeof w.people)[number]) => () => p.root.position.clone().setY(p.height * 0.85);
      if (r < 0.4 && near.length) this.glance = face(near[Math.floor(Math.random() * near.length)]);
      else if (r < 0.65 && w.people[w.owner].root.visible) this.glance = face(w.people[w.owner]);
      else if (r < 0.8) this.glance = () => w.camera.clone();
      else {
        const at = root.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 0.2, (Math.random() - 0.5) * 4)).addScaledVector(fwd, 1.5);
        this.glance = () => at;
      }
    }
    a.gazeAt = this.glance?.() ?? null;
  }
}

/** (x, z) if there's room there for a dog to lie, else the nearest spot round about that has it. */
function clearSpot(x: number, z: number, obstacles: Obstacle[]) {
  const roomy = (px: number, pz: number) => obstacles.every((o) => nearest(o, px, pz).gap >= BODY + 0.05);
  if (roomy(x, z)) return { x, z };
  for (let r = 0.25; r <= 1.5; r += 0.25)
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
      if (roomy(px, pz)) return { x: px, z: pz };
    }
  return { x, z };
}
