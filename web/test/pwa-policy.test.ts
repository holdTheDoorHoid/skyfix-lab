/**
 * The service worker's decisions (src/sw/policy.ts): which requests it answers and how,
 * which caches it may delete, and the content hash it shares with the build.
 */

import { describe, expect, it } from 'vitest';
import { revisionOf } from '../plugins/precache.ts';
import {
  PACKS_SCHEMA,
  RUNTIME_SCHEMA,
  cacheNames,
  forwardPageHtml,
  inParallel,
  isStaleCache,
  offlinePageHtml,
  packsCacheName,
  precacheIndex,
  precacheKey,
  revision,
  route,
  type FragmentMap,
  type RequestFacts,
} from '../src/sw/policy.ts';

const ROOT = 'https://holdthedoorhoid.github.io/skyfix-lab/';
const WORKER = `${ROOT}sw.js`;
// The layout since the retirement of the original workbench: the explorer at the root;
// next/ (the explorer's address while it was built) and classic/ (the workbench) moved to
// the root, classic/'s views mapped to the explorer's; the data packs are network-only
// except their manifest, which is precached.
const CLASSIC: FragmentMap = {
  map: { observations: 'navigate', corrections: 'navigate', fix: 'navigate', planner: 'navigate', simulator: 'learn', about: 'about' },
  fallback: 'navigate',
};
const INDEX = precacheIndex(
  ROOT,
  [
    { url: 'index.html', rev: 'aaaa' },
    { url: 'assets/explorer-Ab12Cd34.js', rev: 'cccc' },
    { url: 'assets/skyfix_wasm_bg-D-fngT_p.wasm', rev: 'dddd' },
    { url: 'data/basemap/land-110m.geojson', rev: 'eeee' },
    { url: 'data/packs/manifest.json', rev: '9999' },
    { url: 'docs/index.html', rev: '8888' },
    { url: 'manifest.webmanifest', rev: 'ffff' },
  ],
  [
    { from: 'next/', to: './' },
    { from: 'classic/', to: './', fragments: CLASSIC },
  ],
  ['data/packs/'],
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
  });

  it('redirects a precached directory page’s address without its trailing slash, keeping the query', () => {
    expect(route(nav(`${ROOT}docs`), INDEX, WORKER)).toEqual({ kind: 'redirect', location: `${ROOT}docs/` });
    expect(route(nav(`${ROOT}docs?search=moon`), INDEX, WORKER)).toEqual({
      kind: 'redirect',
      location: `${ROOT}docs/?search=moon`,
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
    expect(() => precacheIndex(ROOT, [{ url: 'classic/index.html', rev: 'x' }], [{ from: 'classic/', to: './', fragments: CLASSIC }])).toThrow(
      /precached/,
    );
  });
});

describe('route: the retired workbench (classic/ went to the site root, its views to the explorer’s)', () => {
  const forward = { kind: 'forward', target: ROOT, fragments: CLASSIC };

  it('answers every spelling of classic/ with a forwarding page, not a redirect', () => {
    expect(route(nav(`${ROOT}classic/`), INDEX, WORKER)).toEqual(forward);
    expect(route(nav(`${ROOT}classic/index.html`), INDEX, WORKER)).toEqual(forward);
    expect(route(nav(`${ROOT}classic`), INDEX, WORKER)).toEqual(forward);
    // The fragment never reaches the worker; the page maps it.
    expect(route(nav(`${ROOT}classic/#fix`), INDEX, WORKER)).toEqual(forward);
    expect(route(nav(`${ROOT}classic/?api=mock`), INDEX, WORKER)).toEqual(forward);
  });

  it('only for page loads', () => {
    expect(route(get(`${ROOT}classic/`), INDEX, WORKER)).toEqual({ kind: 'network-first', key: `${ROOT}classic/`, navigate: false });
  });

  it('refuses a fragment map that is not plain names', () => {
    expect(() => precacheIndex(ROOT, [], [{ from: 'old/', to: './', fragments: { map: { 'a b': 'x' }, fallback: 'x' } }])).toThrow(/plain name/);
    expect(() => precacheIndex(ROOT, [], [{ from: 'old/', to: './', fragments: { map: {}, fallback: '"><script>' } }])).toThrow(/plain name/);
  });
});

/**
 * Run a forwarding page's script against a fake `location`, the way the browser would:
 * where does `classic/<search><hash>` end up?
 */
function forwardFrom(html: string, pageUrl: string): string {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error('no inline script');
  const url = new URL(pageUrl);
  let target = '';
  const location = { hash: url.hash, search: url.search, href: url.href, replace: (to: string) => (target = new URL(to, url).href) };
  new Function('location', script)(location);
  return target;
}

