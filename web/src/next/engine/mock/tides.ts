/**
 * MOCK tide predictions (tides agent) for developing the interface only: one synthetic
 * harmonic station, "Mock Harbor", with five constituents and no nodal corrections.
 * Every number is illustrative. The shapes, units, error codes and limits are the real
 * engine's (EXPLORER_API "Tides", `skyfix_wasm::tides`).
 */

import { isoUtc } from '../../time.js';
import {
  TIDE_LABEL,
  type TideCurve,
  type TideDatum,
  type TideEvent,
  type TideExtremes,
  type TideNow,
  type TidesEngine,
  type TidesPackInfo,
  type TideStation,
  type TideStationNear,
} from '../types.js';

const DEG = Math.PI / 180;

/** Constituents of the synthetic tide: amplitude m, speed deg/h, phase deg (about MSL). */
const TERMS: readonly (readonly [number, number, number])[] = [
  [0.75, 28.9841042, 30], // M2
  [0.13, 30.0, 60], // S2
  [0.17, 28.4397295, 10], // N2
  [0.1, 15.0410686, 200], // K1
  [0.08, 13.9430356, 180], // O1
];

/** Datum offsets from MSL, metres. */
const DATUMS: Readonly<Record<TideDatum, number>> = {
  HAT: 1.2,
  MHHW: 0.95,
  MHW: 0.85,
  MTL: 0.0,
  MSL: 0.0,
  MLW: -0.85,
  MLLW: -0.92,
  LAT: -1.2,
  NAVD88: 0.05,
};

export const MOCK_TIDE_STATION: TideStation = {
  id: 'MOCK001',
  name: 'Mock Harbor (synthetic)',
  state: null,
  lat_deg: 39.9,
  lon_deg: -75.13,
  kind: 'harmonic',
  reference_id: null,
  reference_name: null,
  tide_type: 'semidiurnal',
  form_number: 0.2045,
  datums: ['HAT', 'MHHW', 'MHW', 'MTL', 'MSL', 'MLW', 'MLLW', 'LAT', 'NAVD88'],
  default_datum: 'MLLW',
  curve: 'harmonic',
  flags: [],
  notes: ['Synthetic station of the mock engine: every number is illustrative.'],
};

const FIRST_JD = 2415020.5; // 1900-01-01
const END_JD = 2488434.5; // 2101-01-01
const EPOCH = 2451545.0;

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function height(jd: number): number {
  const tau = (jd - EPOCH) * 24;
  let h = 0;
  for (const [a, w, g] of TERMS) h += a * Math.cos((w * tau + g) * DEG);
  return h;
}

function rate(jd: number): number {
  const tau = (jd - EPOCH) * 24;
  let r = 0;
  for (const [a, w, g] of TERMS) r -= a * w * DEG * Math.sin((w * tau + g) * DEG);
  return r;
}

function checkJd(jd: number, what: string): void {
  if (!Number.isFinite(jd)) fail('bad_request', `${what} is not a number`);
  if (jd < FIRST_JD || jd >= END_JD) {
    fail('outside_range', `tide predictions are offered from 1900 to 2100; ${what} is ${isoUtc(jd)}`);
  }
}

function checkWindow(a: number, b: number): void {
  checkJd(a, 'jd_start');
  checkJd(b, 'jd_end');
  if (b < a) fail('bad_request', 'jd_end is before jd_start');
}

function resolveDatum(datum: string | undefined): TideDatum {
  const d = (datum ?? '').trim().toUpperCase();
  if (d === '') return 'MLLW';
  const name = (d === 'NAVD' ? 'NAVD88' : d) as TideDatum;
  if (!(name in DATUMS)) {
    fail('bad_request', `unknown datum ${JSON.stringify(datum)}; expected one of ${Object.keys(DATUMS).join(', ')}`);
  }
  return name;
}

function station(id: string): TideStation {
  if (id.trim().toUpperCase() !== MOCK_TIDE_STATION.id) {
    fail('unknown_station', `no tide station ${JSON.stringify(id.trim())} in the tides-us pack`);
  }
  return MOCK_TIDE_STATION;
}

function notes(d: TideDatum): string[] {
  return [`Heights above ${d} (mock engine: illustrative).`];
}

/** Extremes by the sign of the rate on a 6-minute grid, refined by bisection. */
function extremes(a: number, b: number, off: number): TideEvent[] {
  const step = 6 / 1440;
  const out: TideEvent[] = [];
  let t0 = a;
  let r0 = rate(t0);
  while (t0 < b) {
    const t1 = Math.min(t0 + step, b);
    const r1 = rate(t1);
    if ((r0 > 0 && r1 <= 0) || (r0 < 0 && r1 >= 0)) {
      let lo = t0;
      let hi = t1;
      for (let k = 0; k < 40; k += 1) {
        const mid = 0.5 * (lo + hi);
        if (rate(mid) > 0 === r0 > 0) lo = mid;
        else hi = mid;
      }
      const t = 0.5 * (lo + hi);
      out.push({ kind: r0 > 0 ? 'high' : 'low', jd_utc: t, utc: isoUtc(t), height_m: height(t) - off });
    }
    t0 = t1;
    r0 = r1;
  }
  return out;
}

