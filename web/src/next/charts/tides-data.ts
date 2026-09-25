/**
 * Data for the Tides tab (charts2 agent, expansion programme Q5): the nearest US tide
 * stations, a day's or a week's predicted curve and its high and low water, on a datum.
 * OWNER: charts2 agent.
 *
 * Every height and instant is the engine's (`TidesEngine`, EXPLORER_API "Expansion
 * programme — tides", the `tides-us` pack). This module chooses the window (local days of
 * the display zone), the station and the datum, and reads heights off the predicted curve
 * between its samples for the moving cursor (the cubic through the nearest four samples of
 * the 6-minute curve: a fraction of a millimetre from the engine's own `tide_now`; see
 * test/next/charts-real-engine.test.ts).
 */

import type {
  DayEvents,
  EventOptions,
  Observer,
  PhaseSegment,
  TideCurve,
  TideDatum,
  TideEvent,
  TideExtremes,
  TidesEngine,
  TideStation,
  TideStationNear,
} from '../engine/types.js';
import type { ExplorerEngine } from '../engine/types.js';
import type { Units } from '../state.js';
import type { Zone } from '../time.js';
import { localDays, type LocalDay } from './windows.js';

export type TideSpan = 'day' | 'week';

/** How many stations the picker offers. */
export const NEAREST_STATIONS = 12;
/** Beyond this the nearest station says little about the tide here (a caution is shown). */
export const FAR_STATION_KM = 60;
/** Sample step of the curve, minutes: 240 samples a day, 1 680 a week. */
export const TIDE_STEP_MIN: Record<TideSpan, number> = { day: 6, week: 6 };
/** High and low water are looked for this far either side of the window, for "next" and "previous". */
export const EXTREMES_MARGIN_DAYS = 1.5;

export const DATUM_WORDS: Record<TideDatum, string> = {
  MLLW: 'mean lower low water (chart datum)',
  MLW: 'mean low water',
  MSL: 'mean sea level',
  MTL: 'mean tide level',
  MHW: 'mean high water',
  MHHW: 'mean higher high water',
  LAT: 'lowest astronomical tide',
  HAT: 'highest astronomical tide',
  NAVD88: 'the NAVD 88 land datum',
};

export interface TideInput {
  readonly observer: Observer;
  readonly zone: Zone;
  readonly day: LocalDay;
  readonly span: TideSpan;
  /** '' for the station's default datum. */
  readonly datum: TideDatum | '';
  /** The chosen station, or null for the nearest. */
  readonly stationId: string | null;
  readonly options: EventOptions;
}

export interface TideWindow {
  readonly start: number;
  readonly end: number;
  readonly days: readonly LocalDay[];
}

/** The window drawn: the local day, or seven local days from it. */
export function tideWindow(zone: Zone, day: LocalDay, span: TideSpan): TideWindow {
  if (span === 'day') return { start: day.jd_start, end: day.jd_end, days: [day] };
  const days = localDays(zone, day.date, 7);
  return { start: days[0]!.jd_start, end: days[days.length - 1]!.jd_end, days };
}

/** The station to show: the chosen one when it is still among the nearest, else the nearest. */
export function chooseStation(near: readonly TideStationNear[], chosenId: string | null): TideStationNear | null {
  if (chosenId) {
    const hit = near.find((s) => s.id === chosenId);
    if (hit) return hit;
  }
  return near[0] ?? null;
}

/** The datum to use at a station: the one asked for when the station has it, else its default. */
export function datumFor(station: TideStation, wanted: TideDatum | ''): TideDatum {
  return wanted && station.datums.includes(wanted) ? wanted : station.default_datum;
}

export interface TideData {
  readonly input: TideInput;
  readonly near: readonly TideStationNear[];
  readonly station: TideStationNear;
  readonly datum: TideDatum;
  readonly window: TideWindow;
  /** High and low water inside the window. */
  readonly extremes: TideExtremes;
  /** The same with a margin either side (for "previous" and "next"). */
  readonly around: readonly TideEvent[];
  /** Null when the station gives no curve (`curve: none`). */
  readonly curve: TideCurve | null;
  /** The sky's phases over the window (the Sun), for day and night behind the curve. */
  readonly phases: readonly PhaseSegment[];
  readonly timing: { readonly engineMs: number };
}