describe('the forwarding page', () => {
  const cases: [string, string][] = [
    ['', '#navigate'],
    ['#observations', '#navigate'],
    ['#corrections', '#navigate'],
    ['#fix', '#navigate'],
    ['#planner', '#navigate'],
    ['#simulator', '#learn'],
    ['#about', '#about'],
    ['#something-else', '#navigate'],
    ['#constructor', '#navigate'],
    ['#__proto__', '#navigate'],
  ];

  it('maps each old view to the explorer’s and keeps the query, from the worker (absolute target)', () => {
    const html = forwardPageHtml(ROOT, CLASSIC);
    for (const [from, to] of cases) {
      expect(forwardFrom(html, `${ROOT}classic/${from}`), from).toBe(`${ROOT}${to}`);
      expect(forwardFrom(html, `${ROOT}classic${from}`), `classic${from}`).toBe(`${ROOT}${to}`);
    }
    expect(forwardFrom(html, `${ROOT}classic/?engine=mock#simulator`)).toBe(`${ROOT}?engine=mock#learn`);
  });

  it('works without scripts (a refresh to the fallback) and escapes what it embeds', () => {
    const html = forwardPageHtml(ROOT, CLASSIC);
    expect(html).toContain(`<noscript><meta http-equiv="refresh" content="0; url=${ROOT}#navigate"></noscript>`);
    expect(html).toContain('<meta name="robots" content="noindex">');
    const hostile = forwardPageHtml('./</script><b>', { map: { a: 'b' }, fallback: 'c' });
    expect(hostile).not.toContain('</script><b>');
    expect(hostile).toContain('\\u003c/script>');
  });

  it('is the page classic/index.html serves before a worker is installed', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { CLASSIC_VIEWS } = await import('../vite.config.ts');
    expect(CLASSIC_VIEWS).toEqual(CLASSIC);
    const page = readFileSync(resolve(import.meta.dirname, '../classic/index.html'), 'utf8');
    for (const [from, to] of cases) {
      expect(forwardFrom(page, `${ROOT}classic/${from}`), from).toBe(`${ROOT}${to}`);
      expect(forwardFrom(page, `${ROOT}classic/index.html?q=1${from}`), from).toBe(`${ROOT}?q=1${to}`);
    }
    // The script runs before the no-script refresh, which would drop the mapping.
    expect(page.indexOf('location.replace')).toBeLessThan(page.indexOf('http-equiv="refresh"'));
    expect(page).toContain('<noscript><meta http-equiv="refresh" content="0; url=../#navigate" /></noscript>');
    expect(page).not.toMatch(/type="module"|src=/);
  });
});

describe('route: the data packs', () => {
  it('leaves a pack file to the network: the page stores packs itself, never the worker', () => {
    expect(route(get(`${ROOT}data/packs/deep-time-0123456789abcdef.bin`), INDEX, WORKER)).toEqual({ kind: 'pass' });
    expect(route(get(`${ROOT}data/packs/tides-us-fedcba9876543210.bin?x=1`), INDEX, WORKER)).toEqual({ kind: 'pass' });
  });

  it('answers the packs’ manifest from the precache: the page knows offline what exists', () => {
    expect(route(get(`${ROOT}data/packs/manifest.json`), INDEX, WORKER)).toEqual({ kind: 'precache', key: `${ROOT}data/packs/manifest.json?__rev=9999` });
  });

  it('leaves other data files as they were', () => {
    expect(route(get(`${ROOT}data/other.bin`), INDEX, WORKER)).toEqual({ kind: 'network-first', key: `${ROOT}data/other.bin`, navigate: false });
    expect(route(get(`${ROOT}data/packsuite.bin`), INDEX, WORKER)).toEqual({ kind: 'network-first', key: `${ROOT}data/packsuite.bin`, navigate: false });
  });

  it('refuses a network-only prefix outside the site, or the whole site', () => {
    expect(() => precacheIndex(ROOT, [], [], ['/data/packs/'])).toThrow(/relative/);
    expect(() => precacheIndex(ROOT, [], [], ['./'])).toThrow(/whole site/);
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
    expect(precacheKey(`${ROOT}data/gazetteer.json`, 'abc')).toBe(`${ROOT}data/gazetteer.json?__rev=abc`);
  });

  it('give the page its own cache for data packs, which no worker ever deletes', () => {
    expect(PACKS_SCHEMA).toBe(1);
    expect(packsCacheName(ROOT)).toBe('skyfix-lab-packs-1@/skyfix-lab/');
    expect(packsCacheName('http://localhost:4173/')).toBe('skyfix-lab-packs-1@/');
    // Whatever the worker's version, and whatever the packs' schema: never stale for it.
    for (const version of ['v1', 'v2', 'b0b0b0b0b0b0b0b0']) {
      const n = cacheNames(ROOT, version);
      expect(isStaleCache(packsCacheName(ROOT), n)).toBe(false);
      expect(isStaleCache(packsCacheName(ROOT, 2), n)).toBe(false);
      expect(isStaleCache(packsCacheName(ROOT, 0), n)).toBe(false);
    }
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
  it('links the app pages and the manual by absolute address and escapes their labels', () => {
    const html = offlinePageHtml([{ url: './', label: 'SkyFix Lab explorer' }], ROOT, [{ url: 'docs/', label: 'The <b>manual</b>' }]);
    expect(html).toContain(`href="${ROOT}"`);
    expect(html).toContain(`href="${ROOT}docs/"`);
    expect(html).toContain('The &#60;b&#62;manual&#60;/b&#62;');
    expect(html).toContain('Not a navigation instrument.');
    expect(html).not.toMatch(/<script|https?:\/\/(?!holdthedoorhoid)/);
  });
});
