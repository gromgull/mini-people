// Render every sound recipe offline (in the headless browser) to WAV files,
// plus a spectrogram sheet, so they can be auditioned without running the app.
//   node scripts/sounds.mjs [seed=1] [name filter]   (seed also picks the fiddle tune)    → screenshots/sounds/*.wav, screenshots/sounds.png
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const [seed = '1', only] = process.argv.slice(2);
mkdirSync('screenshots/sounds', { recursive: true });
const server = await createServer({ server: { port: 5192, strictPort: true }, logLevel: 'error' });
await server.listen();
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const pg = await b.newPage();
const errors = [];
pg.on('pageerror', (e) => errors.push(String(e)));
await pg.goto(`http://localhost:5192/demo.html?seed=${seed}&count=24&paused&nogui&mode=stand`);
await pg.waitForFunction(() => window.__mini?.ready);

// name → [seconds, script run inside the page with (s, at, C, voices)]
const RECIPES = {
  'steps-light': [2.2, `for (let k = 0; k < 6; k++) at(k * 0.33, () => s.step({ ...V.mid, weight: 0.1 }, { pan: k % 2 ? 0.15 : -0.15, gain: 1 }));`],
  'steps-heavy': [2.2, `for (let k = 0; k < 6; k++) at(k * 0.36, () => s.step({ ...V.mid, weight: 0.95 }, { pan: k % 2 ? 0.15 : -0.15, gain: 1 }));`],
  'talk-deep': [2.6, `at(0, () => s.phrase(1, V.deep, C)); at(1.3, () => s.phrase(2, V.deep, C));`],
  'talk-mid': [2.6, `at(0, () => s.phrase(1, V.mid, C)); at(1.3, () => s.phrase(2, V.mid, C));`],
  'talk-high': [2.6, `at(0, () => s.phrase(1, V.high, C)); at(1.3, () => s.phrase(2, V.high, C));`],
  'conversation': [4.5, `[0, 0.9, 1.7, 2.6, 3.4].forEach((t, k) => at(t, () => s.phrase(k, k % 2 ? V.high : V.deep, { pan: k % 2 ? 0.4 : -0.4, gain: 1 })));`],
  'voice-before': [9, `const say = (t, k, fn) => at(t, () => { Math.random = R(100 + k); fn(); }); say(0.05, 1, () => s.phrase(1, V.deep, C)); say(1.35, 2, () => s.phrase(2, V.mid, C)); say(2.6, 3, () => s.phrase(3, V.high, C)); [3.9, 4.6, 5.3, 6.0].forEach((t, k) => say(t, 10 + k, () => s.phrase(10 + k, k % 2 ? V.high : V.deep, { pan: k % 2 ? 0.4 : -0.4, gain: 1 }))); say(7.0, 20, () => s.exclaim('hey', V.mid, C)); say(7.6, 21, () => s.exclaim('oof', V.deep, C)); say(8.2, 22, () => s.exclaim('grunt', V.mid, C));`, { wobble: false, cascade: false, hums: false, room: false, softRing: false, warm: false }],
  'voice-now': [9, `const say = (t, k, fn) => at(t, () => { Math.random = R(100 + k); fn(); }); say(0.05, 1, () => s.phrase(1, V.deep, C)); say(1.35, 2, () => s.phrase(2, V.mid, C)); say(2.6, 3, () => s.phrase(3, V.high, C)); [3.9, 4.6, 5.3, 6.0].forEach((t, k) => say(t, 10 + k, () => s.phrase(10 + k, k % 2 ? V.high : V.deep, { pan: k % 2 ? 0.4 : -0.4, gain: 1 }))); say(7.0, 20, () => s.exclaim('hey', V.mid, C)); say(7.6, 21, () => s.exclaim('oof', V.deep, C)); say(8.2, 22, () => s.exclaim('grunt', V.mid, C));`],
  hammer: [2.6, `for (let k = 0; k < 3; k++) at(0.1 + k * 0.85, () => s.hammer(C));`],
  saw: [2.2, `for (let f = 0; f < 120; f++) { const u = f / 60 / 0.62; at(f / 60, () => s.saw(9, u < 3, Math.abs(Math.sin(Math.PI * 2 * u)), u % 1 < 0.5, C)); } at(2.05, () => s.saw(9, false, 0, false, C));`],
  'vocal-reactions': [3.6, `['oof', 'hup', 'grunt', 'gasp', 'hey'].forEach((k, i) => at(0.1 + i * 0.7, () => s.exclaim(k, V.mid, C)));`],
  'fiddle-melody': [35, `const e = 30 / 112; const t = T.makeTune(R(+SEED)); const play = (v, g) => t.parts[v].forEach((n, k) => n.hold && at(0.05 + k * e, () => s.fiddleNote(T.degToHz(n.deg), e * n.hold, g))); play(0, C);`],
  'fiddle-trio': [35, `const e = 30 / 112; const t = T.makeTune(R(+SEED)); const play = (v, g) => t.parts[v].forEach((n, k) => n.hold && at(0.05 + k * e, () => s.fiddleNote(T.degToHz(n.deg), e * n.hold, g))); play(0, { pan: -0.35, gain: 1 }); play(1, { pan: 0.35, gain: 0.85 }); play(2, { pan: 0, gain: 0.9 });`],
  'claps': [4.4, `for (let k = 0; k < 8; k++) at(0.05 + k * 60 / 112, () => s.clap({ pan: k % 2 ? 0.2 : -0.2, gain: 1 }));`],
  'chores': [9, `['chop', 'chop', 'chop'].forEach((k, i) => at(0.1 + i * 0.6, () => s.chore(k, C))); at(1.9, () => s.chore('crack', C)); at(3.0, () => s.chore('whump', C)); at(4.0, () => s.chore('rustle', C)); at(4.3, () => s.chore('rustle', C)); at(4.7, () => s.chore('snap', C)); at(5.1, () => s.chore('crunch', C)); at(5.6, () => s.chore('crunch', C)); at(6.1, () => s.chore('whoosh', C)); at(6.7, () => s.chore('plop', C)); for (let k = 0; k < 14; k++) at(7.1 + k * 0.09, () => s.chore('tick', C)); at(7.3, () => s.chore('splash', C)); at(8.4, () => s.chore('splash', C));`],
  'meal': [7, `at(0.1, () => s.creak(C)); at(0.6, () => s.chore('scrape', C)); at(1.0, () => s.chore('scrape', C)); at(1.6, () => s.chore('crunch', C)); at(2.0, () => s.chore('munch', C)); at(2.9, () => s.chore('munch', C)); at(3.6, () => s.chore('gulp', C)); at(4.05, () => s.chore('gulp', C)); at(4.5, () => s.chore('gulp', C)); at(5.1, () => s.chore('clunk', C)); at(5.5, () => s.exclaim('ahh', V.mid, C)); at(6.3, () => s.exclaim('mmm', V.mid, C));`],
  'banjo': [6, `const e8 = 30 / 112; const G = 196; const hz = (st) => G * 2 ** (st / 12); const bum = [0, 7, 4, 7, 5, 4, 2, 0]; const chord = [[-5, 0, 4, 7], [-5, 2, 7, 11], [-3, 0, 5, 9], [-5, 2, 7, 11]]; /* G D C D, on four strings */ for (let b = 0; b < 4; b++) for (let q = 0; q < 2; q++) { const t0 = 0.1 + (b * 8 + q * 4) * e8; const m = bum[b * 2 + q]; at(t0, () => s.banjoNote([hz(m)], 'bum', C)); at(t0 + 2 * e8, () => s.banjoNote(chord[b].map(hz), 'brush', C)); at(t0 + 3 * e8, () => s.banjoNote([hz(12)], 'thumb', C)); }`],
  'bass': [5, `const e8 = 30 / 112; const G = 98; const hz = (st) => G * 2 ** (st / 12); [0, -5, 0, -5, 7, 2, 7, 2, 5, 0, 5, 0, 0, -5, 0, -5].forEach((st, k) => at(0.1 + k * 2 * e8, () => s.bassNote(hz(st), C)));`],
  'woof': [3, `at(0.1, () => s.woof(1.1, C)); at(0.45, () => s.woof(1.1, C)); at(1.2, () => s.woof(0.75, C)); at(1.42, () => s.woof(0.75, C)); at(1.64, () => s.woof(0.75, C));`],
  'props': [1.6, `at(0.1, () => s.thunk(C, 1)); at(0.6, () => s.thunk(C, 0.8)); at(1.0, () => s.creak(C));`],
};

