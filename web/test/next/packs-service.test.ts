/**
 * The page side of the data packs (src/next/packs/): the site's manifest, the app's own
 * store, and the service behind `ctx.packs` — loading saved packs at start-up, the one
 * prompt, downloading with checks, remembering "Not now", replacing a stale copy, removing
 * — with a fake engine, a fake prompt and an in-memory store (no browser here).
 */

import { describe, expect, it } from 'vitest';
import { encodePack, packRev } from '../../plugins/packs.ts';
import type { PackEngine, PackInfo, PackStatus } from '../../src/next/engine/types.ts';
import { formatBytes, parseManifest, type PackManifestEntry } from '../../src/next/packs/manifest.ts';
import {
  createPackService,
  NO_PACKS,
  type PackServiceOptions,
  type PromptAnswer,
  type PromptHandle,
  type Prompter,
  type PromptRequest,
} from '../../src/next/packs/service.ts';
import { memoryPackStorage, packOfUrl } from '../../src/next/packs/storage.ts';

const ROOT = 'https://holdthedoorhoid.github.io/skyfix-lab/';
const MANIFEST_URL = `${ROOT}data/packs/manifest.json`;
const enc = new TextEncoder();

// ---------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------

/** An engine that knows `deep-time` and `tides-us`, and refuses files whose payload says "bad". */
class FakeEngine implements PackEngine {
  readonly loads: { name: string; bytes: number }[] = [];
  private readonly loaded = new Map<string, PackInfo>();
  constructor(private readonly known = ['deep-time', 'tides-us']) {}
  packs(): PackStatus[] {
    return this.known.map((name) => ({
      name,
      version: this.loaded.get(name)?.version ?? '',
      label: `engine ${name}`,
      description: `engine says ${name}`,
      bytes: this.loaded.get(name)?.bytes ?? 0,
      provides: [],
      loaded: this.loaded.has(name),
    }));
  }
  loadPack(name: string, bytes: Uint8Array): PackInfo {
    if (!this.known.includes(name)) throw new Error(`no pack called "${name}" in this build`);
    if (new TextDecoder().decode(bytes).includes('bad')) throw new Error(`the ${name} pack: its data is damaged`);
    const info = { name, version: 'v', bytes: bytes.byteLength, provides: [] };
    this.loaded.set(name, info);
    this.loads.push({ name, bytes: bytes.byteLength });
    return info;
  }
}

/** A prompt that answers from a script, and records what it was shown. */
class FakePrompter implements Prompter {
  readonly asked: PromptRequest[] = [];
  readonly shown: string[] = [];
  progressCalls = 0;
  stopNext = false;
  onFailed: () => void = () => undefined;
  constructor(private readonly answers: PromptAnswer[] = []) {}
  ask(request: PromptRequest): PromptHandle {
    this.asked.push(request);
    const answers = this.answers;
    const self = this;
    return {
      answer: Promise.resolve(answers.shift() ?? 'dismiss'),
      downloading(onStop) {
        self.shown.push('downloading');
        if (self.stopNext) {
          self.stopNext = false;
          onStop();
        }
      },
      progress() {
        self.progressCalls += 1;
      },
      failed(message) {
        self.shown.push(`failed: ${message}`);
        self.onFailed();
        return Promise.resolve(answers.shift() ?? 'dismiss');
      },
      done(message) {
        self.shown.push(`done: ${message}`);
      },
      close() {
        self.shown.push('closed');
      },
    };
  }
}

function pack(name: string, payload: string, version = '2026-09-24'): { entry: PackManifestEntry; bytes: Uint8Array; url: string } {
  const bytes = encodePack(name, enc.encode(payload));
  const rev = packRev(bytes);
  const entry: PackManifestEntry = {
    name,
    version,
    rev,
    file: `${name}-${rev}.bin`,
    bytes: bytes.byteLength,
    label: name === 'deep-time' ? 'Deep time' : 'US tides',
    description: name === 'deep-time' ? 'Positions from 2000 BC to AD 3000' : 'Tide predictions',
    provides: [],
  };
  return { entry, bytes, url: `${ROOT}data/packs/${entry.file}` };
}

interface Rig {
  service: ReturnType<typeof createPackService>;
  engine: FakeEngine;
  prompter: FakePrompter;
  storage: ReturnType<typeof memoryPackStorage>;
  downloads: string[];
  loadedNames: string[];
  online: { value: boolean };
}

