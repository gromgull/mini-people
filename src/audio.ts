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
  crunch: boolean;
}

export const defaultAudio: AudioSettings = { enabled: true, volume: 0.7, steps: 0.45, voices: 0.8, tools: 0.8, music: 0.7, crunch: false };

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
  private crusher!: WaveShaperNode;
  private dry!: GainNode;
  private noise!: AudioBuffer;
  private tokens = { steps: 0, voices: 0, tools: 0, music: 0 };
  private lastRefill = 0;
  private saws = new Map<number, { src: AudioBufferSourceNode; filt: BiquadFilterNode; amp: GainNode; teeth: OscillatorNode; pan: StereoPannerNode; touched: boolean; biteLfo: OscillatorNode; biteBp: BiquadFilterNode }>();
  private talking = new Map<number, number>(); // person → end of current phrase (ctx time)

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
    this.dry = ctx.createGain();
    this.crusher = ctx.createWaveShaper();
    this.crusher.curve = crushCurve(5);
    const mix = ctx.createGain();
    mix.connect(this.dry).connect(this.master);
    mix.connect(this.crusher).connect(this.master);
    this.master.connect(comp).connect(ctx.destination);
    this.bus = { steps: ctx.createGain(), voices: ctx.createGain(), tools: ctx.createGain(), music: ctx.createGain() };
    Object.values(this.bus).forEach((g) => g.connect(mix));
    // one second of white noise, shared by every noisy recipe
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.apply();
  }

  /** Push settings (volume, bus levels, crunch) into the graph. */
  apply() {
    if (!this.ctx) return;
    const s = this.settings;
    this.master.gain.value = s.enabled ? s.volume : 0;
    this.bus.steps.gain.value = s.steps;
    this.bus.voices.gain.value = s.voices;
    this.bus.tools.gain.value = s.tools;
    this.bus.music.gain.value = s.music;
    this.dry.gain.value = s.crunch ? 0 : 1;
    this.crusher.disconnect();
    if (s.crunch) this.crusher.connect(this.master);
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

  private noiseSrc(t: number, dur: number) {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(t, Math.random() * 0.9);
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
      if (Math.random() < 0.45) this.consonant(t, o, v);
      this.syllable(t, dur, pitch, VOWELS[Math.floor(Math.random() * VOWELS.length)], v, o, 0.32, question && i === n - 1 ? 1.15 : 0.95);
      t += dur + rand(0.02, 0.06) / v.rate;
    }
    this.talking.set(id, t);
  }

  private syllable(t: number, dur: number, pitch: number, vowel: [number, number], v: Voice, out: AudioNode, peak: number, glide: number) {
    const ctx = this.ctx!;
    // glottal-ish source: a sawtooth with its top rolled off, a gentle vibrato
    // and a little jitter, so it reads as a throat rather than a buzzer
    const src = this.tone('sawtooth', t, pitch, pitch * glide, dur);
    const vib = ctx.createOscillator();
    vib.frequency.value = rand(4.5, 6.5);
    const vibAmt = ctx.createGain();
    vibAmt.gain.value = pitch * 0.018;
    vib.connect(vibAmt).connect(src.frequency);
    vib.start(t);
    vib.stop(t + dur + 0.05);
    const glottal = this.filter('lowpass', Math.min(2200, pitch * 7), 0.3);
    src.connect(glottal);

    const g = ctx.createGain();
    peak *= Sound.VOICE_GAIN;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.025);
    g.gain.setValueAtTime(peak * 0.8, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    // wide-ish formants (narrow ones ring like metal) + a warm body
    const band = (f: number, q: number, gain: number) => {
      const bf = this.filter('bandpass', f, q);
      const bg = ctx.createGain();
      bg.gain.value = gain;
      glottal.connect(bf).connect(bg).connect(g);
    };
    band(vowel[0] * v.formant, 3, 1);
    band(vowel[1] * v.formant, 4, 0.45);
    band(2600 * v.formant, 5, 0.1);
    band(380 * v.formant, 1, 0.35);
    // breath
    this.noiseSrc(t, dur).connect(this.filter('bandpass', 1300 * v.formant, 0.8)).connect(this.env(t, 0.035, 0.02, dur)).connect(g);

    const top = this.filter('lowpass', 3000, 0.5);
    g.connect(top).connect(out);
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
  exclaim(kind: 'oof' | 'hup' | 'grunt' | 'gasp' | 'hey', v: Voice, w: Where) {
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

/** Bit-depth reduction curve for the optional retro crunch. */
function crushCurve(bits: number) {
  const n = 4096;
  const c = new Float32Array(n);
  const steps = 2 ** bits;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * steps) / steps;
  }
  return c;
}
