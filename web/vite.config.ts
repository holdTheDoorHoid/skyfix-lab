import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

const WASM_ENTRY = resolve(import.meta.dirname, 'src/wasm-pkg/skyfix_wasm.js');

/**
 * A production build with no WebAssembly package would ship a page with nothing to
 * compute with. That is a build failure, not something to discover at runtime and
 * certainly not something to paper over with the mock adapter.
 */
function requireWasmPackage(): Plugin {
  return {
    name: 'skyfix-require-wasm-package',
    apply: 'build',
    buildStart() {
      if (existsSync(WASM_ENTRY)) return;
      this.error(
        'No WebAssembly package in web/src/wasm-pkg.\n' +
          'The site has no numerical core without it, and the mock adapter is a development\n' +
          'tool that must never ship as one.\n\n' +
          '  npm run wasm --prefix web && npm run build --prefix web\n',
      );
    },
  };
}

// `base: './'` so the built site works from any subdirectory — it is served under
// /skyfix-lab/ on GitHub Pages. Nothing is fetched from a CDN: every asset, including
// the WebAssembly module, is emitted next to the page.
export default defineConfig({
  base: './',
  plugins: [requireWasmPackage()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    // Pages while the explorer is built (docs/EXPLORER_PLAN.md): the current workbench
    // at /, the new explorer at /next/, and the explorer's static design mockup at
    // /next/mockup.html (hard-coded numbers, no engine; for design review only).
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        next: resolve(import.meta.dirname, 'next/index.html'),
        mockup: resolve(import.meta.dirname, 'next/mockup.html'),
        // The Charts view on its own, for its developer (charts agent).
        devCharts: resolve(import.meta.dirname, 'next/dev-charts.html'),
        // The Map view on its own, for its developer (map agent).
        devMap: resolve(import.meta.dirname, 'next/dev-map.html'),
      },
    },
  },
  // MapLibre's web worker is an ES module that imports a shared chunk; bundle workers as
  // ES modules so that import survives (the page loads it with `?worker&url`).
  worker: { format: 'es' },
  server: { port: 5173, strictPort: false },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
