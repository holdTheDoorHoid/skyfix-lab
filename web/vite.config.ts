import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import { skyfixPwa } from './plugins/pwa.ts';

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

/**
 * The pages the site ships: the current workbench at /, the new explorer at /next/
 * (docs/EXPLORER_PLAN.md). Both work offline (plugins/pwa.ts).
 */
const APP_PAGES = {
  main: resolve(import.meta.dirname, 'index.html'),
  next: resolve(import.meta.dirname, 'next/index.html'),
};

/**
 * Developer pages: every other `next/*.html` — the design mockup (`mockup.html`) and each
 * view on its own (`dev-map.html`, `dev-sky.html`, `dev-charts.html`, `dev-almanac.html`,
 * …), for screenshots and frame-time measurements. Found by name, so a new one needs no
 * entry here. `vite` (the development server) serves them; production builds leave them
 * out, so they are never deployed, precached or linked. `SKYFIX_DEV_PAGES=1 npm run build`
 * includes them in a local build.
 */
function devPages(): Record<string, string> {
  const dir = resolve(import.meta.dirname, 'next');
  const pages: Record<string, string> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.html') || file === 'index.html') continue;
    const name = file.replace(/\.html$/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (name in APP_PAGES) throw new Error(`next/${file}: a developer page may not share its input name with an app page`);
    pages[name] = resolve(dir, file);
  }
  return pages;
}

// `base: './'` so the built site works from any subdirectory — it is served under
// /skyfix-lab/ on GitHub Pages. Nothing is fetched from a CDN: every asset, including
// the WebAssembly module, is emitted next to the page.
export default defineConfig(({ command }) => {
  const withDevPages = command === 'serve' || process.env.SKYFIX_DEV_PAGES === '1';
  return {
    base: './',
    plugins: [
      requireWasmPackage(),
      skyfixPwa({
        pages: [
          { file: 'next/index.html', label: 'SkyFix Lab explorer' },
          { file: 'index.html', label: 'SkyFix Lab workbench' },
        ],
        // Chunks that only developers load: `?engine=mock` and `?harness` on /next/.
        devModules: ['src/next/engine/mock.ts', 'src/next/harness/harness.ts'],
        manifests: ['data/basemap/manifest.json'],
        extra: [
          'data/gazetteer.json',
          'manifest.webmanifest',
          'icons/icon.svg',
          'icons/icon-maskable.svg',
          'icons/icon-192.png',
          'icons/icon-512.png',
          'icons/icon-maskable-512.png',
          'icons/apple-touch-icon.png',
        ],
        worker: 'src/sw/sw.ts',
        allowOtherPages: withDevPages,
      }),
    ],
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: true,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: { ...APP_PAGES, ...(withDevPages ? devPages() : {}) },
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
  };
});
