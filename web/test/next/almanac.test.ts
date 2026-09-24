/**
 * The Almanac view's pure helpers, the `AlmanacEngine` contract in the WASM wrapper, the
 * memoised engine and the mock, and (when `npm run wasm` has built it) the real package's
 * `almanac_day`. The numbers themselves are validated in Rust against Skyfield and USNO
 * (crates/skyfix-almanac/tests/almanac_reference.rs, almanac_usno.rs).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  blocks,
  dayOfMonth,
  decParts,
  ghaParts,
  jdOfUtDate,
  moveToUtDate,
  pageHeading,
  phaseSymbol,
  showDecDegrees,
  timeCellClass,
  timeCellTitle,
  utDateOf,
  utHourOf,
} from '../../src/next/almanac/layout.js';
import { memoEngine } from '../../src/next/component.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import { fmtAngle, fmtDec, fmtHm, fmtMagnitude } from '../../src/next/engine/mock/almanac.js';
import {
  isAlmanacEngine,
  type AlmanacDay,
  type AlmanacTime,
  type ExplorerEngine,
} from '../../src/next/engine/types.js';
import { WasmEngine, inspectWasmModule, type ExplorerWasmExports } from '../../src/next/engine/wasm.js';

const PRINTED_GHA = /^\d{1,3} \d{2}\.\d$/;
const PRINTED_DEC = /^[NS] \d{1,2} \d{2}\.\d$/;
const PRINTED_TIME = /^-?\d{2} \d{2}$/;
const SYMBOLS = new Set(['□', '■', '////', '--', 'n/a']);

function checkTime(t: AlmanacTime, where: string): void {
  if (t.kind === 'time') {
    expect(t.printed, where).toMatch(PRINTED_TIME);
    expect(t.jd_utc, where).toBeTypeOf('number');
    expect(t.hours, where).toBeTypeOf('number');
  } else {
    expect(SYMBOLS.has(t.printed), `${where}: ${t.printed}`).toBe(true);
    expect(t.jd_utc, where).toBeNull();
  }
}

/** Every field the view reads, in the contract's format. */
function checkDay(day: AlmanacDay, date: string): void {
  expect(day.date).toBe(date);
  expect(day.hours).toHaveLength(24);
  expect(day.planets.map((p) => p.body)).toEqual(['Venus', 'Mars', 'Jupiter', 'Saturn']);
  day.hours.forEach((r, h) => {
    expect(r.hour).toBe(h);
    expect(r.aries.printed.gha).toMatch(PRINTED_GHA);
    expect(r.sun.printed.gha).toMatch(PRINTED_GHA);
    expect(r.sun.printed.dec).toMatch(PRINTED_DEC);
    expect(r.moon?.printed.dec).toMatch(PRINTED_DEC);
    expect(r.moon?.printed.hp).toMatch(/^\d{2}\.\d$/);
    expect(r.planets).toHaveLength(4);
    for (const p of r.planets) expect(p.printed.dec).toMatch(PRINTED_DEC);
  });
  expect(day.stars).toHaveLength(58);
  expect(day.stars[0]!.body).toBe('Acamar');
  expect(day.stars[57]!.body).toBe('Polaris');
  for (const s of day.stars) expect(s.printed.sha).toMatch(PRINTED_GHA);
  expect(day.rise_set.rows).toHaveLength(31);
  expect(day.rise_set.rows[0]!.label).toBe('N 72');
  expect(day.rise_set.rows[30]!.label).toBe('S 60');
  expect(day.rise_set.moon_dates[0]).toBe(date);
  for (const r of day.rise_set.rows) {
    for (const k of ['nautical_dawn', 'civil_dawn', 'sunrise', 'sunset', 'civil_dusk', 'nautical_dusk'] as const) {
      checkTime(r[k], `${r.label} ${k}`);
    }
    expect(r.moonrise).toHaveLength(2);
    r.moonrise.forEach((t, i) => checkTime(t, `${r.label} moonrise ${i}`));
    r.moonset.forEach((t, i) => checkTime(t, `${r.label} moonset ${i}`));
  }
  checkTime(day.sun.mer_pass, 'Sun mer pass');
  expect(day.sun.printed.eot_00h).toMatch(/^\d{2} \d{2}$/);
  expect(day.aries.mer_pass.printed).toMatch(/^\d{2} \d{2}\.\d$/);
  expect(day.notes.length).toBeGreaterThan(3);
}

