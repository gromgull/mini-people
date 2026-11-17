import * as THREE from 'three';
import type { Quadruped } from '../quadruped';
import { QuadAnimator, type QuadMotion, type QuadPose, dogSpeeds } from '../quadgait';
import { BODY, type Obstacle, Walker, nearest } from './walk';
import { AT_SUPPER, type Phase, type StepKind } from './jobs';

/**
 * The village cat. Nobody's: it goes where it pleases.
 *
 *   wandering   by day, from one favourite spot to the next (the woodpile,
 *               the green, a bench, the stook, the pond's edge; the bakery's
 *               oven when it's warm), and at each sits and looks about,
 *               grooms, loafs, or naps curled up; up again with a stretch
 *   stalking    at the pond's edge or under the drying rack, now and then:
 *               prowls up on something, holds low a moment, pounces, then
 *               sits and grooms as if nothing happened
 *   keeping off the dog: trots away from it if it comes close; sat, it
 *               stares it out with its tail swishing
 *   begging     at supper, sat by one diner then another looking up (a meow
 *               now and then); later, loafing by the kitchen hatch
 *   about       after dark, a last prowl round the green
 *   asleep      at night, curled up by the inn's door, purring now and then;
 *               up with a stretch in the morning
 */

export interface CatSpot {
  x: number;
  z: number;
  /** Something to stalk here (the pond's edge, the fish rack). */
  hunt?: boolean;
  /** Warm (the oven, fired): the best place for a nap. */
  warm?: () => boolean;
}

export interface CatWorld {
  time: number;
  dt: number;
  hours: number;
  phase: Phase;
  people: { walker: Walker; root: THREE.Object3D; height: number; doing: StepKind; asleep: boolean }[];
  /** The dog: where it is, and how fast it's going. */
  dog: { x: number; z: number; speed: number };
  spots: CatSpot[];
  /** Where it sleeps (by the inn's door), and where it waits by the kitchen hatch of an evening. */
  bed: { x: number; z: number; yaw: number };
  hatch: { x: number; z: number };
  green: { x: number; z: number; R: number };
  obstacles: Obstacle[];
  walkers: Walker[];
  camera: THREE.Vector3;
  sound: (kind: 'meow' | 'purr' | 'step') => void;
}

/** After dark, it's about till this hour, then off to bed (and up at WAKE_AT). */
const BED_AT = 23.5;
const WAKE_AT = 6;

export class VillageCat {
  readonly anim: QuadAnimator;
  readonly walker: Walker;
  readonly m: QuadMotion = { phase: 0, speed: 0 };
  /** What it's up to (for the panel and the test). */
  doing = 'wandering';
  private task: 'none' | 'to spot' | 'sit' | 'groom' | 'loaf' | 'nap' | 'stretch' | 'stalk' | 'hold' | 'pounce' | 'flee' | 'stare' | 'beg' = 'none';
  private until = 0;
  private next = 0;
  private pending: { x: number; z: number; yaw: number | null; pace: 'walk' | 'trot' | 'prowl' } | null = null;
  private pace: 'walk' | 'trot' | 'prowl' = 'walk';
  private spot: CatSpot | null = null;
  private begFrom = -1;
  private nextMeow = 0;
  private nextGlance = 0;
  private glance: (() => THREE.Vector3) | null = null;
  private lastDogD = Infinity;
  /** The part of the day it's in: a new one starts it afresh (whatever it was doing). */
  private mode: 'day' | 'supper' | 'about' | 'bed' | '' = '';

  constructor(readonly cat: Quadruped, x: number, z: number, yaw: number) {
    this.anim = new QuadAnimator(cat);
    this.walker = new Walker(x, z, yaw);
    cat.root.position.set(x, 0, z);
    cat.root.rotation.y = yaw;
  }

  /** Off somewhere (up on its feet first: with a stretch, if it's been lying down). */
  private go(x: number, z: number, yaw: number | null, pace: 'walk' | 'trot' | 'prowl') {
    const lying = this.anim.pose.curl + this.anim.pose.loaf > 0.5;
    this.anim.setPose(lying && pace !== 'trot' ? 'stretch' : 'stand');
    this.anim.look = null;
    this.anim.wag = 0;
    this.anim.eyesShut = false;
    this.pending = { x, z, yaw, pace };
  }

