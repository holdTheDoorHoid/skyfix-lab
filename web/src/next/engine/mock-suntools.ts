/**
 * MOCK SUN TOOLS — for developing the interface only (`?engine=mock`, or a development
 * server with no complete WebAssembly build). Never a source of results (EXPLORER_PLAN
 * section 3.1): every number is illustrative, and the page says so while the mock runs.
 * OWNER: suntools agent (expansion programme P7).
 *
 * It implements `SunToolsEngine` (types.ts; wire format EXPLORER_API.md "Expansion
 * programme — sun tools") with the contract's shapes, ranges and failure modes, on top
 * of any `ExplorerEngine`'s public calls (`skyState`, `dayEvents`, `findAltitude`,
 * `sampleBodies`, `seasons`): the mock explorer's low-precision astronomy, a 10-minute
 * grid refined by bisection (the core refines to a millisecond), the galactic centre
 * precessed without nutation or aberration, and the solar year sampled every half hour
 * (the core every ten minutes). The definitions are CONVENTIONS 13.10's; only the
 * precision differs.
 */

import { isoUtc, jdFromMs, utcMs } from '../time.js';
import * as A from './mock/astro.js';
import { crossings, grid, sample } from './mock/roots.js';
import type {
  AlignmentKind,
  AlignmentMatch,
  AlignmentRequest,
  AlignmentResult,
  AltitudeCrossing,
  Analemma,
  AnalemmaPoint,
  AnalemmaRequest,
  AzimuthAltitudeBand,
  AzimuthCrossing,
  BodyState,
  EotExtreme,
  EotPoint,
  EquationOfTime,
  ExplorerEngine,
  GalacticCentreWindows,
  GalacticMoment,
  GalacticOptions,
  GalacticWindow,
  Observer,
  RiseSetAzimuthRequest,
  RiseSetAzimuths,
  RiseSetDay,
  RiseSetEventRef,
  SkyEvent,
  SolarDay,
  SolarModel,
  SolarPanel,
  SolarPanelUsed,
  SolarSample,
  SolarYear,
  SolarYearRequest,
  SunHourBoundary,
  SunHours,
  SunLightKind,
  SunLightPeriod,
  SunLightWindow,
  SunPath,
  SunPathDay,
  SunPathDayKind,
  SunToolsEngine,
} from './types.js';

const SEC = 1 / 86_400;
const GRID_DAYS = 10 / 1440;
const MAX_WINDOW_DAYS = 400;
const THRESHOLDS = [-6, -4, 6] as const;
const SGR_A = { ra: (17 + 45 / 60 + 40.04 / 3600) * 15, dec: -(29 + 28.1 / 3600) };
const NGP = { ra: (12 + 51 / 60 + 26.28 / 3600) * 15, dec: 27 + 7 / 60 + 42 / 3600 };

