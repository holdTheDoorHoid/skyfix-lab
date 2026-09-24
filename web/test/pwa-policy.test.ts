/**
 * The service worker's decisions (src/sw/policy.ts): which requests it answers and how,
 * which caches it may delete, and the content hash it shares with the build.
 */

import { describe, expect, it } from 'vitest';
import { revisionOf } from '../plugins/precache.ts';
import {
  RUNTIME_SCHEMA,
  cacheNames,
  inParallel,
  isStaleCache,
  offlinePageHtml,
  precacheIndex,
  precacheKey,
  revision,
  route,
  type RequestFacts,
} from '../src/sw/policy.ts';

const ROOT = 'https://holdthedoorhoid.github.io/skyfix-lab/';
const WORKER = `${ROOT}sw.js`;
// The layout since the switch-over: the explorer at the root, the original workbench at
// classic/, and next/ (the explorer's address while it was built) moved to the root.
const INDEX = precacheIndex(
  ROOT,
  [
    { url: 'index.html', rev: 'aaaa' },
    { url: 'classic/index.html', rev: 'bbbb' },
    { url: 'assets/explorer-Ab12Cd34.js', rev: 'cccc' },
    { url: 'assets/skyfix_wasm_bg-D-fngT_p.wasm', rev: 'dddd' },
    { url: 'data/basemap/land-110m.geojson', rev: 'eeee' },
    { url: 'manifest.webmanifest', rev: 'ffff' },
  ],
  [{ from: 'next/', to: './' }],
);

const get = (url: string, extra: Partial<RequestFacts> = {}): RequestFacts => ({ url, method: 'GET', mode: 'cors', ...extra });
const nav = (url: string): RequestFacts => get(url, { mode: 'navigate' });

describe('route: what the worker never touches', () => {
  it('leaves OpenStreetMap tiles and every other origin alone', () => {
    expect(route(get('https://tile.openstreetmap.org/5/9/12.png', { mode: 'no-cors' }), INDEX, WORKER)).toEqual({ kind: 'pass' });
    expect(route(get('https://tile.openstreetmap.org/0/0/0.png'), INDEX, WORKER)).toEqual({ kind: 'pass' });
    expect(route(nav('https://www.openstreetmap.org/copyright'), INDEX, WORKER)).toEqual({ kind: 'pass' });
    // Same host name, other scheme or port: other origins too.
    expect(route(get('http://holdthedoorhoid.github.io/skyfix-lab/next/'), INDEX, WORKER)).toEqual({ kind: 'pass' });
  });

  it('leaves other sites on the same origin alone', () => {
    expect(route(nav('https://holdthedoorhoid.github.io/hackercon-tracker/'), INDEX, WORKER)).toEqual({ kind: 'pass' });
    expect(route(get('https://holdthedoorhoid.github.io/skyfix-lab-preview/next/'), INDEX, WORKER)).toEqual({ kind: 'pass' });
  });

  it('leaves writes, range requests, sw.js and the DevTools only-if-cached quirk alone', () => {
    expect(route(get(`${ROOT}next/`, { method: 'POST' }), INDEX, WORKER)).toEqual({ kind: 'pass' });
    expect(route(get(`${ROOT}data/gazetteer.json`, { range: true }), INDEX, WORKER)).toEqual({ kind: 'pass' });
    expect(route(get(`${ROOT}sw.js`), INDEX, WORKER)).toEqual({ kind: 'pass' });
    expect(route(get(`${ROOT}sw.js?v=2`), INDEX, WORKER)).toEqual({ kind: 'pass' });
    expect(route(get(`${ROOT}next/`, { cache: 'only-if-cached', mode: 'no-cors' }), INDEX, WORKER)).toEqual({ kind: 'pass' });
  });

  it('passes an unparseable URL', () => {
    expect(route(get('not a url'), INDEX, WORKER)).toEqual({ kind: 'pass' });
  });
});

