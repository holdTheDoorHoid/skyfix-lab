/**
 * The pack service (`Ctx.packs`): which optional data packs exist, which this device has
 * saved, fetching one when a person asks or a view needs it, and loading saved ones into
 * the engine. OWNER: packs agent. Contract: EXPLORER_API "Packs", CONVENTIONS §15.5.
 *
 * - `start()` runs before the first view mounts: every saved pack the site still offers is
 *   read from this device and loaded into the engine, so every view starts with the whole
 *   engine and `explorer_coverage()` is right from the first frame (a pack loads in a few
 *   milliseconds; a visitor with no packs pays one cache lookup). A saved copy the engine
 *   refuses is deleted and the reason kept for Settings.
 * - `ensure(name, reason)`: loaded -> true; saved -> load it; declined this session ->
 *   false; otherwise one prompt ("<reason> … 0.4 MB, saved on this device", Get / Not
 *   now), then download with progress, check the size and the content hash against the
 *   manifest, load it into the engine (so a file the engine refuses is never kept), and
 *   save it. Offline without a copy, the prompt says so. Any dismissal is remembered for
 *   the page session, so a view that asks again does not nag.
 * - A saved copy older than the site's (another revision in the manifest) is still loaded
 *   at start-up, so the pack keeps working offline, and is replaced on its next use: the
 *   new file is fetched in the background, loaded, saved, and the old copy deleted.
 * - `remove(name)` deletes the saved copy; the engine keeps a loaded pack until the page
 *   is reloaded (there is no unloading in the contract), and Settings says so.
 */

import type { PackEngine, PackService, PackState, PackStatus } from '../engine/types.js';
import { isPackEngine } from '../engine/types.js';
import { EMPTY_MANIFEST, formatBytes, parseManifest, type PackManifest, type PackManifestEntry } from './manifest.js';
import type { PackStorage, StoredPack } from './storage.js';

// ---------------------------------------------------------------------------------
// The prompt, as the service sees it (prompt.ts draws it)
// ---------------------------------------------------------------------------------

export interface PromptRequest {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly bytes: number;
  /** The caller's sentence: why the pack is needed now. */
  readonly reason: string;
  /** No connection when asked: the prompt says the pack is not saved yet. */
  readonly offline: boolean;
}

export type PromptAnswer = 'get' | 'dismiss';

export interface PromptHandle {
  /** The person's first answer. */
  readonly answer: Promise<PromptAnswer>;
  /** A download is under way. `stop` is called when the person stops it. */
  downloading(onStop: () => void): void;
  progress(received: number, total: number): void;
  /** It failed: show why; resolves with the person's choice (try again, or dismiss). */
  failed(message: string): Promise<PromptAnswer>;
  /** Saved and loaded: say so briefly, then go. */
  done(message: string): void;
  close(): void;
}

export interface Prompter {
  ask(request: PromptRequest): PromptHandle;
}

// ---------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------

export interface PackServiceOptions {
  /** The engine (unwrapped): packs are loaded with `loadPack` when it is a `PackEngine`. */
  readonly engine: unknown;
  /** Where saved packs live; null when this browser cannot keep them (no Cache API). */
  readonly storage: PackStorage | null;
  /** The manifest's absolute address (`<site>/data/packs/manifest.json`). */
  readonly manifestUrl: string;
  readonly prompter: Prompter;
  /** Fetch and parse JSON (default `fetch`). */
  readonly fetchJson?: (url: string) => Promise<unknown>;
  /** Download a file, reporting progress (default `fetch` with a streamed body). */
  readonly download?: (url: string, onProgress: (received: number, total: number) => void, signal: AbortSignal) => Promise<Uint8Array>;
  /** The content hash the build names files by, or null when this browser cannot compute it. */
  readonly digest?: (bytes: Uint8Array) => Promise<string | null>;
  readonly isOnline?: () => boolean;
  /** After a pack is loaded into the engine (the explorer drops its memoised results). */
  readonly onLoaded?: (name: string) => void;
  /** Where unexpected failures are reported (default `console.warn`). */
  readonly warn?: (message: string, error?: unknown) => void;
}

export interface PackServiceImpl extends PackService {
  /** Load every saved pack. Never throws. */
  start(): Promise<void>;
  destroy(): void;
}

interface Download {
  controller: AbortController;
  received: number;
  total: number;
}

