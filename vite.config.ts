import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Relative base so the build works both at the root and under a sub-path
// (GitHub Pages serves this project from /mini-people/). Two pages: the
// village (index.html) and the debug page (debug.html), plus demo.html,
// which forwards to it (the old address).
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        village: resolve(__dirname, 'index.html'),
        debug: resolve(__dirname, 'debug.html'),
        demo: resolve(__dirname, 'demo.html'),
      },
    },
  },
});