describe('route: the precache', () => {
  it('answers precached files by their revisioned key', () => {
    expect(route(get(`${ROOT}assets/explorer-Ab12Cd34.js`), INDEX, WORKER)).toEqual({
      kind: 'precache',
      key: `${ROOT}assets/explorer-Ab12Cd34.js?__rev=cccc`,
    });
    expect(route(get(`${ROOT}data/basemap/land-110m.geojson`), INDEX, WORKER)).toEqual({
      kind: 'precache',
      key: `${ROOT}data/basemap/land-110m.geojson?__rev=eeee`,
    });
  });

  it('serves a page for its directory address, with or without a query', () => {
    const explorer = { kind: 'precache', key: `${ROOT}index.html?__rev=aaaa` };
    expect(route(nav(ROOT), INDEX, WORKER)).toEqual(explorer);
    expect(route(nav(`${ROOT}index.html`), INDEX, WORKER)).toEqual(explorer);
    expect(route(nav(`${ROOT}?engine=mock`), INDEX, WORKER)).toEqual(explorer);
    expect(route(nav(`${ROOT}?harness#v=1&lat=1&lon=2`), INDEX, WORKER)).toEqual(explorer);
    const classic = { kind: 'precache', key: `${ROOT}classic/index.html?__rev=bbbb` };
    expect(route(nav(`${ROOT}classic/`), INDEX, WORKER)).toEqual(classic);
    expect(route(nav(`${ROOT}classic/#fix`), INDEX, WORKER)).toEqual(classic);
  });

  it('redirects a page address without its trailing slash, keeping the query', () => {
    expect(route(nav(`${ROOT}classic`), INDEX, WORKER)).toEqual({ kind: 'redirect', location: `${ROOT}classic/` });
    expect(route(nav(`${ROOT}classic?api=mock`), INDEX, WORKER)).toEqual({
      kind: 'redirect',
      location: `${ROOT}classic/?api=mock`,
    });
  });

  it('works under / as well as under a sub-path (vite preview)', () => {
    const local = precacheIndex('http://localhost:4173/', [{ url: 'index.html', rev: 'aaaa' }], [{ from: 'next/', to: './' }]);
    expect(route(nav('http://localhost:4173/'), local, 'http://localhost:4173/sw.js')).toEqual({
      kind: 'precache',
      key: 'http://localhost:4173/index.html?__rev=aaaa',
    });
    expect(route(nav('http://localhost:4173/next/'), local, 'http://localhost:4173/sw.js')).toEqual({
      kind: 'redirect',
      location: 'http://localhost:4173/',
    });
  });

  it('refuses absolute entries: everything is relative to the site root', () => {
    expect(() => precacheIndex(ROOT, [{ url: '/skyfix-lab/index.html', rev: 'x' }])).toThrow(/relative/);
    expect(() => precacheIndex(ROOT, [{ url: 'https://example.org/x.js', rev: 'x' }])).toThrow(/relative/);
    expect(() => precacheIndex(ROOT, [], [{ from: '/skyfix-lab/next/', to: './' }])).toThrow(/relative/);
  });
});

describe('route: pages that moved (next/ went to the site root)', () => {
  const home = { kind: 'redirect', location: ROOT };

  it('sends every spelling of the old address to the new one', () => {
    expect(route(nav(`${ROOT}next/`), INDEX, WORKER)).toEqual(home);
    expect(route(nav(`${ROOT}next/index.html`), INDEX, WORKER)).toEqual(home);
    expect(route(nav(`${ROOT}next`), INDEX, WORKER)).toEqual(home);
  });

  it('keeps the query; the fragment (a share link) never reaches the worker and the browser keeps it', () => {
    expect(route(nav(`${ROOT}next/?engine=mock`), INDEX, WORKER)).toEqual({ kind: 'redirect', location: `${ROOT}?engine=mock` });
    expect(route(nav(`${ROOT}next/#v=1&lat=39.9526&lon=-75.1652`), INDEX, WORKER)).toEqual(home);
  });

  it('only for page loads; other requests and other addresses under next/ are not redirected', () => {
    expect(route(get(`${ROOT}next/`), INDEX, WORKER)).toEqual({ kind: 'network-first', key: `${ROOT}next/`, navigate: false });
    expect(route(nav(`${ROOT}next/dev-map.html`), INDEX, WORKER)).toEqual({
      kind: 'network-first',
      key: `${ROOT}next/dev-map.html`,
      navigate: true,
    });
    expect(route(nav(`${ROOT}nextdoor/`), INDEX, WORKER)).toEqual({ kind: 'network-first', key: `${ROOT}nextdoor/`, navigate: true });
  });

  it('refuses a redirect that is not a directory page, is the root, or is also precached', () => {
    expect(() => precacheIndex(ROOT, [], [{ from: 'next', to: './' }])).toThrow(/directory/);
    expect(() => precacheIndex(ROOT, [], [{ from: './', to: 'classic/' }])).toThrow(/directory/);
    expect(() => precacheIndex(ROOT, [{ url: 'next/index.html', rev: 'x' }], [{ from: 'next/', to: './' }])).toThrow(/precached/);
  });
});