function rig(
  offered: { entry: PackManifestEntry; bytes: Uint8Array }[],
  more: Partial<PackServiceOptions> & { answers?: PromptAnswer[]; saved?: [string, Uint8Array][]; files?: Map<string, Uint8Array>; engine?: FakeEngine; noStorage?: boolean } = {},
): Rig {
  const engine = more.engine ?? new FakeEngine();
  const prompter = new FakePrompter(more.answers ?? []);
  const storage = memoryPackStorage(more.saved ?? []);
  const downloads: string[] = [];
  const loadedNames: string[] = [];
  const online = { value: true };
  const files = more.files ?? new Map(offered.map((o) => [`${ROOT}data/packs/${o.entry.file}`, o.bytes]));
  const service = createPackService({
    engine,
    storage: more.noStorage ? null : storage,
    manifestUrl: MANIFEST_URL,
    prompter,
    fetchJson: async () => ({ schema: 'skyfix.packs/1', packs: offered.map((o) => o.entry) }),
    download: async (url, onProgress) => {
      downloads.push(url);
      if (!online.value) throw new TypeError('Failed to fetch');
      const bytes = files.get(url);
      if (!bytes) throw new Error('the site answered 404');
      onProgress(Math.floor(bytes.byteLength / 2), bytes.byteLength);
      onProgress(bytes.byteLength, bytes.byteLength);
      return bytes.slice();
    },
    digest: async (bytes) => packRev(bytes),
    isOnline: () => online.value,
    onLoaded: (name) => loadedNames.push(name),
    warn: () => undefined,
    ...more,
  });
  return { service, engine, prompter, storage, downloads, loadedNames, online };
}

const DEEP = pack('deep-time', 'deep time tables');
const TIDES = pack('tides-us', 'station constants');

// ---------------------------------------------------------------------------------
// The manifest and the store
// ---------------------------------------------------------------------------------

