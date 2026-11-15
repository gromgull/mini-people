// Many village days at once: every village seed × every rng (see
// village-test.mjs), a few at a time in parallel, and a list of the ones
// that failed with what went wrong, each with the line that runs it again.
//
//   node scripts/village-sweep.mjs [seeds=3,5,7,11,13,17] [rngs=1-6] [parallel=6] [seconds=900] [more address arguments…]
//   node scripts/village-sweep.mjs 3,5 1-3 4 900 trip=40
import { spawn } from 'node:child_process';

const [seedArg = '3,5,7,11,13,17', rngArg = '1-6', par = '6', seconds = '900', ...extra] = process.argv.slice(2);
const list = (s) => s.split(',').flatMap((p) => {
  const [a, b] = p.split('-').map(Number);
  return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, k) => a + k);
});
const runs = list(seedArg).flatMap((seed) => list(rngArg).map((rng) => ({ seed, rng })));

const run = ({ seed, rng }) =>
  new Promise((resolve) => {
    const args = ['scripts/village-test.mjs', seconds, String(seed), `rng=${rng}`, ...extra];
    const p = spawn('node', args);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ seed, rng, code, out, cmd: `node ${args.join(' ')}` }));
  });

const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(Number(par), runs.length) }, async () => {
    while (next < runs.length) {
      const r = await run(runs[next++]);
      results.push(r);
      process.stdout.write(r.code === 0 ? '.' : 'x');
    }
  }),
);
console.log();
const failed = results.filter((r) => r.code !== 0).sort((a, b) => a.seed - b.seed || a.rng - b.rng);
for (const r of failed) {
  const why = r.out.split('\n').filter((l) => /^ {2}(t=|the |no |only |nobody|\d+ kegs)/.test(l) || /Error/.test(l)).slice(0, 4);
  console.log(`✗ seed ${r.seed} rng ${r.rng}:\n${why.map((l) => `    ${l.trim()}`).join('\n')}\n    (${r.cmd})`);
}
console.log(`${results.length - failed.length}/${results.length} days passed`);
process.exit(failed.length ? 1 : 0);