/** Listeners hear about download progress at most this often. */
const PROGRESS_MS = 100;

function message(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** `fetch` with a streamed body, so progress can be shown. */
export async function streamDownload(
  url: string,
  onProgress: (received: number, total: number) => void,
  signal: AbortSignal,
  expected = 0,
): Promise<Uint8Array> {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`the site answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
  const total = Number(response.headers.get('content-length')) || expected;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress(bytes.byteLength, bytes.byteLength);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received, Math.max(total, received));
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export function createPackService(options: PackServiceOptions): PackServiceImpl {
  const engine: PackEngine | null = isPackEngine(options.engine) ? options.engine : null;
  const storage = options.storage;
  const warn = options.warn ?? ((text: string, error?: unknown) => console.warn(`SkyFix Lab packs: ${text}`, error ?? ''));
  const isOnline = options.isOnline ?? (() => globalThis.navigator?.onLine !== false);
  const fetchJson =
    options.fetchJson ??
    (async (url: string) => {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return (await response.json()) as unknown;
    });
  const digest = options.digest ?? (async () => null);

  let manifest: PackManifest | null = null;
  let manifestFailed = false;
  let stored: StoredPack[] = [];
  /** Loaded into the engine this page session: name -> the revision it came from ('' unknown). */
  const loaded = new Map<string, string>();
  const removedInUse = new Set<string>();
  const declined = new Set<string>();
  const errors = new Map<string, string>();
  const downloads = new Map<string, Download>();
  const inflight = new Map<string, Promise<boolean>>();
  const updating = new Set<string>();
  const listeners = new Set<() => void>();
  let destroyed = false;

  const notify = (): void => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch (error) {
        warn('a listener failed', error);
      }
    }
  };

  const engineStatus = (): PackStatus[] => {
    if (!engine) return [];
    try {
      return engine.packs();
    } catch (error) {
      warn('the engine did not list its packs', error);
      return [];
    }
  };

  const offeredEntry = (name: string): PackManifestEntry | undefined => manifest?.packs.find((p) => p.name === name);
  const fileUrl = (entry: PackManifestEntry): string => new URL(entry.file, options.manifestUrl).href;

  async function readManifest(force = false): Promise<PackManifest> {
    if (manifest && !force) return manifest;
    try {
      manifest = parseManifest(await fetchJson(options.manifestUrl));
      manifestFailed = false;
    } catch (error) {
      // No manifest (a development page, a site built before packs existed, offline with no
      // worker): nothing is offered. Saved packs still load.
      manifestFailed = true;
      if (!manifest) manifest = EMPTY_MANIFEST;
      warn(`the list of data packs could not be read (${message(error)})`);
    }
    return manifest;
  }

  async function readStored(): Promise<StoredPack[]> {
    if (!storage) return (stored = []);
    try {
      stored = await storage.list();
    } catch (error) {
      warn('the saved packs could not be listed', error);
      stored = [];
    }
    return stored;
  }

  /** Put bytes into the engine; throws the engine's sentence when it refuses them. */
  function install(name: string, bytes: Uint8Array, rev: string): void {
    if (!engine) throw new Error('this build of the numerical core cannot load data packs');
    engine.loadPack(name, bytes);
    loaded.set(name, rev);
    removedInUse.delete(name);
    errors.delete(name);
    options.onLoaded?.(name);
  }

  async function loadSaved(copy: StoredPack): Promise<boolean> {
    if (!storage) return false;
    const bytes = await storage.read(copy.url);
    if (!bytes) return false;
    try {
      install(copy.name, bytes, copy.rev);
      return true;
    } catch (error) {
      errors.set(copy.name, `The saved copy could not be used and was deleted: ${message(error)}`);
      await storage.remove(copy.url).catch(() => undefined);
      stored = stored.filter((s) => s.url !== copy.url);
      return false;
    }
  }

  /** The saved copy to use for a pack: the site's current revision if saved, else any. */
  function savedCopy(name: string): StoredPack | undefined {
    const copies = stored.filter((s) => s.name === name);
    const current = offeredEntry(name);
    return copies.find((c) => current && c.rev === current.rev) ?? copies[0];
  }

  /** Download, check, load and save the site's current file for a pack. */
  async function fetchAndInstall(entry: PackManifestEntry, onProgress: (r: number, t: number) => void, signal: AbortSignal): Promise<void> {
    const url = fileUrl(entry);
    const bytes = await (options.download ?? ((u, p, s) => streamDownload(u, p, s, entry.bytes)))(url, onProgress, signal);
    if (bytes.byteLength !== entry.bytes) {
      throw new Error(`the file is ${bytes.byteLength} bytes, the site lists ${entry.bytes}; reload the page and try again`);
    }
    const rev = await digest(bytes).catch(() => null);
    if (rev !== null && rev !== entry.rev) {
      throw new Error('the file is not the one the site lists (it may be being updated); reload the page and try again');
    }
    install(entry.name, bytes, entry.rev);
    if (!storage) {
      errors.set(entry.name, 'Loaded for this visit only: this browser cannot save packs.');
      return;
    }
    try {
      await storage.write(url, bytes);
      for (const old of stored.filter((s) => s.name === entry.name && s.url !== url)) await storage.remove(old.url);
    } catch (error) {
      errors.set(entry.name, `Loaded for this visit only: the browser would not save it (${message(error)}).`);
    }
    await readStored();
  }

  /**
   * Fetch, with the progress kept where Settings and the prompt both read it. Listeners hear
   * about progress at most every PROGRESS_MS, so a large pack does not redraw Settings for
   * every chunk.
   */
  async function download(entry: PackManifestEntry, onProgress?: (r: number, t: number) => void): Promise<void> {
    const controller = new AbortController();
    const state: Download = { controller, received: 0, total: entry.bytes };
    downloads.set(entry.name, state);
    errors.delete(entry.name);
    notify();
    let told = 0;
    try {
      await fetchAndInstall(
        entry,
        (received, total) => {
          state.received = received;
          state.total = total || entry.bytes;
          onProgress?.(received, state.total);
          const now = Date.now();
          if (now - told >= PROGRESS_MS || received >= state.total) {
            told = now;
            notify();
          }
        },
        controller.signal,
      );
    } finally {
      downloads.delete(entry.name);
      notify();
    }
  }

  /** A newer revision on the site than the one loaded: fetch it quietly, in the background. */
  function updateInBackground(name: string): void {
    const entry = offeredEntry(name);
    if (!entry || updating.has(name) || downloads.has(name) || !isOnline()) return;
    if (!loaded.has(name) || loaded.get(name) === entry.rev) return;
    updating.add(name);
    download(entry)
      .catch((error: unknown) => {
        if (!destroyed) errors.set(name, `The newer version could not be fetched; the saved one is in use (${message(error)}).`);
      })
      .finally(() => {
        updating.delete(name);
        notify();
      });
  }

  const isLoaded = (name: string): boolean => loaded.has(name) || engineStatus().some((p) => p.name === name && p.loaded);

  async function ensureUncached(name: string, reason: string): Promise<boolean> {
    await readManifest();
    if (isLoaded(name)) {
      updateInBackground(name);
      return true;
    }
    if (stored.length === 0) await readStored();
    const copy = savedCopy(name);
    if (copy && (await loadSaved(copy))) {
      notify();
      updateInBackground(name);
      return true;
    }
    if (declined.has(name)) return false;
    const entry = offeredEntry(name);
    if (!entry) {
      warn(`${name}: the site does not offer this pack${manifestFailed ? ' (its list of packs could not be read)' : ''}`);
      return false;
    }
    if (!engineStatus().some((p) => p.name === name)) {
      warn(`${name}: this build of the numerical core cannot load this pack`);
      return false;
    }
    const handle = options.prompter.ask({
      name,
      label: entry.label,
      description: entry.description,
      bytes: entry.bytes,
      reason,
      offline: !isOnline(),
    });
    try {
      let answer = await handle.answer;
      for (;;) {
        if (answer !== 'get') {
          declined.add(name);
          handle.close();
          return false;
        }
        let stopped = false;
        handle.downloading(() => {
          stopped = true;
          downloads.get(name)?.controller.abort();
        });
        try {
          await download(entry, (received, total) => handle.progress(received, total));
        } catch (error) {
          if (stopped) {
            declined.add(name);
            handle.close();
            return false;
          }
          const why = !isOnline() ? 'you are offline' : message(error);
          errors.set(name, `Could not be downloaded: ${why}.`);
          notify();
          answer = await handle.failed(`The ${entry.label} pack could not be downloaded: ${why}.`);
          continue;
        }
        handle.done(`The ${entry.label} pack is saved on this device.`);
        return true;
      }
    } catch (error) {
      // Never leave a prompt up (it would hold back the next one) when something unexpected
      // went wrong around it.
      handle.close();
      throw error;
    }
  }

  const service: PackServiceImpl = {
    async start() {
      if (!storage) return;
      try {
        await storage.cleanup().catch((error: unknown) => warn('older saved packs could not be deleted', error));
        await readStored();
        if (stored.length === 0) return;
        await readManifest();
        for (const name of new Set(stored.map((s) => s.name))) {
          const current = offeredEntry(name);
          if (!current && !manifestFailed) {
            // The site no longer offers it: nothing will ever update it.
            for (const s of stored.filter((x) => x.name === name)) await storage.remove(s.url);
            continue;
          }
          const copy = savedCopy(name);
          if (!copy) continue;
          for (const extra of stored.filter((x) => x.name === name && x.url !== copy.url)) await storage.remove(extra.url);
          await loadSaved(copy);
        }
        await readStored();
      } catch (error) {
        warn('the saved packs could not be loaded', error);
      } finally {
        notify();
      }
    },

    ensure(name, reason) {
      const pending = inflight.get(name);
      if (pending) return pending;
      const run = ensureUncached(name, reason)
        .catch((error: unknown) => {
          warn(`${name}: ${message(error)}`, error);
          return false;
        })
        .finally(() => {
          inflight.delete(name);
          notify();
        });
      inflight.set(name, run);
      return run;
    },

    async get(name) {
      await readManifest();
      const entry = offeredEntry(name);
      if (!entry) return false;
      declined.delete(name);
      if (downloads.has(name)) return false;
      if (!engineStatus().some((p) => p.name === name)) {
        errors.set(name, 'This version of the numerical core cannot use this pack.');
        notify();
        return false;
      }
      try {
        await download(entry);
        return true;
      } catch (error) {
        errors.set(name, `Could not be downloaded: ${!isOnline() ? 'you are offline' : message(error)}.`);
        notify();
        return false;
      }
    },

    async remove(name) {
      downloads.get(name)?.controller.abort();
      if (storage) {
        for (const s of stored.filter((x) => x.name === name)) {
          try {
            await storage.remove(s.url);
          } catch (error) {
            warn(`${name}: the saved copy could not be deleted`, error);
          }
        }
      }
      await readStored();
      if (isLoaded(name)) removedInUse.add(name);
      errors.delete(name);
      notify();
    },

    async refresh() {
      await Promise.all([readManifest(true), readStored()]);
      notify();
    },

    status() {
      const fromEngine = engineStatus();
      const names = new Set<string>([
        ...(manifest?.packs.map((p) => p.name) ?? []),
        ...stored.map((s) => s.name),
        ...loaded.keys(),
      ]);
      return [...names].map((name): PackState => {
        const offered = offeredEntry(name);
        const known = fromEngine.find((p) => p.name === name);
        const copy = savedCopy(name);
        const busy = downloads.get(name);
        const isIn = loaded.has(name) || Boolean(known?.loaded);
        return {
          name,
          version: offered?.version ?? known?.version ?? '',
          label: offered?.label ?? known?.label ?? name,
          description: offered?.description ?? known?.description ?? '',
          bytes: offered?.bytes ?? copy?.bytes ?? known?.bytes ?? 0,
          provides: [...(offered?.provides ?? known?.provides ?? [])],
          loaded: isIn,
          offered: Boolean(offered),
          supported: Boolean(known),
          saved: Boolean(copy),
          savedBytes: copy?.bytes ?? 0,
          stale: Boolean(copy && offered && copy.rev !== offered.rev),
          removedInUse: !copy && isIn && removedInUse.has(name),
          progress: busy ? { received: busy.received, total: busy.total } : null,
          error: errors.get(name) ?? null,
        };
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    destroy() {
      destroyed = true;
      for (const d of downloads.values()) d.controller.abort();
      listeners.clear();
    },
  };
  return service;
}

/** A service for pages without packs (developer harnesses): nothing offered, nothing loads. */
export const NO_PACKS: PackService = {
  ensure: async () => false,
  status: () => [],
  remove: async () => undefined,
  get: async () => false,
  subscribe: () => () => undefined,
  refresh: async () => undefined,
};

/** The size of a pack in the prompt's words: `0.4 MB`. */
export { formatBytes };
