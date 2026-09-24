/**
 * The frame scheduler, `watch`, and the memoising engine wrapper that lets several
 * components share one engine result per frame.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createScheduler,
  deepFreeze,
  disposer,
  memoEngine,
  memoize,
  watch,
} from '../../src/next/component.js';
import type { ExplorerEngine, SkyState } from '../../src/next/engine/types.js';
import { createExplorerStore, shallowEqual } from '../../src/next/state.js';
import { FakeFrames } from './helpers.js';

function scheduler() {
  const frames = new FakeFrames();
  return { frames, scheduler: createScheduler({ requestFrame: frames.request, cancelFrame: frames.cancel }) };
}

describe('frame scheduler', () => {
  it('runs a task once per frame however often it is scheduled', () => {
    const { frames, scheduler: s } = scheduler();
    const task = vi.fn();
    s.schedule(task);
    s.schedule(task);
    s.schedule(task);
    expect(task).not.toHaveBeenCalled();
    frames.step();
    expect(task).toHaveBeenCalledTimes(1);
    frames.step();
    expect(task).toHaveBeenCalledTimes(1);
    expect(frames.pending).toBe(0);
  });

  it('runs frame hooks first, and their scheduled tasks in the same frame', () => {
    const { frames, scheduler: s } = scheduler();
    const order: string[] = [];
    const draw = (): void => {
      order.push('draw');
    };
    const off = s.onFrame(() => {
      order.push('hook');
      s.schedule(draw);
    });
    frames.step();
    expect(order).toEqual(['hook', 'draw']);
    frames.step();
    expect(order).toEqual(['hook', 'draw', 'hook', 'draw']);
    off();
    frames.step();
    expect(frames.pending).toBe(0);
  });

  it('keeps going when a task throws', () => {
    const errors: unknown[] = [];
    const frames = new FakeFrames();
    const s = createScheduler({
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      onError: (e) => errors.push(e),
    });
    const good = vi.fn();
    s.schedule(() => {
      throw new Error('bad view');
    });
    s.schedule(good);
    frames.step();
    expect(good).toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });

  it('skips a task cancelled earlier in the same frame', () => {
    const { frames, scheduler: s } = scheduler();
    const later = vi.fn();
    s.schedule(() => s.cancel(later)); // e.g. a view destroying another view
    s.schedule(later);
    frames.step();
    expect(later).not.toHaveBeenCalled();
  });

  it('flushes on demand and cancels', () => {
    const { frames, scheduler: s } = scheduler();
    const a = vi.fn();
    const b = vi.fn();
    s.schedule(a);
    s.schedule(b);
    s.cancel(b);
    s.flush(0);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    s.destroy();
    s.schedule(a);
    expect(frames.pending).toBe(0);
  });
});

describe('watch', () => {
  it('redraws once per frame with the latest value', () => {
    const { frames, scheduler: s } = scheduler();
    const store = createExplorerStore({ storage: null, now: () => 0 });
    const seen: number[] = [];
    const stop = watch({ store, scheduler: s }, (st) => st.time.jd_utc, (jd) => seen.push(jd));
    frames.step();
    expect(seen).toHaveLength(1); // the initial render
    store.patch({ time: { jd_utc: 1 } });
    store.patch({ time: { jd_utc: 2 } });
    store.patch({ selection: { body: 'Moon' } }); // not watched
    frames.step();
    expect(seen.slice(1)).toEqual([2]);
    stop();
    store.patch({ time: { jd_utc: 3 } });
    frames.step();
    expect(seen.slice(1)).toEqual([2]);
  });

  it('can compare tuples and skip the initial render', () => {
    const { frames, scheduler: s } = scheduler();
    const store = createExplorerStore({ storage: null, now: () => 0 });
    const render = vi.fn();
    watch(
      { store, scheduler: s },
      (st) => [st.observer.lat_deg, st.observer.lon_deg],
      render,
      { equals: shallowEqual, immediate: false },
    );
    store.patch({ observer: { label: 'renamed only' } });
    frames.step();
    expect(render).not.toHaveBeenCalled();
    store.patch({ observer: { lat_deg: 1 } });
    frames.step();
    expect(render).toHaveBeenCalledTimes(1);
  });
});

function fakeEngine(): ExplorerEngine & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const count = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const sky = (jd: number): SkyState => ({
    jd_utc: jd,
    utc: '',
    gha_aries_deg: 0,
    sun_altitude_deg: 0,
    sky_phase: 'day',
    bodies: [],
    errors: [],
  });
  const engine = {
    kind: 'mock',
    description: 'fake',
    calls,
    bodies: () => (count('bodies'), []),
    coverage: () => (count('coverage'), { start_utc: '', end_utc: '', groups: [] }),
    skyState: (_o: unknown, jd: number) => (count('skyState'), sky(jd)),
    sampleBodies: () => (count('sampleBodies'), { jd_utc: new Float64Array(0), bodies: [], errors: [] }),
    dayEvents: () => (count('dayEvents'), { jd_start: 0, jd_end: 1, phases: [], bodies: [], errors: [] }),
    dayEventsBatch: () => (count('dayEventsBatch'), []),
    findAltitude: () => (count('findAltitude'), []),
    moonPhases: () => (count('moonPhases'), []),
    seasons: () => (count('seasons'), []),
    sidereal: () => (count('sidereal'), { gha_aries_deg: 1 }),
    starfieldCatalog: () => {
      count('starfieldCatalog');
      throw new Error('no star field');
    },
    starfieldApparent: () => (count('starfieldApparent'), new Float64Array(2)),
    constellationAt: () => (count('constellationAt'), 'Ori'),
    constellationBoundaries: () => (count('constellationBoundaries'), []),
  };
  return engine as unknown as ExplorerEngine & { calls: Record<string, number> };
}

describe('memoised engine', () => {
  const here = { lat_deg: 39.95, lon_deg: -75.17 };

  it('shares one result for identical calls and recomputes when an input changes', () => {
    const raw = fakeEngine();
    const engine = memoEngine(raw);
    const a = engine.skyState(here, 2461308, 'all');
    const b = engine.skyState({ ...here }, 2461308, 'all');
    expect(b).toBe(a);
    expect(raw.calls.skyState).toBe(1);
    engine.skyState(here, 2461308.001, 'all');
    engine.skyState(here, 2461308, ['Sun']);
    engine.skyState({ ...here, height_m: 100 }, 2461308, 'all');
    expect(raw.calls.skyState).toBe(4);
    expect(engine.kind).toBe('mock');
    expect(engine.description).toBe('fake');
  });

  it('evicts the least recently used entry', () => {
    const raw = fakeEngine();
    const engine = memoEngine(raw, { capacity: 2 });
    engine.skyState(here, 1, 'all');
    engine.skyState(here, 2, 'all');
    engine.skyState(here, 1, 'all'); // 1 is now the most recent
    engine.skyState(here, 3, 'all'); // evicts 2
    engine.skyState(here, 1, 'all');
    expect(raw.calls.skyState).toBe(3);
    engine.skyState(here, 2, 'all');
    expect(raw.calls.skyState).toBe(4);
  });

  it('computes constant tables once and never caches errors', () => {
    const raw = fakeEngine();
    const engine = memoEngine(raw);
    engine.bodies();
    engine.bodies();
    engine.coverage();
    engine.coverage();
    expect(raw.calls.bodies).toBe(1);
    expect(raw.calls.coverage).toBe(1);
    expect(() => engine.starfieldCatalog()).toThrow('no star field');
    expect(() => engine.starfieldCatalog()).toThrow('no star field');
    expect(raw.calls.starfieldCatalog).toBe(2);
    engine.sidereal(1);
    engine.sidereal(1);
    expect(raw.calls.sidereal).toBe(2); // cheap: passed straight through
  });

  it('keys day events by window, bodies and options', () => {
    const raw = fakeEngine();
    const engine = memoEngine(raw);
    engine.dayEvents(here, 1, 2, 'all');
    engine.dayEvents(here, 1, 2, 'all');
    engine.dayEvents(here, 1, 2, 'all', { horizon: 'dip', height_of_eye_m: 3 });
    engine.dayEvents(here, 1, 2, 'all', { horizon: 'dip', height_of_eye_m: 4 });
    expect(raw.calls.dayEvents).toBe(3);
  });

  it('freezes shared results in development so a mutating view fails loudly', () => {
    const engine = memoEngine(fakeEngine(), { freeze: true });
    const state = engine.skyState(here, 1, 'all');
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.bodies)).toBe(true);
    expect(() => (state.bodies as unknown[]).push(1)).toThrow();
    const apparent = engine.starfieldApparent(1);
    expect(() => {
      apparent[0] = 1; // typed arrays cannot be frozen; they stay writable
    }).not.toThrow();
  });
});

describe('small helpers', () => {
  it('deepFreeze leaves typed arrays alone', () => {
    const value = deepFreeze({ a: [1, { b: 2 }], t: new Float64Array(1) });
    expect(Object.isFrozen(value.a[1])).toBe(true);
    expect(Object.isFrozen(value.t)).toBe(false);
  });

  it('memoize caches by key', () => {
    const fn = vi.fn((x: number) => x * 2);
    const m = memoize(fn, (x) => String(x), 2);
    expect(m(2)).toBe(4);
    expect(m(2)).toBe(4);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('disposer runs clean-ups once, newest first', () => {
    const order: number[] = [];
    const d = disposer();
    d.add(() => order.push(1));
    d.add(() => order.push(2));
    d.dispose();
    d.dispose();
    d.add(() => order.push(3)); // after disposal: runs at once
    expect(order).toEqual([2, 1, 3]);
  });
});
