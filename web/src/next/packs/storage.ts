/**
 * Where the page keeps the data packs a person chose: the app's own cache,
 * `skyfix-lab-packs-1@<site>` (src/sw/policy.ts `packsCacheName`), written and read from
 * the page with the Cache API. Never the service worker's precache or runtime cache, so a
 * new version of the site leaves the packs alone. OWNER: packs agent.
 *
 * Each pack is stored under its file's own address (`…/data/packs/<name>-<rev>.bin`), so
 * the name and the revision can be read back from the key alone.
 */

import { PACKS_SCHEMA, packsCacheName } from '../../sw/policy.js';

export interface StoredPack {
  readonly name: string;
  readonly rev: string;
  /** The key: the pack file's absolute address. */
  readonly url: string;
  /** Size in bytes, from the stored response (0 when unknown). */
  readonly bytes: number;
}

export interface PackStorage {
  list(): Promise<StoredPack[]>;
  read(url: string): Promise<Uint8Array | null>;
  write(url: string, bytes: Uint8Array): Promise<void>;
  remove(url: string): Promise<void>;
  /** Delete this site's packs caches of other schemas (a schema bump makes them stale). */
  cleanup(): Promise<void>;
}

const FILE = /\/([a-z0-9][a-z0-9-]*)-([0-9a-f]{16})\.bin$/;

/** The pack a stored address holds, or null for anything else. */
export function packOfUrl(url: string): { name: string; rev: string } | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = FILE.exec(path);
  return m ? { name: m[1]!, rev: m[2]! } : null;
}

/**
 * The Cache API store for the site at `rootUrl`, or null where the browser has no Cache API
 * (an insecure address, some private modes): then nothing is saved and a pack loaded this
 * visit is gone after it.
 */
export function cachePackStorage(rootUrl: string, cacheStorage: CacheStorage | undefined = globalThis.caches): PackStorage | null {
  if (!cacheStorage) return null;
  const store = cacheStorage;
  const name = packsCacheName(rootUrl);
  const site = `@${new URL(rootUrl).pathname}`;
  return {
    async list() {
      if (!(await store.has(name))) return [];
      const cache = await store.open(name);
      const out: StoredPack[] = [];
      for (const request of await cache.keys()) {
        const pack = packOfUrl(request.url);
        if (!pack) continue;
        const response = await cache.match(request);
        out.push({ ...pack, url: request.url, bytes: Number(response?.headers.get('content-length') ?? 0) || 0 });
      }
      return out;
    },
    async read(url) {
      if (!(await store.has(name))) return null;
      const response = await (await store.open(name)).match(url);
      return response ? new Uint8Array(await response.arrayBuffer()) : null;
    },
    async write(url, bytes) {
      const cache = await store.open(name);
      await cache.put(
        url,
        new Response(bytes.slice().buffer, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) },
        }),
      );
    },
    async remove(url) {
      if (!(await store.has(name))) return;
      await (await store.open(name)).delete(url);
    },
    async cleanup() {
      const mine = new RegExp(`^skyfix-lab-packs-(\\d+)${site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
      for (const key of await store.keys()) {
        const m = mine.exec(key);
        if (m && Number(m[1]) !== PACKS_SCHEMA) await store.delete(key);
      }
    },
  };
}

/** An in-memory store (tests, and a stand-in with the same behaviour). */
export function memoryPackStorage(initial: Iterable<[string, Uint8Array]> = []): PackStorage & { readonly files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>(initial);
  return {
    files,
    async list() {
      return [...files].flatMap(([url, bytes]) => {
        const pack = packOfUrl(url);
        return pack ? [{ ...pack, url, bytes: bytes.byteLength }] : [];
      });
    },
    async read(url) {
      const bytes = files.get(url);
      return bytes ? bytes.slice() : null;
    },
    async write(url, bytes) {
      files.set(url, bytes.slice());
    },
    async remove(url) {
      files.delete(url);
    },
    async cleanup() {},
  };
}
