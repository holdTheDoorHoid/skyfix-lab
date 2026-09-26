/**
 * The clock's scale (UTC or UT), local mean time before 1850, coverage tiers and their
 * sentences, the pack a date would need, and the ±ΔT chip's rules (time/scale.ts,
 * time/tier.ts, time/chip.ts; CONVENTIONS 15.1-15.3). Held to the mock engine and, when a
 * package is built, to the real engine's `time_info`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import * as Mock from '../../src/next/engine/mock/timescale.js';
import type { CoverageTier, ExplorerCoverage, ExplorerEngine, PackState, TimeInfo } from '../../src/next/engine/types.js';
import {
  formatOffset,
  formatWithUtc,
  jdFromIso,
  jdFromWallClock,
  resolveZone,
  UTC_ZONE,
  wallClock,
  zoneLabel,
  zoneShortName,
  type ZoneChoice,
} from '../../src/next/time.js';
import { chipOf, CLOCK, farDate, INSTANT, sigmaText, timeInfoAt, uncertaintyText, uncertaintyTip, withUncertainty } from '../../src/next/time/chip.js';
import { LMT_BEFORE_JD, lmtOffsetMs, scaleAt, scaleLabel, UTC_SCALE_END_JD, UTC_SCALE_START_JD } from '../../src/next/time/scale.js';
import {
  coverageBounds,
  packForDate,
  packReason,
  providedYears,
  rangeOfError,
  rangeWords,
  sightsOffered,
  sightsOnlyText,
  tierAt,
  tierNotice,
} from '../../src/next/time/tier.js';

const jd = (iso: string): number => {
  const v = jdFromIso(iso);
  if (v === null) throw new Error(iso);
  return v;
};

const PHILADELPHIA_LON = -75.1652;
const NY_GUESSED: ZoneChoice = { kind: 'iana', zone: 'America/New_York', guessed: true };
const NY_PINNED: ZoneChoice = { kind: 'iana', zone: 'America/New_York', guessed: false };

describe('the clock is UTC from 1972 to 2035 and UT outside', () => {
  it('matches the engine’s scale boundaries', () => {
    expect(UTC_SCALE_START_JD).toBe(Mock.UTC_SCALE_START_JD);
    expect(UTC_SCALE_END_JD).toBe(Mock.UTC_SCALE_END_JD);
    for (const t of [jd('1971-12-31T23:59:59Z'), jd('1972-01-01T00:00:00Z'), jd('2035-12-31T23:59:59Z'), jd('2036-01-01T00:00:00Z'), 1_507_900]) {
      expect(scaleAt(t)).toBe(Mock.scaleAt(t));
    }
    expect(scaleLabel(jd('2026-09-24T12:00:00Z'))).toBe('UTC');
    expect(scaleLabel(jd('1800-01-01T12:00:00Z'))).toBe('UT');
    expect(scaleLabel(jd('2100-01-01T12:00:00Z'))).toBe('UT');
  });

  it('writes the scale beside times and offsets', () => {
    const t = jd('1800-06-01T12:00:00Z');
    expect(zoneShortName(t, UTC_ZONE)).toBe('UT');
    expect(zoneLabel(t, UTC_ZONE)).toBe('UT');
    expect(formatOffset(-3_600_000, t)).toBe('UT−1');
    expect(formatOffset(-3_600_000)).toBe('UTC−1');
    expect(formatWithUtc(t, UTC_ZONE)).toBe('1800-06-01 12:00 UT');
    expect(formatWithUtc(jd('2026-09-24T12:05:00Z'), UTC_ZONE)).toBe('2026-09-24 12:05 UTC');
  });
});

describe('local mean time before 1850', () => {
  it('is four minutes of time per degree, to the second', () => {
    expect(lmtOffsetMs(PHILADELPHIA_LON)).toBe(-(5 * 3600 + 40) * 1000); // −5:00:40
    expect(lmtOffsetMs(0)).toBe(0);
    expect(Object.is(lmtOffsetMs(-0.0001), -0)).toBe(false);
    expect(lmtOffsetMs(180)).toBe(12 * 3_600_000);
    expect(lmtOffsetMs(-180)).toBe(12 * 3_600_000);
    expect(lmtOffsetMs(151.2093)).toBe(Math.round(151.2093 * 240) * 1000);
  });

  it('replaces a zone that follows the place, and only before 1850', () => {
    const before = jd('1849-12-31T23:00:00Z');
    const after = jd('1850-01-01T00:00:00Z');
    expect(after).toBe(LMT_BEFORE_JD);
    expect(resolveZone(NY_GUESSED, PHILADELPHIA_LON, before)).toEqual({ kind: 'fixed', offsetMs: -18_040_000, name: 'LMT' });
    expect(resolveZone(NY_GUESSED, PHILADELPHIA_LON, after)).toEqual({ kind: 'iana', zone: 'America/New_York' });
    expect(resolveZone({ kind: 'nautical' }, PHILADELPHIA_LON, before)).toMatchObject({ name: 'LMT' });
    // A zone the person chose stays as chosen.
    expect(resolveZone(NY_PINNED, PHILADELPHIA_LON, before)).toEqual({ kind: 'iana', zone: 'America/New_York' });
    expect(resolveZone({ kind: 'nautical', guessed: false }, PHILADELPHIA_LON, before)).toMatchObject({ name: 'ZD +5' });
    expect(resolveZone({ kind: 'utc' }, PHILADELPHIA_LON, before)).toEqual(UTC_ZONE);
    // Without an instant, as before.
    expect(resolveZone(NY_GUESSED, PHILADELPHIA_LON)).toEqual({ kind: 'iana', zone: 'America/New_York' });
  });

  it('reads and labels its clock', () => {
    const t = jd('1800-06-01T12:00:00Z');
    const lmt = resolveZone(NY_GUESSED, PHILADELPHIA_LON, t);
    expect(wallClock(t, lmt)).toMatchObject({ year: 1800, month: 6, day: 1, hour: 6, minute: 59, second: 20 });
    expect(zoneShortName(t, lmt)).toBe('LMT');
    expect(zoneLabel(t, lmt)).toBe('LMT (UT−5:00:40)');
    expect(formatWithUtc(t, lmt)).toBe('1800-06-01 06:59 LMT · 12:00 UT');
    expect(jdFromWallClock({ year: 1800, month: 6, day: 1, hour: 6, minute: 59, second: 20 }, lmt)).toBe(t);
  });
});

// ---------------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------------

const GROUPS: ExplorerCoverage['groups'] = [{ name: 'Sun', provider: 'test', accuracy_arcmin: 0.01, validated: true, notes: '', bodies: ['Sun'] }];

function engineWith(coverage: Partial<ExplorerCoverage>, extra: Record<string, unknown> = {}): ExplorerEngine {
  const c = { start_utc: '1550-01-01T00:00:00Z', end_utc: '2650-01-22T00:00:00Z', groups: GROUPS, ...coverage } as ExplorerCoverage;
  return { coverage: () => c, ...extra } as unknown as ExplorerEngine;
}

const TODAY = jd('2026-09-24T12:00:00Z');
const Y1066 = jd('1066-10-20T12:00:00Z');
const Y2800 = jd('2800-01-01T00:00:00Z');
const Y2500BC = jd('-2499-01-01T00:00:00Z');

describe('tierAt', () => {
  it('reads the tiers from explorer_coverage when the engine reports them', () => {
    const e = engineWith({
      start_utc: '-2000-01-01T00:00:00Z',
      end_utc: '3000-12-31T23:59:59Z',
      validated_start_utc: '1550-01-01T00:00:00Z',
      validated_end_utc: '2650-01-22T00:00:00Z',
      packs_loaded: ['deep-time'],
    });
    expect(tierAt(e, TODAY)).toBe('validated');
    expect(tierAt(e, Y1066)).toBe('labelled');
    expect(tierAt(e, Y2800)).toBe('labelled');
    expect(tierAt(e, Y2500BC)).toBe('outside');
    expect(tierAt({ engine: e }, Y1066)).toBe('labelled');
    expect(tierAt(e, Number.NaN)).toBe('outside');
    expect(coverageBounds(e)).toMatchObject({ tiered: true, packsLoaded: ['deep-time'] });
  });

  it('counts the whole span as validated when the engine reports no tiers (today’s core)', () => {
    const e = engineWith({ start_utc: '1990-01-01T00:00:00Z', end_utc: '2060-12-31T23:59:59Z' });
    expect(tierAt(e, TODAY)).toBe('validated');
    expect(tierAt(e, Y1066)).toBe('outside');
    expect(coverageBounds(e)?.tiered).toBe(false);
  });

  it('asks the engine’s own tierAt first (the deeptime agent’s query)', () => {
    const calls: number[] = [];
    const e = engineWith({}, { tierAt: (t: number): CoverageTier => (calls.push(t), 'labelled') });
    expect(tierAt(e, TODAY)).toBe('labelled');
    expect(calls).toEqual([TODAY]);
  });

  it('falls back to time_info.tier when there is no coverage report', () => {
    const e = {
      coverage: () => {
        throw new Error('none');
      },
      timeInfo: (t: number) => ({ tier: t > 2_400_000 ? 'validated' : 'outside' }) as TimeInfo,
    } as unknown as ExplorerEngine;
    expect(tierAt(e, TODAY)).toBe('validated');
    expect(tierAt(e, Y1066)).toBe('outside');
  });

  it('agrees with the mock engine, whose time_info fallback is validated or outside', () => {
    const m = new MockEngine({ syntheticStars: 0 });
    for (const t of [TODAY, Y1066, Y2800, jd('1995-06-01T00:00:00Z')]) expect(tierAt(m, t)).toBe(m.timeInfo(t).tier);
  });

  it('offers sights only in the validated tier, and says between which years', () => {
    const e = engineWith({ start_utc: '-2000-01-01T00:00:00Z', end_utc: '3000-12-31T23:59:59Z', validated_start_utc: '1550-01-01T00:00:00Z', validated_end_utc: '2650-01-22T00:00:00Z' });
    expect(sightsOffered(e, TODAY)).toBe(true);
    expect(sightsOffered(e, Y1066)).toBe(false);
    expect(sightsOnlyText(e)).toMatch(/^Sights are offered only between 1550 and 2650/);
    // Today's core reports no tiers: the contract's years are named.
    expect(sightsOnlyText(engineWith({ start_utc: '1990-01-01T00:00:00Z', end_utc: '2060-12-31T23:59:59Z' }))).toMatch(/between 1550 and 2650/);
  });
});

// polish2: display engines that answer only the validated tier refuse a far date with their
// own words; the page says the years instead of the raw message.
describe('an engine’s range error in plain words', () => {
  it('reads the span from the star field’s and the ephemeris’ messages', () => {
    expect(rangeWords("starfield_apparent: jd_utc 1507900 is outside the star field's range 1550-01-01T00:00:00Z .. 2650-01-22T00:00:00Z")).toBe('1550 to 2650');
    expect(rangeWords('almanac_opening: -0584-05-21 is outside the ephemeris coverage (1550-01-01T00:00:00.000Z to 2650-01-22T00:00:00.000Z)')).toBe('1550 to 2650');
    expect(rangeWords('outside the coverage -2000-01-01T00:00:00Z .. 3000-12-31T23:59:59Z')).toBe('2001 BC to AD 3000');
    expect(rangeOfError("jd_utc 1 is outside the star field's range 1550-01-01T00:00:00Z .. 2650-01-22T00:00:00Z")).toEqual({ start: 2_287_185.5, end: 2_688_973.5 });
    expect(rangeWords('the observer is malformed')).toBeNull();
    expect(rangeWords('1550-01-01T00:00:00Z .. 2650-01-22T00:00:00Z without the word')).toBeNull();
  });
});

describe('what the page says in each tier', () => {
  const tiered = engineWith({
    start_utc: '-2000-01-01T00:00:00Z',
    end_utc: '3000-12-31T23:59:59Z',
    validated_start_utc: '1550-01-01T00:00:00Z',
    validated_end_utc: '2650-01-22T00:00:00Z',
    packs_loaded: ['deep-time'],
  });

  it('nothing in the validated tier', () => {
    expect(tierNotice(tiered, TODAY)).toBeNull();
  });

  it('a historical or far-future estimate in the labelled tier', () => {
    const past = tierNotice(tiered, Y1066)!;
    expect(past).toMatchObject({ level: 'caution', persistent: true, side: 'before' });
    // Both tiers are in the core: the engine keeps no registry here, so no pack is named.
    expect(past.text).toMatch(/^Historical estimate: before 1550 the positions are estimates/);
    const future = tierNotice(tiered, Y2800)!;
    expect(future.side).toBe('after');
    expect(future.text).toMatch(/^Far-future estimate: after 2650 the positions are estimates/);
  });

  // polish2: `packs_loaded` lists every loaded pack; only one that supplies positions is named.
  it('names a loaded pack only when it supplies the positions', () => {
    const status = (name: string, label: string, provides: string[]) => ({ name, label, provides, loaded: true, version: 'v', description: '', bytes: 1 });
    const withRegistry = (loaded: string[], registry: ReturnType<typeof status>[]) =>
      engineWith(
        { start_utc: '-2000-01-01T00:00:00Z', end_utc: '3000-12-31T23:59:59Z', validated_start_utc: '1550-01-01T00:00:00Z', validated_end_utc: '2650-01-22T00:00:00Z', packs_loaded: loaded },
        { packs: () => registry, loadPack: () => ({}) },
      );
    const tides = withRegistry(['tides-us', 'lunar-limb'], [status('tides-us', 'US tides', ['tides:us']), status('lunar-limb', 'Lunar limb', ['eclipses:lunar-limb'])]);
    expect(tierNotice(tides, Y1066)!.text).toMatch(/^Historical estimate: before 1550 the positions are estimates/);
    expect(tierNotice(tides, Y1066)!.text).not.toMatch(/tides|limb/i);
    const far = withRegistry(['far-ephemeris', 'tides-us'], [status('far-ephemeris', 'Far ephemeris', ['ephemeris:-2000..3000']), status('tides-us', 'US tides', ['tides:us'])]);
    expect(tierNotice(far, Y1066)!.text).toMatch(/^Historical estimate: before 1550 the positions from the Far ephemeris pack are estimates/);
  });

  it('the real bounds outside, and the pack that would extend them', () => {
    const core = engineWith({ start_utc: '1990-01-01T00:00:00Z', end_utc: '2060-12-31T23:59:59Z' });
    const n = tierNotice(core, Y1066, { dateText: 'Sat 14 Oct 1066', pack: { label: 'Far ephemeris' } })!;
    expect(n.persistent).toBe(false);
    expect(n.text).toBe(
      'Sat 14 Oct 1066 is outside the years the SkyFix Lab core covers (1 January 1990 to 31 December 2060, Gregorian calendar), so nothing can be computed for it. Choose a date in that range, or press Now. The Far ephemeris pack extends this: get it in Settings → Data packs.',
    );
    expect(tierNotice(tiered, Y2500BC)!.text).toMatch(/\(1 January 2001 BC to 31 December 3000/);
  });
});

// A pack that would extend the years: none ships since the deeptime merge (both tiers are in
// the core), so these use a made-up one; the mechanism stays for a future pack.
describe('the pack a date needs', () => {
  const pack = (over: Partial<PackState>): PackState => ({
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
    ...over,
  });
  const service = (list: PackState[]) => ({ status: () => list });

  it('reads the provides entries', () => {
    expect(providedYears('ephemeris:-2000..3000')).toEqual([-2000, 3000]);
    expect(providedYears('tides:us')).toBeNull();
    expect(providedYears('ephemeris:3000..-2000')).toBeNull();
  });

  it('finds a pack that is not loaded and covers the year', () => {
    expect(packForDate(service([pack({})]), Y1066)?.name).toBe('far-ephemeris');
    expect(packForDate(service([pack({})]), Y2500BC)).toBeNull();
    expect(packForDate(service([pack({ loaded: true })]), Y1066)).toBeNull();
    expect(packForDate(service([pack({ supported: false })]), Y1066)).toBeNull();
    expect(packForDate(service([pack({ offered: false })]), Y1066)).toBeNull();
    expect(packForDate(service([pack({ offered: false, saved: true })]), Y1066)?.name).toBe('far-ephemeris');
    expect(packForDate(service([pack({ name: 'tides-us', provides: ['tides:us'] })]), Y1066)).toBeNull();
    expect(packForDate(null, Y1066)).toBeNull();
  });

  it('says why in one sentence, from the coverage and the pack’s own span', () => {
    const core = engineWith({ start_utc: '1990-01-01T00:00:00Z', end_utc: '2060-12-31T23:59:59Z' });
    expect(packReason(Y1066, core, pack({}))).toBe('Positions before AD 1990 need the Far ephemeris pack, which extends the explorer back to 2001 BC.');
    expect(packReason(Y2800, core, pack({}))).toBe('Positions after AD 2060 need the Far ephemeris pack, which extends the explorer to AD 3000.');
    // A pack whose span does not hold the year says only what it is.
    expect(packReason(Y2500BC, core, pack({}))).toBe('Positions before AD 1990 need the Far ephemeris pack.');
  });
});

// ---------------------------------------------------------------------------------
// The chip
// ---------------------------------------------------------------------------------

describe('the ±ΔT chip', () => {
  it('writes the uncertainty in the unit that suits it', () => {
    expect(sigmaText(0.4)).toBe('±1 s');
    expect(sigmaText(45)).toBe('±45 s');
    expect(sigmaText(158.36)).toBe('±3 min');
    expect(sigmaText(720)).toBe('±12 min');
    expect(sigmaText(883)).toBe('±15 min');
    expect(sigmaText(1817.5)).toBe('±30 min');
    expect(sigmaText(3624)).toBe('±1 h');
    expect(sigmaText(5400)).toBe('±1.5 h');
    expect(sigmaText(7200)).toBe('±2 h');
    expect(sigmaText(40_000)).toBe('±11 h');
  });

  it('the clock’s chip shows above 30 s, and always in the labelled tier (chip2: CLOCK and INSTANT)', () => {
    expect(farDate({ delta_t_sigma_s: 0.001, tier: 'validated' })).toBe(false);
    expect(farDate({ delta_t_sigma_s: 30, tier: 'validated' })).toBe(false);
    expect(farDate({ delta_t_sigma_s: 31, tier: 'validated' })).toBe(true);
    expect(farDate({ delta_t_sigma_s: 15, tier: 'labelled' })).toBe(true);
    expect(farDate(null)).toBe(false);
    expect(uncertaintyText(chipOf({ delta_t_sigma_s: 158.36, tier: 'outside' }, INSTANT))).toBe('±3 min');
    expect(withUncertainty('06:12', chipOf({ delta_t_sigma_s: 158.36, tier: 'labelled' }, INSTANT))).toBe('06:12 ±3 min');
    expect(withUncertainty('06:12', chipOf({ delta_t_sigma_s: 0.1, tier: 'validated' }, INSTANT))).toBe('06:12');
    expect(uncertaintyTip(chipOf({ delta_t_sigma_s: 720, tier: 'labelled' }, CLOCK))).toMatch(/^The Earth’s rotation at this date is known only to ±12 min/);
  });

  it('follows the engine’s ΔT: shown before about AD 700 and after about 2100', () => {
    const m = new MockEngine({ syntheticStars: 0 });
    const shown = (iso: string): boolean => farDate(timeInfoAt(m, jd(iso)));
    expect(shown('-0584-05-22T12:00:00Z')).toBe(true);
    expect(shown('1066-10-20T12:00:00Z')).toBe(false);
    expect(shown('2026-09-24T12:00:00Z')).toBe(false);
    expect(shown('2060-01-01T00:00:00Z')).toBe(false);
    expect(shown('2150-01-01T00:00:00Z')).toBe(true);
    expect(timeInfoAt({ coverage: () => ({}) } as unknown as ExplorerEngine, TODAY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------
// The real engine
// ---------------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('against the built package’s time_info (src/wasm-pkg)', () => {
  let timeInfo: ((jd: number) => TimeInfo) | null = null;
  let coverage: (() => ExplorerCoverage) | null = null;
  beforeAll(async () => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as {
      initSync: (input: { module: BufferSource }) => unknown;
      init?: () => void;
      time_info?: (jd: number) => TimeInfo;
      explorer_coverage?: () => ExplorerCoverage;
    };
    glue.initSync({ module: readFileSync(WASM_FILE) });
    glue.init?.();
    timeInfo = glue.time_info ?? null;
    coverage = glue.explorer_coverage ?? null;
  });

  it('works out the same tier as time_info from explorer_coverage', ({ skip }) => {
    if (!timeInfo || !coverage) {
      skip();
      return;
    }
    const report = coverage();
    const engine = { coverage: () => report } as unknown as ExplorerEngine;
    for (let t = 990_557.5; t < 2_817_152; t += 3_917.3) expect(tierAt(engine, t), String(t)).toBe(timeInfo(t).tier);
    const b = coverageBounds(engine)!;
    for (const t of [b.start, b.start - 1e-6, b.end, b.end + 1e-6]) expect(tierAt(engine, t), String(t)).toBe(timeInfo(t).tier);
  }, 30_000);

  it('labels the scale and the calendar exactly as time_info does', ({ skip }) => {
    if (!timeInfo) {
      skip();
      return;
    }
    for (let t = 990_557.5; t < 2_817_152; t += 7_919.37) {
      const info = timeInfo(t);
      expect(scaleAt(t)).toBe(info.scale);
      const w = wallClock(t, UTC_ZONE);
      expect([w.calendar, w.year, w.month, w.day, w.hour]).toEqual([info.calendar, info.civil.year, info.civil.month, info.civil.day, info.civil.hour]);
    }
    for (const t of [UTC_SCALE_START_JD - 1e-6, UTC_SCALE_START_JD, UTC_SCALE_END_JD - 1e-6, UTC_SCALE_END_JD]) expect(scaleAt(t)).toBe(timeInfo(t).scale);
  }, 30_000);
});
