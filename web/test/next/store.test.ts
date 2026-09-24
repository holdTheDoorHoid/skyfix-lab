/**
 * The store every explorer view shares: patch semantics, selector subscriptions,
 * batching, re-entrancy, and what is (and is never) persisted.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyPatch,
  createExplorerStore,
  createStore,
  currentDayWindow,
  DEFAULT_LAYERS,
  DEFAULT_SETTINGS,
  displayZone,
  engineObserver,
  eventOptions,
  loadPrefs,
  PREFS_KEY,
  sanitizeSettings,
  shallowEqual,
} from '../../src/next/state.js';
import { createNotices } from '../../src/next/notices.js';
import { isoUtc, jdFromIso, UTC_ZONE } from '../../src/next/time.js';
import { MemoryStorage, ThrowingStorage } from './helpers.js';

interface Demo {
  a: { x: number; y: number };
  b: { z: string };
  n: number;
  list: number[];
}

const demo = (): Demo => ({ a: { x: 1, y: 2 }, b: { z: 'q' }, n: 0, list: [1] });

describe('patch semantics', () => {
  it('merges one level deep and keeps untouched slices by reference', () => {
    const s = demo();
    const next = applyPatch(s, { a: { x: 5 } });
    expect(next.a).toEqual({ x: 5, y: 2 });
    expect(next.b).toBe(s.b);
    expect(s.a.x).toBe(1); // the old state is never mutated
  });

  it('returns the same object when nothing changes', () => {
    const s = demo();
    expect(applyPatch(s, { a: { x: 1 } })).toBe(s);
    expect(applyPatch(s, { n: 0 })).toBe(s);
    expect(applyPatch(s, { a: { x: undefined } })).toBe(s);
  });

  it('replaces arrays and primitives instead of merging them', () => {
    const s = demo();
    const next = applyPatch(s, { list: [2, 3], n: 4 });
    expect(next.list).toEqual([2, 3]);
    expect(next.n).toBe(4);
  });
});

describe('store', () => {
  it('notifies subscribers with the new and previous state', () => {
    const store = createStore(demo());
    const seen: [number, number][] = [];
    store.subscribe((s, prev) => seen.push([s.a.x, prev.a.x]));
    store.patch({ a: { x: 2 } });
    store.set((s) => ({ ...s, a: { ...s.a, x: 3 } }));
    expect(seen).toEqual([
      [2, 1],
      [3, 2],
    ]);
  });

  it('does not notify when a patch changes nothing', () => {
    const store = createStore(demo());
    const listener = vi.fn();
    store.subscribe(listener);
    store.patch({ a: { x: 1 }, b: { z: 'q' } });
    expect(listener).not.toHaveBeenCalled();
  });

  it('select fires only when the selected value changes', () => {
    const store = createStore(demo());
    const onA = vi.fn();
    store.select((s) => s.a, onA);
    store.patch({ b: { z: 'other' } });
    store.patch({ n: 7 });
    expect(onA).not.toHaveBeenCalled();
    store.patch({ a: { y: 9 } });
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onA.mock.calls[0]![0]).toEqual({ x: 1, y: 9 });
    expect(onA.mock.calls[0]![1]).toEqual({ x: 1, y: 2 });
  });

  it('select accepts a custom equality for derived tuples', () => {
    const store = createStore(demo());
    const listener = vi.fn();
    store.select((s) => [s.a.x, s.b.z] as const, listener, { equals: shallowEqual });
    store.patch({ a: { y: 100 } }); // the tuple is rebuilt but equal
    expect(listener).not.toHaveBeenCalled();
    store.patch({ b: { z: 'changed' } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('select can fire immediately', () => {
    const store = createStore(demo());
    const listener = vi.fn();
    store.select((s) => s.n, listener, { immediate: true });
    expect(listener).toHaveBeenCalledWith(0, 0);
  });

  it('batch notifies once, with the state from before the batch as prev', () => {
    const store = createStore(demo());
    const calls: [number, number][] = [];
    store.subscribe((s, prev) => calls.push([s.n, prev.n]));
    const result = store.batch(() => {
      store.patch({ n: 1 });
      store.patch({ n: 2 });
      store.batch(() => store.patch({ n: 3 }));
      expect(calls).toEqual([]); // nested batches do not flush early
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls).toEqual([[3, 0]]);
  });

  it('a listener that patches causes a second round after the first finishes', () => {
    const store = createStore(demo());
    const order: string[] = [];
    store.subscribe((s) => {
      order.push(`first:${s.n}`);
      if (s.n === 1) store.patch({ n: 2 });
    });
    store.subscribe((s) => order.push(`second:${s.n}`));
    store.patch({ n: 1 });
    expect(order).toEqual(['first:1', 'second:1', 'first:2', 'second:2']);
    expect(store.get().n).toBe(2);
  });

  it('stops a listener loop that never settles, and reports it', () => {
    const errors: unknown[] = [];
    const store = createStore(demo(), { onError: (e) => errors.push(e) });
    store.subscribe((s) => store.patch({ n: s.n + 1 }));
    store.patch({ n: 1 });
    expect(errors.length).toBe(1);
    expect(String(errors[0])).toMatch(/kept changing the state/);
  });

  it('isolates a throwing listener from the others', () => {
    const errors: unknown[] = [];
    const store = createStore(demo(), { onError: (e) => errors.push(e) });
    const good = vi.fn();
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe(good);
    store.patch({ n: 1 });
    expect(good).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });

  it('does not call a listener removed earlier in the same round', () => {
    const store = createStore(demo());
    const second = vi.fn();
    let offSecond = (): void => undefined;
    store.subscribe(() => offSecond()); // the first listener destroys the second view
    offSecond = store.subscribe(second);
    store.patch({ n: 1 });
    expect(second).not.toHaveBeenCalled();
  });

  it('unsubscribes', () => {
    const store = createStore(demo());
    const listener = vi.fn();
    const off = store.subscribe(listener);
    const offSelect = store.select((s) => s.n, listener);
    off();
    offSelect();
    store.patch({ n: 1 });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('explorer store', () => {
  const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

  it('starts live at now, at the reference place, with the Sun selected', () => {
    const store = createExplorerStore({ storage: null, now: () => NOW });
    const s = store.get();
    expect(isoUtc(s.time.jd_utc)).toBe('2026-09-24T12:00:00.000Z');
    expect(s.time).toMatchObject({ live: true, playing: false });
    expect(s.observer.label).toBe('Philadelphia City Hall');
    expect(s.selection.body).toBe('Sun');
    expect(s.view).toBe('map');
    expect(s.layers.streets).toBe(false); // the network layer is off by default
  });

  it('derives the engine observer, zones, event options and the local day', () => {
    const store = createExplorerStore({ storage: null, now: () => NOW });
    const s = store.get();
    expect(engineObserver(s)).toEqual({ lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 });
    expect(displayZone(s)).toEqual({ kind: 'iana', zone: 'America/New_York' });
    expect(eventOptions(s)).toEqual({ horizon: 'standard', height_of_eye_m: 2 });
    const [a, b] = currentDayWindow(s);
    expect([isoUtc(a), isoUtc(b)]).toEqual(['2026-09-24T04:00:00.000Z', '2026-09-25T04:00:00.000Z']);
    store.patch({ settings: { timeDisplay: 'utc' } });
    expect(displayZone(store.get())).toEqual(UTC_ZONE);
  });

  it('persists settings and layers, and restores them in a new store', () => {
    const storage = new MemoryStorage();
    const store = createExplorerStore({ storage, now: () => NOW });
    expect(storage.writes).toBe(0); // loading writes nothing
    store.patch({ settings: { theme: 'night', height_of_eye_m: 3.5 }, layers: { graticule: true } });
    const again = createExplorerStore({ storage, now: () => NOW });
    expect(again.get().settings.theme).toBe('night');
    expect(again.get().settings.height_of_eye_m).toBe(3.5);
    expect(again.get().layers.graticule).toBe(true);
  });

  it('never persists the place, its name or its time zone', () => {
    const storage = new MemoryStorage();
    const store = createExplorerStore({ storage, now: () => NOW });
    store.patch({
      observer: {
        lat_deg: -33.8568,
        lon_deg: 151.2153,
        label: 'Sydney Opera House',
        zone: { kind: 'iana', zone: 'Australia/Sydney' },
      },
    });
    store.patch({ settings: { units: 'nautical' } }); // forces a write
    const written = storage.dump();
    expect(written).toContain('nautical');
    expect(written).not.toMatch(/33\.85|151\.21|Sydney|lat_deg|lon_deg|observer/);
    expect(Object.keys(JSON.parse(storage.getItem(PREFS_KEY)!) as object).sort()).toEqual([
      'layers',
      'settings',
    ]);
    // A new store starts at the default place, not the last one used.
    expect(createExplorerStore({ storage, now: () => NOW }).get().observer.label).toBe(
      'Philadelphia City Hall',
    );
  });

  it('ignores corrupt or hostile stored preferences field by field', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      PREFS_KEY,
      JSON.stringify({
        settings: { theme: 'neon', units: 'imperial', height_of_eye_m: 1e9, navigatorTerms: 'yes' },
        layers: { graticule: true, streets: 'please', bogus: true },
      }),
    );
    const { settings, layers } = loadPrefs(storage);
    expect(settings.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(settings.units).toBe('imperial');
    expect(settings.height_of_eye_m).toBe(DEFAULT_SETTINGS.height_of_eye_m);
    expect(settings.navigatorTerms).toBe(DEFAULT_SETTINGS.navigatorTerms);
    expect(layers.graticule).toBe(true);
    expect(layers.streets).toBe(DEFAULT_LAYERS.streets);
    expect('bogus' in layers).toBe(false);
    storage.setItem(PREFS_KEY, '{not json');
    expect(loadPrefs(storage).settings).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('works when storage throws on every call', () => {
    const store = createExplorerStore({ storage: new ThrowingStorage(), now: () => NOW });
    expect(() => store.patch({ settings: { theme: 'dark' } })).not.toThrow();
    expect(store.get().settings.theme).toBe('dark');
  });

  it('accepts an initial patch over the defaults', () => {
    const jd = jdFromIso('2030-01-01T00:00:00Z')!;
    const store = createExplorerStore({
      storage: null,
      initial: { time: { jd_utc: jd, live: false }, view: 'sky' },
    });
    expect(store.get().time.jd_utc).toBe(jd);
    expect(store.get().time.live).toBe(false);
    expect(store.get().view).toBe('sky');
  });
});

describe('notices', () => {
  it('replaces keyed notices and keeps persistent ones', () => {
    const notices = createNotices({ max: 3 });
    const seen: number[] = [];
    notices.subscribe((list) => seen.push(list.length));
    const pinned = notices.push('caution', 'mock engine', { persistent: true });
    notices.push('error', 'sky failed 1', { key: 'sky' });
    notices.push('error', 'sky failed 2', { key: 'sky' });
    expect(notices.list().map((n) => n.text)).toEqual(['mock engine', 'sky failed 2']);
    notices.dismiss(pinned.id);
    expect(notices.list()).toHaveLength(2);
    for (let i = 0; i < 5; i += 1) notices.push('info', `n${i}`);
    expect(notices.list()).toHaveLength(3);
    expect(notices.list()[0]!.text).toBe('mock engine');
    notices.clear();
    expect(notices.list().map((n) => n.text)).toEqual(['mock engine']);
    notices.dismissKey('nothing');
    expect(seen.length).toBeGreaterThan(0);
  });
});
