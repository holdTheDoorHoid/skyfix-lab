/**
 * The service worker's decisions, as plain functions with no service-worker globals, so
 * they can be unit-tested (web/test/pwa-policy.test.ts) and shared with the build.
 * OWNER: release agent. The worker itself is `sw.ts`; the build is web/plugins/pwa.ts.
 *
 * What the worker does with a request (`route`):
 *
 *   another origin (OpenStreetMap tiles, anything)  -> untouched: the browser handles it
 *   not a GET, a Range request, outside this site   -> untouched
 *   sw.js itself                                    -> untouched
 *   a page that moved (`next/`, the explorer's      -> redirect to its new address (`./`),
 *   address before the switch-over)                    query kept; the browser keeps the
 *                                                      fragment, so share links still work
 *   a precached file (the app shell, map data)      -> from the precache (cache first)
 *   `classic` (a precached page, no trailing slash) -> redirect to `classic/`
 *   anything else on this site (the docs, …)        -> network first, then the runtime
 *                                                      cache; a page never seen offline
 *                                                      gets a small offline page
 *
 * Nothing about another origin is ever stored: the OpenStreetMap tile usage policy
 * forbids bulk caching of its tiles (docs/THIRD_PARTY.md, "Explorer map view").
 */

/** What the build hands the worker (inlined into sw.js by web/plugins/pwa.ts). */
export interface SwBuild {
  /** Hash of every precached file's path and content. Names the precache. */
  readonly version: string;
  /** Files to precache, relative to the site root (the directory that holds sw.js). */
  readonly entries: readonly SwEntry[];
  /** The app's pages, linked from the offline page. `url` is relative to the site root. */
  readonly pages: readonly { readonly url: string; readonly label: string }[];
  /**
   * Pages that moved: a navigation to `from` (a directory address such as `next/`, with or
   * without its trailing slash or `index.html`) goes to `to`. Both relative to the site root.
   */
  readonly redirects?: readonly SwRedirect[];
}

export interface SwRedirect {
  readonly from: string;
  readonly to: string;
}

export interface SwEntry {
  /** Relative to the site root, e.g. `assets/main-Ab12Cd34.js`, `classic/index.html`. */
  readonly url: string;
  /** SHA-256 of the file, first 16 hex digits (`revision`). */
  readonly rev: string;
}

// ---------------------------------------------------------------------------------
// Cache names
// ---------------------------------------------------------------------------------

export const CACHE_PREFIX = 'skyfix-lab';
/** Bump when the runtime cache's contents change meaning; old ones are then deleted. */
export const RUNTIME_SCHEMA = 1;
/** The runtime cache keeps the most recently stored pages and files, up to this many. */
export const RUNTIME_MAX_ENTRIES = 250;

export interface CacheNames {
  readonly precache: string;
  readonly runtime: string;
  /** `@/skyfix-lab/`: the site's path. Every cache name of this site ends with it. */
  readonly site: string;
}

/**
 * Cache names carry the site's path. Cache storage is shared by the whole origin, and
 * `holdthedoorhoid.github.io` serves several projects (and could serve a second copy of
 * this one): a worker only ever deletes caches that end with its own site's path.
 */
export function cacheNames(rootUrl: string, version: string): CacheNames {
  const site = `@${new URL(rootUrl).pathname}`;
  return {
    precache: `${CACHE_PREFIX}-precache-${version}${site}`,
    runtime: `${CACHE_PREFIX}-runtime-${RUNTIME_SCHEMA}${site}`,
    site,
  };
}

/** True for this site's caches that the current worker no longer uses. */
export function isStaleCache(name: string, current: CacheNames): boolean {
  if (name === current.precache || name === current.runtime) return false;
  if (!name.endsWith(current.site)) return false;
  return name.startsWith(`${CACHE_PREFIX}-precache-`) || name.startsWith(`${CACHE_PREFIX}-runtime-`);
}

// ---------------------------------------------------------------------------------
// The precache index
// ---------------------------------------------------------------------------------

export interface PrecacheIndex {
  /** The site root: the directory of sw.js, with a trailing slash. */
  readonly root: URL;
  /** Absolute URL (no query, no fragment) -> the precache key for it. */
  readonly keys: ReadonlyMap<string, string>;
  /** Absolute URL of a moved page (every spelling of it, no query) -> where it went. */
  readonly moved: ReadonlyMap<string, string>;
}

/**
 * The key a file is stored under: its URL plus its revision. A new worker can then take an
 * unchanged file from the previous precache instead of downloading it again.
 */
export function precacheKey(absoluteUrl: string, rev: string): string {
  return `${absoluteUrl}?__rev=${rev}`;
}

function relative(path: string, what: string): string {
  if (path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new Error(`${what} are relative to the site root: ${path}`);
  }
  return path;
}

