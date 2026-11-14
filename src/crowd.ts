import * as THREE from 'three';
import { type Person, buildPerson, setMouth } from './body';
import type { Genome, MouthShape } from './genome';
import { type GaitParams, type Motion, advance } from './gait';
import { Animator } from './animate';
import { styleFor } from './persona';
import { type ActionPose, Actor, BPM } from './actions';
import { Smoke } from './smoke';
import { Sparks } from './fx';
import { Sound, type Voice, type Where, defaultAudio } from './audio';
import { Gaze, type GazeWorld, type LookMode } from './gaze';
import { q, type Stage } from './stage';

/**
 * People and everything that runs them each frame, shared by the demo and
 * the village: building bodies (with a drop shadow), and per person an
 * action runner, an animator, a gaze, a voice; the sound they make and the
 * particle bursts their actions throw. How people move about (paths, wander,
 * jobs) is the app's business: each step it calls `pre` (the action's pose
 * for this frame), moves and places the root itself, then calls `post`
 * (animate, gaze, sound, effects).
 */

export interface CrowdSettings {
  gait: GaitParams;
  personality: number;
  segments: number;
  eyes: boolean;
  merge: boolean;
  lookAt: LookMode;
}

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

export class Crowd {
  people: Person[] = [];
  // motion state lives beside the person so rebuilding a body keeps its stride
  motions: Motion[] = [];
  anims: Animator[] = [];
  actors: Actor[] = [];
  gazes: Gaze[] = [];
  readonly kit;
  readonly sound = new Sound({ ...defaultAudio, enabled: !q.has('mute') });
  readonly gazeWorld: GazeWorld;
  readonly sparks: Sparks;
  readonly sawdust: Sparks;
  /** Pipe smoke. */
  readonly smoke = new Smoke();
  private bursts;
  private prevPhase: number[] = [];
  private walkersHeard = 0; // on-screen walkers last frame (footsteps share the space)
  private walkersNow = 0;
  private wasGasping: boolean[] = [];
  private voiceCache = new WeakMap<Person, Voice>();
  private lastFrameAt = performance.now();
  private stalled = false;

  constructor(readonly stage: Stage, readonly settings: CrowdSettings) {
    this.kit = { toon: stage.toon, outline: stage.outline };
    const scene = stage.scene;
    this.sparks = new Sparks(scene);
    this.sawdust = new Sparks(scene, 48, ['#d9b77a', '#b8925a', '#e8d2a0'], 6);
    scene.add(this.smoke.group);
    // bursts from the outdoor chores: wood chips, leaves, water, apple
    const chips = new Sparks(scene, 48, ['#e8d2a0', '#c79a5a', '#f2e4c0'], 9);
    const leaves = new Sparks(scene, 48, ['#4e9a3a', '#5aa642', '#78b84a'], 2.5);
    const splash = new Sparks(scene, 64, ['#dff2ff', '#9ccfe8', '#ffffff'], 9);
    const crumbs = new Sparks(scene, 24, ['#f4ecc8', '#e8dca0'], 9);
    this.bursts = { chips: [chips, 6, 0.7], leaves: [leaves, 8, 0.45], splash: [splash, 9, 0.55], crumbs: [crumbs, 3, 0.3] } as const;

    const actors = () => this.actors;
    this.gazeWorld = {
      mode: 'auto',
      people: [],
      busy: (i) => {
        const k = actors()[i]?.kind;
        return k === 'fall' || k === 'jump' || k === 'hammer' || k === 'saw' || k === 'chop' || k === 'fish';
      },
      focus: (i) => actors()[i]?.focus ?? null,
      camera: new THREE.Vector3(),
      cursor: null,
      selected: 0,
      time: 0,
    };

    const sound = this.sound;
    const startSound = () => sound.start();
    window.addEventListener('pointerdown', startSound);
    window.addEventListener('keydown', startSound);
    document.addEventListener('visibilitychange', () => sound.setHidden(document.hidden));
    // Watchdog: if frames stop (alt-tab to an occluding window, minimised, …) the
    // per-frame updates that keep continuous sounds honest stop too — so pause the
    // whole engine until frames come back. Timers keep running when rAF doesn't.
    setInterval(() => {
      if (!this.stalled && performance.now() - this.lastFrameAt > 250) {
        this.stalled = true;
        sound.setHidden(true);
      }
    }, 100);
  }

