/**
 * The precache list: which files of a built site the service worker stores so the app
 * works offline. Pure (no file system): web/plugins/pwa.ts reads the built site and hands
 * it here; web/test/pwa-precache.test.ts tests it. OWNER: release agent.
 *
 * The app shell is found by following references, not by a list someone has to keep up
 * to date:
 *
 *   start from the app's pages (index.html);
 *   in every text file reached (HTML, JavaScript, CSS, JSON, SVG), look for the name of
 *   every hashed file in `assets/`; each name that appears is a file the page can load:
 *     HTML -> entry scripts, preloads, stylesheets
 *     JavaScript -> chunks it imports, including lazy ones (the views), the WebAssembly
 *                   module, the map's worker, fonts imported with `?url`
 *     CSS -> fonts
 *   files in `exclude` (development-only chunks) are neither stored nor followed.
 *
 * Vite gives every file in `assets/` a content hash in its name, so a name appearing by
 * accident in another file does not happen in practice. Files outside `assets/` (the
 * map data, the web app manifest, the icons) are never discovered this way; they are
 * listed by the caller in `extra`.
 */

import { createHash } from 'node:crypto';
import { posix } from 'node:path';

/** Same digest and length as `revision` in src/sw/policy.ts (a test keeps them equal). */
export function revisionOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export interface PrecacheInput {
  /** Every file of the built site: path relative to the site root (`assets/x.js`) -> bytes. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The app's pages, where the search starts. */
  readonly pages: readonly string[];
  /** Precached as they are, never searched: data files, the web app manifest, icons. */
  readonly extra: readonly string[];
  /** Neither stored nor followed. */
  readonly exclude?: ReadonlySet<string>;
  /** The directory of hashed build output. Default `assets/`. */
  readonly assetsDir?: string;
}

export interface PrecacheEntry {
  /** Relative to the site root. */
  readonly url: string;
  /** `revisionOf` the file. */
  readonly rev: string;
  readonly bytes: number;
}

export interface PrecacheList {
  /** Sorted by URL. */
  readonly entries: readonly PrecacheEntry[];
  /** Hash of every entry's URL and revision: changes when anything precached changes. */
  readonly version: string;
  /** Total bytes, uncompressed. */
  readonly bytes: number;
  /** Files in the assets directory that no page reaches, or that were excluded. */
  readonly unreached: readonly string[];
  /**
   * Other files of the site that are not precached (public/ files nobody listed, pages
   * that are not app pages). A new data file the app loads belongs in `extra`.
   */
  readonly unlisted: readonly string[];
}

const TEXT = /\.(?:html?|m?js|css|json|webmanifest|svg|txt)$/i;

function normalise(path: string): string {
  const p = posix.normalize(path.replace(/\\/g, '/')).replace(/^\.\//, '');
  if (p.startsWith('/') || p.startsWith('../')) throw new Error(`site paths are relative to the site root: ${path}`);
  return p;
}

export function precacheList(input: PrecacheInput): PrecacheList {
  const assetsDir = `${normalise(input.assetsDir ?? 'assets').replace(/\/$/, '')}/`;
  const exclude = input.exclude ?? new Set<string>();
  const decoder = new TextDecoder();

  const need = (path: string, what: string): string => {
    const p = normalise(path);
    if (!input.files.has(p)) throw new Error(`precache: ${what} ${p} is not in the built site`);
    return p;
  };
  const pages = input.pages.map((p) => need(p, 'page'));
  const extra = input.extra.map((p) => need(p, 'file'));

  // Hashed build output, by file name. Vite writes them flat, so a name is unique.
  const assets = new Map<string, string>();
  for (const path of input.files.keys()) {
    if (!path.startsWith(assetsDir)) continue;
    const name = path.slice(assetsDir.length);
    if (name.includes('/')) continue;
    if (assets.has(name)) throw new Error(`precache: two files named ${name}`);
    assets.set(name, path);
  }

  const reached = new Set<string>();
  const queue = [...pages];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (reached.has(path)) continue;
    if (exclude.has(path) && !pages.includes(path)) continue;
    reached.add(path);
    if (!TEXT.test(path)) continue;
    const text = decoder.decode(input.files.get(path));
    for (const [name, asset] of assets) {
      if (!reached.has(asset) && !exclude.has(asset) && text.includes(name)) queue.push(asset);
    }
  }
  for (const path of extra) reached.add(path);

  const entries = [...reached].sort().map((url) => {
    const bytes = input.files.get(url) as Uint8Array;
    return { url, rev: revisionOf(bytes), bytes: bytes.byteLength };
  });
  const version = createHash('sha256')
    .update(entries.map((e) => `${e.url} ${e.rev}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
  const unreached = [...assets.values()].filter((path) => !reached.has(path)).sort();
  const unlisted = [...input.files.keys()].filter((path) => !path.startsWith(assetsDir) && !reached.has(path)).sort();
  return { entries, version, bytes: entries.reduce((sum, e) => sum + e.bytes, 0), unreached, unlisted };
}

/**
 * The files a `skyfix.basemap/1` manifest lists (web/public/data/basemap/manifest.json),
 * as site paths, plus the manifest itself. Its `files[].path` are relative to it.
 */
export function listedFiles(manifestPath: string, manifestText: string): string[] {
  const manifest = JSON.parse(manifestText) as { files?: { path?: unknown }[] };
  if (!Array.isArray(manifest.files)) throw new Error(`${manifestPath}: no "files" list`);
  const dir = posix.dirname(normalise(manifestPath));
  const out = [normalise(manifestPath)];
  for (const file of manifest.files) {
    if (typeof file.path !== 'string') throw new Error(`${manifestPath}: a file without a path`);
    out.push(normalise(posix.join(dir, file.path)));
  }
  return out;
}

/** The address of a page: `classic/index.html` -> `classic/`, `index.html` -> `./`. */
export function pageAddress(page: string): string {
  const p = normalise(page);
  if (p === 'index.html') return './';
  return p.endsWith('/index.html') ? p.slice(0, -'index.html'.length) : p;
}
