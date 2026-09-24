/**
 * Where the explorer's static data lives, and how it is fetched. OWNER: map-data agent.
 *
 * The files in web/public/data/ are copied by Vite to `<site>/data/`: the basemap layers under
 * `data/basemap/` and the gazetteer at `data/gazetteer.json`. The explorer page is served
 * from `<site>/next/` while it is being built and from `<site>/` after the switch-over
 * (EXPLORER_PLAN section 1), and the site itself lives under `/skyfix-lab/` on GitHub Pages
 * but at `/` in `vite dev`. So no absolute path can be right everywhere; every URL here is
 * resolved relative to the page:
 *
 *   page directory ends in `next/`  ->  `../data/`
 *   otherwise                       ->  `./data/`
 *
 * `setDataRoot` overrides the rule (tests, or a future layout).
 */

let overrideRoot: string | null = null;

/** Force the data root, e.g. `setDataRoot(new URL('../data/', document.baseURI).href)`. `null` restores the rule. */
export function setDataRoot(url: string | null): void {
  overrideRoot = url === null ? null : url.endsWith('/') ? url : `${url}/`;
}

function defaultPageUrl(): string {
  const doc = (globalThis as { document?: { baseURI?: string } }).document;
  if (doc?.baseURI) return doc.baseURI;
  throw new Error('No page URL: pass one explicitly outside a browser (e.g. in tests).');
}

/** Absolute URL of the data directory, with a trailing slash. */
export function dataRootUrl(pageUrl: string = defaultPageUrl()): string {
  if (overrideRoot !== null) return new URL(overrideRoot, pageUrl).href;
  const dir = new URL('.', pageUrl);
  const parent = /\/next\/$/.test(dir.pathname) ? '../data/' : './data/';
  return new URL(parent, dir).href;
}

/** Absolute URL of a file under the data directory, e.g. `dataUrl('gazetteer.json')`. */
export function dataUrl(path: string, pageUrl?: string): string {
  if (path.startsWith('/') || /^[a-z]+:/i.test(path)) throw new Error(`data paths are relative: ${path}`);
  return new URL(path, dataRootUrl(pageUrl)).href;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Fetch and parse a JSON file, with an error that names the file. */
export async function fetchJson(url: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<unknown> {
  const res = await fetchImpl(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status}).`);
  return res.json();
}
