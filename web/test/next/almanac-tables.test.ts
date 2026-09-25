/**
 * The Almanac view's tables and three-date openings (almanac2 agent): the pure helpers of
 * tables-model.ts and dates.ts, the `AlmanacTablesEngine` contract in the mock and the
 * memoised engine, and (when `npm run wasm` has built it) the real package's tables
 * against the printed values Bowditch reproduces. The tables themselves are validated in
 * Rust against an independent Python computation and the published examples
 * (crates/skyfix-almanac/tests/almanac_tables_reference.rs).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  anachronismNote,
  calendarLabel,
  engineCalendar,
  entryToJd,
  openingHeading,
  shownDate,
  yearText,
} from '../../src/next/almanac/dates.js';
import {
  arcminOfDegMin,
  celsiusOf,
  criticalLines,
  criticalLookup,
  degMinText,
  densityFactor,
  halves,
  hpaOfInHg,
  interpolatePrinted,
  lookupIncrement,
  moonPageColumns,
  pageMinutes,
  pageOfMinute,
  parseMinuteSecond,
  polarisLookup,
  polarisPageColumns,
  trimZeroTail,
  vdPairs,
  zoneOf,
  zonePressure,
} from '../../src/next/almanac/tables-model.js';
import { memoEngine } from '../../src/next/component.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import { openingJdns } from '../../src/next/engine/mock/almanac-tables.js';
import {
  isAlmanacTablesEngine,
  type AlmanacTablesEngine,
  type CriticalTable,
  type ExplorerEngine,
} from '../../src/next/engine/types.js';
import { inspectWasmModule, type WasmEngine } from '../../src/next/engine/wasm.js';
import { jdnFromCivil, setCalendarMode, setYearStyle } from '../../src/next/time/index.js';

afterEach(() => {
  setCalendarMode('historical');
  setYearStyle('era');
});

/** A small critical table in the wire's shape: the Sun, October to March, near 10°. */
const SUN: CriticalTable = {
  argument: 'apparent altitude',
  unit: 'deg_min',
  columns: ['Lower limb', 'Upper limb'],
  boundaries: [
    { value: 9 + 33 / 60, printed: '9 33' },
    { value: 9 + 45 / 60, printed: '9 45' },
    { value: 9 + 55 / 60, printed: '9 55' },
  ],
  values: [
    [
      { arcmin: 10.8, printed: '+10.8' },
      { arcmin: -21.5, printed: '-21.5' },
    ],
    [
      { arcmin: 10.9, printed: '+10.9' },
      { arcmin: -21.4, printed: '-21.4' },
    ],
  ],
};

describe('critical tables', () => {
  it('prints each correction between its two arguments, with a sentence for screen readers', () => {
    const lines = criticalLines(SUN);
    expect(lines.map((l) => l.boundary)).toEqual(['9 33', '9 45', '9 55']);
    expect(lines[0]!.values).toEqual(['+10.8', '-21.5']);
    expect(lines[0]!.label).toBe('9°33′ to 9°45′: Lower limb +10.8′, Upper limb -21.5′');
    expect(lines[2]!.values).toBeNull();
    expect(lines[2]!.label).toBe('9°55′: end of the table');
  });

  it('looks up as the printed table does: between two arguments, and exactly on one the value above', () => {
    expect(criticalLookup(SUN, 9.6)).toEqual(['+10.8', '-21.5']);
    expect(criticalLookup(SUN, 9.75)).toEqual(['+10.8', '-21.5']); // 9° 45′ exactly: ascend
    expect(criticalLookup(SUN, 9.76)).toEqual(['+10.9', '-21.4']);
    expect(criticalLookup(SUN, 9 + 55 / 60)).toEqual(['+10.9', '-21.4']);
    expect(criticalLookup(SUN, 9.55)).toBeNull(); // the first argument itself is outside
    expect(criticalLookup(SUN, 10)).toBeNull();
  });

  it('ends a correction that falls to zero where it becomes 0.0, as the Venus and Mars tables do', () => {
    const t: CriticalTable = {
      argument: 'apparent altitude',
      unit: 'deg',
      columns: ['Corr'],
      boundaries: [0, 42, 90].map((d) => ({ value: d, printed: String(d) })),
      values: [[{ arcmin: 0.1, printed: '+0.1' }], [{ arcmin: 0, printed: '0.0' }]],
    };
    const lines = trimZeroTail(criticalLines(t));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.values).toEqual(['+0.1']);
    expect(lines[1]).toMatchObject({ boundary: '42', values: null, label: '42° and above: 0.0′' });
  });
});

