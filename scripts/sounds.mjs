// Render every sound recipe offline (in the headless browser) to WAV files,
// plus a spectrogram sheet, so they can be auditioned without running the app.
//   node scripts/sounds.mjs [seed=1]    → screenshots/sounds/*.wav, screenshots/sounds.png
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const [seed = '1'] = process.argv.slice(2);
mkdirSync('screenshots/sounds', { recursive: true });
const server = await createServer({ server: { port: 5192, strictPort: true }, logLevel: 'error' });
await server.listen();
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const pg = await b.newPage();
const errors = [];
pg.on('pageerror', (e) => errors.push(String(e)));
await pg.goto(`http://localhost:5192/?seed=${seed}&count=24&paused&nogui&mode=stand`);
await pg.waitForFunction(() => window.__mini?.ready);

// name → [seconds, script run inside the page with (s, at, C, voices)]
const RECIPES = {
  'steps-light': [2.2, `for (let k = 0; k < 6; k++) at(k * 0.33, () => s.step({ ...V.mid, weight: 0.1 }, { pan: k % 2 ? 0.15 : -0.15, gain: 1 }));`],
  'steps-heavy': [2.2, `for (let k = 0; k < 6; k++) at(k * 0.36, () => s.step({ ...V.mid, weight: 0.95 }, { pan: k % 2 ? 0.15 : -0.15, gain: 1 }));`],
  'talk-deep': [2.6, `at(0, () => s.phrase(1, V.deep, C)); at(1.3, () => s.phrase(2, V.deep, C));`],
  'talk-mid': [2.6, `at(0, () => s.phrase(1, V.mid, C)); at(1.3, () => s.phrase(2, V.mid, C));`],
  'talk-high': [2.6, `at(0, () => s.phrase(1, V.high, C)); at(1.3, () => s.phrase(2, V.high, C));`],
  'conversation': [4.5, `[0, 0.9, 1.7, 2.6, 3.4].forEach((t, k) => at(t, () => s.phrase(k, k % 2 ? V.high : V.deep, { pan: k % 2 ? 0.4 : -0.4, gain: 1 })));`],
  hammer: [2.6, `for (let k = 0; k < 3; k++) at(0.1 + k * 0.85, () => s.hammer(C));`],
  saw: [2.2, `for (let f = 0; f < 120; f++) { const u = f / 60 / 0.62; at(f / 60, () => s.saw(9, u < 3, Math.abs(Math.sin(Math.PI * 2 * u)), u % 1 < 0.5, C)); } at(2.05, () => s.saw(9, false, 0, false, C));`],
  'vocal-reactions': [3.6, `['oof', 'hup', 'grunt', 'gasp', 'hey'].forEach((k, i) => at(0.1 + i * 0.7, () => s.exclaim(k, V.mid, C)));`],
  'fiddle': [4.4, `const e = 30 / 112; [0,2,4,7,9,7,4,2,0,4,7,12,9,7,4,0].forEach((d, k) => at(0.05 + k * e, () => s.fiddleNote(293.66 * 2 ** (d / 12), e * (k === 15 ? 2 : 1), C)));`],
  'claps': [2.4, `for (let k = 0; k < 8; k++) at(0.05 + k * 60 / 112, () => s.clap({ pan: k % 2 ? 0.2 : -0.2, gain: 1 }));`],
  'props': [1.6, `at(0.1, () => s.thunk(C, 1)); at(0.6, () => s.thunk(C, 0.8)); at(1.0, () => s.creak(C));`],
};

for (const [name, [secs, body]] of Object.entries(RECIPES)) {
  const b64 = await pg.evaluate(async ([secs, body]) => {
    const s = window.__mini.sound;
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
    const at = (t, fn) => {
      const q = Math.max(0, Math.round((t * sr) / 128) * 128) / sr;
      if (q === 0) fn();
      else ctx.suspend(q).then(() => { fn(); ctx.resume(); }).catch(() => fn());
    };
    new Function('s', 'at', 'C', 'V', body)(s, at, C, V);
    const buf = await ctx.startRendering();
    // 16-bit stereo WAV
    const n = buf.length;
    const out = new DataView(new ArrayBuffer(44 + n * 4));
    const str = (o, t) => [...t].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true);
    out.setUint32(24, sr, true); out.setUint32(28, sr * 4, true); out.setUint16(32, 4, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, n * 4, true);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    let peak = 0;
    for (let i = 0; i < n; i++) {
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
      out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
    }
    const bytes = new Uint8Array(out.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { data: btoa(bin), peak };
  }, [secs, body]);
  writeFileSync(`screenshots/sounds/${name}.wav`, Buffer.from(b64.data, 'base64'));
  console.log(`${name.padEnd(16)} peak ${b64.peak.toFixed(2)}`);
}
await b.close();
await server.close();

// spectrogram sheet
const pics = [];
for (const name of Object.keys(RECIPES)) {
  const out = `screenshots/frames/spec-${name}.png`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `screenshots/sounds/${name}.wav`, '-lavfi', `showspectrumpic=s=600x200:legend=0:fscale=log,drawtext=text='${name}':x=8:y=8:fontcolor=white:fontsize=18`, out]);
  pics.push(out);
}
execFileSync('montage', [...pics, '-tile', '2x', '-geometry', '+2+2', '-background', '#222', 'screenshots/sounds.png']);
console.log(errors.length ? `✗ ${errors.join('\n')}` : '✓ screenshots/sounds/*.wav, screenshots/sounds.png');
