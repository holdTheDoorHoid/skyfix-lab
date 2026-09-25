import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import { PACKS_DIR, skyfixPacks } from './plugins/packs.ts';
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
 * The page the site ships: the explorer, at the site's home page (switched over on
 * 2026-09-24). It works offline (plugins/pwa.ts).
 */
const APP_PAGES = {
  explorer: resolve(import.meta.dirname, 'index.html'),
};

/**
 * The original workbench's views, and where each went when it was retired
 * (docs/EXPANSION_PLAN.md §2.4): observations, corrections, the fix and the planner are
 * Navigate; the simulator is Learn; anything else, the bare address included, Navigate.
 */
export const CLASSIC_VIEWS = {
  map: { observations: 'navigate', corrections: 'navigate', fix: 'navigate', planner: 'navigate', simulator: 'learn', about: 'about' },
  fallback: 'navigate',
} as const;

/**
 * Addresses that moved. Each page only forwards to the home page, and the service worker
 * answers the same forward itself, offline too.
 *
 * - /next/ was the explorer's address while it was built: its fragment (share links carry
 *   the place in it) is kept as it is.
 * - /classic/ was the original workbench, retired in the expansion programme: its views'
 *   fragments are mapped to the explorer's (`CLASSIC_VIEWS`), and the query is kept.
 */
const REDIRECT_PAGES = {
  next: { file: 'next/index.html', from: 'next/', to: './' },
  classic: { file: 'classic/index.html', from: 'classic/', to: './', fragments: CLASSIC_VIEWS },
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
    if (name in APP_PAGES || name in REDIRECT_PAGES) {
      throw new Error(`next/${file}: a developer page may not share its input name with a page the site ships`);
    }
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
      // Before the pwa plugin: it writes data/packs/manifest.json, which is precached.
      skyfixPacks(),
      skyfixPwa({
        pages: [{ file: 'index.html', label: 'SkyFix Lab explorer' }],
        redirects: Object.values(REDIRECT_PAGES),
        // The data packs: downloaded only when a person asks, and kept by the page itself.
        networkOnly: [`${PACKS_DIR}/`],
        // The manual (mdBook, added by the Pages workflow): pages read online stay readable.
        links: [{ url: 'docs/', label: 'The SkyFix Lab manual (the pages you have read before)' }],
        // Chunks that only developers load: `?engine=mock` (the mock engine and its
        // navigation tools) and `?harness` on the explorer.
        devModules: ['src/next/engine/mock.ts', 'src/next/engine/mock-nav.ts', 'src/next/harness/harness.ts'],
        manifests: ['data/basemap/manifest.json'],
        extra: [
          'data/gazetteer.json',
          `${PACKS_DIR}/manifest.json`,
          'manifest.webmanifest',
          'icons/icon.svg',
          'icons/icon-maskable.svg',
          'icons/icon-192.png',
          'icons/icon-512.png',
          'icons/icon-maskable-512.png',
          'icons/apple-touch-icon.png',
          // The typefaces' licence, shipped with them as the SIL OFL asks (verify2).
          'licenses/inter-OFL.txt',
          'licenses/jetbrains-mono-OFL.txt',
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
        input: {
          ...APP_PAGES,
          ...Object.fromEntries(Object.entries(REDIRECT_PAGES).map(([name, r]) => [name, resolve(import.meta.dirname, r.file)])),
          ...(withDevPages ? devPages() : {}),
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
  };
});