  styleOf(p: Person) {
    return styleFor(this.settings.gait, p.genome.persona, this.settings.personality);
  }

  /** Build a body (plus its drop shadow) and add it to the scene. */
  spawn(genome: Genome, index: number) {
    const s = this.settings;
    const p = buildPerson(genome, this.stage.toon, this.stage.outline, { segments: s.segments, eyes: s.eyes, skin: s.merge ? this.stage.skinMats : null });
    p.root.userData.index = index;
    // drop shadow: an ellipse in a pivot that turns it away from the sun (see Stage.orient)
    const c = this.stage.makeCaster(Math.max(p.dims.hipR, p.dims.shoulderR, p.dims.waistR) * 1.35, p.dims.height);
    p.root.add(c.pivot);
    p.root.userData.shadow = c;
    this.stage.scene.add(p.root);
    return p;
  }

  despawn(p: Person) {
    this.stage.scene.remove(p.root);
    p.dispose();
  }

  /** A person's voice and tread, from their body and personality. */
  voiceOf(p: Person): Voice {
    let v = this.voiceCache.get(p);
    if (!v) {
      const g = p.genome;
      const small = 1 - g.height;
      v = {
        f0: lerpN(100, 235, 0.65 * g.fem + 0.35 * small) * (1.08 - 0.16 * g.girth) * (0.92 + 0.16 * g.persona.energy),
        formant: lerpN(0.9, 1.22, 0.55 * g.fem + 0.45 * small),
        rate: 0.8 + 0.5 * g.persona.energy,
        weight: Math.min(1, 0.55 * g.persona.weight + 0.45 * g.girth + 0.2 * g.height - 0.1),
      };
      this.voiceCache.set(p, v);
    }
    return v;
  }

  private _sp = new THREE.Vector3();
  /** Stereo position + loudness from where the person is on screen; null = off-screen. */
  whereOf(p: Person): Where | null {
    const camera = this.stage.camera;
    this._sp.set(0, p.dims.height * 0.8, 0).applyMatrix4(p.root.matrixWorld).project(camera);
    if (Math.abs(this._sp.x) > 1.15 || Math.abs(this._sp.y) > 1.15) return null;
    // what's near the middle of the view is what you're listening to
    const centre = Math.min(1, Math.max(0.2, 1.15 - 0.85 * Math.hypot(this._sp.x, this._sp.y)));
    return { pan: this._sp.x * 0.8, gain: Math.min(1.2, 0.3 + 0.45 * camera.zoom) * centre };
  }

  /** Once per frame, before simulating: wakes the sound back up after a stall. */
  frameTick() {
    this.lastFrameAt = performance.now();
    if (this.stalled) {
      this.stalled = false;
      if (!document.hidden) this.sound.setHidden(false);
    }
  }

  /** Once per simulation step, before anyone's `pre`. */
  beginStep(simTime: number, cursor: THREE.Vector3 | null, selected: number) {
    const gw = this.gazeWorld;
    gw.mode = this.settings.lookAt;
    gw.people = this.people;
    gw.camera.copy(this.stage.camera.position);
    gw.cursor = cursor;
    gw.selected = selected;
    gw.time = simTime;
    this.walkersHeard = this.walkersNow;
    this.walkersNow = 0;
  }

  /** The action's pose for person i this step (null = no action). */
  pre(i: number, dt: number, simTime: number): ActionPose | null {
    const a = this.actors[i];
    a.beatTime = (simTime * BPM) / 60; // shared beat: dancers and fiddlers keep time together
    return a.pre(dt, this.motions[i], this.styleOf(this.people[i]));
  }