export interface MockTidesOptions {
  /** Answer as if the tides-us pack were loaded (default true); false exercises `pack_not_loaded`. */
  loaded?: boolean;
}

/** The mock's tide engine: every method of `TidesEngine`. */
export class MockTides implements TidesEngine {
  private loaded: boolean;

  constructor(options: MockTidesOptions = {}) {
    this.loaded = options.loaded ?? true;
  }

  private need(): void {
    if (!this.loaded) {
      fail('pack_not_loaded', 'tide predictions need the tides-us pack (US stations, NOAA), which is not loaded');
    }
  }

  tideStationsNear(latDeg: number, lonDeg: number, n: number): TideStationNear[] {
    this.need();
    if (!(Number.isFinite(latDeg) && Math.abs(latDeg) <= 90)) fail('bad_request', `latitude ${latDeg} is outside -90..90`);
    if (!(Number.isFinite(lonDeg) && Math.abs(lonDeg) <= 360)) {
      fail('bad_request', `longitude ${lonDeg} is outside -360..360`);
    }
    void n; // one station: n (clamped to 1..100) cannot matter
    const s = MOCK_TIDE_STATION;
    const p1 = latDeg * DEG;
    const p2 = s.lat_deg * DEG;
    const dl = (s.lon_deg - lonDeg) * DEG;
    const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    const km = 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    const bearing = ((Math.atan2(y, x) / DEG) % 360 + 360) % 360;
    return [{ ...s, distance_km: km, distance_nm: km / 1.852, bearing_deg: bearing }];
  }

  tideStation(stationId: string): TideStation {
    this.need();
    return station(stationId);
  }

  tidePredict(stationId: string, jdStart: number, jdEnd: number, stepMin: number, datum: TideDatum | '' = ''): TideCurve {
    this.need();
    const s = station(stationId);
    checkWindow(jdStart, jdEnd);
    if (!(Number.isFinite(stepMin) && stepMin >= 0.5 && stepMin <= 1440)) {
      fail('bad_request', 'step_min must be between 0.5 and 1440 minutes');
    }
    const d = resolveDatum(datum);
    const step = stepMin / 1440;
    const n = Math.floor((jdEnd - jdStart) / step + 1e-9) + 1;
    if (n > 20_000) fail('bad_request', `${n} samples requested; at most 20000 per call`);
    const jd = new Float64Array(n);
    const h = new Float64Array(n);
    for (let k = 0; k < n; k += 1) {
      jd[k] = jdStart + k * step;
      h[k] = height(jd[k]!) - DATUMS[d];
    }
    return {
      station: s,
      datum: d,
      method: 'harmonic',
      jd_start: jdStart,
      jd_end: jdEnd,
      step_min: stepMin,
      jd_utc: jd,
      height_m: h,
      label: TIDE_LABEL,
      notes: notes(d),
    };
  }

  tideExtremes(stationId: string, jdStart: number, jdEnd: number, datum: TideDatum | '' = ''): TideExtremes {
    this.need();
    const s = station(stationId);
    checkWindow(jdStart, jdEnd);
    if (jdEnd - jdStart > 400) fail('bad_request', 'at most 400 days of high and low water per call');
    const d = resolveDatum(datum);
    return {
      station: s,
      datum: d,
      method: 'harmonic',
      jd_start: jdStart,
      jd_end: jdEnd,
      extremes: extremes(jdStart, jdEnd, DATUMS[d]),
      label: TIDE_LABEL,
      notes: notes(d),
    };
  }

  tideNow(stationId: string, jdUtc: number, datum: TideDatum | '' = ''): TideNow {
    this.need();
    const s = station(stationId);
    checkJd(jdUtc, 'jd_utc');
    const d = resolveDatum(datum);
    const around = extremes(jdUtc - 1.5, jdUtc + 3, DATUMS[d]);
    const after = around.filter((e) => e.jd_utc > jdUtc);
    const before = around.filter((e) => e.jd_utc <= jdUtc);
    const r = rate(jdUtc);
    const next = after[0] ?? null;
    return {
      station: s,
      datum: d,
      method: 'harmonic',
      jd_utc: jdUtc,
      utc: isoUtc(jdUtc),
      height_m: height(jdUtc) - DATUMS[d],
      rate_m_per_h: r,
      state: r > 0 || (r === 0 && next?.kind === 'high') ? 'rising' : 'falling',
      previous: before.at(-1) ?? null,
      next,
      next_high: after.find((e) => e.kind === 'high') ?? null,
      next_low: after.find((e) => e.kind === 'low') ?? null,
      label: TIDE_LABEL,
      notes: notes(d),
    };
  }

  tidePackInfo(): TidesPackInfo | null {
    if (!this.loaded) return null;
    return {
      name: 'tides-us',
      version: 'mock',
      bytes: 0,
      provides: ['tides:us-noaa'],
      stations: 1,
      harmonic: 1,
      subordinate: 0,
    };
  }

  /** Accepts any bytes, as the mock's `loadPack` does. */
  loadTidesPack(bytes: Uint8Array): TidesPackInfo {
    void bytes;
    this.loaded = true;
    return this.tidePackInfo()!;
  }
}