describe('the site’s manifest, as the page reads it', () => {
  it('keeps well-formed entries and drops the rest', () => {
    const m = parseManifest({
      schema: 'skyfix.packs/1',
      packs: [
        DEEP.entry,
        { ...TIDES.entry, file: '../../evil.bin' },
        { ...TIDES.entry, name: 'Tides US' },
        { ...TIDES.entry, bytes: -1 },
        { ...DEEP.entry, label: 'duplicate' },
        'nonsense',
      ],
    });
    expect(m.packs).toEqual([DEEP.entry]);
  });

  it('refuses another document', () => {
    expect(() => parseManifest({ schema: 'skyfix.basemap/1', files: [] })).toThrow(/skyfix\.packs\/1/);
    expect(() => parseManifest(null)).toThrow();
  });

  it('writes sizes the way the prompt says them', () => {
    expect(formatBytes(412_000)).toBe('0.4 MB');
    expect(formatBytes(86_400)).toBe('86 KB');
    expect(formatBytes(2_040_000)).toBe('2.0 MB');
    expect(formatBytes(12_400_000)).toBe('12 MB');
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(120)).toBe('1 KB');
  });

  it('reads a pack’s name and revision back from its stored address', () => {
    expect(packOfUrl(DEEP.url)).toEqual({ name: 'deep-time', rev: DEEP.entry.rev });
    expect(packOfUrl(`${ROOT}data/packs/manifest.json`)).toBeNull();
    expect(packOfUrl('not a url')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------------

describe('start-up: saved packs go into the engine before the first view', () => {
  it('loads every saved pack the site offers, without asking or downloading', async () => {
    const r = rig([DEEP, TIDES], { saved: [[DEEP.url, DEEP.bytes]] });
    await r.service.start();
    expect(r.engine.loads).toEqual([{ name: 'deep-time', bytes: DEEP.bytes.byteLength }]);
    expect(r.loadedNames).toEqual(['deep-time']);
    expect(r.prompter.asked).toEqual([]);
    expect(r.downloads).toEqual([]);
    const s = r.service.status();
    expect(s.map((p) => p.name)).toEqual(['deep-time', 'tides-us']);
    expect(s[0]).toMatchObject({ loaded: true, saved: true, stale: false, offered: true, supported: true, label: 'Deep time', bytes: DEEP.bytes.byteLength });
    expect(s[1]).toMatchObject({ loaded: false, saved: false, offered: true });
  });

  it('with nothing saved, costs one look at the store and nothing else', async () => {
    let manifestReads = 0;
    const r = rig([DEEP], { fetchJson: async () => (manifestReads++, { schema: 'skyfix.packs/1', packs: [DEEP.entry] }) });
    await r.service.start();
    expect(manifestReads).toBe(0);
    expect(r.engine.loads).toEqual([]);
  });

  it('still loads an older saved revision (it works offline) and marks it stale', async () => {
    const old = pack('deep-time', 'older tables', '2026-01-01');
    const r = rig([DEEP], { saved: [[old.url, old.bytes]] });
    await r.service.start();
    expect(r.engine.loads).toEqual([{ name: 'deep-time', bytes: old.bytes.byteLength }]);
    expect(r.service.status()[0]).toMatchObject({ loaded: true, saved: true, stale: true });
  });

  it('deletes a saved copy the engine refuses, and says why', async () => {
    const broken = pack('deep-time', 'bad tables');
    const r = rig([{ entry: { ...broken.entry }, bytes: broken.bytes }], { saved: [[broken.url, broken.bytes]] });
    await r.service.start();
    expect(r.storage.files.size).toBe(0);
    const s = r.service.status()[0]!;
    expect(s.loaded).toBe(false);
    expect(s.error).toMatch(/could not be used and was deleted: the deep-time pack: its data is damaged/);
  });

  it('deletes a saved pack the site no longer offers, and keeps extra copies to one', async () => {
    const old = pack('deep-time', 'older tables');
    const r = rig([DEEP], { saved: [[TIDES.url, TIDES.bytes], [old.url, old.bytes], [DEEP.url, DEEP.bytes]] });
    await r.service.start();
    expect([...r.storage.files.keys()]).toEqual([DEEP.url]);
    expect(r.engine.loads.map((l) => l.bytes)).toEqual([DEEP.bytes.byteLength]);
  });

  it('keeps and loads saved packs when the site’s list cannot be read', async () => {
    const r = rig([], { saved: [[DEEP.url, DEEP.bytes]], fetchJson: async () => Promise.reject(new Error('offline')) });
    await r.service.start();
    expect(r.engine.loads).toEqual([{ name: 'deep-time', bytes: DEEP.bytes.byteLength }]);
    expect(r.storage.files.has(DEEP.url)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------
// ensure: the one prompt
// ---------------------------------------------------------------------------------

describe('ensure: a view that needs a pack', () => {
  it('asks once with the reason and the size, then downloads, checks, loads and saves', async () => {
    const r = rig([DEEP], { answers: ['get'] });
    await expect(r.service.ensure('deep-time', 'Positions before 1550 need the Deep time pack')).resolves.toBe(true);
    expect(r.prompter.asked).toEqual([
      {
        name: 'deep-time',
        label: 'Deep time',
        description: 'Positions from 2000 BC to AD 3000',
        bytes: DEEP.bytes.byteLength,
        reason: 'Positions before 1550 need the Deep time pack',
        offline: false,
      },
    ]);
    expect(r.prompter.shown).toEqual(['downloading', 'done: The Deep time pack is saved on this device.']);
    expect(r.prompter.progressCalls).toBe(2);
    expect(r.downloads).toEqual([DEEP.url]);
    expect(r.engine.loads).toHaveLength(1);
    expect([...r.storage.files.keys()]).toEqual([DEEP.url]);
    expect(r.loadedNames).toEqual(['deep-time']);
    // Now it is there: no second prompt, no second download.
    await expect(r.service.ensure('deep-time', 'again')).resolves.toBe(true);
    expect(r.prompter.asked).toHaveLength(1);
    expect(r.downloads).toHaveLength(1);
  });

  it('remembers Not now for the page session: no second prompt', async () => {
    const r = rig([DEEP], { answers: ['dismiss', 'get'] });
    await expect(r.service.ensure('deep-time', 'why')).resolves.toBe(false);
    await expect(r.service.ensure('deep-time', 'why')).resolves.toBe(false);
    expect(r.prompter.asked).toHaveLength(1);
    expect(r.prompter.shown).toEqual(['closed']);
    expect(r.downloads).toEqual([]);
    // Settings → Get still works, and clears the choice.
    await expect(r.service.get('deep-time')).resolves.toBe(true);
    expect(r.service.status()[0]).toMatchObject({ loaded: true, saved: true });
  });

  it('shares one prompt between views that ask at the same time', async () => {
    const r = rig([DEEP], { answers: ['get'] });
    const [a, b] = await Promise.all([r.service.ensure('deep-time', 'one'), r.service.ensure('deep-time', 'two')]);
    expect([a, b]).toEqual([true, true]);
    expect(r.prompter.asked).toHaveLength(1);
    expect(r.downloads).toHaveLength(1);
  });

  it('loads a saved copy without asking', async () => {
    const r = rig([DEEP], { saved: [[DEEP.url, DEEP.bytes]] });
    await expect(r.service.ensure('deep-time', 'why')).resolves.toBe(true);
    expect(r.prompter.asked).toEqual([]);
    expect(r.downloads).toEqual([]);
  });

  it('offline without a copy: the prompt says so; trying again offline fails in words; dismissing is remembered', async () => {
    const r = rig([DEEP], { answers: ['get', 'dismiss'] });
    r.online.value = false;
    await expect(r.service.ensure('deep-time', 'why')).resolves.toBe(false);
    expect(r.prompter.asked[0]!.offline).toBe(true);
    expect(r.prompter.shown).toEqual(['downloading', 'failed: The Deep time pack could not be downloaded: you are offline.', 'closed']);
    expect(r.service.status()[0]!.error).toBe('Could not be downloaded: you are offline.');
    await expect(r.service.ensure('deep-time', 'why')).resolves.toBe(false);
    expect(r.prompter.asked).toHaveLength(1);
  });

  it('tries again after a failure, and succeeds', async () => {
    const files = new Map<string, Uint8Array>();
    const r = rig([DEEP], { answers: ['get', 'get'], files });
    // The first download finds nothing (a 404); the file is there when the person tries again.
    r.prompter.onFailed = () => files.set(DEEP.url, DEEP.bytes);
    await expect(r.service.ensure('deep-time', 'why')).resolves.toBe(true);
    expect(r.prompter.shown[1]).toMatch(/^failed: The Deep time pack could not be downloaded: the site answered 404\./);
    expect(r.prompter.shown.at(-1)).toMatch(/^done:/);
    expect(r.service.status()[0]!.error).toBeNull();
  });

  it('Stop during the download counts as Not now', async () => {
    // The fake download fails once stopped (a real fetch rejects when aborted).
    const r = rig([DEEP], { answers: ['get'], files: new Map() });
    r.prompter.stopNext = true;
    await expect(r.service.ensure('deep-time', 'why')).resolves.toBe(false);
    expect(r.prompter.shown).toEqual(['downloading', 'closed']);
    await expect(r.service.ensure('deep-time', 'why')).resolves.toBe(false);
    expect(r.prompter.asked).toHaveLength(1);
  });

  it('never keeps a file the engine refuses, or one that is not the file the site lists', async () => {
    const broken = pack('deep-time', 'bad tables');
    const r = rig([broken], { answers: ['get', 'dismiss'] });
    await expect(r.service.ensure('deep-time', 'why')).resolves.toBe(false);
    expect(r.storage.files.size).toBe(0);
    expect(r.prompter.shown[1]).toMatch(/its data is damaged/);

    const other = pack('deep-time', 'deep time TABLES'); // the same size, other bytes
    const swapped = rig([DEEP], { answers: ['get', 'dismiss'], files: new Map([[DEEP.url, other.bytes]]) });
    await expect(swapped.service.ensure('deep-time', 'why')).resolves.toBe(false);
    expect(swapped.engine.loads).toEqual([]);
    expect(swapped.storage.files.size).toBe(0);
    expect(swapped.prompter.shown[1]).toMatch(/not the one the site lists/);

    const short = rig([DEEP], { answers: ['get', 'dismiss'], files: new Map([[DEEP.url, DEEP.bytes.subarray(0, 10)]]) });
    await expect(short.service.ensure('deep-time', 'why')).resolves.toBe(false);
    expect(short.prompter.shown[1]).toMatch(/the file is 10 bytes, the site lists/);
  });

  it('does not prompt for a pack the site does not offer, or the engine cannot load', async () => {
    const r = rig([TIDES], { engine: new FakeEngine(['deep-time']) });
    await expect(r.service.ensure('deep-time', 'why')).resolves.toBe(false);
    await expect(r.service.ensure('tides-us', 'why')).resolves.toBe(false);
    expect(r.prompter.asked).toEqual([]);
    expect(r.service.status()[0]).toMatchObject({ name: 'tides-us', offered: true, supported: false });
  });

  it('replaces a stale saved copy on its next use, in the background, and deletes the old one', async () => {
    const old = pack('deep-time', 'older tables');
    const r = rig([DEEP], { saved: [[old.url, old.bytes]] });
    await r.service.start();
    expect(r.service.status()[0]!.stale).toBe(true);
    await expect(r.service.ensure('deep-time', 'why')).resolves.toBe(true);
    await new Promise((ok) => setTimeout(ok, 0));
    await new Promise((ok) => setTimeout(ok, 0));
    expect(r.downloads).toEqual([DEEP.url]);
    expect([...r.storage.files.keys()]).toEqual([DEEP.url]);
    expect(r.service.status()[0]).toMatchObject({ saved: true, stale: false, loaded: true });
    expect(r.prompter.asked).toEqual([]);
  });

  it('in a browser that cannot save, loads it for this visit and says so', async () => {
    const r = rig([DEEP], { answers: ['get'], noStorage: true });
    await expect(r.service.ensure('deep-time', 'why')).resolves.toBe(true);
    expect(r.service.status()[0]).toMatchObject({ loaded: true, saved: false, error: 'Loaded for this visit only: this browser cannot save packs.' });
  });
});

// ---------------------------------------------------------------------------------
// Settings: get, remove, status, listeners
// ---------------------------------------------------------------------------------

describe('Settings → Data packs', () => {
  it('Remove deletes the saved copy; a loaded pack stays in use until the page is reloaded', async () => {
    const r = rig([DEEP], { saved: [[DEEP.url, DEEP.bytes]] });
    await r.service.start();
    await r.service.remove('deep-time');
    expect(r.storage.files.size).toBe(0);
    expect(r.service.status()[0]).toMatchObject({ saved: false, loaded: true, removedInUse: true });
    // Still loaded, so a view gets it without a prompt this session.
    await expect(r.service.ensure('deep-time', 'why')).resolves.toBe(true);
    expect(r.prompter.asked).toEqual([]);
  });

  it('Get downloads without a prompt and reports progress to listeners', async () => {
    const r = rig([DEEP, TIDES]);
    let calls = 0;
    const stop = r.service.subscribe(() => (calls += 1));
    await expect(r.service.get('tides-us')).resolves.toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3); // started, progress, finished
    stop();
    const before = calls;
    await r.service.refresh();
    expect(calls).toBe(before);
    expect(r.service.status().find((p) => p.name === 'tides-us')).toMatchObject({ saved: true, loaded: true, savedBytes: TIDES.bytes.byteLength });
    expect(r.prompter.asked).toEqual([]);
  });

  it('Get refuses a pack this core cannot load, before downloading it', async () => {
    const r = rig([TIDES], { engine: new FakeEngine(['deep-time']) });
    await expect(r.service.get('tides-us')).resolves.toBe(false);
    expect(r.downloads).toEqual([]);
    expect(r.service.status()[0]!.error).toBe('This version of the numerical core cannot use this pack.');
  });

  it('lists nothing when the site offers nothing and nothing is saved (the section is then hidden)', async () => {
    const r = rig([]);
    await r.service.start();
    await r.service.refresh();
    expect(r.service.status()).toEqual([]);
  });

  it('works with an engine that has no packs at all (an older core): nothing loads, nothing throws', async () => {
    const r = rig([DEEP], { saved: [[DEEP.url, DEEP.bytes]] });
    const none = createPackService({
      engine: {},
      storage: r.storage,
      manifestUrl: MANIFEST_URL,
      prompter: r.prompter,
      fetchJson: async () => ({ schema: 'skyfix.packs/1', packs: [DEEP.entry] }),
      warn: () => undefined,
    });
    await none.start();
    expect(none.status()[0]).toMatchObject({ supported: false, loaded: false });
  });

  it('NO_PACKS: developer pages get a service that offers nothing', async () => {
    await expect(NO_PACKS.ensure('deep-time', 'why')).resolves.toBe(false);
    expect(NO_PACKS.status()).toEqual([]);
  });
});