  private settle(pose: QuadPose, until: number, look: THREE.Vector3 | null = null) {
    this.walker.stop();
    this.pending = null;
    this.anim.setPose(pose);
    this.anim.look = look;
    this.anim.prowlTo = 0;
    this.until = until;
  }

  step(w: CatWorld) {
    const me = this.walker;
    const a = this.anim;
    const t = w.time;
    const dogD = Math.hypot(w.dog.x - me.x, w.dog.z - me.z);
    const night = w.phase === 'night' && (w.hours >= BED_AT || w.hours < WAKE_AT);

    // the dog close and coming on: off, away from it (not while it's asleep at night)
    if (!night && this.task !== 'flee' && dogD < 1.5 && w.dog.speed > 0.1 && dogD < this.lastDogD + 0.01) {
      const ax = me.x - w.dog.x, az = me.z - w.dog.z, d = Math.hypot(ax, az) || 1;
      this.go(me.x + (ax / d) * 3, me.z + (az / d) * 3, null, 'trot');
      this.task = 'flee';
      this.doing = 'keeping off the dog';
      this.anim.wag = 0.6;
    }
    this.lastDogD = dogD;

    // a new part of the day: whatever it was at (a nap, the loaf by the hatch) is over
    const mode = night ? 'bed' : w.phase === 'night' ? 'about' : w.phase === 'supper' ? 'supper' : 'day';
    if (mode !== this.mode) {
      this.mode = mode;
      this.task = 'none';
      this.until = 0;
      this.next = 0;
      this.doing = '';
      this.anim.look = null;
      this.anim.wag = 0;
      this.anim.eyesShut = false;
    }
    // away from the dog: that's that, back to whatever's next
    if (this.task === 'flee' && this.there) {
      this.task = 'none';
      this.anim.wag = 0;
    }

    if (w.phase === 'night') this.nightStep(w); // (about after dark, then bed)
    else if (w.phase === 'supper') this.supperStep(w);
    else this.dayStep(w, dogD);

    // the eyes, and a meow now and then (begging, mostly)
    this.eyes(w);
    if (t >= this.nextMeow) {
      this.nextMeow = t + (this.task === 'beg' ? 6 + Math.random() * 8 : 25 + Math.random() * 40);
      if (this.doing === 'asleep') {
        if (Math.random() < 0.7) w.sound('purr');
      } else if (this.task === 'beg' || Math.random() < 0.4) w.sound('meow');
    }

    // --- moving: up on its feet first (a stretch takes a moment), then off
    if (this.pending && !a.down) {
      const p = this.pending;
      this.pending = null;
      this.pace = p.pace;
      a.prowlTo = p.pace === 'prowl' ? 1 : 0;
      me.go({ x: p.x, z: p.z, yaw: p.yaw });
    }
    // (a stretch, held a moment, then up)
    if (this.pending && a.pose.stretch > 0.9) a.setPose('stand');
    const sp = dogSpeeds(this.cat);
    let want = 0;
    if (!this.pending && !a.down && me.goal && !me.arrived) {
      const pref = this.pace === 'trot' ? sp.trot : this.pace === 'prowl' ? sp.walk * 0.4 : sp.walk;
      want = me.think(w.dt, w.obstacles, w.walkers, pref);
    } else if (me.goal && me.arrived) me.think(w.dt, w.obstacles, w.walkers, 0);
    this.m.speed += (want - this.m.speed) * Math.min(1, w.dt * 5);
    if (this.m.speed < 0.01 && want === 0) this.m.speed = 0;
    me.move(this.m.speed, w.dt, w.obstacles, w.walkers);
    this.cat.root.position.set(me.x, 0, me.z);
    this.cat.root.rotation.y = me.yaw;
    a.advance(this.m, w.dt);
    a.update(this.m, w.dt);
    for (const e of a.events) if (e === 'step') w.sound('step');
  }

  /** Arrived where it was going (and up on its feet). */
  private get there() {
    return !this.pending && this.walker.arrived;
  }