describe('route: everything else on the site', () => {
  it('fetches pages first and keeps them without their query', () => {
    expect(route(nav(`${ROOT}docs/ACCURACY.html?search=moon`), INDEX, WORKER)).toEqual({
      kind: 'network-first',
      key: `${ROOT}docs/ACCURACY.html`,
      navigate: true,
    });
  });

  it('fetches other files first and keeps them under their full address', () => {
    expect(route(get(`${ROOT}docs/searchindex.js`), INDEX, WORKER)).toEqual({
      kind: 'network-first',
      key: `${ROOT}docs/searchindex.js`,
      navigate: false,
    });
    expect(route(get(`${ROOT}assets/mock-mYQi1ewh.js`), INDEX, WORKER)).toEqual({
      kind: 'network-first',
      key: `${ROOT}assets/mock-mYQi1ewh.js`,
      navigate: false,
    });
  });
});

describe('cache names', () => {
  const names = cacheNames(ROOT, 'v2');

  it('carry the version and the site path', () => {
    expect(names.precache).toBe('skyfix-lab-precache-v2@/skyfix-lab/');
    expect(names.runtime).toBe(`skyfix-lab-runtime-${RUNTIME_SCHEMA}@/skyfix-lab/`);
  });

  it('let a worker delete only its own site’s older caches', () => {
    expect(isStaleCache('skyfix-lab-precache-v1@/skyfix-lab/', names)).toBe(true);
    expect(isStaleCache('skyfix-lab-runtime-0@/skyfix-lab/', names)).toBe(true);
    expect(isStaleCache(names.precache, names)).toBe(false);
    expect(isStaleCache(names.runtime, names)).toBe(false);
    // Another copy of the site on the same origin, and other projects' caches.
    expect(isStaleCache('skyfix-lab-precache-v1@/skyfix-lab-preview/', names)).toBe(false);
    expect(isStaleCache('hackercon-tracker-v3', names)).toBe(false);
    expect(isStaleCache('workbox-precache-v2-https://holdthedoorhoid.github.io/skyfix-lab/', names)).toBe(false);
  });

  it('differ per site path', () => {
    expect(cacheNames('http://localhost:4173/', 'v2').precache).toBe('skyfix-lab-precache-v2@/');
  });

  it('key a file by URL and revision', () => {
    expect(precacheKey(`${ROOT}classic/index.html`, 'abc')).toBe(`${ROOT}classic/index.html?__rev=abc`);
  });
});

describe('revision', () => {
  it('is the same in the worker (Web Crypto) and in the build (node:crypto)', async () => {
    const samples = [new Uint8Array(0), new TextEncoder().encode('SkyFix Lab'), new Uint8Array(70_000).map((_, i) => (i * 31) % 251)];
    for (const bytes of samples) {
      const rev = await revision(bytes);
      expect(rev).toMatch(/^[0-9a-f]{16}$/);
      expect(rev).toBe(revisionOf(bytes));
    }
  });

  it('is the start of the SHA-256 digest', async () => {
    expect(await revision(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea');
  });
});

describe('inParallel', () => {
  it('runs every item, never more than the limit at once', async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];
    await inParallel([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      done.push(n);
      running -= 1;
    });
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(most).toBe(3);
  });

  it('rejects when an item fails, and copes with nothing to do', async () => {
    await expect(inParallel([1, 2], 2, async (n) => (n === 2 ? Promise.reject(new Error('no')) : undefined))).rejects.toThrow('no');
    await expect(inParallel([], 4, async () => undefined)).resolves.toBeUndefined();
  });
});

describe('offline page', () => {
  it('links the app pages by absolute address and escapes their labels', () => {
    const html = offlinePageHtml(
      [
        { url: './', label: 'SkyFix Lab explorer' },
        { url: 'classic/', label: 'A <b>workbench</b>' },
      ],
      ROOT,
    );
    expect(html).toContain(`href="${ROOT}"`);
    expect(html).toContain(`href="${ROOT}classic/"`);
    expect(html).toContain('A &#60;b&#62;workbench&#60;/b&#62;');
    expect(html).toContain('Not a navigation instrument.');
    expect(html).not.toMatch(/<script|https?:\/\/(?!holdthedoorhoid)/);
  });
});
