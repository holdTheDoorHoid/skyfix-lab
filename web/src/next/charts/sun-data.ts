/**
 * Data for the Sun tab (charts2 agent, expansion programme Q5): the sun path, the analemma,
 * sunrise and sunset bearings through the year, the equation of time and the solar panel.
 * OWNER: charts2 agent.
 *
 * Every number is the engine's (`SunToolsEngine`, EXPLORER_API "Expansion programme — sun
 * tools"); this module only asks for the right window and clock and shapes the answers for
 * drawing: runs of a path above the horizon, whole hours on the local clock, the days of a
 * year as positions on a date axis, a sky projection for the analemma. No astronomy.
 */

import type {
  Analemma,
  AnalemmaClock,
  EquationOfTime,
  EventOptions,
  Observer,
  SolarDay,
  SolarPanel,
  SolarYear,
  SunPath,
  SunPathDay,
  SunPathDayKind,
  SunPathPoint,
  SunToolsEngine,
} from '../engine/types.js';
import { utcMs, zoneOffsetMs, type Zone } from '../time.js';
import { scaleLabel } from '../time/scale.js';
import { daysInMonth, isLeapYear, wallHours, type LocalDay } from './windows.js';

export const DEG = Math.PI / 180;
const MS_PER_HOUR = 3_600_000;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// ---------------------------------------------------------------------------------------
// Angles

