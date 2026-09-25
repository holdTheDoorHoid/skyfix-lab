/**
 * navigate2 (expansion programme): the sight form's extras — "What did I shoot?" (the
 * star-identification request), the watch log read as the core reads it, and the tier gate
 * (sights only in the validated span) — with the mock engine, and against the real core
 * when a package is built.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ReducedSight, Session } from '../../src/types.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { ExplorerEngine, TimeInfo } from '../../src/next/engine/types.js';
import { WasmEngine, type ExplorerWasmExports } from '../../src/next/engine/wasm.js';
import { instrumentJson } from '../../src/next/engine/wasm-nav.js';
import { defaultState } from '../../src/next/state.js';
import { logRows, logValueAt, watchCorrectionAt } from '../../src/next/navigate/logs.js';
import { defaultWorking, type Working } from '../../src/next/navigate/model.js';
import { starIdPlace, starIdRequestFor } from '../../src/next/navigate/starid.js';
import { dateWords, sightTierAt } from '../../src/next/navigate/tier.js';

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

  it('offers sights in the validated tier and says why not in the labelled one, with ΔT', () => {
    expect(sightTierAt(fake(info('validated', 0.1)), 0)).toMatchObject({ offered: true, sentence: null });
    const t = sightTierAt(fake(info('labelled', 3 * 3600)), 0);
    expect(t.offered).toBe(false);
    expect(t.sentence).toBe(
      'No sights for 28 May 585 BC (Julian): positions then are labelled estimates, because the Earth’s rotation is known only roughly (±3.0 h of time, 45.1° of longitude). ' +
        'Sights, predicted readings and plans are offered only from 1550 to 2650, where the accuracy figures hold.',
    );
    expect(dateWords(info('labelled', 1, { calendar: 'gregorian', year: 2026, month: 9, day: 24, era_year: 2026, era: 'AD' }), 0)).toBe('24 Sep 2026');
  });

  it('with the mock engine: outside its coverage, no sights', () => {
    const t = sightTierAt(new MockEngine(), 2415020.5); // 1900
    expect(t.offered).toBe(false);
    expect(t.sentence).toMatch(/No sights for/);
  });
});

const PKG = resolve(__dirname, '../../src/wasm-pkg/skyfix_wasm.js');

describe.skipIf(!existsSync(PKG))('against the built core (npm run wasm)', () => {
  it('reads the watch log exactly as the core does, and identifies Vega from its compass bearing', async () => {
    const mod = (await import(pathToFileURL(PKG).href)) as Record<string, unknown> & { initSync: (o: { module: Buffer }) => void; reduce: (s: string, m: string) => { status: string; sight: ReducedSight }[] };
    mod.initSync({ module: readFileSync(resolve(__dirname, '../../src/wasm-pkg/skyfix_wasm_bg.wasm')) });
    const reduced = mod.reduce(JSON.stringify(LOGGED), 'auto');
    for (const [i, obs] of LOGGED.observations.entries()) {
      const core = reduced[i]!.sight.clock_correction_from_log!.value;
      expect(watchCorrectionAt(LOGGED, obs.utc)).toBeCloseTo(core, 6);
    }
    if (typeof mod.star_identify !== 'function') return;
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
    // The tier from the real engine: 1980 is outside this build's coverage.
    expect(sightTierAt(engine, 2444391.5).offered).toBe(false);
    expect(sightTierAt(engine, 2461314.5).offered).toBe(true);
  });
});