  private dayStep(w: CatWorld, dogD: number) {
    const t = w.time;
    const me = this.walker;
    this.anim.eyesShut = this.task === 'nap';
    switch (this.task) {
      case 'flee':
        return;
      case 'to spot':
        if (!this.there) return;
        this.arrive(w);
        return;
      case 'stalk':
        // close: hold low, rump twitching, then go
        if (!this.there) return;
        this.settle('stand', t + 1.2 + Math.random() * 1.5);
        this.anim.prowlTo = 1;
        this.anim.wag = 0.8;
        this.task = 'hold';
        this.doing = 'stalking';
        return;
      case 'hold': {
        if (t < this.until) return;
        const fwd = new THREE.Vector3(Math.sin(me.yaw), 0, Math.cos(me.yaw));
        this.go(me.x + fwd.x * 0.7, me.z + fwd.z * 0.7, null, 'trot');
        this.anim.prowlTo = 0;
        this.anim.wag = 0;
        this.task = 'pounce';
        return;
      }
      case 'pounce':
        if (this.there) this.sitAbout(w, 'groom', 5 + Math.random() * 3); // (as if nothing happened)
        return;
      case 'none':
        if (t >= this.next) this.toSpot(w);
        return;
      default:
        // sat, grooming, loafing, napping, staring: till it's had enough
        if (this.task === 'sit' || this.task === 'stare') {
          // the dog about: stare it out, tail swishing
          if (dogD < 3.5) {
            this.task = 'stare';
            this.anim.look = new THREE.Vector3(w.dog.x, 0.2, w.dog.z);
            this.anim.wag = 0.7;
          } else if (this.task === 'stare') {
            this.task = 'sit';
            this.anim.look = null;
            this.anim.wag = 0;
          }
        }
        if (t >= this.until) {
          this.task = 'none';
          this.next = t + 0.5 + Math.random() * 2;
        }
    }
  }

  /** Settle into something at the spot it's got to (and say so). */
  private sitAbout(w: CatWorld, pose: 'sit' | 'groom' | 'loaf' | 'curl', secs: number) {
    this.settle(pose, w.time + secs);
    this.task = pose === 'curl' ? 'nap' : pose;
    this.doing = { sit: 'sitting about', groom: 'grooming', loaf: 'loafing', curl: 'napping' }[pose];
  }

  /** Arrived at a favourite spot: what to do there. */
  private arrive(w: CatWorld) {
    const s = this.spot;
    const r = Math.random();
    if (s?.hunt && r < 0.55) {
      // something in the grass: creep up on it
      const a = Math.random() * Math.PI * 2, d = 1.2 + Math.random() * 0.8;
      this.go(this.walker.x + Math.sin(a) * d, this.walker.z + Math.cos(a) * d, null, 'prowl');
      this.task = 'stalk';
      this.doing = 'stalking';
      return;
    }
    if (s?.warm?.() || r < 0.2) this.sitAbout(w, 'curl', 20 + Math.random() * 25);
    else if (r < 0.45) this.sitAbout(w, 'loaf', 10 + Math.random() * 12);
    else if (r < 0.7) this.sitAbout(w, 'groom', 5 + Math.random() * 5);
    else this.sitAbout(w, 'sit', 6 + Math.random() * 8);
  }

  /** Off to a favourite spot (a warm one first, if there is). */
  private toSpot(w: CatWorld) {
    const warm = w.spots.filter((s) => s.warm?.());
    const pool = warm.length && Math.random() < 0.6 ? warm : w.spots;
    const s = pool[Math.floor(Math.random() * pool.length)];
    this.spot = s;
    const at = clearSpot(s.x + (Math.random() - 0.5) * 1.2, s.z + (Math.random() - 0.5) * 1.2, w.obstacles);
    this.go(at.x, at.z, null, 'walk');
    this.task = 'to spot';
    this.doing = 'wandering';
  }

