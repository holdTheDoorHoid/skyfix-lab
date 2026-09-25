/**
 * The time bar's pure parts (golden and blue hour bands, hour ticks, fast playback), the
 * words about zones (local mean time, the tz database before 1970, UT), the coverage
 * table's tiers and ΔT rows, and the tier notice service's choices — with the mock engine
 * (time-ui agent).
 */
import { describe, expect, it } from 'vitest';
import { createScheduler, memoEngine } from '../../src/next/component.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { ExplorerCoverage, ExplorerEngine, PackService, PackState, SunLightWindow } from '../../src/next/engine/types.js';
import { createNotices } from '../../src/next/notices.js';
import { createExplorerStore } from '../../src/next/state.js';
import { NO_PACKS } from '../../src/next/packs/service.js';
import { jdFromIso, resolveZone, UTC_ZONE } from '../../src/next/time.js';
import { groupTiers, SIGMA_YEARS, sigmaRows } from '../../src/next/time/coverage-table.js';
import { startTimeServices, TIER_NOTICE_KEY } from '../../src/next/time/services.js';
import { lmtReason, longitudeWords, zoneTooltip } from '../../src/next/time/zones.js';
import { fastPlayback, FAST_PLAYBACK_S, MONTH_S } from '../../src/next/playback.js';
import { aroundToday, sunToday } from '../../src/next/shell/derived.js';
import { bandsWait, evenHourTicks, sunBands } from '../../src/next/timebar/timebar.js';
import { FakeFrames } from './helpers.js';

const jd = (iso: string): number => {
  const v = jdFromIso(iso);
  if (v === null) throw new Error(iso);
  return v;
};
const NY = { kind: 'iana', zone: 'America/New_York' } as const;

describe('the ribbon’s golden and blue hours', () => {
  const day: [number, number] = [jd('2026-09-24T04:00:00Z'), jd('2026-09-25T04:00:00Z')];
  const w = (kind: 'golden' | 'blue', a: string, b: string): SunLightWindow => ({
    kind,
    period: 'evening',
    jd_start: jd(a),
    utc_start: a,
    jd_end: jd(b),
    utc_end: b,
    duration_min: 0,
    open_start: false,
    open_end: false,
  });

  it('turns sun_hours windows into bands with plain tooltips', () => {
    const bands = sunBands([w('golden', '2026-09-24T22:19:00Z', '2026-09-24T23:11:00Z'), w('blue', '2026-09-24T23:11:00Z', '2026-09-24T23:21:00Z')], day[0], day[1], NY);
    expect(bands.map((b) => b.kind)).toEqual(['golden', 'blue']);
    expect(bands[0]!.tip).toBe('Golden hour 18:19–19:11 EDT: the Sun between 6° above and 4° below the horizon: warm, low light and long shadows.');
    expect(bands[1]!.tip).toMatch(/^Blue hour 19:11–19:21 EDT: the Sun 4° to 6° below the horizon/);
  });

  it('leaves out windows of other days and says when one runs from midnight or to its end', () => {
    const bands = sunBands(
      [w('golden', '2026-09-23T22:00:00Z', '2026-09-23T23:00:00Z'), w('golden', '2026-09-24T02:00:00Z', '2026-09-24T05:00:00Z'), w('blue', '2026-09-25T03:00:00Z', '2026-09-25T05:00:00Z')],
      day[0],
      day[1],
      NY,
    );
    expect(bands).toHaveLength(2);
    expect(bands[0]!.tip).toMatch(/^Golden hour from midnight–01:00 EDT/);
    expect(bands[1]!.tip).toMatch(/^Blue hour 23:00–24:00 EDT/);
  });
});

describe('fast playback', () => {
  it('stops computing the day’s events above eight days a second, the bands above one', () => {
    const store = createExplorerStore({ storage: null });
    expect(fastPlayback(store.get())).toBe(false);
    store.patch({ time: { playing: true, speed: 7 * 86_400 } }); // a week a second
    expect(fastPlayback(store.get())).toBe(false);
    expect(bandsWait(store.get())).toBe(true);
    store.patch({ time: { speed: FAST_PLAYBACK_S } });
    expect(fastPlayback(store.get())).toBe(false);
    store.patch({ time: { speed: -MONTH_S } });
    expect(fastPlayback(store.get())).toBe(true);
    store.patch({ time: { playing: false } });
    expect(fastPlayback(store.get())).toBe(false);
    expect(bandsWait(store.get())).toBe(false);
  });

  it('leaves the day’s events to when time slows, and computes them again then', () => {
    const store = createExplorerStore({ storage: null, initial: { time: { live: false, jd_utc: jd('2026-09-24T12:00:00Z') } } });
    const frames = new FakeFrames();
    const ctx = {
      store,
      engine: memoEngine(new MockEngine({ syntheticStars: 0 })),
      notices: createNotices(),
      scheduler: createScheduler({ requestFrame: frames.request, cancelFrame: frames.cancel }),
      packs: NO_PACKS,
    };
    expect(sunToday(ctx, store.get())).not.toBeNull();
    store.patch({ time: { playing: true, speed: 10 * 31_556_952 } });
    expect(sunToday(ctx, store.get())).toBeNull();
    expect(aroundToday(ctx, store.get(), 'Moon')).toBeNull();
    store.patch({ time: { playing: false } });
    expect(aroundToday(ctx, store.get(), 'Moon')?.bodies[0]?.body).toBe('Moon');
  });

  it('draws even hour ticks without zone arithmetic', () => {
    const t = evenHourTicks(10, 11);
    expect(t).toHaveLength(25);
    expect(t[0]).toEqual({ jd: 10, label: '0', major: true });
    expect(t[12]).toEqual({ jd: 10.5, label: '12', major: true });
    expect(t[13]!.label).toBe('');
    expect(t[24]!.jd).toBe(11);
  });
});