const NAMES = Object.keys(RECIPES).filter((n) => !only || n.includes(only));
for (const name of NAMES) {
  const [secs, body, fx] = RECIPES[name];
  const b64 = await pg.evaluate(async ([secs, body, seed, fx]) => {
    const s = window.__mini.sound;
    const rnd = Math.random;
    const { defaultVoiceFx } = await import('/src/audio.ts');
    s.voiceFx = { ...defaultVoiceFx, ...fx }; // recipes can switch the warmth off for comparison
    const T = await import('/src/tune.ts');
    const { mulberry32: RNG } = await import('/src/rng.ts');
    const sr = 44100;
    const ctx = new OfflineAudioContext(2, Math.ceil(sr * secs), sr);
    s.start(ctx);
    const C = { pan: 0, gain: 1 };
    const V = {
      deep: { f0: 100, formant: 0.9, rate: 0.85, weight: 0.8 },
      mid: { f0: 160, formant: 1.05, rate: 1, weight: 0.5 },
      high: { f0: 235, formant: 1.22, rate: 1.2, weight: 0.2 },
    };
    // schedule calls at render times by suspending the offline context there
    // (one suspend per render quantum: several calls can share a moment)
    const due = new Map();
    const at = (t, fn) => {
      const q = Math.max(0, Math.round((t * sr) / 128) * 128) / sr;
      if (q === 0) return fn();
      if (q >= secs) return; // past the end of the render
      if (!due.has(q)) {
        due.set(q, []);
        ctx.suspend(q).then(() => { due.get(q).forEach((f) => f()); ctx.resume(); });
      }
      due.get(q).push(fn);
    };
    new Function('s', 'at', 'C', 'V', 'T', 'R', 'SEED', body)(s, at, C, V, T, RNG, seed);
    const buf = await ctx.startRendering();
    Math.random = rnd;
    // 16-bit stereo WAV
    const n = buf.length;
    const out = new DataView(new ArrayBuffer(44 + n * 4));
    const str = (o, t) => [...t].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true);
    out.setUint32(24, sr, true); out.setUint32(28, sr * 4, true); out.setUint16(32, 4, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, n * 4, true);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    let peak = 0, sq = 0;
    for (let i = 0; i < n; i++) {
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      sq += L[i] * L[i] + R[i] * R[i];
      out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
      out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
    }
    const bytes = new Uint8Array(out.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { data: btoa(bin), peak, rms: Math.sqrt(sq / (2 * n)) };
  }, [secs, body, seed, fx ?? {}]);
  writeFileSync(`screenshots/sounds/${name}.wav`, Buffer.from(b64.data, 'base64'));
  console.log(`${name.padEnd(16)} peak ${b64.peak.toFixed(2)}  rms ${b64.rms.toFixed(3)}`);
}
await b.close();
await server.close();

// spectrogram sheet
const pics = [];
for (const name of NAMES) {
  const out = `screenshots/frames/spec-${name}.png`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `screenshots/sounds/${name}.wav`, '-lavfi', `showspectrumpic=s=600x200:legend=0:fscale=log,drawtext=text='${name}':x=8:y=8:fontcolor=white:fontsize=18`, out]);
  pics.push(out);
}
execFileSync('montage', [...pics, '-tile', '2x', '-geometry', '+2+2', '-background', '#222', 'screenshots/sounds.png']);
console.log(errors.length ? `✗ ${errors.join('\n')}` : '✓ screenshots/sounds/*.wav, screenshots/sounds.png');