  private supperStep(w: CatWorld) {
    const t = w.time;
    this.anim.eyesShut = false;
    // later on: by the kitchen hatch, loafing (something might come its way)
    if (w.hours >= 19.5) {
      if (this.task === 'flee') return;
      if (this.doing !== 'by the hatch') {
        this.doing = 'by the hatch';
        const at = clearSpot(w.hatch.x, w.hatch.z, w.obstacles);
        this.go(at.x, at.z, null, 'walk');
        this.task = 'to spot';
      } else if (this.task === 'to spot' && this.there) {
        this.sitAbout(w, 'loaf', Infinity);
        this.doing = 'by the hatch';
      } else if (this.task === 'none') this.doing = ''; // (chased off: back to the hatch)
      return;
    }
    // begging: sat by a diner, looking up; on to another now and then
    const diners = w.people.map((p, i) => ({ p, i })).filter((x) => AT_SUPPER.has(x.p.doing));
    // (the one it was begging from has got up and gone: someone else, then)
    if (this.task === 'beg' && this.begFrom >= 0 && !AT_SUPPER.has(w.people[this.begFrom].doing)) this.until = 0;
    if (this.task === 'beg' && this.there && this.begFrom >= 0) {
      const p = w.people[this.begFrom];
      this.anim.setPose('sit');
      this.anim.look = p.root.position.clone().setY(p.height * 0.6);
    }
    if ((this.task !== 'beg' && this.task !== 'flee') || t >= this.until) {
      if (!diners.length) {
        if (this.task !== 'sit') this.sitAbout(w, 'sit', 4);
        return;
      }
      const d = diners[Math.floor(Math.random() * diners.length)];
      this.begFrom = d.i;
      const pw = d.p.walker;
      const side = Math.random() < 0.5 ? 1 : -1;
      const at = clearSpot(pw.x + Math.cos(pw.yaw) * 0.45 * side - Math.sin(pw.yaw) * 0.2, pw.z - Math.sin(pw.yaw) * 0.45 * side - Math.cos(pw.yaw) * 0.2, w.obstacles);
      this.go(at.x, at.z, null, 'walk');
      this.task = 'beg';
      this.doing = 'begging';
      this.until = t + 15 + Math.random() * 12;
    }
  }

  private nightStep(w: CatWorld) {
    const t = w.time;
    if (w.hours >= BED_AT || w.hours < WAKE_AT) {
      if (this.doing !== 'asleep' && this.doing !== 'off to bed') {
        this.doing = 'off to bed';
        const at = clearSpot(w.bed.x, w.bed.z, w.obstacles);
        this.go(at.x, at.z, null, 'walk');
        this.task = 'to spot';
      } else if (this.doing === 'off to bed' && this.there) {
        this.settle('curl', Infinity);
        this.task = 'nap';
        this.doing = 'asleep';
      }
      this.anim.eyesShut = this.doing === 'asleep';
      return;
    }
    // after dark: about the green, prowling, now and then sitting
    this.doing = 'about';
    if ((this.task === 'none' || this.task === 'sit' || this.task === 'groom' || this.task === 'to spot') && (this.there || this.task === 'none') && t >= this.until) {
      if (this.task === 'to spot') {
        this.sitAbout(w, Math.random() < 0.5 ? 'sit' : 'groom', 4 + Math.random() * 5);
        this.doing = 'about';
      } else {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * w.green.R * 1.3;
        this.go(w.green.x + Math.sin(a) * r, w.green.z + Math.cos(a) * r, null, Math.random() < 0.4 ? 'prowl' : 'walk');
        this.task = 'to spot';
      }
    }
  }

  /** What its eyes are on: ahead going somewhere, else a glance about now and then (at people, at you, at nothing). */
  private eyes(w: CatWorld) {
    const a = this.anim;
    const root = this.cat.root;
    const fwd = new THREE.Vector3(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
    if (a.look) {
      a.gazeAt = null;
      return;
    }
    if (this.m.speed > 0.05) {
      a.gazeAt = root.position.clone().addScaledVector(fwd, 2).setY(0.1);
      return;
    }
    if (w.time >= this.nextGlance) {
      this.nextGlance = w.time + 1.5 + Math.random() * 3;
      const me = this.walker;
      const near = w.people.filter((p) => p.root.visible && Math.hypot(p.walker.x - me.x, p.walker.z - me.z) < 3);
      const r = Math.random();
      if (r < 0.35 && near.length) {
        const p = near[Math.floor(Math.random() * near.length)];
        this.glance = () => p.root.position.clone().setY(p.height * 0.8);
      } else if (r < 0.5) this.glance = () => w.camera.clone();
      else {
        const at = root.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, 0.1, (Math.random() - 0.5) * 3)).addScaledVector(fwd, 1);
        this.glance = () => at;
      }
    }
    a.gazeAt = this.glance?.() ?? null;
  }
}

/** (x, z) if there's room there for a cat, else the nearest spot round about that has it. */
function clearSpot(x: number, z: number, obstacles: Obstacle[]) {
  const roomy = (px: number, pz: number) => obstacles.every((o) => nearest(o, px, pz).gap >= BODY + 0.03);
  if (roomy(x, z)) return { x, z };
  for (let r = 0.25; r <= 1.5; r += 0.25)
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
      if (roomy(px, pz)) return { x: px, z: pz };
    }
  return { x, z };
}