describe('increments', () => {
  const mock = new MockEngine({ syntheticStars: 10 });

  it('pages two minutes at a time, 30 pages', () => {
    expect(pageMinutes(0)).toEqual([0, 1]);
    expect(pageMinutes(29)).toEqual([58, 59]);
    expect(pageMinutes(99)).toEqual([58, 59]);
    expect(pageOfMinute(58)).toBe(29);
    expect(pageOfMinute(3)).toBe(1);
  });

  it('reads a time after the hour as navigators write it', () => {
    expect(parseMinuteSecond('58:27')).toEqual({ minute: 58, second: 27 });
    expect(parseMinuteSecond('58 27')).toEqual({ minute: 58, second: 27 });
    expect(parseMinuteSecond('58m 27s')).toEqual({ minute: 58, second: 27 });
    expect(parseMinuteSecond('5')).toEqual({ minute: 5, second: 0 });
    expect(parseMinuteSecond('60:00')).toBeNull();
    expect(parseMinuteSecond('12:61')).toBeNull();
    expect(parseMinuteSecond('noon')).toBeNull();
  });

  it('adds printed values only: Deneb at 58m 27s (Bowditch §1906), and v and d with their signs', () => {
    const t = mock.almanacIncrements(58);
    expect(t.rows).toHaveLength(61);
    expect(t.corrections).toHaveLength(181);
    const r = lookupIncrement(t, 27, 1.5, -0.2);
    expect(r.aries).toBe('14 39.2');
    expect(r.v).toEqual({ value: '1.5', correction: '+1.5' });
    expect(r.d).toEqual({ value: '0.2', correction: '−0.2' });
    expect(lookupIncrement(t, 34, null, null)).toMatchObject({ sunPlanets: '14 38.5', v: null, d: null });
    // The three v-or-d columns of a row: 0.0-5.9, 6.0-11.9, 12.0-17.9 in steps of 0.1.
    expect(vdPairs(t, 15).map(([v]) => v)).toEqual(['1.5', '7.5', '13.5']);
  });

  it('writes degrees and minutes', () => {
    expect(arcminOfDegMin('14 39.2')).toBeCloseTo(879.2, 9);
    expect(arcminOfDegMin('-0 12.3')).toBeCloseTo(-12.3, 9);
    expect(degMinText(879.2)).toBe('14° 39.2′');
    expect(degMinText(-12.3)).toBe('−0° 12.3′');
  });
});

