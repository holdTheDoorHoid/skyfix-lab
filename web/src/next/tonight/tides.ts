/**
 * The Tonight view's tides line: the nearest NOAA station's high and low waters through the
 * night, from the optional `tides-us` pack. OWNER: tonight agent (expansion programme Q2).
 *
 * The pack is asked for only when the person presses the card's button
 * (`ctx.packs.ensure('tides-us', …)`, which prompts with its size); a copy already saved on
 * this device is loaded without a question. Without the pack the card is shown only where a
 * station may lie within 100 NM (tide-cells.ts); with it, only where one does. Predictions of
 * the astronomical tide, not observations: the card says so, with the engine's label.
 */

import type { Ctx } from '../component.js';
import {
  isTidePackNotLoaded,
  isTidesEngine,
  type TideEvent,
  type TideStationNear,
} from '../engine/types.js';
import { MINUS } from '../shell/format.js';
import type { Units } from '../state.js';
import { errorText } from './data.js';
import { mayHaveTideStation, TIDE_RADIUS_NM } from './tide-cells.js';

export const TIDES_PACK = 'tides-us';
export const TIDES_REASON = 'Tide times for US stations need the US tides pack.';

/** Tide predictions exist from 1900 to 2100 only (EXPLORER_API "Tides": `outside_range`). */
export const TIDE_FIRST_JD = 2415020.5;
export const TIDE_END_JD = 2488434.5;

export type TideCard =
  /** The engine has no tides at all: the card is not shown. */
  | { kind: 'hidden'; why: 'engine' | 'far' | 'none-near' | 'outside' }
  /** Near a station, the pack not loaded: offer it. `declined`: asked already this session. */
  | { kind: 'offer'; bytes: number | null; declined: boolean; offline: boolean }
  | { kind: 'loading' }
  | { kind: 'ready'; station: TideStationNear; extremes: TideEvent[]; datum: string; label: string; notes: string[] }
  | { kind: 'error'; message: string };

/** Whether the engine has the tides pack installed. */
export function tidesLoaded(ctx: Pick<Ctx, 'engine'>): boolean {
  const { engine } = ctx;
  if (!isTidesEngine(engine)) return false;
  try {
    return engine.tidePackInfo() !== null;
  } catch {
    return false;
  }
}

/** The stations the card may use: within the radius, with a prediction. */
export function usableStations(near: readonly TideStationNear[], radiusNm = TIDE_RADIUS_NM): TideStationNear[] {
  return near.filter((st) => st.distance_nm <= radiusNm && st.curve !== 'none' && !st.flags.includes('no_constants'));
}

/**
 * The card for a place and a stretch of the night (`from`–`to`, the timeline's span), from
 * what the engine and the pack service say now. Never throws.
 */
export function tideCard(ctx: Pick<Ctx, 'engine' | 'packs'>, lat: number, lon: number, from: number, to: number, pending: boolean): TideCard {
  const { engine } = ctx;
  if (!isTidesEngine(engine)) return { kind: 'hidden', why: 'engine' };
  if (to < TIDE_FIRST_JD || from >= TIDE_END_JD) return { kind: 'hidden', why: 'outside' };
  if (!tidesLoaded(ctx)) {
    if (!mayHaveTideStation(lat, lon)) return { kind: 'hidden', why: 'far' };
    if (pending) return { kind: 'loading' };
    const st = ctx.packs.status().find((p) => p.name === TIDES_PACK);
    if (st && !st.offered && !st.saved) return { kind: 'hidden', why: 'engine' };
    return { kind: 'offer', bytes: st?.bytes || null, declined: Boolean(st?.error) || declinedThisSession(ctx), offline: typeof navigator !== 'undefined' && navigator.onLine === false };
  }
  try {
    const near = usableStations(engine.tideStationsNear(lat, lon, 5));
    for (const station of near) {
      try {
        const a = Math.max(TIDE_FIRST_JD, from);
        const b = Math.min(TIDE_END_JD - 1e-6, Math.max(to, from + 0.55));
        const t = engine.tideExtremes(station.id, a, b, '');
        return { kind: 'ready', station, extremes: t.extremes, datum: t.datum, label: t.label, notes: t.notes };
      } catch (error) {
        if (isTidePackNotLoaded(error)) return { kind: 'offer', bytes: null, declined: false, offline: false };
      }
    }
    return { kind: 'hidden', why: 'none-near' };
  } catch (error) {
    return isTidePackNotLoaded(error) ? { kind: 'offer', bytes: null, declined: false, offline: false } : { kind: 'error', message: errorText(error) };
  }
}

const declined = new WeakSet<object>();

/** Remember that the person said "Not now" to the pack in this page session. */
export function markDeclined(ctx: Pick<Ctx, 'packs'>): void {
  declined.add(ctx.packs);
}

function declinedThisSession(ctx: Pick<Ctx, 'packs'>): boolean {
  return declined.has(ctx.packs);
}

/** A tide height in the chosen units, with a true minus: `1.9 m`, `−0.3 ft`. */
export function tideHeight(m: number, units: Units): string {
  const v = units === 'imperial' ? m / 0.3048 : m;
  const text = Math.abs(v).toFixed(1);
  return `${v < 0 && Number(text) !== 0 ? MINUS : ''}${text} ${units === 'imperial' ? 'ft' : 'm'}`;
}

/** `12 NM north` or `22 km north`, from the place to the station. */
export function stationWhere(st: TideStationNear, units: Units, point: string): string {
  const d =
    units === 'metric'
      ? `${st.distance_km < 10 ? st.distance_km.toFixed(1) : Math.round(st.distance_km)} km`
      : `${st.distance_nm < 10 ? st.distance_nm.toFixed(1) : Math.round(st.distance_nm)} NM`;
  return `${d} ${point}`;
}

/** The datum in words for the card's tooltip. */
export function datumWords(datum: string): string {
  return datum === 'MLLW' ? 'mean lower low water (MLLW), the datum of US charts' : datum;
}

/** `0.3 MB`, `1.3 MB`, `45 KB`. */
export function sizeText(bytes: number | null): string {
  if (!bytes) return '';
  return bytes >= 1e5 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