export const MOCK_SOLAR_MODEL: SolarModel = {
  label: 'clear-sky estimate',
  clear_sky:
    'MOCK: Haurwitz (1945) GHI = 1098 cos z exp(-0.057 / cos z) W/m2 on the mock engine\'s low-precision Sun',
  diffuse_split: 'MOCK: Meinel & Meinel (1976) beam, DNI = E0 0.7^(AM^0.678); diffuse the remainder',
  transposition: 'MOCK: isotropic sky with ground reflection',
  typical_error: 'MOCK: illustrative numbers; the real engine states the model\'s error (about 7 %)',
  not_modelled: 'clouds, haze, snow, shading, soiling, temperature and inverter losses',
};

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${what}: expected a finite number, got ${String(value)}`);
  }
  return value;
}

function checkWindow(jdStart: number, jdEnd: number, maxDays = MAX_WINDOW_DAYS): [number, number] {
  const a = finite(jdStart, 'jd_start');
  const b = finite(jdEnd, 'jd_end');
  if (!(b > a)) throw new Error(`the window must end after it starts: jd_start ${a}, jd_end ${b}`);
  if (b - a > maxDays) throw new Error(`the window is ${(b - a).toFixed(1)} days long; at most ${maxDays} days`);
  return [a, b];
}

function checkYear(year: number): number {
  if (!Number.isInteger(year) || year < -4000 || year > 10_000) {
    throw new Error(`year must be a whole number within -4000 .. 10000, got ${String(year)}`);
  }
  return year;
}

function offsetHours(observer: Observer, utcOffsetHours: number | null | undefined): number {
  if (utcOffsetHours === undefined || utcOffsetHours === null) return observer.lon_deg / 15;
  const h = finite(utcOffsetHours, 'utc_offset_hours');
  if (Math.abs(h) > 15) throw new Error(`utc_offset_hours must be between -15 and 15, got ${h}`);
  return h;
}

function localDate(jd: number, offsetH: number): string {
  return isoUtc(jd + offsetH / 24).slice(0, 10);
}

function yearStart(year: number): number {
  return jdFromMs(utcMs(year, 1, 1));
}

function bearing(value: number): number {
  const b = finite(value, 'azimuth_deg');
  if (b < -360 || b > 720) throw new Error(`azimuth_deg must be a bearing in degrees, got ${b}`);
  return b;
}

/** Haurwitz GHI, Meinel DNI and the diffuse remainder (CONVENTIONS 13.10). */
function clearSky(apparentZenithDeg: number, distanceAu: number): { ghi: number; dni: number; dhi: number } {
  const cz = Math.cos(apparentZenithDeg * A.D2R);
  if (cz <= 0) return { ghi: 0, dni: 0, dhi: 0 };
  const ghi = 1098 * cz * Math.exp(-0.057 / cz);
  const e0 = 1361 / (distanceAu * distanceAu);
  const dni = Math.min(e0 * 0.7 ** ((1 / cz) ** 0.678), ghi / cz);
  return { ghi, dni, dhi: Math.max(ghi - dni * cz, 0) };
}

function planeOfArray(
  cs: { ghi: number; dni: number; dhi: number },
  zenithDeg: number,
  sunAzDeg: number,
  panel: SolarPanelUsed,
): { total: number; incidence: number } {
  const z = zenithDeg * A.D2R;
  const b = panel.tilt_deg * A.D2R;
  const cosT = Math.max(
    -1,
    Math.min(1, Math.cos(z) * Math.cos(b) + Math.sin(z) * Math.sin(b) * Math.cos((sunAzDeg - panel.azimuth_deg) * A.D2R)),
  );
  const total =
    cs.dni * Math.max(cosT, 0) + (cs.dhi * (1 + Math.cos(b))) / 2 + (cs.ghi * panel.albedo * (1 - Math.cos(b))) / 2;
  return { total, incidence: Math.acos(cosT) * A.R2D };
}

function resolvePanel(panel: SolarPanel | undefined, observer: Observer): SolarPanelUsed {
  const tilt = panel?.tilt_deg ?? 0;
  if (!Number.isFinite(tilt) || tilt < 0 || tilt > 90) throw new Error(`tilt_deg must be between 0 and 90, got ${tilt}`);
  const az = panel?.azimuth_deg ?? (observer.lat_deg >= 0 ? 180 : 0);
  const albedo = panel?.albedo ?? 0.2;
  if (!Number.isFinite(albedo) || albedo < 0 || albedo > 1) throw new Error(`albedo must be between 0 and 1, got ${albedo}`);
  return { tilt_deg: tilt, azimuth_deg: A.norm360(bearing(az)), albedo };
}

/** Mock sun tools over any explorer engine's public calls. */
export function createMockSunTools(engine: ExplorerEngine): SunToolsEngine {
  function body(observer: Observer, t: number, name: string): BodyState {
    const s = engine.skyState(observer, t, [name]);
    const b = s.bodies[0];
    if (!b) throw new Error(`${name}: ${s.errors[0]?.message ?? 'cannot be computed'}`);
    return b;
  }

  /** Geometric crossings of a threshold by a body, on a 10-minute grid. */
  function geometricCrossings(observer: Observer, name: string, a: number, b: number, h: number): AltitudeCrossing[] {
    const f = (t: number): number => body(observer, t, name).alt_deg - h;
    const times = grid(a, b, GRID_DAYS);
    return crossings(f, times, sample(f, times)).map((c) => {
      const s = body(observer, c.t, name);
      return { jd_utc: c.t, utc: isoUtc(c.t), alt_deg: s.alt_deg, az_deg: s.az_deg, rising: c.rising };
    });
  }

  function sunHours(observer: Observer, jdStart: number, jdEnd: number): SunHours {
    const [a, b] = checkWindow(jdStart, jdEnd);
    const de = engine.dayEvents(observer, a, b, ['Sun']);
    const sun = de.bodies[0];
    if (!sun) throw new Error(`sun_hours: ${de.errors[0]?.message ?? 'the Sun cannot be computed'}`);
    const startAlt = body(observer, a, 'Sun').alt_deg;
    const boundaries: SunHourBoundary[] = THRESHOLDS.map((h) => {
      const c = geometricCrossings(observer, 'Sun', a, b, h);
      return { altitude_deg: h, crossings: c, always_above: c.length === 0 && startAlt > h, always_below: c.length === 0 && startAlt <= h };
    });
    const cuts = [...new Set(boundaries.flatMap((x) => x.crossings.map((c) => c.jd_utc)))].sort((p, q) => p - q);
    const bounds = [a, ...cuts.filter((t) => t > a && t < b), b];
    const band = (alt: number): number => THRESHOLDS.filter((h) => alt > h).length;
    const spans: { start: number; end: number; band: number }[] = [];
    for (let k = 0; k + 1 < bounds.length; k += 1) {
      const s = bounds[k]!;
      const e = bounds[k + 1]!;
      const bd = band(body(observer, 0.5 * (s + e), 'Sun').alt_deg);
      const last = spans[spans.length - 1];
      if (last && last.band === bd) last.end = e;
      else spans.push({ start: s, end: e, band: bd });
    }
    const transits = sun.events.filter((e) => e.kind === 'transit' || e.kind === 'lower_transit');
    const risingAt = (t: number): boolean | undefined =>
      boundaries.flatMap((x) => x.crossings).find((c) => Math.abs(c.jd_utc - t) < 1e-9)?.rising;
    const windows: SunLightWindow[] = [];
    for (const s of spans) {
      const kind: SunLightKind | null = s.band === 1 ? 'blue' : s.band === 2 ? 'golden' : null;
      if (!kind) continue;
      const openStart = s.start <= a;
      const openEnd = s.end >= b;
      const inside = (k: SkyEvent['kind']): boolean => transits.some((e) => e.kind === k && e.jd_utc > s.start && e.jd_utc < s.end);
      let period: SunLightPeriod;
      if (openStart && openEnd) period = 'all_day';
      else if (inside('transit')) period = 'midday';
      else if (inside('lower_transit')) period = 'midnight';
      else period = (openEnd ? risingAt(s.start) : risingAt(s.end)) === false ? 'evening' : 'morning';
      windows.push({
        kind,
        period,
        jd_start: s.start,
        utc_start: isoUtc(s.start),
        jd_end: s.end,
        utc_end: isoUtc(s.end),
        duration_min: (s.end - s.start) * 1440,
        open_start: openStart,
        open_end: openEnd,
      });
    }
    return { jd_start: a, jd_end: b, windows, boundaries, sun, phases: de.phases };
  }

  function findAzimuth(
    observer: Observer,
    name: string,
    jdStart: number,
    jdEnd: number,
    azimuthDeg: number,
    band: AzimuthAltitudeBand = {},
  ): AzimuthCrossing[] {
    const [a, b] = checkWindow(jdStart, jdEnd);
    const target = bearing(azimuthDeg);
    const lo = band.min_deg ?? null;
    const hi = band.max_deg ?? null;
    for (const v of [lo, hi]) {
      if (v !== null && (!Number.isFinite(v) || v < -90 || v > 90)) throw new Error(`altitude band limits must be between -90 and 90, got ${v}`);
    }
    if (lo !== null && hi !== null && lo > hi) throw new Error(`altitude band min_deg ${lo} is above max_deg ${hi}`);
    const d = (t: number): number => A.wrap180(body(observer, t, name).az_deg - target);
    const times = grid(a, b, GRID_DAYS);
    const out: AzimuthCrossing[] = [];
    for (const c of crossings(d, times, sample(d, times), { maxJump: 90 })) {
      const s = body(observer, c.t, name);
      const low = lo !== null ? s.alt_apparent_deg >= lo : s.alt_apparent_deg + s.semidiameter_arcmin / 60 > 0;
      if (!low || (hi !== null && s.alt_apparent_deg > hi)) continue;
      const rising = body(observer, c.t + 60 * SEC, name).alt_deg > body(observer, c.t - 60 * SEC, name).alt_deg;
      out.push({
        jd_utc: c.t,
        utc: isoUtc(c.t),
        az_deg: s.az_deg,
        alt_deg: s.alt_deg,
        alt_apparent_deg: s.alt_apparent_deg,
        rising,
        clockwise: c.rising,
      });
    }
    return out;
  }

  function alignmentDays(observer: Observer, request: AlignmentRequest): AlignmentResult {
    const name = request.body ?? 'Sun';
    const target = bearing(request.azimuth_deg);
    const tol = request.tolerance_deg ?? 0.5;
    if (!Number.isFinite(tol) || tol <= 0 || tol > 90) throw new Error(`tolerance_deg must be above 0 and at most 90, got ${tol}`);
    const year = checkYear(request.year);
    const off = offsetHours(observer, request.utc_offset_hours);
    const a = yearStart(year) - off / 24;
    const b = yearStart(year + 1) - off / 24;
    const events: { kind: AlignmentKind; jd: number; az: number; alt: number }[] = [];
    const ev = request.event;
    if (ev.kind === 'rise' || ev.kind === 'set') {
      const de = engine.dayEvents(observer, a, b, [name], request.options ?? undefined);
      if (de.errors.length) throw new Error(`alignment_days: ${de.errors[0]!.message}`);
      for (const e of de.bodies[0]?.events ?? []) {
        if (e.kind === ev.kind) events.push({ kind: ev.kind, jd: e.jd_utc, az: e.az_deg, alt: e.alt_deg });
      }
    } else if (ev.kind === 'at_altitude') {
      for (const c of engine.findAltitude(observer, name, a, b, finite(ev.altitude_deg, 'altitude_deg'))) {
        events.push({ kind: c.rising ? 'rising' : 'setting', jd: c.jd_utc, az: c.az_deg, alt: c.alt_deg });
      }
    } else {
      throw new Error(`event: unknown kind ${String((ev as { kind?: unknown }).kind)}`);
    }
    const toMatch = (e: (typeof events)[number]): AlignmentMatch => ({
      date: localDate(e.jd, off),
      kind: e.kind,
      jd_utc: e.jd,
      utc: isoUtc(e.jd),
      az_deg: e.az,
      offset_deg: A.wrap180(e.az - target),
      alt_deg: e.alt,
      best: false,
    });
    let closest: AlignmentMatch | null = null;
    for (const e of events) {
      const m = toMatch(e);
      if (!closest || Math.abs(m.offset_deg) < Math.abs(closest.offset_deg)) closest = m;
    }
    const matches = events.map(toMatch).filter((m) => Math.abs(m.offset_deg) <= tol);
    // The closest day of each run of matches of one kind less than 1.5 days apart.
    let run: AlignmentMatch[] = [];
    const flush = (): void => {
      const best = run.reduce<AlignmentMatch | null>((p, m) => (!p || Math.abs(m.offset_deg) < Math.abs(p.offset_deg) ? m : p), null);
      if (best) best.best = true;
      run = [];
    };
    for (const m of matches) {
      const last = run[run.length - 1];
      if (last && (m.kind !== last.kind || m.jd_utc - last.jd_utc >= 1.5)) flush();
      run.push(m);
    }
    flush();
    return {
      body: name,
      year,
      azimuth_deg: target,
      tolerance_deg: tol,
      event: ev,
      utc_offset_hours: off,
      jd_start: a,
      jd_end: b,
      truncated: false,
      events_considered: events.length,
      matches,
      closest,
    };
  }

  function eotOf(jd: number, sunGhaDeg: number): number {
    const day0 = Math.floor(jd - 0.5) + 0.5;
    return A.wrap180(sunGhaDeg - 15 * ((jd - day0) * 24 - 12)) * 240;
  }

  function analemma(observer: Observer, request: AnalemmaRequest): Analemma {
    const year = checkYear(request.year);
    const t = finite(request.time_h, 'time_h');
    if (t < 0 || t >= 24) throw new Error(`time_h must be in [0, 24), got ${t}`);
    let off: number;
    if (request.clock === 'lmt') {
      if (request.utc_offset_hours !== undefined && request.utc_offset_hours !== null) {
        throw new Error('clock lmt takes its offset from the longitude; give utc_offset_hours only with clock zone');
      }
      off = observer.lon_deg / 15;
    } else if (request.clock === 'zone') {
      if (request.utc_offset_hours === undefined || request.utc_offset_hours === null) {
        throw new Error('clock zone needs utc_offset_hours (e.g. -5 for UTC-5)');
      }
      off = offsetHours(observer, request.utc_offset_hours);
    } else {
      throw new Error(`clock must be "lmt" or "zone", got ${String(request.clock)}`);
    }
    const d0 = yearStart(year);
    const days = Math.round(yearStart(year + 1) - d0);
    const points: AnalemmaPoint[] = [];
    for (let k = 0; k < days; k += 1) {
      const jd = d0 + k + (t - off) / 24;
      const s = body(observer, jd, 'Sun');
      points.push({
        date: localDate(jd, off),
        jd_utc: jd,
        utc: isoUtc(jd),
        alt_deg: s.alt_deg,
        alt_apparent_deg: s.alt_apparent_deg,
        az_deg: s.az_deg,
        dec_deg: s.dec_deg,
        eot_s: eotOf(jd, s.gha_deg),
      });
    }
    return { year, time_h: t, clock: request.clock, utc_offset_hours: off, points, errors: [] };
  }

  function sunPath(observer: Observer, jdStart: number, jdEnd: number, stepMinutes = 10): SunPath {
    const [a, b] = checkWindow(jdStart, jdEnd, 2);
    const step = finite(stepMinutes, 'step_minutes');
    if (step < 1 || step > 60) throw new Error(`step_minutes must be between 1 and 60, got ${step}`);
    const path = (day: SunPathDayKind, s: number, e: number, season: number | null): SunPathDay => {
      const sm = engine.sampleBodies(observer, ['Sun'], s, e, step);
      const sun = sm.bodies[0];
      if (!sun) throw new Error(`sun_path: ${sm.errors[0]?.message ?? 'the Sun cannot be computed'}`);
      return {
        day,
        jd_start: s,
        jd_end: e,
        season_jd_utc: season,
        points: Array.from(sm.jd_utc, (t, k) => ({
          jd_utc: t,
          alt_deg: sun.alt_deg[k]!,
          alt_apparent_deg: sun.alt_apparent_deg[k]!,
          az_deg: sun.az_deg[k]!,
        })),
      };
    };
    const mid = 0.5 * (a + b);
    const year = Number(isoUtc(mid).slice(0, 4));
    const envelope: SunPathDay[] = [];
    const errors: { body: string; message: string }[] = [];
    try {
      for (const s of engine.seasons(year)) {
        const n = b - a <= 1 ? Math.floor(s.jd_utc - a) : Math.round(s.jd_utc - mid);
        try {
          envelope.push(path(s.kind, a + n, b + n, s.jd_utc));
        } catch (error) {
          errors.push({ body: 'Sun', message: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      errors.push({ body: 'Sun', message: `no envelope: ${error instanceof Error ? error.message : String(error)}` });
    }
    return { step_minutes: step, path: path('day', a, b, null), envelope, errors };
  }

  function riseSetAzimuths(observer: Observer, request: RiseSetAzimuthRequest): RiseSetAzimuths {
    const name = request.body ?? 'Sun';
    const year = checkYear(request.year);
    const off = offsetHours(observer, request.utc_offset_hours);
    const a = yearStart(year) - off / 24;
    const b = yearStart(year + 1) - off / 24;
    const de = engine.dayEvents(observer, a, b, [name], request.options ?? undefined);
    if (de.errors.length) throw new Error(`rise_set_azimuths: ${de.errors[0]!.message}`);
    const events = de.bodies[0]?.events ?? [];
    const days: RiseSetDay[] = [];
    for (let s = a; s < b - 0.5; s += 1) {
      const e = s + 1;
      const ref = (k: SkyEvent['kind']): RiseSetEventRef[] =>
        events
          .filter((x) => x.kind === k && x.jd_utc >= s && x.jd_utc < e)
          .map((x) => ({ jd_utc: x.jd_utc, utc: x.utc, az_deg: x.az_deg, alt_deg: x.alt_deg }));
      const rises = ref('rise');
      const sets = ref('set');
      let above = false;
      let below = false;
      if (rises.length === 0 && sets.length === 0) {
        const st = body(observer, s + 0.5, name);
        above = st.above_horizon;
        below = !above;
      }
      days.push({ date: localDate(s + 0.5, off), jd_start: s, jd_end: e, rises, sets, transit: ref('transit')[0] ?? null, always_above: above, always_below: below });
    }
    return { body: name, year, utc_offset_hours: off, jd_start: a, jd_end: b, truncated: false, days };
  }

  function equationOfTime(year: number, utcHour = 12): EquationOfTime {
    checkYear(year);
    const h = finite(utcHour, 'utc_hour');
    if (h < 0 || h >= 24) throw new Error(`utc_hour must be in [0, 24), got ${h}`);
    const d0 = yearStart(year);
    const days = Math.round(yearStart(year + 1) - d0);
    const greenwich: Observer = { lat_deg: 0, lon_deg: 0 };
    const points: EotPoint[] = [];
    for (let k = 0; k < days; k += 1) {
      const jd = d0 + k + h / 24;
      const s = body(greenwich, jd, 'Sun');
      points.push({ date: localDate(d0 + k + 0.5, 0), jd_utc: jd, utc: isoUtc(jd), eot_s: eotOf(jd, s.gha_deg), dec_deg: s.dec_deg });
    }
    const extremes: EotExtreme[] = [];
    for (let k = 1; k + 1 < points.length; k += 1) {
      const [p, q, r] = [points[k - 1]!.eot_s, points[k]!.eot_s, points[k + 1]!.eot_s];
      const kind = q > p && q >= r ? 'maximum' : q < p && q <= r ? 'minimum' : null;
      if (kind) extremes.push({ kind, date: points[k]!.date, jd_utc: points[k]!.jd_utc, eot_s: q });
    }
    return { year, utc_hour: h, points, extremes, errors: [] };
  }

  function solarDay(observer: Observer, jdStart: number, jdEnd: number, panel?: SolarPanel, stepMinutes = 10): SolarDay {
    const [a, b] = checkWindow(jdStart, jdEnd, 2);
    const step = finite(stepMinutes, 'step_minutes');
    if (step < 1 || step > 60) throw new Error(`step_minutes must be between 1 and 60, got ${step}`);
    const used = resolvePanel(panel, observer);
    const samples: SolarSample[] = [];
    const n = Math.floor((b - a) / (step / 1440) + 1e-9);
    for (let k = 0; k <= n; k += 1) {
      const t = a + (k * step) / 1440;
      const s = body(observer, t, 'Sun');
      const z = 90 - s.alt_apparent_deg;
      const cs = clearSky(z, (s.distance_km ?? A.AU_KM) / A.AU_KM);
      const up = s.alt_apparent_deg > 0;
      const poa = planeOfArray(cs, z, s.az_deg, used);
      samples.push({
        jd_utc: t,
        sun_alt_apparent_deg: s.alt_apparent_deg,
        sun_az_deg: s.az_deg,
        ghi_w_m2: cs.ghi,
        dni_w_m2: cs.dni,
        dhi_w_m2: cs.dhi,
        poa_w_m2: up ? poa.total : 0,
        incidence_deg: up ? poa.incidence : null,
      });
    }
    const kwh = (f: (s: SolarSample) => number): number =>
      samples.slice(1).reduce((sum, s, k) => sum + 0.5 * (f(samples[k]!) + f(s)) * (s.jd_utc - samples[k]!.jd_utc) * 24, 0) / 1000;
    return {
      jd_start: a,
      jd_end: b,
      step_minutes: step,
      panel: used,
      samples,
      poa_kwh_m2: kwh((s) => s.poa_w_m2),
      ghi_kwh_m2: kwh((s) => s.ghi_w_m2),
      dni_kwh_m2: kwh((s) => s.dni_w_m2),
      peak_poa_w_m2: Math.max(0, ...samples.map((s) => s.poa_w_m2)),
      model: MOCK_SOLAR_MODEL,
    };
  }

  function solarYear(observer: Observer, request: SolarYearRequest): SolarYear {
    const year = checkYear(request.year);
    const used = resolvePanel(request.panel, observer);
    const stepMinutes = request.step_minutes ?? 10;
    if (!Number.isFinite(stepMinutes) || stepMinutes < 1 || stepMinutes > 60) {
      throw new Error(`step_minutes must be between 1 and 60, got ${stepMinutes}`);
    }
    const off = offsetHours(observer, request.utc_offset_hours);
    const a = yearStart(year) - off / 24;
    const b = yearStart(year + 1) - off / 24;
    const mockStepH = 0.5; // coarser than the core, for speed
    const lit: { day: number; z: number; az: number; cs: ReturnType<typeof clearSky> }[] = [];
    const days: SolarYear['days'] = [];
    for (let d = 0; a + d < b - 0.5; d += 1) {
      const d0 = a + d;
      let ghi = 0;
      for (let h = mockStepH / 2; h < 24; h += mockStepH) {
        const s = body(observer, d0 + h / 24, 'Sun');
        if (s.alt_apparent_deg <= 0) continue;
        const z = 90 - s.alt_apparent_deg;
        const cs = clearSky(z, (s.distance_km ?? A.AU_KM) / A.AU_KM);
        ghi += cs.ghi * mockStepH;
        lit.push({ day: d, z, az: s.az_deg, cs });
      }
      days.push({ date: localDate(d0 + 0.5, off), jd_start: d0, poa_kwh_m2: 0, ghi_kwh_m2: ghi / 1000 });
    }
    const annual = (tilt: number): number =>
      lit.reduce((sum, l) => sum + planeOfArray(l.cs, l.z, l.az, { ...used, tilt_deg: tilt }).total, 0) * (mockStepH / 1000);
    for (const l of lit) days[l.day]!.poa_kwh_m2 += (planeOfArray(l.cs, l.z, l.az, used).total * mockStepH) / 1000;
    const months: SolarYear['months'] = [];
    for (const d of days) {
      const month = Number(d.date.slice(5, 7));
      const m = months[months.length - 1];
      if (m && m.month === month) {
        m.days += 1;
        m.poa_kwh_m2 += d.poa_kwh_m2;
        m.ghi_kwh_m2 += d.ghi_kwh_m2;
      } else {
        months.push({ month, days: 1, poa_kwh_m2: d.poa_kwh_m2, ghi_kwh_m2: d.ghi_kwh_m2 });
      }
    }
    let optimal: SolarYear['optimal'] = null;
    if (request.optimise_tilt) {
      // Golden section on [0, 90].
      let lo = 0;
      let hi = 90;
      const g = (Math.sqrt(5) - 1) / 2;
      let x1 = hi - g * (hi - lo);
      let x2 = lo + g * (hi - lo);
      let f1 = annual(x1);
      let f2 = annual(x2);
      while (hi - lo > 0.1) {
        if (f1 > f2) {
          hi = x2;
          x2 = x1;
          f2 = f1;
          x1 = hi - g * (hi - lo);
          f1 = annual(x1);
        } else {
          lo = x1;
          x1 = x2;
          f1 = f2;
          x2 = lo + g * (hi - lo);
          f2 = annual(x2);
        }
      }
      const tilt = 0.5 * (lo + hi);
      optimal = { tilt_deg: tilt, azimuth_deg: used.azimuth_deg, poa_kwh_m2: annual(tilt) };
    }
    return {
      year,
      utc_offset_hours: off,
      step_minutes: stepMinutes,
      panel: used,
      jd_start: a,
      jd_end: b,
      truncated: false,
      days,
      months,
      poa_kwh_m2: days.reduce((s, d) => s + d.poa_kwh_m2, 0),
      ghi_kwh_m2: days.reduce((s, d) => s + d.ghi_kwh_m2, 0),
      optimal,
      model: MOCK_SOLAR_MODEL,
    };
  }

  function fixedHorizontal(observer: Observer, raJ2000: number, decJ2000: number, t: number): { alt: number; az: number } {
    const p = A.applyMat(A.precessionMatrix(A.centuriesTT(t)), A.unitVector(raJ2000, decJ2000));
    const { ra_deg, dec_deg } = A.vecToRaDec(p);
    const site = A.makeSite(observer.lat_deg, observer.lon_deg, observer.height_m ?? 0);
    const h = A.horizontal(A.gmstDeg(t) + observer.lon_deg - ra_deg, dec_deg, site);
    return { alt: h.alt_deg, az: h.az_deg };
  }

  function moment(observer: Observer, t: number): GalacticMoment {
    const c = fixedHorizontal(observer, SGR_A.ra, SGR_A.dec, t);
    const p = fixedHorizontal(observer, NGP.ra, NGP.dec, t);
    const [h, az] = p.alt >= 0 ? [p.alt, p.az] : [-p.alt, A.norm360(p.az + 180)];
    const e1 = A.norm360(az - 90);
    const e2 = A.norm360(az + 90);
    return {
      jd_utc: t,
      utc: isoUtc(t),
      alt_deg: c.alt,
      alt_apparent_deg: c.alt + A.refractionArcmin(c.alt, observer.pressure_hpa, observer.temperature_c) / 60,
      az_deg: c.az,
      arch_top_alt_deg: 90 - h,
      arch_top_az_deg: A.norm360(az + 180),
      arch_ends_az_deg: [Math.min(e1, e2), Math.max(e1, e2)],
    };
  }

  function galacticCentreWindows(observer: Observer, jdStart: number, jdEnd: number, options: GalacticOptions = {}): GalacticCentreWindows {
    const [a, b] = checkWindow(jdStart, jdEnd);
    const minAlt = options.min_altitude_deg ?? 10;
    const sunMax = options.sun_max_altitude_deg ?? -18;
    if (!Number.isFinite(minAlt) || minAlt < -5 || minAlt > 89) throw new Error(`min_altitude_deg must be between -5 and 89, got ${minAlt}`);
    if (!Number.isFinite(sunMax) || sunMax < -30 || sunMax > 0) throw new Error(`sun_max_altitude_deg must be between -30 and 0, got ${sunMax}`);
    const windows: GalacticWindow[] = [];
    let open: { start: number; moonUp: boolean; best: GalacticMoment } | null = null;
    const close = (end: number): void => {
      if (!open) return;
      const mid = 0.5 * (open.start + end);
      windows.push({
        jd_start: open.start,
        utc_start: isoUtc(open.start),
        jd_end: end,
        utc_end: isoUtc(end),
        duration_h: (end - open.start) * 24,
        moon_up: open.moonUp,
        moon_illuminated_fraction: body(observer, mid, 'Moon').illuminated_fraction ?? 0,
        best: open.best,
      });
      open = null;
    };
    for (const t of grid(a, b, GRID_DAYS)) {
      const m = moment(observer, t);
      const dark = body(observer, t, 'Sun').alt_deg <= sunMax && m.alt_apparent_deg >= minAlt;
      const moonUp = dark ? body(observer, t, 'Moon').above_horizon : false;
      if (open && (!dark || moonUp !== open.moonUp)) close(t);
      if (dark && !open) open = { start: t, moonUp, best: m };
      if (open && m.alt_apparent_deg > open.best.alt_apparent_deg) open.best = m;
    }
    close(b);
    return {
      jd_start: a,
      jd_end: b,
      min_altitude_deg: minAlt,
      sun_max_altitude_deg: sunMax,
      galactic_centre: { ra_j2000_deg: SGR_A.ra, dec_j2000_deg: SGR_A.dec },
      galactic_pole: { ra_j2000_deg: NGP.ra, dec_j2000_deg: NGP.dec },
      windows,
    };
  }

  return {
    sunHours,
    findAzimuth,
    alignmentDays,
    analemma,
    sunPath,
    riseSetAzimuths,
    equationOfTime,
    solarDay,
    solarYear,
    galacticCentreWindows,
  };
}