  /** Step the gait toward the motion's target speed. */
  advance(i: number, dt: number) {
    advance(this.motions[i], this.people[i], this.styleOf(this.people[i]).gait, dt);
  }

  /** After the root is placed: animate, gaze, mouth, sound and effects. */
  post(i: number, dt: number, simTime: number, pose: ActionPose | null) {
    const p = this.people[i];
    const m = this.motions[i];
    const a = this.actors[i];
    const g = this.gazes[i];
    const st = this.styleOf(p);
    g.partner = a.talkingTo;
    g.aim(this.gazeWorld);
    this.anims[i].update(dt, p, m, st, p.root.rotation.y, pose, g.hint);
    a.post(dt, m, st);
    g.update(dt, simTime);
    const gasp = g.surprised || (a.kind === 'fall' && a.rootLocked);
    if (p.mouth) setMouth(p, this.mouthFor(i, a, m, gasp, simTime));
    this.soundFor(i, p, m, a, g.surprised && !this.wasGasping[i]);
    this.wasGasping[i] = g.surprised;
    if (a.impact && a.hammerHead) {
      p.root.updateMatrixWorld(true);
      this.sparks.burst(a.hammerHead.getWorldPosition(new THREE.Vector3()), 7, Math.sqrt(p.dims.height));
    }
    for (const f of a.puffs) this.smoke.puff(f.at, f.size, 1.6 + Math.random() * 0.8, f.vel ?? new THREE.Vector3(0, 0.1, 0));
    for (const b of a.bursts) {
      const [fx, n, power] = this.bursts[b.kind];
      fx.burst(b.at, n, power * Math.sqrt(p.dims.height));
    }
    if (a.dust && a.sawTip) {
      p.root.updateMatrixWorld(true);
      this.sawdust.burst(a.sawTip.getWorldPosition(new THREE.Vector3()), 4, 0.35);
    }
  }

  /** Once per simulation step, after everyone. */
  endStep(dt: number) {
    this.sparks.update(dt);
    this.sawdust.update(dt);
    this.smoke.update(dt, this.stage.toon.uniforms.uTint.value);
    for (const [fx] of Object.values(this.bursts)) fx.update(dt);
  }

  /** Stop continuous sounds whose owner stopped reporting (mode switch, pause…). */
  sweep() {
    this.sound.sweep();
  }

  /** Point every drop shadow away from the light (after Stage.updateLight). */
  orientShadows() {
    for (const p of this.people) if (p.root.userData.shadow) this.stage.orient(p.root.userData.shadow, p.root.rotation.y);
  }

  // ------------------------------------------------------------ the face

  private mood: { shape: MouthShape; since: number; talkUntil: number; frownUntil: number; fell: boolean }[] = [];

  /**
   * What the mouth does, from what they're up to and what's happening to
   * them: an O for a fright or a bite; flapping while they talk, a smile (or
   * a smirk) between; a frown after a fall or under a heavy log; a straight
   * face for hard work, walking and waiting; a smile at their ease (idle,
   * sat, smoking, playing, dancing, fed). Moods hold a moment, so faces don't
   * flicker; frights, bites and speech show at once.
   */
  private mouthFor(i: number, a: Actor, m: Motion, gasp: boolean, now: number): MouthShape {
    const md = (this.mood[i] ??= { shape: 'line', since: -1, talkUntil: 0, frownUntil: 0, fell: false });
    // (a fall: the face stays sour a little while after they're up)
    if (a.kind === 'fall') md.fell = true;
    else if (md.fell) {
      md.fell = false;
      md.frownUntil = now + 2.5;
    }
    const to = a.talkingTo;
    if (a.beat && to >= 0) md.talkUntil = now + 0.45;
    const k = a.kind;
    const working = k === 'saw' || k === 'chop' || k === 'hammer' || k === 'hold' || k === 'armful' || k === 'carry' || k === 'fish' || k === 'pick' || k === 'haul';
    // (busy at their own work, nobody else's drama makes them gape)
    if (working) gasp = false;
    const speaking = this.sound.live ? this.sound.speaking(i) : now < md.talkUntil;
    // at once: frights, bites, words
    if (gasp || a.mouthOpen) return this.holdMouth(md, 'O', now, true);
    if (to >= 0 && speaking) return Math.floor(now * 9 + i * 0.37) % 2 ? 'O' : 'line';
    if (a.kind === 'fall' || now < md.frownUntil) return this.holdMouth(md, 'frown', now, true);
    // moods
    let want: MouthShape;
    if (to >= 0) want = (i * 7 + to * 3) % 4 === 0 ? 'smirk' : 'smile';
    else if (k === 'haul') want = 'frown'; // (a log on the shoulder is heavy)
    else if (working) want = 'line';
    else if (k === 'dine' || k === 'eat' || k === 'drink') {
      // at table: fed, or with something in the tankard, is content; waiting isn't
      const d = a.choreOf('dine');
      want = d.ate > 0 || !d.needsRefill ? 'smile' : 'line';
    }
    else if (k) want = 'smile'; // playing, smoking, dancing, waving, sitting about…
    else want = m.speed > 0.08 ? 'line' : 'smile'; // on their way somewhere; or at their ease
    return this.holdMouth(md, want, now, false);
  }

