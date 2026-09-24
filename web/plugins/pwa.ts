/**
 * The offline app, at build time: the precache list, the service worker and the checks
 * around them. OWNER: release agent. Wired in web/vite.config.ts; production builds only.
 *
 * At the end of `vite build` (`closeBundle`: every file is on disk, public/ included):
 *
 *  1. Refuse HTML pages that are not app pages. Developer pages (next/dev-*.html,
 *     next/mockup.html) are served by `vite` in development only; one reaching the
 *     production build means vite.config.ts lost that rule, and it would be deployed.
 *  2. Work out the precache (precache.ts): the app's pages and every hashed file they
 *     reach, minus development-only chunks (the mock engine, the developer harness);
 *     plus the basemap files its manifest lists, the gazetteer, the web app manifest and
 *     the icons.
 *  3. Compile src/sw/sw.ts into `<site>/sw.js` with that list and its version hash
 *     inlined. Any change to a precached file changes sw.js, which is how browsers learn
 *     that a new version exists.
 *
 * No service-worker library: the worker is about 200 lines (src/sw/), and a library would
 * be a dependency to audit for a job this small.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build, type Plugin, type ResolvedConfig } from 'vite';
import type { SwBuild } from '../src/sw/policy.ts';
import { listedFiles, pageAddress, precacheList, type PrecacheList } from './precache.ts';

export interface PwaOptions {
  /** The app's pages (site paths) and how the offline page names them. */
  readonly pages: readonly { readonly file: string; readonly label: string }[];
  /** Source modules (relative to the Vite root) whose chunks are development tools. */
  readonly devModules: readonly string[];
  /** Site paths of JSON manifests whose `files[].path` are precached too, with the manifest. */
  readonly manifests: readonly string[];
  /** Further site paths precached as they are: data files, the web app manifest, icons. */
  readonly extra: readonly string[];
  /** The service worker's source, relative to the Vite root. */
  readonly worker: string;
  /** Allow HTML pages other than `pages` in the output (never precached). Default false. */
  readonly allowOtherPages?: boolean;
}

/** The worker's file name. It must sit at the site root, so that its scope is the whole site. */
export const WORKER_FILE = 'sw.js';

function readSite(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    files.set(relative(dir, full).split(sep).join('/'), readFileSync(full));
  }
  return files;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

async function compileWorker(config: ResolvedConfig, outDir: string, source: string, data: SwBuild): Promise<void> {
  await build({
    configFile: false,
    root: config.root,
    mode: config.mode,
    logLevel: 'warn',
    publicDir: false,
    define: { __SKYFIX_SW_BUILD__: JSON.stringify(data) },
    build: {
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      target: 'es2022',
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
      lib: {
        entry: resolve(config.root, source),
        formats: ['iife'],
        name: 'SkyfixServiceWorker',
        fileName: () => WORKER_FILE,
      },
    },
  });
}

export function skyfixPwa(options: PwaOptions): Plugin {
  let config: ResolvedConfig;
  let bundled = false;
  const devFiles = new Set<string>();

  return {
    name: 'skyfix-pwa',
    apply: 'build',

    configResolved(resolved) {
      config = resolved;
    },

    buildStart() {
      // The pages find sw.js one directory above their modules (src/pwa/register.ts).
      if (config.build.assetsDir !== 'assets') {
        this.error(`skyfix-pwa: build.assetsDir must be "assets" (src/pwa/register.ts expects ../${WORKER_FILE} from a module)`);
      }
    },

    generateBundle(_output, bundle) {
      // Chunks of development-only modules, and stylesheets only they use.
      const dev = new Set(options.devModules.map((m) => resolve(config.root, m)));
      const kept = new Set<string>();
      const devCss = new Set<string>();
      for (const out of Object.values(bundle)) {
        if (out.type !== 'chunk') continue;
        const css = out.viteMetadata?.importedCss ?? new Set<string>();
        if (out.facadeModuleId && dev.has(out.facadeModuleId)) {
          devFiles.add(out.fileName);
          for (const c of css) devCss.add(c);
        } else {
          for (const c of css) kept.add(c);
        }
      }
      for (const c of devCss) if (!kept.has(c)) devFiles.add(c);
      bundled = true;
    },

    async closeBundle() {
      if (!bundled) return; // the build failed before writing anything
      const outDir = resolve(config.root, config.build.outDir);
      const files = readSite(outDir);
      files.delete(WORKER_FILE);

      const pages = options.pages.map((p) => p.file);
      const others = [...files.keys()].filter((f) => /\.html?$/i.test(f) && !pages.includes(f));
      if (others.length > 0 && !options.allowOtherPages) {
        throw new Error(
          `skyfix-pwa: ${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} in the production build but not an app page.\n` +
            'Developer pages are served by `vite` in development only (web/vite.config.ts); SKYFIX_DEV_PAGES=1 builds\n' +
            'them for local use. A page meant for visitors belongs in the pwa plugin\'s `pages`, so it works offline.',
        );
      }

      const listed = options.manifests.flatMap((m) => {
        const text = files.get(m);
        if (!text) throw new Error(`skyfix-pwa: ${m} is not in the built site`);
        return listedFiles(m, new TextDecoder().decode(text));
      });
      const list: PrecacheList = precacheList({
        files,
        pages,
        extra: [...listed, ...options.extra],
        exclude: devFiles,
      });

      await compileWorker(config, outDir, options.worker, {
        version: list.version,
        entries: list.entries.map(({ url, rev }) => ({ url, rev })),
        pages: options.pages.map((p) => ({ url: pageAddress(p.file), label: p.label })),
      });

      const gzip = list.entries.reduce((sum, e) => sum + gzipSync(files.get(e.url) as Uint8Array).byteLength, 0);
      const log = config.logger;
      log.info(
        `skyfix-pwa: ${WORKER_FILE} precaches ${list.entries.length} files, ${megabytes(list.bytes)} ` +
          `(${megabytes(gzip)} gzipped), version ${list.version}`,
      );
      if (list.unreached.length > 0) {
        log.info(
          `skyfix-pwa: not precached (development only, or reached by no page): ` +
            list.unreached.map((f) => `${f} (${Math.round((files.get(f)?.byteLength ?? 0) / 1000)} kB)`).join(', '),
        );
      }
      if (list.unlisted.length > 0) {
        // Normally empty. A data file the app loads must be listed in `extra`, or it will
        // not work offline; developer pages (SKYFIX_DEV_PAGES=1) are expected here.
        log.warn(`skyfix-pwa: in the site but not precached: ${list.unlisted.join(', ')}`);
      }
    },
  };
}
