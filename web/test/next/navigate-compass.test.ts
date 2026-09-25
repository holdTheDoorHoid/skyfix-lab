/**
 * navigate2 (expansion programme): the Compass tab's logic and the session settings it
 * shares with the sights — the deviation table and its five-coefficient curve, the
 * compass request, the error logs, the DUT1 wording and the shore horizon's sentence —
 * with the mock engine, and against the real core when a package is built.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dipArcmin, dipShortArcmin } from '../../src/corrections.js';
import type { Session } from '../../src/types.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { TimeInfo } from '../../src/next/engine/types.js';
import { WasmEngine, type ExplorerWasmExports } from '../../src/next/engine/wasm.js';
import { defaultState } from '../../src/next/state.js';
import { sanitizeWorking } from '../../src/next/navigate/autosave.js';
import {
  deviationAt,
  deviationCard,
  eastWest,
  fitDeviation,
  interpolateDeviation,
  maxHeadingGap,
  parseEastWest,
} from '../../src/next/navigate/compass/deviation.js';
import { compassPlace, compassRequest, compassUtc } from '../../src/next/navigate/compass/request.js';
import { dut1Instant, dut1Line } from '../../src/next/navigate/dut1.js';
import { checkLogRow, logRows, logSummary, withLogRow, withoutLogRow } from '../../src/next/navigate/logs.js';
import { defaultWorking, hasOwnData, type DeviationEntry, type Working } from '../../src/next/navigate/model.js';
import { shoreSentence } from '../../src/next/navigate/shore.js';

const entry = (headingDeg: number, deviationDeg: number, i = 0): DeviationEntry => ({
  id: `d${i}-${headingDeg}`,
  headingDeg,
  deviationDeg,
  utc: null,
  source: 'typed',
  note: '',
});

describe('the deviation table', () => {
  // A swing on the eight cardinal and intercardinal headings (degrees, east positive).
  const SWING: [number, number][] = [
    [0, 1.5],
    [45, 3.5],
    [90, 4.0],
    [135, 1.0],
    [180, -2.5],
    [225, -4.5],
    [270, -3.0],
    [315, 0.0],
  ];

  it('fits a swing: A, D and E are the textbook’s approximate coefficients; B and C use all eight headings', () => {
    const r = fitDeviation(SWING.map(([hdg, dev], i) => entry(hdg, dev, i)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = Object.fromEntries(SWING.map(([hdg, dev]) => [hdg, dev])) as Record<number, number>;
    // Textbook: A = mean; D = (NE + SW - SE - NW)/4; E = (N + S - E - W)/4.
    const mean = SWING.reduce((s, [, dev]) => s + dev, 0) / 8;
    expect(r.fit.a).toBeCloseTo(mean, 10);
    expect(r.fit.d).toBeCloseTo((v[45]! + v[225]! - v[135]! - v[315]!) / 4, 10);
    expect(r.fit.e).toBeCloseTo((v[0]! + v[180]! - v[90]! - v[270]!) / 4, 10);
    // Least squares over eight equally spaced headings: B = (E - W)/4 + (NE + SE - SW - NW) sqrt2/8,
    // C = (N - S)/4 + (NE + NW - SE - SW) sqrt2/8 (the textbook's (E - W)/2 and (N - S)/2 use two).
    const k = Math.SQRT2 / 8;
    expect(r.fit.b).toBeCloseTo((v[90]! - v[270]!) / 4 + (v[45]! + v[135]! - v[225]! - v[315]!) * k, 10);
    expect(r.fit.c).toBeCloseTo((v[0]! - v[180]!) / 4 + (v[45]! + v[315]! - v[135]! - v[225]!) * k, 10);
    expect(r.fit.dof).toBe(3);
    expect(r.fit.maxGapDeg).toBe(45);
  });

  it('agrees with the textbook’s B and C exactly when the swing follows the curve', () => {
    const truth = { a: -0.3, b: 2.1, c: -1.4, d: 0.7, e: 0.2, rmsDeg: 0, n: 0, dof: 0, maxGapDeg: 0 };
    const swing = [0, 45, 90, 135, 180, 225, 270, 315].map((hdg, i) => entry(hdg, deviationAt(truth, hdg), i));
    const r = fitDeviation(swing);
    if (!r.ok) throw new Error(r.reason);
    const dev = (hdg: number): number => swing.find((e) => e.headingDeg === hdg)!.deviationDeg;
    expect(r.fit.b).toBeCloseTo((dev(90) - dev(270)) / 2, 10);
    expect(r.fit.c).toBeCloseTo((dev(0) - dev(180)) / 2, 10);
  });

  it('recovers the coefficients of a curve exactly, and gives a card from it', () => {
    const truth = { a: 0.5, b: -3.2, c: 1.8, d: 0.9, e: -0.4 };
    const entries = [10, 50, 95, 140, 170, 200, 250, 300, 340].map((hdg, i) => entry(hdg, deviationAt({ ...truth, rmsDeg: 0, n: 0, dof: 0, maxGapDeg: 0 }, hdg), i));
    const r = fitDeviation(entries);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const k of ['a', 'b', 'c', 'd', 'e'] as const) expect(r.fit[k]).toBeCloseTo(truth[k], 9);
    expect(r.fit.rmsDeg).toBeLessThan(1e-9);
    const card = deviationCard(r.fit, 15);
    expect(card).toHaveLength(24);
    expect(card[6]!.headingDeg).toBe(90);
    expect(card[6]!.deviationDeg).toBeCloseTo(truth.a + truth.b - truth.e, 9);
  });

  it('refuses a curve with too few headings or a gap it would have to guess across', () => {
    const few = fitDeviation([entry(0, 1), entry(90, 2), entry(180, 1), entry(270, 0)]);
    expect(few.ok).toBe(false);
    if (!few.ok) expect(few.reason).toMatch(/five different headings \(4 so far\)/);
    const gappy = fitDeviation([0, 20, 40, 60, 80, 100].map((hdg, i) => entry(hdg, 1, i)));
    expect(gappy.ok).toBe(false);
    if (!gappy.ok) expect(gappy.reason).toMatch(/gap of 260°/);
    expect(maxHeadingGap([entry(350, 0), entry(10, 0)])).toBe(340);
  });

  it('interpolates round the circle, and says where a value came from', () => {
    const list = [entry(350, 2), entry(10, -2), entry(90, 4)];
    const i = interpolateDeviation(list, 0)!;
    expect(i.deviationDeg).toBeCloseTo(0, 12);
    expect(i.from.headingDeg).toBe(350);
    expect(i.to.headingDeg).toBe(10);
    expect(i.gapDeg).toBe(20);
    const at = interpolateDeviation(list, 90)!;
    expect(at.gapDeg).toBe(0);
    expect(at.deviationDeg).toBe(4);
    const wrap = interpolateDeviation(list, 200)!;
    expect(wrap.from.headingDeg).toBe(90);
    expect(wrap.to.headingDeg).toBe(350);
    expect(wrap.deviationDeg).toBeCloseTo(4 + ((200 - 90) / 260) * (2 - 4), 12);
    expect(interpolateDeviation([entry(10, 1)], 20)).toBeNull();
  });

  it('writes and reads deviation and variation with their names', () => {
    expect(eastWest(-2.64)).toBe('2.6° W');
    expect(eastWest(1.39)).toBe('1.4° E');
    expect(eastWest(0.02)).toBe('0.0°');
    expect(parseEastWest('2.5 W')).toBe(-2.5);
    expect(parseEastWest('1,4E')).toBe(1.4);
    expect(parseEastWest('-3')).toBe(-3);
    expect(parseEastWest('11.8° W')).toBe(-11.8);
    expect(parseEastWest('-2 W')).toBeNull();
    expect(parseEastWest('north')).toBeNull();
  });
});

describe('the compass request', () => {
  const explorer = defaultState(Date.UTC(2026, 8, 24, 21, 40));
  const withDr = (w: Working): Working => ({
    ...w,
    session: { ...w.session, observer: { ...w.session.observer, assumed_position: { lat_deg: 39.9526, lon_deg: -75.1652 } } },
  });

  it('asks for the reading until there is one, then sends the documented request', () => {
    const w = defaultWorking();
    expect(compassRequest(w, explorer)).toEqual({ missing: 'Type what the compass read for the body.' });
    const r = compassRequest({ ...w, compass: { ...w.compass, bearingDeg: 272 } }, explorer);
    expect('request' in r).toBe(true);
    if (!('request' in r)) return;
    expect(r.request).toEqual({
      method: 'azimuth',
      body: 'Sun',
      utc: '2026-09-24T21:40:00Z',
      observer: { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 },
      compass_bearing_deg: 272,
      compass: 'magnetic',
    });
  });

  it('prefers the DR to the map’s place, and the form’s time to the time bar’s', () => {
    const w = withDr(defaultWorking());
    expect(compassPlace(w, explorer).source).toBe('dr');
    expect(compassPlace(defaultWorking(), explorer).source).toBe('place');
    expect(compassUtc({ ...w.compass, utc: '2026-09-25T06:00:00Z' }, explorer)).toEqual({ utc: '2026-09-25T06:00:00Z', fromForm: true });
  });

  it('sends the amplitude’s horizon, limb, event and the session’s dip and refraction inputs', () => {
    const base = withDr(defaultWorking());
    const w: Working = {
      ...base,
      session: { ...base.session, observer: { ...base.session.observer, height_of_eye_m: 10, pressure_hpa: 1000, temperature_c: 20 } },
      compass: { ...base.compass, method: 'amplitude', bearingDeg: 280, limb: 'lower', event: 'setting', variationDeg: -12, bearingSigmaDeg: 1, compass: 'magnetic' },
    };
    const r = compassRequest(w, explorer);
    if (!('request' in r)) throw new Error('expected a request');
    expect(r.request).toMatchObject({ method: 'amplitude', horizon: 'visible', event: 'setting', limb: 'lower', height_of_eye_m: 10, pressure_hpa: 1000, temperature_c: 20, variation_deg: -12, bearing_sigma_deg: 1 });
    const gyro = compassRequest({ ...w, compass: { ...w.compass, compass: 'gyro', horizon: 'celestial' } }, explorer);
    if (!('request' in gyro)) throw new Error('expected a request');
    expect(gyro.request.variation_deg).toBeUndefined();
    expect(gyro.request.height_of_eye_m).toBeUndefined();
  });

  it('works with the mock engine end to end (shapes, not numbers)', () => {
    const engine = new MockEngine();
    const r = compassRequest({ ...defaultWorking(), compass: { ...defaultWorking().compass, bearingDeg: 272 } }, explorer);
    if (!('request' in r)) throw new Error('expected a request');
    const out = engine.compassError(r.request);
    expect(out.body).toBe('Sun');
    expect(typeof out.sentence).toBe('string');
    expect(out.compass_error_deg).toBeCloseTo(out.true_bearing_deg - 272 - (out.true_bearing_deg - 272 > 180 ? 360 : 0), 6);
  });
});

const SESSION: Session = {
  schema: 'skyfix.session/1',
  meta: { name: 't', notes: '', kind: 'real' },
  observer: { height_of_eye_m: 3, pressure_hpa: 1010, temperature_c: 10, assumed_position: null, assumed_position_role: { role: 'initializer' } },
  instrument: { name: '', index_correction_arcmin: 0, horizon: 'sea' },
  clock: { uncertainty_s: 0, correction_s: 0 },
  observations: [],
};

describe('the error logs', () => {
  it('keeps entries in time order, one per instant, and removes an empty log from the session', () => {
    let s = withLogRow(SESSION, 'index', { utc: '2026-10-01T02:00:00Z', value: -2, note: '' }).session;
    s = withLogRow(s, 'index', { utc: '2026-10-01T00:00:00Z', value: -1, note: 'dusk' }).session;
    expect(logRows(s, 'index').map((r) => r.value)).toEqual([-1, -2]);
    expect(s.instrument.index_error_log).toEqual([
      { utc: '2026-10-01T00:00:00Z', ic_arcmin: -1, note: 'dusk' },
      { utc: '2026-10-01T02:00:00Z', ic_arcmin: -2, note: '' },
    ]);
    const replaced = withLogRow(s, 'index', { utc: '2026-10-01T02:00:00.000Z', value: -2.4, note: 'again' });
    expect(replaced.replaced).toBe(true);
    expect(logRows(replaced.session, 'index')).toHaveLength(2);
    expect(logSummary(replaced.session)).toBe('index-error log 2 entries');
    let w = withLogRow(SESSION, 'watch', { utc: '2026-09-30T12:00:00Z', value: 3, note: 'radio' }).session;
    expect(w.clock.watch_log).toEqual([{ utc: '2026-09-30T12:00:00Z', correction_s: 3, note: 'radio' }]);
    w = withoutLogRow(w, 'watch', '2026-09-30T12:00:00Z');
    expect('watch_log' in w.clock).toBe(false);
    expect(JSON.stringify(w)).toBe(JSON.stringify(SESSION));
  });

  it('refuses entries the core would refuse', () => {
    expect(checkLogRow('index', { utc: 'yesterday', value: 1, note: '' }).ok).toBe(false);
    expect(checkLogRow('index', { utc: '2026-10-01T00:00:00Z', value: 75, note: '' }).ok).toBe(false);
    expect(checkLogRow('watch', { utc: '2026-10-01T00:00:00Z', value: Number.NaN, note: '' }).ok).toBe(false);
    expect(checkLogRow('watch', { utc: '2026-10-01T00:00:00Z', value: 12.5, note: ' x ' })).toEqual({ ok: true, value: { utc: '2026-10-01T00:00:00Z', value: 12.5, note: 'x' } });
  });

  it('counts as the person’s own data, so autosave keeps it', () => {
    const w = defaultWorking();
    expect(hasOwnData(w)).toBe(false);
    const withLog = { ...w, session: withLogRow(w.session, 'watch', { utc: '2026-10-01T00:00:00Z', value: 2, note: '' }).session };
    expect(hasOwnData(withLog)).toBe(true);
    expect(hasOwnData({ ...w, compass: { ...w.compass, bearingDeg: 12 } })).toBe(true);
    expect(hasOwnData({ ...w, deviations: [entry(0, 1)] })).toBe(true);
  });
});

describe('the saved copy (autosave) of the new forms', () => {
  it('round-trips the compass form, the deviation table and the passage, and repairs nonsense', () => {
    const w = defaultWorking();
    const mine: Working = {
      ...w,
      compass: { ...w.compass, method: 'amplitude', body: 'Vega', bearingDeg: 359.5, variationDeg: -11.8, headingDeg: 90, event: 'rising' },
      deviations: [entry(90, -2.5)],
      passage: {
        ...w.passage,
        waypoints: [
          { id: 'a', name: 'Cape Henry', lat_deg: 36.93, lon_deg: -76.0, leg: 'great_circle' },
          { id: 'b', name: 'Bermuda', lat_deg: 32.38, lon_deg: -64.68, leg: 'rhumb' },
        ],
        speedKn: 6.5,
        departureUtc: '2026-10-01T12:00:00Z',
      },
    };
    const back = sanitizeWorking(JSON.parse(JSON.stringify(mine)))!;
    expect(back.compass).toEqual(mine.compass);
    expect(back.deviations).toEqual(mine.deviations);
    expect(back.passage).toEqual(mine.passage);
    const junk = sanitizeWorking({
      ...JSON.parse(JSON.stringify(mine)),
      compass: { method: 'sideways', bearingDeg: 400, variationDeg: 'x', bearingSigmaDeg: -1 },
      deviations: [{ headingDeg: 12 }, 'x', { headingDeg: 45, deviationDeg: -1 }],
      passage: { waypoints: [{ lat_deg: 95, lon_deg: 0 }, { lat_deg: 10, lon_deg: 20, leg: 'zigzag' }], speedKn: -3, tickHours: 999 },
    })!;
    expect(junk.compass.method).toBe('azimuth');
    expect(junk.compass.bearingDeg).toBeNull();
    expect(junk.compass.bearingSigmaDeg).toBeNull();
    expect(junk.deviations).toHaveLength(1);
    expect(junk.passage.waypoints).toEqual([{ id: 'wp-2', name: '', lat_deg: 10, lon_deg: 20, leg: 'great_circle' }]);
    expect(junk.passage.speedKn).toBeNull();
    expect(junk.passage.tickHours).toBe(48);
  });

  it('gives an old saved copy (before the Compass and Passage tabs) their defaults', () => {
    const old = JSON.parse(JSON.stringify(defaultWorking())) as Record<string, unknown>;
    delete old.compass;
    delete old.deviations;
    delete old.passage;
    const back = sanitizeWorking(old)!;
    expect(back.compass).toEqual(defaultWorking().compass);
    expect(back.deviations).toEqual([]);
    expect(back.passage).toEqual(defaultWorking().passage);
  });
});

describe('DUT1, automatic: what it means for these sights', () => {
  const info = (over: Partial<TimeInfo>): TimeInfo => ({
    jd_utc: 2461308,
    utc: '2026-09-24T12:00:00.000Z',
    scale: 'utc',
    tier: 'validated',
    delta_t_s: 69.2,
    delta_t_sigma_s: 0.001,
    delta_t_source: 'iers',
    tt_minus_clock_s: 69.184,
    dut1_s: -0.0147,
    dut1_sigma_s: 0.001,
    dut1_source: 'iers',
    calendar: 'gregorian',
    civil: { calendar: 'gregorian', year: 2026, month: 9, day: 24, hour: 12, minute: 0, second: 0, era_year: 2026, era: 'AD' },
    julian_civil: { calendar: 'julian', year: 2026, month: 9, day: 11, hour: 12, minute: 0, second: 0, era_year: 2026, era: 'AD' },
    notes: [],
    ...over,
  });

  it('names the source: the IERS history, a prediction, assumed zero, or UT itself', () => {
    expect(dut1Line(null, info({}), '24 Sep').text).toMatch(/−0\.015 s .*IERS history \(±0\.001 s\)/);
    expect(dut1Line(null, info({ dut1_sigma_s: 0.03 }), '24 Sep').text).toMatch(/Bulletin A’s prediction \(±0\.03 s, 0\.01′ of longitude\)/);
    const assumed = dut1Line(null, info({ dut1_source: 'assumed', dut1_s: 0, dut1_sigma_s: 0.9 }), '14 Dec 2027');
    expect(assumed.level).toBe('caution');
    expect(assumed.text).toMatch(/assumed 0 s ±0\.9 s.*±0\.23′ of longitude/);
    expect(dut1Line(null, info({ scale: 'ut', dut1_source: 'model', dut1_s: 0, dut1_sigma_s: 0 }), '2 Jan 2040').text).toMatch(/UT \(UT1\) itself/);
    expect(dut1Line(null, null, 'x').text).toMatch(/automatic/);
  });

  it('says a typed value is used, or ignored on the UT scale', () => {
    expect(dut1Line(-0.2, info({}), 'x')).toEqual({ level: 'note', text: expect.stringMatching(/UT1 = UTC − 0\.2 s/) as unknown as string });
    expect(dut1Line(0.1, info({ scale: 'ut', dut1_source: 'model' }), 'x').level).toBe('caution');
  });

  it('is read at the earliest sight, else the time bar', () => {
    const s: Session = {
      ...SESSION,
      observations: [
        { id: 'a', body: 'Vega', utc: '2026-10-01T03:00:00Z', altitude_deg: 40, altitude_kind: 'sextant_hs', sigma_arcmin: 1, limb: 'center', horizon: null, geocentric: null, notes: '' },
        { id: 'b', body: 'Vega', utc: '2026-10-01T01:00:00Z', altitude_deg: 60, altitude_kind: 'sextant_hs', sigma_arcmin: 1, limb: 'center', horizon: null, geocentric: null, notes: '' },
      ],
    };
    expect(dut1Instant(s, 0)).toEqual({ jd: 2461314.5416666665, from: 'sights' });
    expect(dut1Instant(SESSION, 123)).toEqual({ jd: 123, from: 'time bar' });
  });
});

describe('the shore horizon’s sentence (dip short of the horizon)', () => {
  it('uses Bowditch Table 14 inside the sea horizon and the sea dip beyond it', () => {
    // 100 ft (30.48 m) at 0.2 NM: Table 14 prints 282.3′.
    const near = shoreSentence(0.2, 30.48);
    expect(near.level).toBe('note');
    expect(near.dipArcmin).toBeCloseTo(282.3, 1);
    expect(near.text).toMatch(/282\.3\d′ instead of the sea dip 9\.7\d′/);
    // 5 ft (1.524 m): the sea horizon is 2.61 NM; a shore 5 NM off is hidden.
    const far = shoreSentence(5, 1.524);
    expect(far.level).toBe('caution');
    expect(far.dipArcmin).toBe(dipArcmin(1.524));
    expect(far.text).toMatch(/Beyond the sea horizon, which is 2\.61 NM away/);
    // Just inside the horizon the dip short never falls below the sea dip (the chain's rule).
    const edge = shoreSentence(2.6, 1.524);
    expect(edge.dipArcmin).toBe(Math.max(dipShortArcmin(1.524, 2.6), dipArcmin(1.524)));
  });
});

const PKG = resolve(__dirname, '../../src/wasm-pkg/skyfix_wasm.js');

describe.skipIf(!existsSync(PKG))('the Compass tab against the built core (npm run wasm)', () => {
  it('reproduces the documented Philadelphia bearing: compass error 14.4° W, variation 11.8° W, deviation 2.6° W', async ({ skip }) => {
    const mod = (await import(pathToFileURL(PKG).href)) as Record<string, unknown> & { initSync: (o: { module: Buffer }) => void };
    mod.initSync({ module: readFileSync(resolve(__dirname, '../../src/wasm-pkg/skyfix_wasm_bg.wasm')) });
    if (typeof mod.compass_error !== 'function') return skip(); // a package built before the geomag work (verify2: skipped, not a silent pass)
    const engine = new WasmEngine(mod as unknown as ExplorerWasmExports);
    const explorer = defaultState(Date.UTC(2026, 8, 24, 21, 40));
    explorer.observer.height_m = 12;
    const w = defaultWorking();
    const r = compassRequest({ ...w, compass: { ...w.compass, bearingDeg: 272 } }, explorer);
    if (!('request' in r)) throw new Error('expected a request');
    const out = engine.compassError(r.request);
    expect(out.true_bearing_deg).toBeCloseTo(257.552, 3);
    expect(out.compass_error_deg).toBeCloseTo(-14.448, 3);
    expect(out.variation?.deg).toBeCloseTo(-11.805, 3);
    expect(out.deviation_deg).toBeCloseTo(-2.642, 3);
    expect(out.sentence).toBe('Compass error 14.4° W; variation 11.8° W; deviation 2.6° W.');
    // Before 1900 there is no variation, only the reason.
    const mf = engine.magneticField(39.9526, -75.1652, 12, 2396758.5);
    expect(mf.available).toBe(false);
    if (!mf.available) expect(mf.reason).toMatch(/models start in 1900/);
  });
});
