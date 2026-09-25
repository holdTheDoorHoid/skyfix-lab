/**
 * navigate2 (expansion programme): the sight form's extras — "What did I shoot?" (the
 * star-identification request), the watch log read as the core reads it, and the tier gate
 * (sights only in the validated span) — with the mock engine, and against the real core
 * when a package is built.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReducedSight, Session } from '../../src/types.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { ExplorerEngine, TimeInfo } from '../../src/next/engine/types.js';
import { WasmEngine, type ExplorerWasmExports } from '../../src/next/engine/wasm.js';
import { instrumentJson } from '../../src/next/engine/wasm-nav.js';
import { defaultState } from '../../src/next/state.js';
import { logRows, logValueAt, watchCorrectionAt } from '../../src/next/navigate/logs.js';
import { defaultWorking, type Working } from '../../src/next/navigate/model.js';
import { starIdPlace, starIdRequestFor } from '../../src/next/navigate/starid.js';
import { dateWords, rotationCaution, sightTierAt } from '../../src/next/navigate/tier.js';
import { parseUtcInput } from '../../src/next/navigate/parse.js';
import { fmtUtcClock, utcInputText, utcText, utcTimeText } from '../../src/next/navigate/format.js';
import { jdnFromCivil, setCalendarMode } from '../../src/next/time/civil.js';

const LOGGED: Session = {
  schema: 'skyfix.session/1',
  meta: { name: 't', notes: '', kind: 'real' },
  observer: { height_of_eye_m: 3, pressure_hpa: 1010, temperature_c: 10, assumed_position: { lat_deg: 39.95, lon_deg: -75.17 }, assumed_position_role: { role: 'initializer' } },
  instrument: {
    name: '',
    index_correction_arcmin: 0,
    horizon: 'sea',
    index_error_log: [
      { utc: '2026-10-01T00:00:00Z', ic_arcmin: -1.0, note: 'dusk' },
      { utc: '2026-10-01T02:00:00Z', ic_arcmin: -2.0, note: '' },
    ],
  },
  clock: {
    uncertainty_s: 0,
    correction_s: 0,
    watch_log: [
      { utc: '2026-09-30T12:00:00Z', correction_s: 3, note: 'radio' },
      { utc: '2026-10-01T12:00:00Z', correction_s: 5, note: '' },
    ],
  },
  observations: [
    { id: 'o1', body: 'Vega', utc: '2026-10-01T01:00:00Z', altitude_deg: 61.5, altitude_kind: 'sextant_hs', sigma_arcmin: 1, limb: 'center', horizon: null, geocentric: null, notes: '' },
    { id: 'o2', body: 'Vega', utc: '2026-10-01T13:00:00Z', altitude_deg: 41.5, altitude_kind: 'sextant_hs', sigma_arcmin: 1, limb: 'center', horizon: null, geocentric: null, notes: '' },
  ],
};

describe('a log read at an instant (the core’s rule)', () => {
  it('interpolates inside, holds outside, and takes a one-entry log as a constant', () => {
    const rows = logRows(LOGGED, 'watch');
    expect(logValueAt(rows, '2026-10-01T01:00:00Z')!.value).toBeCloseTo(3 + (13 / 24) * 2, 8);
    expect(logValueAt(rows, '2026-10-01T13:00:00Z')!.value).toBe(5);
    expect(logValueAt(rows, '2026-10-01T13:00:00Z')!.hoursOutside).toBeCloseTo(1, 6);
    expect(logValueAt(rows, '2026-09-30T00:00:00Z')!.value).toBe(3);
    expect(logValueAt(rows.slice(0, 1), '2027-01-01T00:00:00Z')).toEqual({ value: 3, hoursOutside: 0 });
    expect(logValueAt([], '2026-10-01T00:00:00Z')).toBeNull();
    expect(watchCorrectionAt({ ...LOGGED, clock: { uncertainty_s: 0, correction_s: -2.5 } }, '2026-10-01T01:00:00Z')).toBe(-2.5);
  });
});

describe('predictions take the index-error log (navigate2)', () => {
  it('sends the log with the instrument when it has entries, and not otherwise', () => {
    const log = [{ utc: '2026-10-01T00:00:00Z', ic_arcmin: -3, note: '' }];
    expect(JSON.parse(instrumentJson({ index_correction_arcmin: 0, horizon: 'sea', index_error_log: log }))).toEqual({ index_correction_arcmin: 0, horizon: 'sea', index_error_log: log });
    expect(JSON.parse(instrumentJson({ index_correction_arcmin: -1, index_error_log: [] }))).toEqual({ index_correction_arcmin: -1 });
  });
});

describe('the star-identification request', () => {
  const explorer = defaultState(Date.UTC(2026, 9, 1, 0, 30));
  const w: Working = { ...defaultWorking(), session: LOGGED };

  it('asks for the time and the reading first', () => {
    const bearing = { deg: 286, kind: 'true' as const, deviationDeg: null, variationDeg: null, toleranceDeg: 5 };
    expect(starIdRequestFor(w, explorer, { utc: null, altitudeDeg: 60, altitudeKind: 'sextant_hs', horizon: 'sea' }, bearing)).toEqual({ missing: 'Type the time of the sight first (above).' });
    expect(starIdRequestFor(w, explorer, { utc: '2026-10-01T00:30:00Z', altitudeDeg: null, altitudeKind: 'sextant_hs', horizon: 'sea' }, bearing)).toEqual({ missing: 'Type the sextant reading first (above).' });
  });

  it('sends the session’s DR, instrument, index log and DUT1, the watch-corrected time and the bearing', () => {
    const r = starIdRequestFor(
      { ...w, session: { ...LOGGED, clock: { ...LOGGED.clock, dut1_s: -0.1 } } },
      explorer,
      { utc: '2026-10-01T00:30:00Z', altitudeDeg: 72.59, altitudeKind: 'sextant_hs', horizon: { shore: { distance_nm: 1.2 } } },
      { deg: 286, kind: 'compass', deviationDeg: 1.5, variationDeg: -12.5, toleranceDeg: 10 },
    );
    if (!('request' in r)) throw new Error(r.missing);
    // The watch log at 00:30: 3 + 12.5/24 x 2 = 4.0417 s added.
    const added = 3 + (12.5 / 24) * 2;
    expect(Date.parse(r.request.utc) - Date.parse('2026-10-01T00:30:00Z')).toBeCloseTo(added * 1000, 0);
    expect(r.request).toMatchObject({
      observer: { lat_deg: 39.95, lon_deg: -75.17, height_of_eye_m: 3, pressure_hpa: 1010, temperature_c: 10, dut1_s: -0.1 },
      instrument: { index_correction_arcmin: 0, horizon: { shore: { distance_nm: 1.2 } }, index_error_log: LOGGED.instrument.index_error_log },
      altitude_deg: 72.59,
      altitude_kind: 'sextant_hs',
      bearing_deg: 286,
      bearing_kind: 'compass',
      variation_deg: -12.5,
      deviation_deg: 1.5,
      bearing_tolerance_deg: 10,
    });
    const truly = starIdRequestFor(w, explorer, { utc: '2026-10-01T00:30:00Z', altitudeDeg: 60, altitudeKind: 'observed_ho', horizon: 'sea' }, { deg: 90, kind: 'true', deviationDeg: 2, variationDeg: -12, toleranceDeg: 5 });
    if (!('request' in truly)) throw new Error('expected a request');
    expect(truly.request.variation_deg).toBeUndefined();
    expect(truly.request.deviation_deg).toBeUndefined();
  });

  it('works from the map’s place when the session has no DR', () => {
    const noDr = { ...w, session: { ...LOGGED, observer: { ...LOGGED.observer, assumed_position: null } } };
    expect(starIdPlace(noDr, explorer)).toMatchObject({ lat_deg: explorer.observer.lat_deg, lon_deg: explorer.observer.lon_deg });
  });

  it('finds a mock star from its own mock direction (shapes)', () => {
    const engine = new MockEngine();
    const sky = engine.skyState({ lat_deg: 39.95, lon_deg: -75.17 }, 2461314.5208333, ['Vega']);
    const vega = sky.bodies.find((b) => b.body === 'Vega')!;
    const r = starIdRequestFor(w, explorer, { utc: '2026-10-01T00:30:00Z', altitudeDeg: vega.alt_deg, altitudeKind: 'observed_ho', horizon: 'sea' }, { deg: vega.az_deg, kind: 'true', deviationDeg: null, variationDeg: null, toleranceDeg: 5 });
    if (!('request' in r)) throw new Error('expected a request');
    const out = engine.starIdentify({ ...r.request, utc: '2026-10-01T00:30:00Z' });
    expect(out.candidates.length).toBeGreaterThan(0);
    expect(out.best).toBe('Vega');
  });
});

describe('the tier gate: sights only in the validated span', () => {
  const info = (tier: TimeInfo['tier'], sigma: number, civil?: Partial<TimeInfo['civil']>): TimeInfo => ({
    jd_utc: 0,
    utc: '',
    scale: 'ut',
    tier,
    delta_t_s: 0,
    delta_t_sigma_s: sigma,
    delta_t_source: 'parabola',
    tt_minus_clock_s: 0,
    dut1_s: 0,
    dut1_sigma_s: 0,
    dut1_source: 'model',
    calendar: 'julian',
    civil: { calendar: 'julian', year: -584, month: 5, day: 28, hour: 0, minute: 0, second: 0, era_year: 585, era: 'BC', ...civil },
    julian_civil: { calendar: 'julian', year: -584, month: 5, day: 28, hour: 0, minute: 0, second: 0, era_year: 585, era: 'BC' },
    notes: [],
  });
  const fake = (i: TimeInfo): ExplorerEngine =>
    ({
      ...new MockEngine(),
      coverage: () => ({ start_utc: '-2000-01-01T00:00:00Z', end_utc: '3000-12-31T23:59:59Z', validated_start_utc: '1550-01-01T00:00:00Z', validated_end_utc: '2650-01-22T00:00:00Z', groups: [] }),
      timeInfo: () => i,
      setDut1: () => undefined,
      calendarConvert: () => {
        throw new Error('unused');
      },
    }) as unknown as ExplorerEngine;

  // Instants on the app's clock: 585 BC May 28 (Julian) at noon, and 2026-09-24.
  const BC585 = jdnFromCivil('julian', -584, 5, 28);
  const Y2026 = 2461307.5;

  it('offers sights in the validated tier and says why not in the labelled one, with ΔT (time-ui tierAt, sightsOnlyText)', () => {
    expect(sightTierAt(fake(info('validated', 0.1)), Y2026)).toMatchObject({ tier: 'validated', offered: true, sentence: null });
    const t = sightTierAt(fake(info('labelled', 3 * 3600)), BC585);
    expect(t.tier).toBe('labelled');
    expect(t.offered).toBe(false);
    expect(t.sentence).toBe(
      'No sights for 28 May 585 BC (Julian): positions then are estimates, because the Earth’s rotation is known only roughly (±3 h of time, 45.1° of longitude). ' +
        'Sights are offered only between 1550 and 2650, the years whose positions are checked against JPL’s DE440 ephemeris.',
    );
    // The chip's information travels with the answer.
    expect(t.info?.delta_t_sigma_s).toBe(3 * 3600);
    expect(dateWords(Y2026)).toBe('24 September 2026');
  });

  it('outside the engine’s coverage: the years it covers, and the shared sentence when it reports tiers', () => {
    const t = sightTierAt(fake(info('outside', 0)), jdnFromCivil('julian', -2500, 1, 1));
    expect(t.tier).toBe('outside');
    expect(t.sentence).toBe(
      'No sights for 1 January 2501 BC (Julian): it is outside the years the SkyFix Lab core covers (1 January 2001 BC to 31 December 3000, Gregorian calendar), so nothing can be computed for it. ' +
        'Sights are offered only between 1550 and 2650, the years whose positions are checked against JPL’s DE440 ephemeris.',
    );
  });

  it('with the mock engine (no tiers reported): outside its coverage, no sights, and its own years named', () => {
    // The mock reports its window as its validated tier and answers `tierAt` (deeptime
    // agent); an engine that reports no tiers is the mock without both.
    const base = new MockEngine();
    const { validated_start_utc: _vs, validated_end_utc: _ve, ...plain } = base.coverage();
    const noTiers = Object.assign(Object.create(base) as MockEngine, { coverage: () => plain, tierAt: undefined });
    const t = sightTierAt(noTiers, 2415020.5); // 1900-01-01
    expect(t.offered).toBe(false);
    expect(t.sentence).toBe('No sights for 1 January 1900: it is outside the years the SkyFix Lab core covers (1 January 1990 to 31 December 2060, Gregorian calendar), so nothing can be computed for it.');
  });

  it('far-future sights inside the validated tier carry the Earth’s rotation’s uncertainty', () => {
    const quiet = sightTierAt(fake(info('validated', 12)), Y2026);
    expect(rotationCaution(quiet)).toBeNull();
    const loud = sightTierAt(fake(info('validated', 120)), Y2026);
    expect(loud.offered).toBe(true);
    expect(rotationCaution(loud)).toBe('The Earth’s rotation then is known only to ±2 min (ΔT), so every fix’s longitude is uncertain by ±30.1′. The bodies’ places are not affected.');
  });
});

describe('dates typed in the display calendar (time-ui civil helpers)', () => {
  afterEach(() => setCalendarMode('historical'));

  it('reads a date before 1582-10-15 as Julian and writes it back the same way', () => {
    const r = parseUtcInput('1550-03-01 12:00:00');
    expect(r).toEqual({ ok: true, value: '1550-03-11T12:00:00Z' });
    expect(utcInputText('1550-03-11T12:00:00Z')).toBe('1550-03-01 12:00:00');
    // The reform: Julian 4 October 1582 is followed by Gregorian 15 October.
    expect(parseUtcInput('1582-10-04 12:00:00')).toEqual({ ok: true, value: '1582-10-14T12:00:00Z' });
    expect(parseUtcInput('1582-10-15 12:00:00')).toEqual({ ok: true, value: '1582-10-15T12:00:00Z' });
    const gap = parseUtcInput('1582-10-10 12:00:00');
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.error).toMatch(/ten dates the 1582 reform skipped/);
    // Julian 1500 is a leap year; Gregorian 1500 is not.
    expect(parseUtcInput('1500-02-29 00:00:00').ok).toBe(true);
    // Modern dates are unchanged.
    expect(parseUtcInput('2026-10-01 01:30:05')).toEqual({ ok: true, value: '2026-10-01T01:30:05Z' });
  });

  it('takes years of any width, BC as ISO 8601 writes them, and round-trips them', () => {
    expect(parseUtcInput('-0584-05-28 12:00:00')).toEqual({ ok: true, value: '-0584-05-22T12:00:00Z' });
    expect(parseUtcInput('−584-05-28 12:00:00')).toEqual({ ok: true, value: '-0584-05-22T12:00:00Z' });
    expect(parseUtcInput('79-08-24 12:00:00')).toEqual({ ok: true, value: '0079-08-22T12:00:00Z' });
    expect(parseUtcInput('+12345-01-01 00:00:00').ok).toBe(true);
    expect(parseUtcInput('123456-01-01 00:00:00').ok).toBe(false);
    for (const utc of ['-0584-05-22T12:00:00Z', '0079-08-22T12:00:00Z', '1066-10-20T09:00:00Z', '1582-10-14T00:00:00Z', '1582-10-15T00:00:00Z', '2026-10-01T01:30:05.5Z']) {
      const back = parseUtcInput(utcInputText(utc));
      expect(back.ok && back.value).toBe(utc);
    }
    expect(utcInputText('-0584-05-22T12:00:00Z')).toBe('-0584-05-28 12:00:00');
  });

  it('in the ISO setting reads every date as proleptic Gregorian', () => {
    setCalendarMode('iso');
    expect(parseUtcInput('1550-03-01 12:00:00')).toEqual({ ok: true, value: '1550-03-01T12:00:00Z' });
    expect(parseUtcInput('1582-10-10 12:00:00').ok).toBe(true);
    expect(utcInputText('1550-03-11T12:00:00Z')).toBe('1550-03-11 12:00:00');
  });

  it('writes the clock’s word: UTC in 1972-2035, UT outside', () => {
    expect(utcText('2026-10-01T01:30:05Z')).toBe('2026-10-01 01:30:05 UTC');
    expect(utcText('2040-01-01T00:00:00Z')).toBe('2040-01-01 00:00:00 UT');
    expect(utcTimeText('1950-06-01T12:00:00Z')).toBe('12:00:00 UT');
    expect(fmtUtcClock(2466155.0)).toBe('12:00:00 UT'); // 2040-01-01
  });
});

const PKG = resolve(__dirname, '../../src/wasm-pkg/skyfix_wasm.js');

describe.skipIf(!existsSync(PKG))('against the built core (npm run wasm)', () => {
  it('reads the watch log exactly as the core does, and identifies Vega from its compass bearing', async ({ skip }) => {
    const mod = (await import(pathToFileURL(PKG).href)) as Record<string, unknown> & { initSync: (o: { module: Buffer }) => void; reduce: (s: string, m: string) => { status: string; sight: ReducedSight }[] };
    mod.initSync({ module: readFileSync(resolve(__dirname, '../../src/wasm-pkg/skyfix_wasm_bg.wasm')) });
    const reduced = mod.reduce(JSON.stringify(LOGGED), 'auto');
    for (const [i, obs] of LOGGED.observations.entries()) {
      const core = reduced[i]!.sight.clock_correction_from_log!.value;
      expect(watchCorrectionAt(LOGGED, obs.utc)).toBeCloseTo(core, 6);
    }
    if (typeof mod.star_identify !== 'function') return skip(); // verify2: skipped, not a silent pass
    const engine = new WasmEngine(mod as unknown as ExplorerWasmExports);
    const explorer = defaultState(Date.UTC(2026, 9, 1, 0, 30));
    const plain: Working = { ...defaultWorking(), session: { ...LOGGED, instrument: { name: '', index_correction_arcmin: -1.2, horizon: 'sea' }, clock: { uncertainty_s: 0, correction_s: 0 }, observer: { ...LOGGED.observer, height_of_eye_m: 2.5 } } };
    const r = starIdRequestFor(plain, explorer, { utc: '2026-10-01T00:30:00Z', altitudeDeg: 72.59, altitudeKind: 'sextant_hs', horizon: 'sea' }, { deg: 286, kind: 'compass', deviationDeg: 0, variationDeg: -12.5, toleranceDeg: 5 });
    if (!('request' in r)) throw new Error('expected a request');
    const out = engine.starIdentify(r.request);
    expect(out.best).toBe('Vega');
    expect(out.observed_bearing_deg).toBeCloseTo(273.5, 6);
    // A predicted reading with a one-entry log equals one with that single correction.
    const nav = (engine as unknown as { nav: { predictSextant: (o: object, i: object, b: string, l: string, jd: number) => { hs_deg: number } } }).nav;
    expect(nav).toBeTruthy();
    if (nav) {
      const observer = { lat_deg: 39.95, lon_deg: -75.17, height_of_eye_m: 2.5 };
      const byLog = nav.predictSextant(observer, { index_correction_arcmin: 0, index_error_log: [{ utc: '2026-10-01T00:00:00Z', ic_arcmin: -3, note: '' }] }, 'Vega', 'center', 2461314.5625);
      const bySingle = nav.predictSextant(observer, { index_correction_arcmin: -3 }, 'Vega', 'center', 2461314.5625);
      expect(byLog.hs_deg).toBeCloseTo(bySingle.hs_deg, 12);
    }
    // The tier from the real engine: 1500 is before the validated tier (1550-2650; it was
    // outside the one-tier core's 1990-2060 as well).
    expect(sightTierAt(engine, 2268923.5).offered).toBe(false);
    expect(sightTierAt(engine, 2461314.5).offered).toBe(true);
  });
});
