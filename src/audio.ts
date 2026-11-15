/**
 * Procedural sound: everything is synthesised with Web Audio, no samples.
 * The simulation reports events (a heel strike, a hammer blow, a syllable…)
 * with a stereo position and loudness; recipes below turn them into sound.
 */

export interface Where {
  pan: number; // -1 … 1
  gain: number; // 0 … ~1.2 (distance / zoom)
}

/** Per-person voice, derived from the body so everyone sounds like themselves. */
export interface Voice {
  f0: number; // base pitch (Hz)
  formant: number; // formant scale (small bodies → higher)
  rate: number; // syllables per second multiplier
  weight: number; // 0 light … 1 heavy (footsteps)
}

export interface AudioSettings {
  enabled: boolean;
  volume: number;
  steps: number;
  voices: number;
  tools: number;
  music: number;
}

/**
 * What makes the voices warm rather than metallic. All on by default; the
 * flags exist so scripts/sounds.mjs can render before/after comparisons.
 */
export interface VoiceFx {
  wobble: boolean; // 1: random pitch drift + jitter + shimmer instead of a steady sine vibrato
  cascade: boolean; // 4: formant resonators in series (no cancelling between bands)
  hums: boolean; // 8: nasal m/n murmurs and the odd "mm" syllable
  room: boolean; // 9: a little room reverb on voices
  softRing: boolean; // 5: tame the fixed high formant around 2600 Hz
  warm: boolean; // 10: gentle saturation + a treble cut on the voices
}
export const defaultVoiceFx: VoiceFx = { wobble: true, cascade: true, hums: true, room: true, softRing: true, warm: true };

export const defaultAudio: AudioSettings = { enabled: true, volume: 0.7, steps: 0.45, voices: 0.8, tools: 0.8, music: 0.7 };