/** An azimuth in [0, 360). */
export function norm360(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** The signed difference b − a of two azimuths, in (−180, 180]. */
export function azDelta(a: number, b: number): number {
  const d = norm360(b - a);
  return d > 180 ? d - 360 : d;
}

/**
 * The azimuth axis of a chart "facing the equator": north of the equator it runs N (0°) →
 * E → S → W → N (360°) with south in the middle, as a person facing south sees it (east on
 * the left); south of the equator it runs S (180°) → W → N → E → S (540°) with north in the
 * middle. Returns the axis start; `unwrapAz` puts an azimuth on it.
 */
export function azAxisStart(latDeg: number): number {
  return latDeg >= 0 ? 0 : 180;
}

/** An azimuth on the axis that starts at `start` (a value in [start, start + 360)). */
export function unwrapAz(az: number, start: number): number {
  return start + norm360(az - start);
}

// ---------------------------------------------------------------------------------------
// Clocks

/** Local mean time's offset from UTC at a longitude, hours (CONVENTIONS 13.10). */
export function lmtOffsetHours(lonDeg: number): number {
  return lonDeg / 15;
}

/**
 * A zone's standard time (the clock without daylight saving) in a year, hours: the smaller
 * of its offsets in mid-January and mid-July (daylight saving always puts the clock ahead).
 */
export function standardOffsetHours(zone: Zone, year: number): number {
  const jan = zoneOffsetMs(utcMs(year, 1, 15, 12), zone);
  const jul = zoneOffsetMs(utcMs(year, 7, 15, 12), zone);
  return Math.min(jan, jul) / MS_PER_HOUR;
}

/** `UTC−5`, `UTC+5:30`, `UTC−5:00:39` for an offset in hours. */
export function offsetText(hours: number, jd?: number): string {
  // The clock's own word: UT outside 1972-2035 (time-ui's `scaleLabel`; polish2).
  const word = jd === undefined ? 'UTC' : scaleLabel(jd);
  if (hours === 0) return word;
  const sign = hours > 0 ? '+' : '−';
  const total = Math.round(Math.abs(hours) * 3600);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const p = (n: number): string => String(n).padStart(2, '0');
  return ss ? `${word}${sign}${hh}:${p(mm)}:${p(ss)}` : mm ? `${word}${sign}${hh}:${p(mm)}` : `${word}${sign}${hh}`;
}

// ---------------------------------------------------------------------------------------
// Dates on a year axis

/** `2026-03-15` → day of the year, 0 for 1 January (proleptic Gregorian, any year). */
export function dayOfYearOf(date: string): number {
  const m = /^([+-]?\d{4,6})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return Number.NaN;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  let n = day - 1;
  for (let k = 1; k < month; k += 1) n += daysInMonth(year, k);
  return n;
}

export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

/** Day-of-year indices of the first of each month. */
export function monthStarts(year: number): number[] {
  const out: number[] = [];
  let n = 0;
  for (let m = 1; m <= 12; m += 1) {
    out.push(n);
    n += daysInMonth(year, m);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Sun path

export interface SkyPoint {
  readonly jd: number;
  /** Apparent altitude (what the eye sees), degrees. */
  readonly alt: number;
  readonly az: number;
}

/**
 * The stretches of a path above the horizon (apparent altitude of the centre ≥ 0), each
 * starting and ending on the horizon, the crossing placed by linear interpolation between the
 * samples either side (the Sun moves under 3° between 10-minute samples).
 */
export function aboveHorizonRuns(points: readonly SunPathPoint[]): SkyPoint[][] {
  const runs: SkyPoint[][] = [];
  let run: SkyPoint[] | null = null;
  const at = (p: SunPathPoint): SkyPoint => ({ jd: p.jd_utc, alt: p.alt_apparent_deg, az: p.az_deg });
  const cross = (a: SunPathPoint, b: SunPathPoint): SkyPoint => {
    const t = a.alt_apparent_deg / (a.alt_apparent_deg - b.alt_apparent_deg);
    return { jd: a.jd_utc + t * (b.jd_utc - a.jd_utc), alt: 0, az: norm360(a.az_deg + t * azDelta(a.az_deg, b.az_deg)) };
  };
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    const up = p.alt_apparent_deg >= 0;
    const prev = i > 0 ? points[i - 1]! : null;
    if (up) {
      if (!run) {
        run = prev && prev.alt_apparent_deg < 0 ? [cross(prev, p)] : [];
        runs.push(run);
      }
      run.push(at(p));
    } else if (run) {
      if (prev && prev.alt_apparent_deg >= 0) run.push(cross(prev, p));
      run = null;
    }
  }
  return runs;
}

export interface HourMark extends SkyPoint {
  /** The hour on the local clock, 0-23. */
  readonly hour: number;
}

/** The path's samples at whole hours of the local clock, above the horizon. */
export function hourMarks(day: LocalDay, points: readonly SunPathPoint[], zone: Zone): HourMark[] {
  const out: HourMark[] = [];
  for (const p of points) {
    if (p.jd_utc < day.jd_start - 1e-9 || p.jd_utc >= day.jd_end - 1e-9 || p.alt_apparent_deg < 0) continue;
    const wall = wallHours(day, p.jd_utc, zone);
    const hour = Math.round(wall);
    if (Math.abs(wall - hour) > 1e-4 || hour < 0 || hour > 23) continue;
    out.push({ jd: p.jd_utc, alt: p.alt_apparent_deg, az: p.az_deg, hour });
  }
  return out;
}

export interface PathCurve {
  readonly kind: SunPathDayKind;
  /** The equinox or solstice instant; null for the requested day. */
  readonly seasonJd: number | null;
  readonly runs: readonly SkyPoint[][];
  /** Above the horizon at some sample. */
  readonly everUp: boolean;
  /** Above the horizon at every sample (midnight sun). */
  readonly alwaysUp: boolean;
  /** Highest sample (apparent altitude, degrees) and its azimuth. */
  readonly peak: SkyPoint | null;
}

export function pathCurve(day: SunPathDay): PathCurve {
  let peak: SkyPoint | null = null;
  let up = 0;
  for (const p of day.points) {
    if (p.alt_apparent_deg >= 0) up += 1;
    if (!peak || p.alt_apparent_deg > peak.alt) peak = { jd: p.jd_utc, alt: p.alt_apparent_deg, az: p.az_deg };
  }
  return {
    kind: day.day,
    seasonJd: day.season_jd_utc,
    runs: aboveHorizonRuns(day.points),
    everUp: up > 0,
    alwaysUp: day.points.length > 0 && up === day.points.length,
    peak,
  };
}

export interface SunPathInput {
  readonly observer: Observer;
  readonly zone: Zone;
  readonly day: LocalDay;
  readonly options: EventOptions;
}

export interface SunPathData {
  readonly input: SunPathInput;
  readonly raw: SunPath;
  readonly today: PathCurve;
  readonly hours: readonly HourMark[];
  /** March equinox, June solstice, September equinox, December solstice (calendar order). */
  readonly envelope: readonly PathCurve[];
  readonly errors: readonly string[];
  readonly timing: { readonly engineMs: number; readonly totalMs: number };
}

/** The sample step of the sun path, minutes (the engine's default). */
export const SUN_PATH_STEP_MIN = 10;

export function computeSunPath(engine: SunToolsEngine, input: SunPathInput): SunPathData {
  const t0 = now();
  const raw = engine.sunPath(input.observer, input.day.jd_start, input.day.jd_end, SUN_PATH_STEP_MIN);
  const t1 = now();
  return {
    input,
    raw,
    today: pathCurve(raw.path),
    hours: hourMarks(input.day, raw.path.points, input.zone),
    envelope: raw.envelope.map(pathCurve),
    errors: raw.errors.map((e) => `${e.body}: ${e.message}`),
    timing: { engineMs: t1 - t0, totalMs: now() - t0 },
  };
}

// ---------------------------------------------------------------------------------------
// A sky projection (the analemma's picture)

/** East, north and up components of a direction given by azimuth and altitude. */
export function enu(azDeg: number, altDeg: number): [number, number, number] {
  const a = azDeg * DEG;
  const h = altDeg * DEG;
  return [Math.cos(h) * Math.sin(a), Math.cos(h) * Math.cos(a), Math.sin(h)];
}

export interface Projected {
  /** To the right (increasing azimuth, as the viewer facing the centre sees it), degrees near the centre. */
  readonly x: number;
  /** Up, degrees near the centre. */
  readonly y: number;
}

/**
 * The stereographic projection of the sky onto the plane that touches it at (`az0`, `alt0`):
 * what a camera pointed there shows, with angles and small shapes kept (a figure-8 keeps its
 * shape anywhere, the zenith included). Near the centre one unit is one degree. Directions
 * more than 150° from the centre are refused (null): they would be far off the picture.
 */
export function stereographic(az0: number, alt0: number): (az: number, alt: number) => Projected | null {
  const c = enu(az0, alt0);
  // Screen right: the direction of increasing azimuth at the centre; screen up: increasing altitude.
  const r: [number, number, number] = [Math.cos(az0 * DEG), -Math.sin(az0 * DEG), 0];
  const u: [number, number, number] = [
    -Math.sin(alt0 * DEG) * Math.sin(az0 * DEG),
    -Math.sin(alt0 * DEG) * Math.cos(az0 * DEG),
    Math.cos(alt0 * DEG),
  ];
  const limit = Math.cos(150 * DEG);
  return (az, alt) => {
    const p = enu(az, alt);
    const d = p[0] * c[0] + p[1] * c[1] + p[2] * c[2];
    if (d < limit) return null;
    const k = (2 / (1 + d)) / DEG;
    return { x: k * (p[0] * r[0] + p[1] * r[1] + p[2] * r[2]), y: k * (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) };
  };
}

/** The mean direction of some sky points (the centre of the analemma's picture). */
export function meanDirection(points: readonly { az: number; alt: number }[]): { az: number; alt: number } {
  let e = 0;
  let n = 0;
  let up = 0;
  for (const p of points) {
    const v = enu(p.az, p.alt);
    e += v[0];
    n += v[1];
    up += v[2];
  }
  const horiz = Math.hypot(e, n);
  return { az: horiz > 1e-12 ? norm360(Math.atan2(e, n) / DEG) : 180, alt: Math.atan2(up, horiz) / DEG };
}

// ---------------------------------------------------------------------------------------
// Analemma

export interface AnalemmaInput {
  readonly observer: Observer;
  readonly year: number;
  /** Clock time of day, hours [0, 24). */
  readonly timeH: number;
  readonly clock: AnalemmaClock;
  /** For `zone`: the fixed offset (the display zone's standard time); ignored for `lmt`. */
  readonly zoneOffsetH: number;
}

export interface AnalemmaData {
  readonly input: AnalemmaInput;
  readonly raw: Analemma;
  /** Indices into `raw.points` of the first of each month present. */
  readonly monthFirsts: readonly number[];
  /** The picture's centre (the points' mean direction) and projection. */
  readonly centre: { readonly az: number; readonly alt: number };
  readonly timing: { readonly engineMs: number };
}

export function computeAnalemma(engine: SunToolsEngine, input: AnalemmaInput): AnalemmaData {
  const t0 = now();
  const raw = engine.analemma(input.observer, {
    year: input.year,
    time_h: input.timeH,
    clock: input.clock,
    ...(input.clock === 'zone' ? { utc_offset_hours: input.zoneOffsetH } : {}),
  });
  const engineMs = now() - t0;
  const monthFirsts: number[] = [];
  raw.points.forEach((p, i) => {
    if (p.date.endsWith('-01')) monthFirsts.push(i);
  });
  const centre = meanDirection(raw.points.map((p) => ({ az: p.az_deg, alt: p.alt_apparent_deg })));
  return { input, raw, monthFirsts, centre, timing: { engineMs } };
}

// ---------------------------------------------------------------------------------------
// Sunrise and sunset bearings

export interface BearingDay {
  /** Day of the year (0 = 1 January). */
  readonly index: number;
  readonly date: string;
  readonly rise: { readonly jd: number; readonly az: number } | null;
  readonly set: { readonly jd: number; readonly az: number } | null;
  /** Solar noon: the instant and the Sun's geometric height then. */
  readonly transit: { readonly jd: number; readonly alt: number } | null;
  readonly alwaysAbove: boolean;
  readonly alwaysBelow: boolean;
}

export interface BearingData {
  readonly year: number;
  readonly days: readonly BearingDay[];
  /** Extremes of the year's sunrise and sunset bearings (northernmost and southernmost). */
  readonly riseRange: { readonly min: number; readonly max: number } | null;
  readonly setRange: { readonly min: number; readonly max: number } | null;
  /** Days the engine could not compute (outside its coverage). */
  readonly missing: number;
}

/** What `bearingsFromYear` reads from the Year chart's days (year-data.ts `YearDay`). */
export interface EventDay {
  readonly day: { readonly key: string; readonly date: { readonly year: number } };
  readonly events: readonly { readonly kind: string; readonly jd: number; readonly az: number; readonly alt: number }[];
  readonly alwaysAbove: boolean;
  readonly alwaysBelow: boolean;
  readonly error: string | null;
}

/**
 * Sunrise and sunset bearings through the year from the Year chart's own day events
 * (`day_events_batch` over the local days of the display zone, shared and memoised): the
 * event finder's rise and set (the upper limb on the horizon) and transit, exactly what
 * `rise_set_azimuths` gives, which is the same finder over the year split into days.
 * The first rise and the last set of each day.
 */
export function bearingsFromYear(year: number, days: readonly EventDay[]): BearingData {
  const out: BearingDay[] = [];
  let missing = 0;
  for (const d of days) {
    if (d.error) {
      missing += 1;
      continue;
    }
    const rise = d.events.find((e) => e.kind === 'rise') ?? null;
    const sets = d.events.filter((e) => e.kind === 'set');
    const set = sets.length ? sets[sets.length - 1]! : null;
    const transit = d.events.find((e) => e.kind === 'transit') ?? null;
    out.push({
      index: dayOfYearOf(d.day.key),
      date: d.day.key,
      rise: rise ? { jd: rise.jd, az: rise.az } : null,
      set: set ? { jd: set.jd, az: set.az } : null,
      transit: transit ? { jd: transit.jd, alt: transit.alt } : null,
      alwaysAbove: d.alwaysAbove,
      alwaysBelow: d.alwaysBelow,
    });
  }
  return {
    year,
    days: out,
    riseRange: range(out.flatMap((d) => (d.rise ? [d.rise.az] : []))),
    setRange: range(out.flatMap((d) => (d.set ? [d.set.az] : []))),
    missing,
  };
}

function range(values: number[]): { min: number; max: number } | null {
  if (!values.length) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

// ---------------------------------------------------------------------------------------
// Equation of time

export interface EotData {
  readonly year: number;
  readonly raw: EquationOfTime;
  readonly timing: { readonly engineMs: number };
}

/** The UTC hour the equation of time is evaluated at (the almanac page's `eot_12h`). */
export const EOT_UTC_HOUR = 12;

export function computeEot(engine: SunToolsEngine, year: number): EotData {
  const t0 = now();
  const raw = engine.equationOfTime(year, EOT_UTC_HOUR);
  return { year, raw, timing: { engineMs: now() - t0 } };
}

/** `+16 min 25 s`, `−14 min 13 s`, `+42 s`: a sundial's lead (positive) or lag. */
export function eotText(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const total = Math.round(Math.abs(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const sign = seconds < 0 && total > 0 ? '−' : total > 0 ? '+' : '';
  return m ? `${sign}${m} min ${String(s).padStart(2, '0')} s` : `${sign}${s} s`;
}

// ---------------------------------------------------------------------------------------
// Solar panel

/** The default panel: tilted at the latitude (whole degrees), facing the equator. */
export function defaultPanel(latDeg: number): { tilt: number; azimuth: number } {
  return { tilt: Math.min(90, Math.round(Math.abs(latDeg))), azimuth: latDeg >= 0 ? 180 : 0 };
}

export interface SolarInput {
  readonly observer: Observer;
  readonly year: number;
  /** The clock local days are on (the display zone's standard time). */
  readonly offsetH: number;
  readonly panel: { readonly tilt: number; readonly azimuth: number };
}

export interface SolarData {
  readonly input: SolarInput;
  readonly year: SolarYear;
  /** Days as positions on the date axis, in order. */
  readonly index: readonly number[];
  readonly best: { readonly index: number; readonly poa: number } | null;
  readonly worst: { readonly index: number; readonly poa: number } | null;
  readonly timing: { readonly engineMs: number };
}

export function solarPanelArg(panel: { tilt: number; azimuth: number }): SolarPanel {
  return { tilt_deg: panel.tilt, azimuth_deg: panel.azimuth };
}

export function computeSolarYear(engine: SunToolsEngine, input: SolarInput): SolarData {
  const t0 = now();
  const year = engine.solarYear(input.observer, {
    year: input.year,
    panel: solarPanelArg(input.panel),
    utc_offset_hours: input.offsetH,
    optimise_tilt: true,
  });
  const engineMs = now() - t0;
  let best: { index: number; poa: number } | null = null;
  let worst: { index: number; poa: number } | null = null;
  const index = year.days.map((d) => dayOfYearOf(d.date));
  year.days.forEach((d, i) => {
    if (!best || d.poa_kwh_m2 > best.poa) best = { index: index[i]!, poa: d.poa_kwh_m2 };
    if (!worst || d.poa_kwh_m2 < worst.poa) worst = { index: index[i]!, poa: d.poa_kwh_m2 };
  });
  return { input, year, index, best, worst, timing: { engineMs } };
}

/** A local day's clear-sky irradiance on the panel (cheap: under a millisecond natively). */
export function computeSolarDay(
  engine: SunToolsEngine,
  observer: Observer,
  day: LocalDay,
  panel: { tilt: number; azimuth: number },
): SolarDay {
  return engine.solarDay(observer, day.jd_start, day.jd_end, solarPanelArg(panel), SOLAR_DAY_STEP_MIN);
}

/** Irradiance samples through a day, minutes. */
export const SOLAR_DAY_STEP_MIN = 10;

/** `2 448`: kWh/m² with thin-space thousands, as the rest of the page groups digits. */
export function kwh(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  const text = value.toFixed(digits);
  const [int, frac] = text.split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return frac ? `${grouped}.${frac}` : grouped;
}