  private holdMouth(md: { shape: MouthShape; since: number }, want: MouthShape, now: number, at_once: boolean): MouthShape {
    if (want !== md.shape && (at_once || now - md.since > 0.6)) {
      md.shape = want;
      md.since = now;
    }
    return md.shape;
  }

  /** Turn this frame's motion and action cues for person i into sound. */
  private soundFor(i: number, p: Person, m: Motion, a: Actor, gasped: boolean) {
    const sound = this.sound;
    const prev = this.prevPhase[i] ?? m.phase;
    this.prevPhase[i] = m.phase;
    if (!sound.live) {
      if (sound.ctx) sound.saw(i, false, 0, false, { pan: 0, gain: 0 });
      return;
    }
    const w = this.whereOf(p);
    const v = this.voiceOf(p);
    // heel strikes: left at phase 0, right at 0.5
    if (w && m.speed > 0.06 && !m.lockPhase && !a.rootLocked) {
      this.walkersNow++;
      // a crowd's footsteps blend into a patter instead of adding up
      const crowd = 1 / Math.sqrt(Math.max(1, this.walkersHeard / 1.5));
      const crossed = (at: number) => (prev < at && m.phase >= at) || (prev > m.phase && (at === 0 || m.phase >= at));
      if (crossed(0) || crossed(0.5)) sound.step(v, { pan: w.pan, gain: w.gain * crowd * Math.min(1, 0.5 + m.speed) });
    }
    sound.saw(i, !!w && a.kind === 'saw' && a.sawSpeed > 0, a.sawSpeed, a.sawPush, w ?? { pan: 0, gain: 0 });
    if (!w) return;
    if (a.impact) sound.hammer(w);
    if (a.note) sound.fiddleNote(a.note.f, a.note.dur, w);
    if (a.pluck?.kind === 'bass') sound.bassNote(a.pluck.f[0], w);
    else if (a.pluck) sound.banjoNote(a.pluck.f, a.pluck.kind, w);
    const to = a.talkingTo;
    if (a.beat && Math.random() < (to >= 0 ? 0.55 : 0.2) && !(to >= 0 && sound.speaking(to)) && !sound.speaking(i)) sound.phrase(i, v, w);
    if (gasped && Math.random() < 0.2) sound.exclaim('gasp', v, w);
    for (const e of a.events) {
      if (e === 'clap') sound.clap(w);
      else if (e === 'thunk') sound.thunk(w, 1);
      else if (e === 'log') sound.thunk(w, 0.8);
      else if (e === 'creak') sound.creak(w);
      else if (e === 'oof' || e === 'hup' || e === 'grunt' || e === 'hey' || e === 'ahh' || e === 'mmm') sound.exclaim(e, v, w);
      else sound.chore(e, w);
    }
  }
}