describe('layout helpers', () => {
  it('works in UT dates, whatever the time of day', () => {
    const jd = jdOfUtDate('2026-09-24')!;
    expect(jd).toBe(2461307.5);
    expect(utDateOf(jd)).toBe('2026-09-24');
    expect(utDateOf(jd + 0.9999)).toBe('2026-09-24');
    expect(utDateOf(jd + 1)).toBe('2026-09-25');
    expect(utHourOf(jd + 13.5 / 24)).toBe(13);
    expect(jdOfUtDate('2026-02-30')).toBeNull();
    expect(jdOfUtDate('24/09/2026')).toBeNull();
    // Moving to another date keeps the time of day.
    const moved = moveToUtDate(jd + 0.25, '2000-02-29')!;
    expect(utDateOf(moved)).toBe('2000-02-29');
    expect(utHourOf(moved)).toBe(6);
    expect(moveToUtDate(jd, 'nonsense')).toBeNull();
  });

  it('writes the page heading and the moon dates as the printed almanac does', () => {
    expect(pageHeading({ date: '2026-09-24', weekday: 'Thursday' })).toBe('2026 SEPTEMBER 24 (THURSDAY)');
    expect(dayOfMonth('2026-09-05')).toBe('5');
    expect(blocks([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it('splits printed angles and repeats a declination’s degrees only where the printed almanac does', () => {
    expect(ghaParts('183 12.4')).toEqual({ deg: '183', min: '12.4' });
    expect(decParts('S 0 23.3')).toEqual({ hemisphere: 'S', deg: '0', min: '23.3' });
    expect(showDecDegrees(['S 0 58.1', 'S 0 59.0', 'S 1 00.0', 'S 1 01.0', 'N 0 00.2'])).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it('describes symbols in words, and dates beyond the day', () => {
    const t = (kind: AlmanacTime['kind'], printed: string, hours: number | null = null): AlmanacTime => ({
      kind,
      jd_utc: hours === null ? null : 1,
      utc: hours === null ? null : '2026-09-25T00:05:00.000Z',
      hours,
      printed,
    });
    expect(timeCellClass(t('time', '06 42', 6.7))).toBe('alm-t');
    expect(timeCellClass(t('all_night', '////'))).toBe('alm-t alm-sym alm-all-night');
    expect(timeCellTitle(t('above', '□'))).toMatch(/above the horizon all day/i);
    expect(timeCellTitle(t('time', '24 05', 24.08))).toMatch(/following date/);
    expect(timeCellTitle(t('time', '06 42', 6.7))).toBeUndefined();
    expect(phaseSymbol('full_moon')).toBe('○');
  });
});

describe('the engines', () => {
  it('the WASM wrapper calls almanac_day with the date, and says when a build lacks it', () => {
    const calls: unknown[] = [];
    const engine = new WasmEngine({
      almanac_day: (date: string) => {
        calls.push(date);
        return { date };
      },
    } as unknown as ExplorerWasmExports);
    expect(isAlmanacEngine(engine)).toBe(true);
    expect(engine.almanacDay('2026-09-24')).toEqual({ date: '2026-09-24' });
    expect(calls).toEqual(['2026-09-24']);
    const old = new WasmEngine({} as ExplorerWasmExports);
    expect(() => old.almanacDay('2026-09-24')).toThrow(/no almanac pages.*npm run wasm/);
    const failing = new WasmEngine({
      almanac_day: () => {
        throw 'date must be a UT calendar date written YYYY-MM-DD, got "x"';
      },
    } as unknown as ExplorerWasmExports);
    expect(() => failing.almanacDay('x')).toThrow('almanac_day: date must be');
  });

  it('the memoised engine forwards almanacDay when the engine has it, one page per date', () => {
    let n = 0;
    const raw = {
      kind: 'mock',
      description: 'fake',
      almanacDay: (date: string) => {
        n += 1;
        return { date } as unknown as AlmanacDay;
      },
    } as unknown as ExplorerEngine;
    const memo = memoEngine(raw);
    expect(isAlmanacEngine(memo)).toBe(true);
    if (!isAlmanacEngine(memo)) return;
    expect(memo.almanacDay('2026-09-24')).toBe(memo.almanacDay('2026-09-24'));
    memo.almanacDay('2026-09-25');
    expect(n).toBe(2);
    expect(isAlmanacEngine(memoEngine({ kind: 'mock', description: '' } as unknown as ExplorerEngine))).toBe(false);
  });

  it('the mock makes illustrative pages in the contract shape, with the printed conventions', () => {
    const mock = new MockEngine({ syntheticStars: 10 });
    const day = mock.almanacDay('2026-09-24');
    checkDay(day, '2026-09-24');
    expect(day.notes[0]).toMatch(/MOCK ENGINE/);
    // June solstice: midnight sun and twilight all night in the north.
    const june = mock.almanacDay('1992-06-21');
    const n72 = june.rise_set.rows[0]!;
    expect(n72.sunrise.printed).toBe('□');
    expect(june.rise_set.rows.some((r) => r.nautical_dawn.printed === '////')).toBe(true);
    expect(() => mock.almanacDay('2026-9-24')).toThrow(/YYYY-MM-DD/);
    expect(() => mock.almanacDay('2061-01-01')).toThrow(/mock engine makes almanac pages/);
  }, 20_000);

  it('the mock prints as the real engine does', () => {
    expect(fmtAngle(359.99999)).toBe('0 00.0');
    expect(fmtAngle(183.206667)).toBe('183 12.4');
    expect(fmtDec(-0.0001)).toBe('S 0 00.0');
    expect(fmtHm(24 + 5 / 60)).toBe('24 05');
    expect(fmtHm(-2 / 60)).toBe('-00 02');
    expect(fmtMagnitude(1.26)).toBe('+1.3');
  });
});

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('the built WebAssembly package (src/wasm-pkg)', () => {
  let engine: WasmEngine | null = null;
  let hasExport = false;

  beforeAll(async () => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as {
      initSync: (input: { module: BufferSource }) => unknown;
      init?: () => void;
      almanac_day?: unknown;
    };
    glue.initSync({ module: readFileSync(WASM_FILE) });
    glue.init?.();
    hasExport = typeof glue.almanac_day === 'function';
    const load = inspectWasmModule(glue);
    if (load.status === 'ready') engine = load.engine;
  });

  it('makes the page the Rust tests validate (needs a package built with almanac_day)', ({ skip }) => {
    if (!engine || !hasExport) {
      skip();
      return;
    }
    const t = performance.now();
    const day = engine.almanacDay('2026-09-24');
    const ms = performance.now() - t;
    checkDay(day, '2026-09-24');
    // The numbers `skyfix almanac --date 2026-09-24` prints (crates/skyfix-cli/tests/almanac.rs).
    expect(day.hours[0]!.sun.printed).toEqual({ gha: '181 57.1', dec: 'S 0 23.3' });
    expect(day.hours[0]!.moon?.printed).toEqual({ gha: '32 25.8', v: '14.1', dec: 'S 12 13.1', d: '13.7', hp: '56.0' });
    expect(day.aries.mer_pass.printed).toBe('23 44.7');
    expect(day.rise_set.rows[0]!.nautical_dawn.printed).toBe('03 10');
    expect(day.moon?.printed).toEqual({ sd: '15.4', age: '13', illuminated: '95' });
    expect(() => engine!.almanacDay('2061-01-01')).toThrow(/coverage/);
    console.info(`almanac_day in WebAssembly under node: ${ms.toFixed(0)} ms`);
  });
});