describe('words about the zone', () => {
  it('writes a longitude for a sentence', () => {
    expect(longitudeWords(-75.1652)).toBe('75° 09.9′ W');
    expect(longitudeWords(151.2093)).toBe('151° 12.6′ E');
    expect(longitudeWords(0)).toBe('0° 00.0′');
    expect(longitudeWords(-0.99999)).toBe('1° 00.0′ W');
  });

  it('gives local mean time its reason and UT its scale', () => {
    const t = jd('1800-06-01T12:00:00Z');
    const lmt = resolveZone({ kind: 'iana', zone: 'America/New_York', guessed: true }, -75.1652, t);
    expect(lmtReason(t, -75.1652, -18_040_000)).toMatch(/^Local mean time at 75° 09.9′ W \(UT−5:00:40\): before about 1850 clocks were set by the Sun/);
    const tip = zoneTooltip(t, lmt, -75.1652);
    expect(tip).toMatch(/^LMT \(UT−5:00:40\) Local mean time/);
    expect(tip).toMatch(/UTC with leap seconds began only in 1972/);
  });

  it('warns that civil offsets before 1970 may be approximate', () => {
    expect(zoneTooltip(jd('1930-06-01T12:00:00Z'), NY, -75.1652)).toMatch(/Civil offsets before 1970 may be approximate \(tz database\)\./);
    expect(zoneTooltip(jd('2026-06-01T12:00:00Z'), NY, -75.1652)).toBe('America/New_York · EDT (UTC−4)');
    expect(zoneTooltip(jd('2026-06-01T12:00:00Z'), UTC_ZONE, 0)).toBe('UTC');
    expect(zoneTooltip(jd('2100-06-01T12:00:00Z'), UTC_ZONE, 0)).toMatch(/^UT UT is Universal Time/);
  });
});

describe('the coverage table', () => {
  const coverage = (over: Partial<ExplorerCoverage>): ExplorerCoverage => ({
    start_utc: '1990-01-01T00:00:00Z',
    end_utc: '2060-12-31T23:59:59Z',
    groups: [],
    ...over,
  });

  it('reads both tiers when the engine reports them, else the one span it has', () => {
    const tiered = coverage({ validated_start_utc: '1550-01-01T00:00:00Z', validated_end_utc: '2650-01-22T00:00:00Z' });
    const g = {
      name: 'Moon',
      provider: 'x',
      accuracy_arcmin: 0.05,
      validated: true,
      notes: '',
      tiers: [
        { tier: 'validated' as const, start_utc: '1550-01-01T00:00:00Z', end_utc: '2650-01-22T00:00:00Z', accuracy_arcmin: 0.05 },
        { tier: 'labelled' as const, start_utc: '-2000-01-01T00:00:00Z', end_utc: '3000-12-31T23:59:59Z', accuracy_arcmin: 0.5 },
      ],
    };
    expect(groupTiers(g, tiered).labelled?.accuracy_arcmin).toBe(0.5);
    const plain = { name: 'Sun', provider: 'x', accuracy_arcmin: 0.01, validated: true, notes: '' };
    expect(groupTiers(plain, coverage({}))).toEqual({
      validated: { tier: 'validated', start_utc: '1990-01-01T00:00:00Z', end_utc: '2060-12-31T23:59:59Z', accuracy_arcmin: 0.01 },
      labelled: null,
    });
    expect(groupTiers({ ...plain, validated: false }, coverage({})).validated).toBeNull();
  });

  it('lists the ΔT uncertainty from 2000 BC to AD 3000 from the engine', () => {
    const rows = sigmaRows(new MockEngine({ syntheticStars: 0 }));
    expect(rows.map((r) => r.year)).toEqual([...SIGMA_YEARS]);
    const at = (y: number): number => rows.find((r) => r.year === y)!.sigmaS;
    expect(at(-2000)).toBeGreaterThan(3000); // about an hour, 2001 BC (the labelled tier's first year)
    expect(at(2026)).toBeLessThan(1);
    expect(at(3000)).toBeGreaterThan(1500); // about half an hour
    expect(sigmaRows({ coverage: () => coverage({}) } as unknown as ExplorerEngine)).toEqual([]);
  });
});

