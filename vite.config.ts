import { defineConfig } from 'vite';

// Relative base so the build works both at the root and under a sub-path
// (GitHub Pages serves this project from /mini-people/).
export default defineConfig({
  base: './',
});