export function precacheIndex(rootUrl: string, entries: readonly SwEntry[], redirects: readonly SwRedirect[] = []): PrecacheIndex {
  const root = new URL('./', rootUrl);
  const keys = new Map<string, string>();
  for (const entry of entries) {
    const url = new URL(relative(entry.url, 'precache entries'), root).href;
    keys.set(url, precacheKey(url, entry.rev));
  }
  const moved = new Map<string, string>();
  for (const { from, to } of redirects) {
    const dir = new URL(relative(from, 'redirects'), root).href;
    if (!dir.endsWith('/') || dir === root.href) throw new Error(`a redirect moves a directory page, not ${from}`);
    const target = new URL(relative(to, 'redirects'), root).href;
    if (keys.has(`${dir}index.html`)) throw new Error(`${from} is precached and cannot also be redirected`);
    for (const spelling of [dir, `${dir}index.html`, dir.slice(0, -1)]) moved.set(spelling, target);
  }
  return { root, keys, moved };
}

// ---------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------

/** The parts of a `Request` that decide its route. */
export interface RequestFacts {
  readonly url: string;
  readonly method: string;
  /** `navigate`, `cors`, `no-cors`, `same-origin`. */
  readonly mode: string;
  readonly cache?: string;
  /** The request has a `Range` header (media). */
  readonly range?: boolean;
}

export type Route =
  | { readonly kind: 'pass' }
  | { readonly kind: 'precache'; readonly key: string }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'network-first'; readonly key: string; readonly navigate: boolean };

const PASS: Route = { kind: 'pass' };

/** The file a URL names: `…/classic/` is `…/classic/index.html`. */
function fileUrl(href: string): string {
  return href.endsWith('/') ? `${href}index.html` : href;
}

/**
 * Decide what the worker does with a request. `workerUrl` is the worker's own script URL
 * (`self.location.href`); its directory is the site root.
 */
export function route(request: RequestFacts, index: PrecacheIndex, workerUrl: string): Route {
  if (request.method !== 'GET' || request.range) return PASS;
  // A request DevTools makes that a worker must not answer with a different mode.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return PASS;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return PASS;
  }
  // Other origins are never touched, stored or answered: OpenStreetMap's tiles above all.
  if (url.origin !== index.root.origin) return PASS;
  // The same origin can serve other sites (other repositories' Pages): not ours.
  if (!url.pathname.startsWith(index.root.pathname)) return PASS;

  url.hash = '';
  const bare = new URL(url.href);
  bare.search = '';
  const worker = new URL(workerUrl);
  worker.search = '';
  worker.hash = '';
  if (bare.href === worker.href) return PASS;

  const navigate = request.mode === 'navigate';
  // A page that moved: keep the query (`?engine=mock`); the browser carries the fragment
  // across the redirect by itself, so a share link (`#v=1&…`) arrives intact, offline too.
  const moved = navigate ? index.moved.get(bare.href) : undefined;
  if (moved) return { kind: 'redirect', location: `${moved}${url.search}` };
  // The query never changes which build file is meant (`?engine=mock`, `?harness`).
  const key = index.keys.get(fileUrl(bare.href));
  if (key) return { kind: 'precache', key };
  if (navigate && !bare.pathname.endsWith('/') && index.keys.has(`${bare.href}/index.html`)) {
    // Relative links inside the page only work from `classic/`, never from `classic`.
    return { kind: 'redirect', location: `${bare.href}/${url.search}` };
  }
  // Pages are stored without their query: an address never leaves anything personal in
  // the cache (the explorer puts a shared place in the fragment, which never gets here).
  return { kind: 'network-first', key: navigate ? bare.href : url.href, navigate };
}

// ---------------------------------------------------------------------------------
// Content hashes
// ---------------------------------------------------------------------------------

/** Length, in hex digits, of a revision. 64 bits: collisions are not a practical concern. */
export const REVISION_LENGTH = 16;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The revision of a file: SHA-256 of its bytes, first 16 hex digits. The build computes
 * the same with node:crypto (web/plugins/precache.ts `revisionOf`); a test keeps them equal.
 */
export async function revision(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(digest).slice(0, REVISION_LENGTH);
}

// ---------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------

/** Run `task` over `items`, at most `limit` at a time. Rejects on the first failure. */
export async function inParallel<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await task(item as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The page shown for an address on this site that was never visited while online, when
 * there is no connection. Plain HTML with its own small style: nothing else may be
 * available. Links go to the app's pages, which always work offline.
 */
export function offlinePageHtml(pages: SwBuild['pages'], rootUrl: string): string {
  const links = pages
    .map((p) => `<li><a href="${escapeHtml(new URL(p.url, rootUrl).href)}">${escapeHtml(p.label)}</a></li>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Offline · SkyFix Lab</title>
<style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#131a21;color:#f1f4f7}
main{max-width:34rem;margin:12vh auto 0;padding:0 20px}
h1{font-size:1.4rem;margin:0 0 .5rem}
p{margin:0 0 1rem;color:#b6c2cd}
a{color:#f5c35c}
.note{font-size:.85rem;color:#909eac;margin-top:2rem}
</style>
</head>
<body>
<main>
<h1>You are offline</h1>
<p>This page has not been saved on this device yet, so it cannot be shown without a connection.</p>
<p>These work offline:</p>
<ul>${links}</ul>
<p class="note">Simulation and analysis workbench. Not a navigation instrument.</p>
</main>
</body>
</html>
`;
}
