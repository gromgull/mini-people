// The shared start of every script that drives the app in a headless
// browser: the dev server on a free port (so scripts can run side by side),
// chromium with software GL, the page's errors collected, and optionally a
// seeded Math.random in every page load (so paused scenes come out the same
// every time).
//
//   const h = await open({ viewport: { width: 640, height: 400 }, seeded: true });
//   await h.page.goto(h.url('mode=single&paused'));        // debug.html
//   await h.page.goto(h.url('seed=3&paused', 'index.html')); // the village
//   await h.ready();                                        // window.__mini is up
//   ...
//   await h.close();
//   if (h.errors.length) ...
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createServer as tcp } from 'node:net';

/** chromium flags for WebGL without a GPU. */
export const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = tcp();
    s.unref();
    s.on('error', reject);
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/**
 * @param {{ viewport?: { width: number, height: number }, seeded?: boolean, args?: string[] }} [opts]
 *   viewport: the page's size; seeded: a seeded Math.random in every load; args: more chromium flags
 */
export async function open({ viewport, seeded = false, args = [] } = {}) {
  const port = await freePort();
  const server = await createServer({ root: process.cwd(), server: { port, strictPort: true }, logLevel: 'error' });
  await server.listen();
  const browser = await chromium.launch({ args: [...GL_ARGS, ...args] });
  const page = await browser.newPage(viewport ? { viewport } : {});
  if (seeded) {
    await page.addInitScript(() => {
      let a = 12345;
      Math.random = () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    });
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return {
    page,
    browser,
    errors,
    port,
    /** An address on the dev server: debug.html unless another page is named. */
    url: (query = '', file = 'debug.html') => `http://localhost:${port}/${file}?${query}`,
    /** Wait for the page's test hook (window.__mini) to be ready. */
    ready: (timeout = 20000) => page.waitForFunction(() => window.__mini?.ready, null, { timeout }),
    close: async () => {
      await browser.close();
      await server.close();
    },
  };
}