describe('the tier notice and the pack prompt', () => {
  function setup(coverageOver: Partial<ExplorerCoverage>, packs: PackService = NO_PACKS) {
    const store = createExplorerStore({ storage: null, initial: { time: { live: false, jd_utc: jd('2026-09-24T12:00:00Z') } } });
    const frames = new FakeFrames();
    const scheduler = createScheduler({ requestFrame: frames.request, cancelFrame: frames.cancel });
    const notices = createNotices();
    const base = new MockEngine({ syntheticStars: 0 });
    // The mock reports its own window as its validated tier and answers `tierAt` from it
    // (deeptime agent); this engine is the coverage below and nothing else, so it drops
    // both and its tiers come from `coverageOver` alone.
    const { validated_start_utc: _vs, validated_end_utc: _ve, ...mockCoverage } = base.coverage();
    const c = { ...mockCoverage, ...coverageOver };
    const engine = memoEngine(
      Object.assign(Object.create(base) as ExplorerEngine, { coverage: () => c, tierAt: undefined }),
    );
    const ctx = { store, engine, notices, scheduler, packs };
    const stop = startTimeServices(ctx);
    const flush = (): void => scheduler.flush();
    return { store, notices, stop, flush };
  }

  it('says nothing in the validated tier, names the bounds outside', () => {
    const { store, notices, flush } = setup({ start_utc: '1990-01-01T00:00:00Z', end_utc: '2060-12-31T23:59:59Z' });
    flush();
    expect(notices.list()).toHaveLength(0);
    store.patch({ time: { jd_utc: jd('1066-10-20T12:00:00Z') } });
    flush();
    const n = notices.list().find((x) => x.key === TIER_NOTICE_KEY)!;
    expect(n.text).toMatch(/^The time shown is outside the years the SkyFix Lab core covers \(1 January 1990 to 31 December 2060, Gregorian calendar\)/);
    expect(n.persistent).toBe(false);
    store.patch({ time: { jd_utc: jd('2026-09-24T12:00:00Z') } });
    flush();
    expect(notices.list()).toHaveLength(0);
  });

  it('keeps a persistent estimate notice in the labelled tier', () => {
    const { store, notices, flush } = setup({
      start_utc: '-2000-01-01T00:00:00Z',
      end_utc: '3000-12-31T23:59:59Z',
      validated_start_utc: '1550-01-01T00:00:00Z',
      validated_end_utc: '2650-01-22T00:00:00Z',
    });
    store.patch({ time: { jd_utc: jd('1066-10-20T12:00:00Z') } });
    flush();
    const n = notices.list().find((x) => x.key === TIER_NOTICE_KEY)!;
    expect(n.persistent).toBe(true);
    // Both tiers are in the core (the deeptime merge): no pack is named.
    expect(n.text).toMatch(/^Historical estimate: before 1550 the positions are estimates/);
    // Moving within the band changes nothing (no flicker, no re-reading aloud).
    const id = n.id;
    store.patch({ time: { jd_utc: jd('1100-01-01T12:00:00Z') } });
    flush();
    expect(notices.list().find((x) => x.key === TIER_NOTICE_KEY)!.id).toBe(id);
  });

  // No pack extends the years today (both tiers are in the core); a made-up one keeps the
  // mechanism tested for the day one does.
  it('asks for a pack that extends the years once per crossing when it would reach the date', () => {
    const asked: string[] = [];
    const deep: PackState = {
      name: 'far-ephemeris',
      version: '',
      label: 'Far ephemeris',
      description: 'Positions from 2000 BC to AD 3000',
      bytes: 0,
      provides: ['ephemeris:-2000..3000'],
      loaded: false,
      offered: true,
      supported: true,
      saved: false,
      savedBytes: 0,
      stale: false,
      removedInUse: false,
      progress: null,
      error: null,
    };
    const packs: PackService = {
      ...NO_PACKS,
      status: () => [deep],
      ensure: (name, reason) => {
        asked.push(`${name}: ${reason}`);
        return Promise.resolve(false);
      },
    };
    const { store, notices, flush } = setup({ start_utc: '1990-01-01T00:00:00Z', end_utc: '2060-12-31T23:59:59Z' }, packs);
    store.patch({ time: { jd_utc: jd('1066-10-20T12:00:00Z') } });
    flush();
    store.patch({ time: { jd_utc: jd('1067-10-20T12:00:00Z') } });
    flush();
    expect(asked).toEqual(['far-ephemeris: Positions before AD 1990 need the Far ephemeris pack, which extends the explorer back to 2001 BC.']);
    expect(notices.list()[0]!.text).toMatch(/The Far ephemeris pack extends this: get it in Settings → Data packs\.$/);
    store.patch({ time: { jd_utc: jd('2080-01-01T12:00:00Z') } });
    flush();
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatch(/^far-ephemeris: Positions after AD 2060 need the Far ephemeris pack, which extends the explorer to AD 3000\.$/);
  });
});