/** Thrown when no station is known at all (an empty pack). */
export class NoStationError extends Error {
  constructor() {
    super('No tide station is known: the tides pack is empty.');
    this.name = 'NoStationError';
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function computeTides(engine: TidesEngine & Pick<ExplorerEngine, 'dayEvents'>, input: TideInput): TideData {
  const t0 = now();
  const near = engine.tideStationsNear(input.observer.lat_deg, input.observer.lon_deg, NEAREST_STATIONS);
  const station = chooseStation(near, input.stationId);
  if (!station) throw new NoStationError();
  const datum = datumFor(station, input.datum);
  const window = tideWindow(input.zone, input.day, input.span);
  const around = engine.tideExtremes(station.id, window.start - EXTREMES_MARGIN_DAYS, window.end + EXTREMES_MARGIN_DAYS, datum);
  const inside = around.extremes.filter((e) => e.jd_utc >= window.start && e.jd_utc < window.end);
  const extremes: TideExtremes = { ...around, jd_start: window.start, jd_end: window.end, extremes: inside };
  const curve = station.curve === 'none' ? null : engine.tidePredict(station.id, window.start, window.end, TIDE_STEP_MIN[input.span], datum);
  let phases: readonly PhaseSegment[] = [];
  try {
    const ev: DayEvents = engine.dayEvents(input.observer, window.start, window.end, ['Sun'], input.options);
    phases = ev.phases;
  } catch {
    phases = [];
  }
  return { input, near, station, datum, window, extremes, around: around.extremes, curve, phases, timing: { engineMs: now() - t0 } };
}

// ---------------------------------------------------------------------------------------
// Reading the curve

/** Index of the last sample at or before `jd`, or -1. */
function sampleBefore(jd: Float64Array, t: number): number {
  let lo = 0;
  let hi = jd.length - 1;
  if (hi < 0 || t < jd[0]!) return -1;
  if (t >= jd[hi]!) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (jd[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The cubic through the four samples around `t` (three or two at the curve's ends): its
 * value and its slope per day. Null outside the curve.
 */
function cubicAt(curve: Pick<TideCurve, 'jd_utc' | 'height_m'>, t: number): { h: number; dh: number } | null {
  const jd = curve.jd_utc;
  const hm = curve.height_m;
  const n = jd.length;
  const i = sampleBefore(jd, t);
  if (i < 0 || (i === n - 1 && t !== jd[i])) return null;
  if (n === 1) return { h: hm[0]!, dh: 0 };
  const first = Math.max(0, Math.min(i - 1, n - 4));
  const last = Math.min(n - 1, first + 3);
  // Lagrange form, and its derivative, over the nodes first..last.
  let h = 0;
  let dh = 0;
  for (let a = first; a <= last; a += 1) {
    let w = 1;
    let dw = 0;
    for (let b = first; b <= last; b += 1) {
      if (b === a) continue;
      const denom = jd[a]! - jd[b]!;
      let term = 1 / denom;
      for (let c = first; c <= last; c += 1) if (c !== a && c !== b) term *= (t - jd[c]!) / (jd[a]! - jd[c]!);
      dw += term;
      w *= (t - jd[b]!) / denom;
    }
    h += w * hm[a]!;
    dh += dw * hm[a]!;
  }
  return { h, dh };
}

/**
 * The predicted height at `t` read off the curve: the cubic through the four samples
 * around it (within a fraction of a millimetre of the engine's own `tide_now` on the
 * 6-minute curve; ACCURACY.md, "Charts"). Null outside the curve.
 */
export function heightAt(curve: Pick<TideCurve, 'jd_utc' | 'height_m'>, t: number): number | null {
  return cubicAt(curve, t)?.h ?? null;
}

/** The rate of rise at `t`, metres per hour, the same cubic's slope; null outside the curve. */
export function rateAt(curve: Pick<TideCurve, 'jd_utc' | 'height_m'>, t: number): number | null {
  const c = cubicAt(curve, t);
  return c ? c.dh / 24 : null;
}

/** The high or low water before and after `t` (and the next high and the next low). */
export function tideAround(events: readonly TideEvent[], t: number): {
  previous: TideEvent | null;
  next: TideEvent | null;
  nextHigh: TideEvent | null;
  nextLow: TideEvent | null;
} {
  let previous: TideEvent | null = null;
  let next: TideEvent | null = null;
  let nextHigh: TideEvent | null = null;
  let nextLow: TideEvent | null = null;
  for (const e of events) {
    if (e.jd_utc <= t) previous = e;
    else {
      next ??= e;
      if (e.kind === 'high') nextHigh ??= e;
      else nextLow ??= e;
    }
  }
  return { previous, next, nextHigh, nextLow };
}

// ---------------------------------------------------------------------------------------
// Units

const M_PER_FT = 0.3048;

/** Heights in the chosen units: metres (metric and nautical) or feet (imperial). */
export function heightUnit(units: Units): { unit: 'm' | 'ft'; perMetre: number; digits: number } {
  return units === 'imperial' ? { unit: 'ft', perMetre: 1 / M_PER_FT, digits: 1 } : { unit: 'm', perMetre: 1, digits: 2 };
}

/** `1.24 m`, `−0.31 m`, `4.1 ft` (a true minus). */
export function heightText(metres: number, units: Units): string {
  if (!Number.isFinite(metres)) return '—';
  const u = heightUnit(units);
  const v = metres * u.perMetre;
  const text = Math.abs(v).toFixed(u.digits);
  return `${v < 0 && Number(text) !== 0 ? '−' : ''}${text} ${u.unit}`;
}

/** A height as a bare number in the chosen unit, for a CSV file. */
export function heightValue(metres: number, units: Units): string {
  const u = heightUnit(units);
  return (metres * u.perMetre).toFixed(u.digits + 1);
}

/** `0.31 m an hour` */
export function rateText(metresPerHour: number, units: Units): string {
  const u = heightUnit(units);
  return `${Math.abs(metresPerHour * u.perMetre).toFixed(u.digits)} ${u.unit} an hour`;
}
