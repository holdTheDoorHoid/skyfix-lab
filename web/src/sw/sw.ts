/**
 * The SkyFix Lab service worker: once a visitor has loaded the site, it works with no
 * connection. OWNER: release agent. Decisions live in `policy.ts`; this file only wires
 * them to the worker's events. web/plugins/pwa.ts compiles it, with the precache list
 * inlined, into `<site>/sw.js` at the end of `vite build`.
 *
 * - install:  download every precached file into a precache named by the build's hash.
 *             A file the previous version already stored with the same content hash is
 *             copied across instead of downloaded. Each download is checked against the
 *             hash the build recorded, so a half-deployed site is never stored as a
 *             version: the install fails and is retried on the next visit.
 *             The new worker then WAITS. It takes over only when the person presses
 *             Reload in the page's prompt (message `SKIP_WAITING`) or every tab of the
 *             site has been closed. It never reloads a page by itself.
 * - activate: delete this site's older caches, take control of open pages. The page's own
 *             cache of data packs (`packsCacheName`) is not the worker's and stays.
 * - fetch:    see `route` in policy.ts. Other origins are never touched.
 */

import {
  RUNTIME_MAX_ENTRIES,
  cacheNames,
  forwardPageHtml,
  inParallel,
  isStaleCache,
  offlinePageHtml,
  precacheIndex,
  precacheKey,
  revision,
  route,
  type SwBuild,
  type SwEntry,
} from './policy.js';

declare const self: ServiceWorkerGlobalScope;
/** Inlined by web/plugins/pwa.ts. */
declare const __SKYFIX_SW_BUILD__: SwBuild;

const BUILD: SwBuild = __SKYFIX_SW_BUILD__;
const ROOT = new URL('./', self.location.href).href;
const NAMES = cacheNames(ROOT, BUILD.version);
const INDEX = precacheIndex(ROOT, BUILD.entries, BUILD.redirects ?? [], BUILD.networkOnly ?? []);
const DOWNLOADS_AT_ONCE = 6;

// ---------------------------------------------------------------------------------
// Install: fill the precache
// ---------------------------------------------------------------------------------

/** Keep only the content type: nothing else about the original response matters offline. */
function storedHeaders(from: Headers): Headers {
  const headers = new Headers();
  const type = from.get('content-type');
  if (type) headers.set('content-type', type);
  return headers;
}

async function download(entry: SwEntry): Promise<Response> {
  const url = new URL(entry.url, ROOT).href;
  // The page has usually just downloaded most of these files, so the browser's HTTP cache
  // is tried first; the content hash decides whether that copy belongs to this build.
  // Otherwise ask the server itself.
  for (const cache of ['default', 'reload'] as const) {
    const response = await fetch(url, { cache, credentials: 'same-origin' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const body = await response.arrayBuffer();
    if ((await revision(body)) === entry.rev) {
      return new Response(body, { status: 200, headers: storedHeaders(response.headers) });
    }
  }
  throw new Error(
    `${url} is not the file this version was built with (expected revision ${entry.rev}); ` +
      'the site is probably being deployed. The next visit tries again.',
  );
}

async function precache(): Promise<void> {
  const cache = await caches.open(NAMES.precache);
  const stored = new Set((await cache.keys()).map((request) => request.url));
  const missing = BUILD.entries.filter((entry) => !stored.has(precacheKey(new URL(entry.url, ROOT).href, entry.rev)));
  await inParallel(missing, DOWNLOADS_AT_ONCE, async (entry) => {
    const key = precacheKey(new URL(entry.url, ROOT).href, entry.rev);
    // The same URL and content hash in an older precache of this site: reuse it.
    const previous = await caches.match(key);
    await cache.put(key, previous ?? (await download(entry)));
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precache().catch((error: unknown) => {
      console.error('SkyFix Lab: could not save the site for offline use.', error);
      throw error;
    }),
  );
});

// ---------------------------------------------------------------------------------
// Activate: clean up, take control
// ---------------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => isStaleCache(name, NAMES)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data: unknown = event.data;
  if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

// ---------------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------------

function offlinePage(): Response {
  return new Response(offlinePageHtml(BUILD.pages, ROOT, BUILD.links ?? []), {
    status: 503,
    statusText: 'Offline',
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function fromPrecache(request: Request, key: string): Promise<Response> {
  const cache = await caches.open(NAMES.precache);
  const hit = await cache.match(key);
  if (hit) return hit;
  // The browser dropped the precache (storage pressure): the network, if there is one.
  try {
    return await fetch(request);
  } catch (error) {
    if (request.mode === 'navigate') return offlinePage();
    throw error;
  }
}

async function remember(key: string, response: Response): Promise<void> {
  try {
    const cache = await caches.open(NAMES.runtime);
    await cache.put(key, response);
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - RUNTIME_MAX_ENTRIES))) await cache.delete(old);
  } catch (error) {
    // Out of space, or the cache was deleted underneath: the page still got its response.
    console.warn('SkyFix Lab: could not keep a copy for offline use.', error);
  }
}

async function networkFirst(event: FetchEvent, key: string, navigate: boolean): Promise<Response> {
  try {
    const response = await fetch(event.request);
    // Only this site's own successful answers are kept; a redirected response cannot be
    // replayed for a page load.
    if (response.ok && response.type === 'basic' && !response.redirected) {
      event.waitUntil(remember(key, response.clone()));
    }
    return response;
  } catch (error) {
    const cache = await caches.open(NAMES.runtime);
    const hit = await cache.match(key, { ignoreVary: true });
    if (hit) return hit;
    if (navigate) return offlinePage();
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const decision = route(
    {
      url: request.url,
      method: request.method,
      mode: request.mode,
      cache: request.cache,
      range: request.headers.has('range'),
    },
    INDEX,
    self.location.href,
  );
  switch (decision.kind) {
    case 'pass':
      return;
    case 'precache':
      event.respondWith(fromPrecache(request, decision.key));
      return;
    case 'redirect':
      event.respondWith(Response.redirect(decision.location, 301));
      return;
    case 'forward':
      event.respondWith(
        new Response(forwardPageHtml(decision.target, decision.fragments), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );
      return;
    case 'network-first':
      event.respondWith(networkFirst(event, decision.key, decision.navigate));
      return;
  }
});
