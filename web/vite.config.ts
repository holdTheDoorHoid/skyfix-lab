import { defineConfig } from 'vitest/config';

// `base: './'` so the built site works from any subdirectory — it is served under
// /skyfix-lab/ on GitHub Pages. Nothing is fetched from a CDN: every asset, including
// the WebAssembly module, is emitted next to the page.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  server: { port: 5173, strictPort: false },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