describe('altitude corrections, Polaris and the zone chart', () => {
  const mock = new MockEngine({ syntheticStars: 10 });

  it('lays out the Moon on two pages (0°–34°, 35°–89°) and the 0°–10° table in two halves', () => {
    const t = mock.almanacAltitudeTables();
    expect(moonPageColumns(t.moon, 0).map((c) => c.from_deg)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect(moonPageColumns(t.moon, 1)).toHaveLength(11);
    expect(halves([1, 2, 3, 4, 5])).toEqual([[1, 2, 3], [4, 5]]);
  });

  it('interpolates printed values as a navigator would, halves up', () => {
    expect(interpolatePrinted(0, '1.0', 10, '2.0', 5)).toBe('1.5');
    expect(interpolatePrinted(0, '-1.0', 1, '-2.0', 0.5)).toBe('-1.5');
    expect(interpolatePrinted(0, '0.0', 3, '0.1', 1.5)).toBe('0.1');
  });

  it('finds the zone of a temperature and a pressure (Bowditch §1907: 88 °F, 982 hPa is zone M)', () => {
    const zones = mock.almanacAltitudeTables().additional.zones;
    expect(zonePressure(1, 10)).toBeCloseTo(1010, 9);
    expect(densityFactor(10, 1010)).toBeCloseTo(1, 12);
    expect(zoneOf(zones, 10, 1010)).toBe('G');
    expect(zoneOf(zones, celsiusOf(88), 982)).toBe('M');
    expect(zoneOf(zones, -40, 1060)).toBeNull();
    expect(hpaOfInHg(29.92)).toBeCloseTo(1013.2, 1);
  });

  it('reads Polaris for LHA Aries, the latitude and the month, three pages of 120°', () => {
    const t = mock.almanacPolaris(2016);
    expect(polarisPageColumns(t, 1)).toHaveLength(12);
    expect(polarisPageColumns(t, 1)[0]!.from_deg).toBe(120);
    const r = polarisLookup(t, 162.5, 50, 4);
    expect(r).not.toBeNull();
    const col = t.columns[16]!;
    expect(r!.a1).toBe(col.a1[6]!.printed); // 50° N
    expect(r!.a2).toBe(col.a2[3]!.printed); // April
    const tenths = (x: string): number => Math.round(Number(x.replace('−', '-')) * 10);
    const sum = Math.round(arcminOfDegMin(r!.a0) * 10) + tenths(r!.a1) + tenths(r!.a2) - 600;
    expect(tenths(r!.correction)).toBe(sum);
    expect(polarisLookup(t, 162.5, 50, 13)).toBeNull();
  });
});

describe('dates in any year', () => {
  it('shows a date in the display calendar: Julian before 1582-10-15, BC years, the wire date beside it', () => {
    // Thales' eclipse: 28 May 585 BC in the Julian calendar is -0584-05-22 proleptic Gregorian.
    const thales = shownDate(1_507_900, 'auto');
    expect(thales).toMatchObject({ calendar: 'julian', year: -584, month: 5, day: 28, era_year: 585, era: 'BC', wire: '-0584-05-22' });
    expect(shownDate(1_507_900, 'gregorian')).toMatchObject({ calendar: 'gregorian', month: 5, day: 22 });
    // The reform: 4 October 1582 (Julian) was followed by 15 October (Gregorian).
    expect(shownDate(2_299_160, 'auto')).toMatchObject({ calendar: 'julian', day: 4, month: 10 });
    expect(shownDate(2_299_161, 'auto')).toMatchObject({ calendar: 'gregorian', day: 15, month: 10 });
    setCalendarMode('iso');
    expect(shownDate(1_507_900, 'auto')).toMatchObject({ calendar: 'gregorian', day: 22 });
    expect(engineCalendar('auto')).toBe('gregorian');
    setCalendarMode('historical');
    expect(engineCalendar('auto')).toBe('');
    expect(engineCalendar('julian')).toBe('julian');
  });

  it('reads years as the time bar does: 585 BC, −584, -0584, or a bare number in the era beside it', () => {
    const at = (yearText: string, era: 'AD' | 'BC' = 'AD') => entryToJd({ yearText, era, month: 5, day: 28 }, 'auto', 0.5);
    for (const r of [at('585', 'BC'), at('585 BC'), at('-584'), at('−584'), at('-0584')]) expect(r).toEqual({ jd: 1_507_900 });
    expect(at('1066')).toEqual({ jd: jdnFromCivil('julian', 1066, 5, 28) });
    expect(at('')).toEqual({ error: 'Type a year such as 1066, 585 BC or −584.' });
    expect(at('the year of the Armada')).toHaveProperty('error');
  });

  it('refuses dates no calendar had, unless a calendar is chosen', () => {
    const oct = (day: number, choice: 'auto' | 'julian' | 'gregorian') =>
      entryToJd({ yearText: '1582', era: 'AD', month: 10, day }, choice, 0);
    expect(oct(10, 'auto')).toHaveProperty('error', expect.stringMatching(/neither calendar/));
    expect(oct(10, 'gregorian')).toEqual({ jd: jdnFromCivil('gregorian', 1582, 10, 10) - 0.5 });
    expect(oct(10, 'julian')).toEqual({ jd: jdnFromCivil('julian', 1582, 10, 10) - 0.5 });
    const feb29 = (year: string, choice: 'auto' | 'gregorian') => entryToJd({ yearText: year, era: 'AD', month: 2, day: 29 }, choice, 0);
    expect(feb29('1500', 'auto')).toHaveProperty('jd'); // a Julian leap year
    expect(feb29('1500', 'gregorian')).toEqual({ error: 'February 1500 has 28 days (Gregorian calendar).' });
    expect(feb29('2026', 'auto')).toEqual({ error: 'February 2026 has 28 days (Gregorian calendar).' });
  });

  it('writes years in the style Settings chooses, and names the calendar', () => {
    expect(yearText(-584)).toBe('585 BC');
    setYearStyle('astronomical');
    expect(yearText(-584)).toBe('−584');
    setYearStyle('iso');
    expect(yearText(-584)).toBe('-0584');
    setYearStyle('era');
    expect(calendarLabel({ calendar: 'julian', year: 1500, month: 3, day: 1 })).toBe('Julian calendar');
    expect(calendarLabel({ calendar: 'gregorian', year: 1500, month: 3, day: 10 })).toBe('proleptic Gregorian calendar (ISO 8601)');
    expect(calendarLabel({ calendar: 'gregorian', year: 2026, month: 9, day: 25 })).toBe('Gregorian calendar');
    expect(anachronismNote(1766)).toMatch(/first Nautical Almanac was for 1767/);
    expect(anachronismNote(1767)).toBeNull();
  });
});

describe('the engines', () => {
  it('the mock and the memoised engine have the tables', () => {
    const mock = new MockEngine({ syntheticStars: 10 });
    expect(isAlmanacTablesEngine(mock)).toBe(true);
    const memo = memoEngine(mock as unknown as ExplorerEngine);
    expect(isAlmanacTablesEngine(memo)).toBe(true);
    expect(isAlmanacTablesEngine(memoEngine({ kind: 'mock', description: '' } as unknown as ExplorerEngine))).toBe(false);
  });

  it('the mock groups openings from January 1, across a year end and in the Julian calendar', () => {
    const mock = new MockEngine({ syntheticStars: 10 });
    const o = mock.almanacOpening('2016-03-08');
    expect(o.index).toBe(1);
    expect(o.dates.map((d) => d.day)).toEqual([7, 8, 9]);
    expect(o.moon_days.map((d) => d.day)).toEqual([7, 8, 9, 10]);
    expect(openingHeading(o.dates)).toBe('2016 MARCH 7, 8, 9 (MON., TUES., WED.)');
    const end = mock.almanacOpening('2025-12-31');
    expect(end.dates.map((d) => `${d.year}-${d.month}-${d.day}`)).toEqual(['2025-12-30', '2025-12-31', '2026-1-1']);
    expect(openingHeading(end.dates)).toBe('2025 DECEMBER 30, 31, 2026 JANUARY 1 (TUES., WED., THURS.)');
    // The grouping (the mock's pages stop at 1990): 1 March 1500 (Julian, a leap year) is
    // day 61, the first of its opening; in 1582 the days count across the reform.
    const march1 = jdnFromCivil('julian', 1500, 3, 1);
    expect(openingJdns(march1, null)).toEqual({ jdns: [march1, march1 + 1, march1 + 2], index: 0 });
    // The same day is 11 March 1500 in the Gregorian calendar (not a leap year): day 70.
    expect(jdnFromCivil('gregorian', 1500, 3, 11)).toBe(march1);
    expect(openingJdns(march1 + 1, 'gregorian').index).toBe((31 + 28 + 12 - 1) % 3);
    const oct15 = jdnFromCivil('gregorian', 1582, 10, 15);
    expect(openingJdns(oct15, null)).toEqual({ jdns: [oct15 - 1, oct15, oct15 + 1], index: 1 });
  }, 30_000);
});

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('the built WebAssembly package (src/wasm-pkg)', () => {
  let engine: (WasmEngine & AlmanacTablesEngine) | null = null;

  beforeAll(async () => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as {
      initSync: (input: { module: BufferSource }) => unknown;
      init?: () => void;
      almanac_opening?: unknown;
    };
    glue.initSync({ module: readFileSync(WASM_FILE) });
    glue.init?.();
    const load = inspectWasmModule(glue);
    if (load.status === 'ready' && typeof glue.almanac_opening === 'function' && isAlmanacTablesEngine(load.engine)) {
      engine = load.engine as WasmEngine & AlmanacTablesEngine;
    }
  });

  it('prints the values Bowditch reproduces from the Nautical Almanac (needs a package with the tables)', ({ skip }) => {
    if (!engine) {
      skip();
      return;
    }
    const inc = engine.almanacIncrements(58);
    expect(inc.rows[27]!.aries.printed).toBe('14 39.2'); // §1906, Deneb
    expect(inc.rows[34]!.sun_planets.printed).toBe('14 38.5'); // §1909, Mars
    expect(engine.almanacIncrements(1).rows[4]!.moon.printed).toBe('0 15.3'); // §1908, Moon
    const alt = engine.almanacAltitudeTables();
    const byName = (name: string): CriticalTable => {
      const t = { sun_oct_mar: alt.sun_oct_mar, sun_apr_sep: alt.sun_apr_sep, stars_planets: alt.stars_planets }[name];
      if (!t) throw new Error(name);
      return t;
    };
    expect(criticalLookup(byName('stars_planets'), 50 + 26.6 / 60)).toEqual(['-0.8']); // §1906
    expect(criticalLookup(byName('sun_oct_mar'), 45 + 46.2 / 60)?.[0]).toBe('+15.3'); // §1910
    expect(criticalLookup(byName('sun_apr_sep'), 32 + 42.4 / 60)?.[1]).toBe('-17.3'); // vol. 2 §618
    expect(criticalLookup(alt.dip.feet, 68)).toEqual(['-8.0']); // §1906
    const zone = engine.almanacAltitudeTables({ temperature_c: celsiusOf(88), pressure_hpa: 982 });
    expect(zone.additional.conditions?.zone).toBe('M'); // §1907
    const arc = engine.almanacArcToTime();
    expect(arc.degrees).toHaveLength(360);
    expect(arc.arcminutes).toHaveLength(60);
  });

  it('makes a three-date opening and the year tables', ({ skip }) => {
    if (!engine) {
      skip();
      return;
    }
    const t0 = performance.now();
    const o = engine.almanacOpening('2016-03-08');
    const ms = performance.now() - t0;
    expect(o.index).toBe(1);
    expect(o.dates.map((d) => d.date)).toEqual(['2016-03-07', '2016-03-08', '2016-03-09']);
    expect(o.days.map((d) => d.date)).toEqual(['2016-03-07', '2016-03-08', '2016-03-09']);
    expect(o.moon_days).toHaveLength(4);
    expect(o.moon_rows).toHaveLength(o.days[1]!.rise_set.rows.length);
    expect(o.planet_sha_00h.map((p) => p.body)).toEqual(['Venus', 'Mars', 'Jupiter', 'Saturn']);
    // 1 March 1560 (Julian): the first date of its opening. And 28 May 585 BC (Julian), in
    // the labelled tier, which the almanac answers since the deeptime merge (polish2).
    const julianWire = shownDate(jdnFromCivil('julian', 1560, 3, 1), 'gregorian').wire;
    const j = engine.almanacOpening(julianWire);
    expect(j.calendar).toBe('julian');
    expect(j.dates.map((d) => d.day)).toEqual([1, 2, 3]);
    const thales = engine.almanacOpening(shownDate(jdnFromCivil('julian', -584, 5, 28), 'gregorian').wire);
    expect(thales.calendar).toBe('julian');
    expect(thales.days).toHaveLength(3);
    const polaris = engine.almanacPolaris(2016);
    expect(polaris.columns).toHaveLength(36);
    expect(polaris.columns.every((c) => c.a0.length === 11 && c.a1.length === 13 && c.a2.length === 12 && c.azimuth.length === 7)).toBe(true);
    const planets = engine.almanacPlanetCorrections(2024);
    expect(planets.venus.length).toBeGreaterThan(0);
    expect(planets.venus[0]!.from).toEqual({ year: 2024, month: 1, day: 1 });
    console.info(`almanac_opening in WebAssembly under node: ${ms.toFixed(0)} ms`);
  }, 60_000);
});