const VOWELS: [number, number][] = [
  [800, 1200], // a
  [500, 1850], // e
  [320, 2300], // i
  [520, 900], // o
  [340, 780], // u
];
const MAX_SAWS = 2;
const MAX_TALKERS = 3;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Sound {
  ctx: BaseAudioContext | null = null;
  private offline = false;
  private master!: GainNode;
  private bus!: { steps: GainNode; voices: GainNode; tools: GainNode; music: GainNode };
  private noise!: AudioBuffer;
  private tokens = { steps: 0, voices: 0, tools: 0, music: 0 };
  private lastRefill = 0;
  private saws = new Map<number, { src: AudioBufferSourceNode; filt: BiquadFilterNode; amp: GainNode; teeth: OscillatorNode; pan: StereoPannerNode; touched: boolean; biteLfo: OscillatorNode; biteBp: BiquadFilterNode }>();
  private talking = new Map<number, number>(); // person → end of current phrase (ctx time)
  private roomSend!: GainNode;
  private voiceSat!: WaveShaperNode;
  private voiceShelf!: BiquadFilterNode;
  voiceFx: VoiceFx = { ...defaultVoiceFx };
  // the wobble's own dice, so switching it on doesn't change what gets said
  private wobSeed = 1;
  private wob = (a: number, b: number) => {
    this.wobSeed = (this.wobSeed * 16807) % 2147483647;
    return a + (this.wobSeed / 2147483647) * (b - a);
  };

  constructor(public settings: AudioSettings) {}

  /** Browsers only allow audio after a user gesture: call from one. */
  start(offlineCtx?: OfflineAudioContext) {
    if (this.ctx && !offlineCtx) {
      if (this.ctx.state === 'suspended') (this.ctx as AudioContext).resume();
      return;
    }
    this.offline = !!offlineCtx;
    this.saws.clear();
    this.talking.clear();
    const ctx = offlineCtx ?? new AudioContext();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    const mix = ctx.createGain();
    mix.connect(this.master);
    this.master.connect(comp).connect(ctx.destination);
    this.bus = { steps: ctx.createGain(), voices: ctx.createGain(), tools: ctx.createGain(), music: ctx.createGain() };
    const { voices, ...others } = this.bus;
    Object.values(others).forEach((g) => g.connect(mix));
    // voices get their own little channel strip: saturation, a treble shelf, then a room send
    this.voiceSat = ctx.createWaveShaper();
    this.voiceSat.oversample = '2x';
    this.voiceShelf = ctx.createBiquadFilter();
    this.voiceShelf.type = 'highshelf';
    this.voiceShelf.frequency.value = 3500;
    voices.connect(this.voiceSat).connect(this.voiceShelf).connect(mix);
    const room = ctx.createConvolver();
    room.buffer = roomImpulse(ctx);
    this.roomSend = ctx.createGain();
    this.voiceShelf.connect(this.roomSend).connect(room).connect(mix);
    // one second of white noise, shared by every noisy recipe
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.apply();
  }

  /** Push settings (volume, bus levels) into the graph. */
  apply() {
    if (!this.ctx) return;
    const s = this.settings;
    this.master.gain.value = s.enabled ? s.volume : 0;
    this.bus.steps.gain.value = s.steps;
    this.bus.voices.gain.value = s.voices;
    this.bus.tools.gain.value = s.tools;
    this.bus.music.gain.value = s.music;
    this.roomSend.gain.value = this.voiceFx.room ? 0.14 : 0;
    this.voiceSat.curve = this.voiceFx.warm ? satCurve(2.2) : null;
    this.voiceShelf.gain.value = this.voiceFx.warm ? -6 : 0;
  }

  /** Pause/resume the whole engine (e.g. while the tab is hidden). */
  setHidden(hidden: boolean) {
    if (!this.ctx || this.offline) return;
    const c = this.ctx as AudioContext;
    if (hidden && c.state === 'running') c.suspend();
    else if (!hidden && c.state === 'suspended') c.resume();
  }

  get live() {
    return !!this.ctx && (this.offline || this.ctx.state === 'running') && this.settings.enabled;
  }

  /** Rate limiting so a big crowd doesn't turn into noise. */
  private allow(kind: keyof Sound['tokens']) {
    if (this.offline) return true;
    const now = this.ctx!.currentTime;
    const dt = now - this.lastRefill;
    this.lastRefill = now;
    const caps = { steps: 8, voices: 12, tools: 6, music: 40 }; // events per second
    for (const k of Object.keys(this.tokens) as (keyof Sound['tokens'])[]) this.tokens[k] = Math.min(caps[k] * 0.5, this.tokens[k] + dt * caps[k]);
    if (this.tokens[kind] < 1) return false;
    this.tokens[kind] -= 1;
    return true;
  }

  // ------------------------------------------------------------ building blocks

  private out(bus: keyof Sound['bus'], w: Where) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = w.gain;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, w.pan));
    g.connect(p).connect(this.bus[bus]);
    return g;
  }

  private noiseSrc(t: number, dur: number, offset = Math.random()) {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(t, offset * 0.9);
    s.stop(t + dur + 0.05);
    return s;
  }

  /** Exponential-ish percussive envelope on a fresh gain node. */
  private env(t: number, peak: number, attack: number, decay: number) {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  private filter(type: BiquadFilterType, freq: number, q = 1) {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private tone(type: OscillatorType, t: number, f0: number, f1: number, dur: number) {
    const o = this.ctx!.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  // ------------------------------------------------------------ recipes

  /** A light footstep: a filtered scuff plus a small low thump. */
  step(v: Voice, w: Where) {
    if (!this.live || !this.allow('steps')) return;
    const t = this.ctx!.currentTime + 0.005;
    const o = this.out('steps', w);
    const W = v.weight;
    const scuff = this.noiseSrc(t, 0.08);
    scuff
      .connect(this.filter('bandpass', rand(0.85, 1.15) * (1300 - 600 * W), 0.8))
      .connect(this.filter('lowpass', 3200))
      .connect(this.env(t, 0.22 * rand(0.7, 1), 0.002, 0.035 + 0.03 * W))
      .connect(o);
    this.tone('sine', t, (150 - 60 * W) * rand(0.9, 1.1), 50, 0.07)
      .connect(this.env(t, 0.25 + 0.45 * W, 0.003, 0.06 + 0.05 * W))
      .connect(o);
  }

  /** Hammer on rock: click, short metallic ring, dull thud, stone clack. */
  hammer(w: Where) {
    if (!this.live || !this.allow('tools')) return;
    const t = this.ctx!.currentTime + 0.003;
    const o = this.out('tools', w);
    this.noiseSrc(t, 0.03).connect(this.filter('bandpass', 1400, 1)).connect(this.env(t, 0.45, 0.001, 0.015)).connect(o);
    const base = rand(560, 720);
    [1, 2.76, 5.4].forEach((k, i) =>
      this.tone('triangle', t, base * k * rand(0.99, 1.01), base * k * 0.985, 0.2).connect(this.env(t, [0.22, 0.1, 0.05][i], 0.001, [0.14, 0.08, 0.05][i])).connect(o),
    );
    this.tone('sine', t, 75, 32, 0.18).connect(this.env(t, 0.8, 0.002, 0.15)).connect(o);
    this.noiseSrc(t, 0.08).connect(this.filter('bandpass', 850, 3)).connect(this.env(t, 0.45, 0.001, 0.06)).connect(o);
  }

  /** Something wooden set down / dropped: box, log halves. */
  thunk(w: Where, pitch = 1) {
    if (!this.live || !this.allow('tools')) return;
    const t = this.ctx!.currentTime + 0.003;
    const o = this.out('tools', w);
    this.tone('sine', t, 120 * pitch, 48 * pitch, 0.15).connect(this.env(t, 0.75, 0.002, 0.13)).connect(o);
    this.tone('triangle', t, 230 * pitch, 205 * pitch, 0.07).connect(this.env(t, 0.12, 0.001, 0.06)).connect(o);
    this.noiseSrc(t, 0.06).connect(this.filter('bandpass', 380 * pitch, 1.5)).connect(this.env(t, 0.3, 0.001, 0.05)).connect(o);
  }

  /** A hand clap: two quick noise bursts a hair apart. */
  clap(w: Where) {
    if (!this.live || !this.allow('tools')) return;
    const t = this.ctx!.currentTime + 0.003;
    const o = this.out('tools', w);
    for (const [dt, a] of [[0, 1.0], [0.008, 1.4]] as const) {
      this.noiseSrc(t + dt, 0.06).connect(this.filter('bandpass', rand(1000, 1400), 1.2)).connect(this.filter('lowpass', 3000, 0.5)).connect(this.env(t + dt, a, 0.001, 0.05)).connect(o);
    }
  }

  /**
   * One bowed fiddle note: two slightly detuned saws, darkened, with a wooden
   * body resonance, a delayed vibrato and a little bow scratch at the start.
   */
  fiddleNote(f: number, dur: number, w: Where) {
    if (!this.live || !this.allow('music')) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.005;
    const o = this.out('music', w);
    const env = ctx.createGain();
    const end = t + Math.max(0.08, dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.22, t + 0.035);
    env.gain.setValueAtTime(0.2, end - 0.05);
    env.gain.exponentialRampToValueAtTime(0.0001, end + 0.06);
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.6;
    const vibAmt = ctx.createGain();
    vibAmt.gain.setValueAtTime(0, t);
    vibAmt.gain.linearRampToValueAtTime(f * 0.007, t + Math.min(0.25, dur)); // vibrato blooms in
    vib.connect(vibAmt);
    vib.start(t);
    vib.stop(end + 0.1);
    const tone = this.filter('lowpass', 2600, 0.6);
    for (const det of [0.998, 1.003]) {
      const s = this.tone('sawtooth', t, f * det, f * det, end - t + 0.06);
      vibAmt.connect(s.frequency);
      s.connect(tone);
    }
    // body: a couple of wooden resonances on top of the plain tone
    const body1 = this.filter('peaking', 450, 1.5);
    body1.gain.value = 6;
    const body2 = this.filter('peaking', 1100, 2);
    body2.gain.value = 4;
    tone.connect(body1).connect(body2).connect(env).connect(o);
    // bow scratch at the attack
    this.noiseSrc(t, 0.06).connect(this.filter('bandpass', 2400, 1.5)).connect(this.env(t, 0.035, 0.003, 0.04)).connect(o);
  }

  /**
   * A banjo string: a bright pluck that dies fast. The skin head gives it a
   * nasal ring (a resonance around 1.8 kHz) and the filter closes as the
   * note decays; a click from the fingernail on the attack.
   */
  /**
   * Banjo, clawhammer style, where the three strokes of bum-ditty sound
   * different: the melody note (bum) struck firm with the nail and left to
   * ring; the brush (dit) a quick rake down across the strings with a
   * scratch of nail, ringing a while before the hand comes round again; the
   * thumb's drone (ty) light and short, and a hair early, pushing on into
   * the next beat. (Early can't be scheduled before the frame that asks for
   * it, so the bum and the dit sound a little after theirs instead.)
   */
  banjoNote(fs: number[], kind: 'bum' | 'brush' | 'thumb', w: Where) {
    if (!this.live || !this.allow('music')) return;
    const EARLY = 0.03;
    if (kind === 'brush') {
      // (the hand comes down across the strings from the low one, nearest the face, to the high)
      fs.forEach((f, k) => this.banjoString(f, EARLY + k * 0.008, 0.42 * (1 - 0.08 * k), w, 0.55));
      const t = this.ctx!.currentTime + 0.005 + EARLY;
      this.noiseSrc(t, 0.04).connect(this.filter('bandpass', 5200, 1.4)).connect(this.env(t, 0.16, 0.002, 0.025)).connect(this.out('music', w));
    } else if (kind === 'thumb') this.banjoString(fs[0], 0, 0.38, w, 0.4);
    else this.banjoString(fs[0], EARLY, 1, w, 1);
  }

  /**
   * A dog's bark: a short voiced burst whose pitch drops, through a mouth
   * resonance, with a breathy edge; smaller dogs higher and yappier
   * (`size` ~0.7 small … 1.2 big).
   */
  woof(size: number, w: Where) {
    if (!this.live || !this.allow('voices')) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.005;
    const o = this.out('voices', w);
    const f0 = 260 / size; // (an octave down from where it started: deeper, less yappy)
    const dur = 0.11 + 0.06 * size;
    const src = this.tone('sawtooth', t, f0, f0 * 0.62, dur);
    const mouth = this.filter('bandpass', 1300 / Math.sqrt(size), 1.6);
    mouth.frequency.setValueAtTime(1500 / Math.sqrt(size), t);
    mouth.frequency.exponentialRampToValueAtTime(800 / Math.sqrt(size), t + dur);
    const body = this.filter('lowpass', 2600, 0.8);
    src.connect(mouth).connect(body).connect(this.env(t, 0.55, 0.008, dur)).connect(o);
    // the breath of it
    this.noiseSrc(t, dur).connect(this.filter('bandpass', 1800, 1.2)).connect(this.env(t, 0.12, 0.004, dur * 0.8)).connect(o);
  }

  /**
   * Double bass, plucked: a round, woody low note (the fundamental with a
   * couple of harmonics so small speakers still carry it), a soft thump at
   * the start, a long-ish fade.
   */
  bassNote(f: number, w: Where) {
    if (!this.live || !this.allow('music')) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.005;
    const o = this.out('music', w);
    const decay = 1.1;
    const lp = this.filter('lowpass', 900, 0.9);
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(320, t + 0.35);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.42, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.14, t + 0.25);
    env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const parts: [OscillatorType, number, number][] = [['sine', 1, 1], ['triangle', 2, 0.45], ['sine', 3, 0.22]];
    for (const [type, h, g] of parts) {
      const gn = ctx.createGain();
      gn.gain.value = g;
      this.tone(type, t, f * h * 1.004, f * h, decay).connect(gn).connect(lp);
    }
    lp.connect(env).connect(o);
    // the finger leaving the string
    this.noiseSrc(t, 0.03).connect(this.filter('lowpass', 500, 1)).connect(this.env(t, 0.12, 0.002, 0.03)).connect(o);
  }

  /** One banjo string: `ring` scales how long it sounds (a muted string stops short). */
  private banjoString(f: number, delay: number, gain: number, w: Where, ring: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.005 + delay;
    const o = this.out('music', w);
    const decay = (0.9 * Math.min(1, 330 / f) + 0.25) * ring;
    const lp = this.filter('lowpass', 5200, 1.2);
    lp.frequency.setValueAtTime(5200, t);
    lp.frequency.exponentialRampToValueAtTime(1100, t + decay * 0.5);
    const head = this.filter('peaking', 1800, 2.2);
    head.gain.value = 7;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.34 * gain, t + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const saw = this.tone('sawtooth', t, f * 1.008, f, decay);
    const oct = this.tone('triangle', t, f * 2.01, f * 2, decay * 0.6);
    const ov = ctx.createGain();
    ov.gain.value = 0.35;
    saw.connect(lp);
    oct.connect(ov).connect(lp);
    lp.connect(head).connect(this.filter('highpass', 140, 0.7)).connect(env).connect(o);
    this.noiseSrc(t, 0.012).connect(this.filter('bandpass', 3200, 2)).connect(this.env(t, 0.08, 0.0005, 0.008)).connect(o);
  }

  /** A swept noise band: whooshes, rustles, splashes. */
  private noiseSweep(t: number, o: AudioNode, f0: number, f1: number, q: number, peak: number, attack: number, dur: number) {
    const f = this.filter('bandpass', f0, q);
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    this.noiseSrc(t, dur + attack).connect(f).connect(this.env(t, peak, attack, dur)).connect(o);
  }

  /**
   * Sounds of the outdoor chores: axe, falling tree, leaves, apples, and
   * fishing (cast, float, splashes, the reel's ratchet).
   */
  chore(kind: 'chop' | 'crack' | 'whump' | 'rustle' | 'snap' | 'crunch' | 'whoosh' | 'plop' | 'splash' | 'tick' | 'munch' | 'gulp' | 'clunk' | 'scrape' | 'shave' | 'clank', w: Where) {
    // the reel's ratchet ticks fast and quietly: not worth a rate-limit token
    if (!this.live || (kind !== 'tick' && !this.allow('tools'))) return;
    const t = this.ctx!.currentTime + 0.003;
    const o = this.out('tools', w);
    switch (kind) {
      case 'chop': {
        // axe into wood: a hard knock with a hollow body, a splintery crack on top
        this.noiseSrc(t, 0.02).connect(this.filter('bandpass', 2600, 1.2)).connect(this.env(t, 0.5, 0.001, 0.012)).connect(o);
        const f = rand(170, 210);
        this.tone('triangle', t, f * 1.4, f, 0.1).connect(this.env(t, 0.5, 0.001, 0.08)).connect(o);
        this.tone('sine', t, 95, 50, 0.12).connect(this.env(t, 0.6, 0.002, 0.1)).connect(o);
        this.noiseSrc(t, 0.07).connect(this.filter('bandpass', 700, 2.5)).connect(this.env(t, 0.35, 0.001, 0.05)).connect(o);
        break;
      }
      case 'crack': {
        // the hinge giving way: a long creak that falls in pitch, with splinters
        const dur = 0.9;
        const src = this.tone('sawtooth', t, rand(60, 70), 34, dur);
        const f = this.filter('bandpass', 600, 5);
        f.frequency.setValueAtTime(700, t);
        f.frequency.exponentialRampToValueAtTime(260, t + dur);
        src.connect(f).connect(this.env(t, 1.3, 0.05, dur)).connect(o);
        for (let k = 0; k < 5; k++) {
          const tk = t + rand(0, 0.5);
          this.noiseSrc(tk, 0.02).connect(this.filter('bandpass', rand(1800, 3200), 2)).connect(this.env(tk, 0.6, 0.001, 0.015)).connect(o);
        }
        break;
      }
      case 'whump': {
        // the trunk hits the ground, the branches thrash
        this.tone('sine', t, 70, 30, 0.35).connect(this.env(t, 1.0, 0.004, 0.3)).connect(o);
        this.noiseSrc(t, 0.2).connect(this.filter('lowpass', 400, 1)).connect(this.env(t, 0.6, 0.003, 0.18)).connect(o);
        this.noiseSweep(t + 0.02, o, 3500, 1800, 0.6, 0.6, 0.02, 0.6);
        break;
      }
      case 'rustle':
        this.noiseSweep(t, o, rand(2600, 3600), rand(3800, 5000), 0.8, 0.3, 0.04, 0.22);
        break;
      case 'snap':
        // the stalk letting go: a tiny dry tick
        this.noiseSrc(t, 0.02).connect(this.filter('bandpass', 3000, 3)).connect(this.env(t, 0.9, 0.001, 0.01)).connect(o);
        this.tone('square', t, 1400, 900, 0.015).connect(this.env(t, 0.05, 0.001, 0.012)).connect(o);
        break;
      case 'crunch':
        // a bite: a rattle of crisp little bursts
        for (let k = 0; k < 6; k++) {
          const tk = t + k * rand(0.018, 0.03);
          this.noiseSrc(tk, 0.025).connect(this.filter('bandpass', rand(1800, 3400), 1.5)).connect(this.env(tk, rand(0.45, 0.75), 0.001, 0.02)).connect(o);
        }
        break;
      case 'whoosh':
        this.noiseSweep(t, o, 500, 2400, 1.2, 0.55, 0.08, 0.25);
        break;
      case 'plop': {
        // a float or a fish going in: the classic rising "bloop"
        this.tone('sine', t, rand(260, 320), rand(900, 1100), 0.06).connect(this.env(t, 0.35, 0.002, 0.07)).connect(o);
        this.noiseSrc(t, 0.05).connect(this.filter('bandpass', 1200, 1)).connect(this.env(t, 0.12, 0.001, 0.04)).connect(o);
        break;
      }
      case 'splash':
        this.noiseSweep(t, o, 1400, 2600, 0.7, 0.55, 0.005, 0.25);
        this.tone('sine', t, rand(400, 500), rand(1100, 1400), 0.05).connect(this.env(t, 0.15, 0.002, 0.05)).connect(o);
        break;
      case 'tick':
        this.noiseSrc(t, 0.01).connect(this.filter('bandpass', 4200, 4)).connect(this.env(t, 0.16, 0.0005, 0.006)).connect(o);
        break;
      case 'munch':
        // chewing with the mouth shut: soft, dull, wet little squelches
        for (let k = 0; k < 3; k++) {
          const tk = t + k * rand(0.17, 0.22);
          this.noiseSrc(tk, 0.06).connect(this.filter('bandpass', rand(450, 750), 2)).connect(this.env(tk, rand(0.35, 0.5), 0.008, 0.05)).connect(o);
          this.tone('sine', tk, rand(140, 170), 90, 0.05).connect(this.env(tk, 0.25, 0.005, 0.04)).connect(o);
        }
        break;
      case 'gulp': {
        // a swallow: a throaty "glk", a low bloop dropping in pitch
        this.noiseSrc(t, 0.03).connect(this.filter('bandpass', 900, 3)).connect(this.env(t, 0.25, 0.002, 0.02)).connect(o);
        const f = rand(210, 250);
        this.tone('sine', t + 0.02, f, f * 0.55, 0.12).connect(this.filter('lowpass', 900, 1)).connect(this.env(t + 0.02, 0.7, 0.01, 0.1)).connect(o);
        break;
      }
      case 'clunk': {
        // a tankard set down on wood: dull knock plus a faint ring of the hoops
        this.tone('sine', t, 180, 90, 0.1).connect(this.env(t, 0.7, 0.002, 0.08)).connect(o);
        this.noiseSrc(t, 0.03).connect(this.filter('bandpass', 1100, 2)).connect(this.env(t, 0.4, 0.001, 0.025)).connect(o);
        const f = rand(1150, 1300);
        [1, 2.7].forEach((k, i) => this.tone('triangle', t, f * k, f * k * 0.99, 0.15).connect(this.env(t, [0.08, 0.04][i], 0.001, 0.12)).connect(o));
        break;
      }
      case 'shave':
        // a draw-knife down a stave: a bright, papery curl of a hiss, falling as the shaving comes off
        this.noiseSweep(t, o, rand(3200, 3800), rand(1700, 2100), 1.8, 0.5, 0.03, 0.4);
        this.noiseSrc(t + 0.05, 0.3).connect(this.filter('bandpass', rand(900, 1100), 1.5)).connect(this.env(t + 0.05, 0.18, 0.05, 0.22)).connect(o);
        break;
      case 'clank': {
        // the hoop driver struck: a hard knock on wood with a short iron ring (the hoop)
        this.noiseSrc(t, 0.02).connect(this.filter('bandpass', 1800, 1.2)).connect(this.env(t, 0.5, 0.0008, 0.012)).connect(o);
        this.tone('sine', t, 260, 140, 0.08).connect(this.env(t, 0.5, 0.001, 0.06)).connect(o);
        const f = rand(1500, 1750);
        [1, 2.4, 4.1].forEach((k, i) => this.tone('triangle', t, f * k, f * k * 0.995, 0.3).connect(this.env(t, [0.12, 0.06, 0.03][i], 0.0008, [0.2, 0.12, 0.06][i])).connect(o));
        break;
      }
      case 'scrape':
        // a bench dragged a few inches over the ground
        this.noiseSweep(t, o, 700, 420, 2.5, 1.1, 0.02, 0.2);
        this.noiseSrc(t, 0.2).connect(this.filter('lowpass', 300, 1)).connect(this.env(t, 0.6, 0.02, 0.16)).connect(o);
        break;
    }
  }

  /** A short wooden creak (sitting down on the bench). */
  creak(w: Where) {
    if (!this.live || !this.allow('tools')) return;
    const t = this.ctx!.currentTime + 0.003;
    const o = this.out('tools', w);
    const dur = 0.22;
    const src = this.tone('sawtooth', t, rand(42, 55), rand(58, 72), dur);
    const f = this.filter('bandpass', 500, 6);
    f.frequency.setValueAtTime(380, t);
    f.frequency.linearRampToValueAtTime(720, t + dur);
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.04);
    g.gain.setValueAtTime(0.3, t + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(o);
  }

  /**
   * Continuous saw: looping noise through a band-pass, chopped by a "teeth"
   * oscillator. Drive every frame with stroke speed 0…1 and direction.
   */
  saw(id: number, active: boolean, speed: number, push: boolean, w: Where) {
    if (!this.ctx) return;
    let s = this.saws.get(id);
    if (!active || !this.live) {
      this.stopSaw(id);
      return;
    }
    const ctx = this.ctx;
    if (!s && this.saws.size >= MAX_SAWS) return; // a couple of saws is plenty
    if (!s) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filt = this.filter('bandpass', 450, 1.4);
      // two low-passes: keep the rasp, lose the hiss
      const lp1 = this.filter('lowpass', 1100, 0.6);
      const lp2 = this.filter('lowpass', 1100, 0.6);
      const chop = ctx.createGain();
      chop.gain.value = 0.55;
      const teeth = ctx.createOscillator();
      teeth.type = 'triangle';
      const depth = ctx.createGain();
      depth.gain.value = 0.6;
      teeth.connect(depth).connect(chop.gain);
      // the bite: each tooth catching, as a ratchety tick in the upper mids.
      // A sawtooth LFO gives a sharp onset per tooth; the band-pass and
      // low-pass after it keep it crisp but not hissy.
      const bite = ctx.createGain();
      bite.gain.value = 1; // 1 − saw(−1…1): jumps to 2 at each tooth, ramps to 0
      const biteLfo = ctx.createOscillator();
      biteLfo.type = 'sawtooth';
      const biteDepth = ctx.createGain();
      biteDepth.gain.value = -1;
      biteLfo.connect(biteDepth).connect(bite.gain);
      const biteBp = this.filter('bandpass', 1500, 2.2);
      const biteLp = this.filter('lowpass', 3000, 0.5);
      const biteLevel = ctx.createGain();
      biteLevel.gain.value = 0.35;
      const amp = ctx.createGain();
      amp.gain.value = 0;
      const pan = ctx.createStereoPanner();
      // teeth chop the noise *before* filtering, so the filters smooth the edges too
      src.connect(chop).connect(filt).connect(lp1).connect(lp2).connect(amp).connect(pan).connect(this.bus.tools);
      src.connect(bite).connect(biteBp).connect(biteLp).connect(biteLevel).connect(amp);
      src.start();
      teeth.start();
      biteLfo.start();
      s = { src, filt, amp, teeth, pan, touched: true, biteLfo, biteBp };
      this.saws.set(id, s);
    }
    s.touched = true;
    const t = ctx.currentTime;
    const k = Math.min(1, speed);
    s.amp.gain.setTargetAtTime(w.gain * 1.3 * k, t, 0.015);
    s.filt.frequency.setTargetAtTime(260 + 480 * k + (push ? 120 : 0), t, 0.02);
    s.teeth.frequency.setTargetAtTime(20 + 60 * k, t, 0.02);
    // teeth bite at the same rate (slightly offset so they don't phase-lock dully)
    s.biteLfo.frequency.setTargetAtTime(22 + 64 * k, t, 0.02);
    s.biteBp.frequency.setTargetAtTime(1200 + 700 * k + (push ? 250 : 0), t, 0.03);
    s.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, w.pan)), t, 0.05);
  }

  private stopSaw(id: number) {
    const s = this.saws.get(id);
    if (!s || !this.ctx) return;
    const t = this.ctx.currentTime;
    s.amp.gain.setTargetAtTime(0, t, 0.03);
    s.src.stop(t + 0.2);
    s.teeth.stop(t + 0.2);
    s.biteLfo.stop(t + 0.2);
    this.saws.delete(id);
  }

  /**
   * Call once per rendered frame: any continuous sound nobody updated since
   * the last sweep (person removed, mode switched, sim paused) fades out.
   */
  sweep() {
    for (const [id, s] of this.saws) {
      if (!s.touched) this.stopSaw(id);
      else s.touched = false;
    }
  }

  /** Is this person mid-phrase? (for conversational turn-taking) */
  speaking(id: number) {
    return !!this.ctx && (this.talking.get(id) ?? 0) > this.ctx.currentTime;
  }

  /**
   * A muttered gibberish phrase: a few vowel syllables on a buzzy source
   * through two formant filters, with occasional consonant ticks, and a
   * falling (or, sometimes, questioning) pitch contour.
   */
  phrase(id: number, v: Voice, w: Where, syllables = 0) {
    if (!this.live) return;
    const ctx = this.ctx!;
    let talkers = 0;
    for (const end of this.talking.values()) if (end > ctx.currentTime) talkers++;
    if (talkers >= MAX_TALKERS || !this.allow('voices')) return;
    const n = syllables || 2 + Math.floor(Math.random() * 4);
    const question = Math.random() < 0.25;
    let t = ctx.currentTime + 0.01;
    const o = this.out('voices', w);
    for (let i = 0; i < n; i++) {
      const dur = rand(0.07, 0.15) / v.rate;
      const u = n > 1 ? i / (n - 1) : 0;
      let pitch = v.f0 * (1.08 - 0.18 * u) * rand(0.95, 1.06);
      if (question && i === n - 1) pitch *= 1.3;
      const glide = question && i === n - 1 ? 1.15 : 0.95;
      if (this.voiceFx.hums && Math.random() < 0.12) {
        // a whole "mm" / "mm-hm" syllable, mouth closed
        this.hum(t, dur * 1.3, pitch, v, o, 0.3, glide);
        t += dur * 1.3 + rand(0.02, 0.06) / v.rate;
        continue;
      }
      let at = t;
      if (this.voiceFx.hums && Math.random() < 0.35) {
        // m/n onset: a short nasal murmur sliding into the vowel
        const hd = rand(0.035, 0.06) / v.rate;
        this.hum(t, hd + 0.02, pitch, v, o, 0.28, 1);
        at = t + hd;
      } else if (Math.random() < 0.45) this.consonant(t, o, v);
      this.syllable(at, dur, pitch, VOWELS[Math.floor(Math.random() * VOWELS.length)], v, o, 0.32, glide);
      t = at + dur + rand(0.02, 0.06) / v.rate;
    }
    this.talking.set(id, t);
  }

  /**
   * The throat: a sawtooth with its top rolled off. Either a steady sine
   * vibrato (classic) or, with `wobble`, the irregular drift and cycle-to-cycle
   * jitter of a real voice.
   */
  private voiceSource(t: number, dur: number, pitch: number, glide: number) {
    const ctx = this.ctx!;
    const src = this.tone('sawtooth', t, pitch, pitch * glide, dur);
    if (this.voiceFx.wobble) {
      // slow wander: random targets every ~40 ms, ±25 cents, joined by ramps
      src.detune.setValueAtTime(this.wob(-20, 20), t);
      for (let k = 0.03 + this.wob(0, 1) * 0.03; k < dur + 0.05; k += this.wob(0.03, 0.06)) src.detune.linearRampToValueAtTime(this.wob(-25, 25), t + k);
      // fast jitter: low-passed noise on the pitch (±~10 cents)
      const jit = this.noiseSrc(t, dur, this.wob(0, 1));
      const jg = ctx.createGain();
      jg.gain.value = 260;
      jit.connect(this.filter('lowpass', 70, 0.5)).connect(jg).connect(src.detune);
    } else {
      const vib = ctx.createOscillator();
      vib.frequency.value = this.wob(4.5, 6.5);
      const vibAmt = ctx.createGain();
      vibAmt.gain.value = pitch * 0.018;
      vib.connect(vibAmt).connect(src.frequency);
      vib.start(t);
      vib.stop(t + dur + 0.05);
    }
    const glottal = this.filter('lowpass', Math.min(2200, pitch * 7), 0.3);
    src.connect(glottal);
    if (!this.voiceFx.wobble) return glottal as AudioNode;
    // shimmer: a little uneven loudness from cycle to cycle
    const sh = ctx.createGain();
    sh.gain.setValueAtTime(1, t);
    for (let k = 0.02; k < dur + 0.05; k += this.wob(0.02, 0.04)) sh.gain.linearRampToValueAtTime(this.wob(0.8, 1.1), t + k);
    return glottal.connect(sh);
  }

  /** Syllable envelope: quick swell, sustain, fade. */
  private voiceEnv(t: number, dur: number, peak: number) {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.025);
    g.gain.setValueAtTime(peak * 0.8, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    return g;
  }

  private syllable(t: number, dur: number, pitch: number, vowel: [number, number], v: Voice, out: AudioNode, peak: number, glide: number) {
    const ctx = this.ctx!;
    const src = this.voiceSource(t, dur, pitch, glide);
    const g = this.voiceEnv(t, dur, peak * Sound.VOICE_GAIN);
    if (this.voiceFx.cascade) {
      // resonators in series, like a vocal tract: each formant is a resonant
      // low-pass, so there's nothing to cancel between them and the natural
      // high-frequency roll-off comes for free (resonance in dB for lowpass)
      const f1 = this.filter('lowpass', vowel[0] * v.formant, 9);
      const f2 = this.filter('lowpass', vowel[1] * v.formant, 11);
      const f3 = this.filter('lowpass', 2600 * v.formant, this.voiceFx.softRing ? 1.5 : 6);
      const lift = this.filter('highshelf', 900 * v.formant, 0); // put back some presence the chain rolls off
      lift.gain.value = 9;
      const mk = ctx.createGain();
      mk.gain.value = 0.32;
      src.connect(f1).connect(f2).connect(f3).connect(lift).connect(mk).connect(g);
    } else {
      // wide-ish formants (narrow ones ring like metal) + a warm body
      const band = (f: number, q: number, gain: number) => {
        const bf = this.filter('bandpass', f, q);
        const bg = ctx.createGain();
        bg.gain.value = gain;
        src.connect(bf).connect(bg).connect(g);
      };
      band(vowel[0] * v.formant, 3, 1);
      band(vowel[1] * v.formant, 4, 0.45);
      if (this.voiceFx.softRing) band(2600 * v.formant, 1.5, 0.05);
      else band(2600 * v.formant, 5, 0.1);
      band(380 * v.formant, 1, 0.35);
    }
    // breath
    this.noiseSrc(t, dur).connect(this.filter('bandpass', 1300 * v.formant, 0.8)).connect(this.env(t, 0.035, 0.02, dur)).connect(g);

    const top = this.filter('lowpass', 3000, 0.5);
    g.connect(top).connect(out);
  }

  /**
   * Mouth closed: a nasal murmur. Low resonance around 250 Hz, a dip around
   * 1 kHz where the closed mouth swallows energy, and very little above.
   */
  private hum(t: number, dur: number, pitch: number, v: Voice, out: AudioNode, peak: number, glide: number) {
    const src = this.voiceSource(t, dur, pitch, glide);
    const g = this.voiceEnv(t, dur, peak * Sound.VOICE_GAIN);
    const nasal = this.filter('lowpass', 280 * v.formant, 8);
    const dip = this.filter('notch', 1000 * v.formant, 2);
    const ring = this.filter('peaking', 2100 * v.formant, 3);
    ring.gain.value = 4;
    const mk = this.ctx!.createGain();
    mk.gain.value = 0.55;
    src.connect(nasal).connect(dip).connect(ring).connect(mk).connect(g).connect(out);
  }

  /** Narrow formant filters eat a lot of energy: make up for it here. */
  private static VOICE_GAIN = 1.5;

  private consonant(t: number, out: AudioNode, v: Voice) {
    this.noiseSrc(t, 0.03)
      .connect(this.filter('bandpass', rand(1600, 3200) * v.formant, 1.5))
      .connect(this.filter('lowpass', 3500, 0.5))
      .connect(this.env(t, 0.07, 0.003, 0.02))
      .connect(out);
  }

  /** Little vocal reactions in the person's own voice. */
  exclaim(kind: 'oof' | 'hup' | 'grunt' | 'gasp' | 'hey' | 'ahh' | 'mmm', v: Voice, w: Where) {
    if (!this.live || !this.allow('voices')) return;
    const t = this.ctx!.currentTime + 0.01;
    const o = this.out('voices', w);
    switch (kind) {
      case 'oof':
        this.consonant(t, o, v);
        this.syllable(t + 0.01, 0.2, v.f0 * 1.15, VOWELS[4], v, o, 0.5, 0.7);
        break;
      case 'hup':
        this.syllable(t, 0.1, v.f0 * 1.1, VOWELS[0], v, o, 0.4, 1.25);
        break;
      case 'grunt':
        this.syllable(t, 0.24, v.f0 * 0.85, VOWELS[3], v, o, 0.35, 0.92);
        break;
      case 'hey':
        this.syllable(t, 0.09, v.f0 * 1.15, VOWELS[1], v, o, 0.35, 1.0);
        this.syllable(t + 0.1, 0.16, v.f0 * 1.35, VOWELS[2], v, o, 0.38, 0.85);
        break;
      case 'ahh':
        // after a good long drink: an open, falling, breathy "aah"
        this.noiseSrc(t, 0.12).connect(this.filter('bandpass', 1500 * v.formant, 1)).connect(this.env(t, 0.06, 0.02, 0.1)).connect(o);
        this.syllable(t + 0.04, 0.45, v.f0 * 1.2, VOWELS[0], v, o, 0.4, 0.7);
        break;
      case 'mmm':
        // satisfied, mouth shut: a hum that rises then settles
        this.hum(t, 0.4, v.f0 * 1.05, v, o, 0.5, 1.15);
        this.hum(t + 0.42, 0.3, v.f0 * 1.15, v, o, 0.45, 0.85);
        break;
      case 'gasp': {
        // a sharp inhale (rising noise) with a hint of "oh"
        const s = this.noiseSrc(t, 0.25);
        const f = this.filter('bandpass', 1200 * v.formant, 3);
        f.frequency.setValueAtTime(900 * v.formant, t);
        f.frequency.linearRampToValueAtTime(2200 * v.formant, t + 0.2);
        s.connect(f).connect(this.env(t, 0.25, 0.03, 0.2)).connect(o);
        this.syllable(t + 0.03, 0.14, v.f0 * 1.4, VOWELS[3], v, o, 0.16, 1.1);
        break;
      }
    }
  }
}

/** A small, soft room: a few early reflections, then a short dark tail. */
function roomImpulse(ctx: BaseAudioContext) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 0.45);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const tt = i / sr;
      // dark noise tail: one-pole low-pass on white noise, gone in ~0.3 s
      lp += 0.25 * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp(-tt / 0.06) * 0.5;
    }
    for (const [ms, a] of [[7, 0.35], [13, 0.22], [21, 0.15], [31, 0.1]]) {
      const i = Math.floor(((ms + c * 2.5) / 1000) * sr);
      d[i] += a * (c ? 0.9 : 1);
    }
  }
  return buf;
}

/** Soft clipping (tanh), normalised so small signals pass at unity gain. */
function satCurve(drive: number) {
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / drive;
  }
  return c;
}

