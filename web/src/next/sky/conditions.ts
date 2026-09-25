/**
 * How dark the observer's sky is, and how much the air dims what is low in it: the Sky
 * view's magnitude limit, and the sky the deep-sky and meteor estimates assume.
 * OWNER: sky2 agent (expansion Q3). No DOM.
 *
 * Settings (state.ts, "sky2 agent"): `skyQuality` is
 * - `auto` — a dark site, dimmed only by twilight: the zenith limit follows the Sun's
 *   altitude (`limitingMagnitude`, 6.5 in full darkness), as the Sky view always did; the
 *   estimates assume the same dark sky (naked-eye limit 6.5);
 * - `bortle` — a Bortle class 1 to 9 (the engine stands each for the middle of its
 *   naked-eye range: 1 → 7.8 … 5 → 5.8 … 9 → 4.0);
 * - `nelm` — the faintest star the person sees at the zenith.
 * In the last two the limit is the brighter of the site's own and twilight's.
 *
 * Extinction (EXPLORER_API "deep sky", `extinction_table`): the engine's air mass
 * (Pickering 2002) times `k` (0.25 mag per air mass by default), per degree of apparent
 * altitude. The Sky view uses it relative to the zenith — `k (X − 1)`, 1.15 mag at 10°,
 * 9.4 mag on the horizon — because the naked-eye limit is a zenith figure. Everything
 * here is display only (CONVENTIONS 13.6) and an estimate; the Layers menu says so.
 */

import {
  isDeepSkyEngine,
  type ExplorerEngine,
  type ExtinctionTable,
  type SkyConditions,
  type SkyConditionsInput,
} from '../engine/types.js';
import type { Settings } from '../state.js';
import { limitingMagnitude } from './astro.js';

/** The limit a dark site reaches with the Sun far down (the `auto` setting's night). */
export const DARK_SKY_NELM = 6.5;

/** Bortle's classes as the engine resolves them (EXPLORER_API "Common arguments"). */
export const BORTLE_NELM: readonly number[] = [7.8, 7.3, 6.8, 6.3, 5.8, 5.3, 4.8, 4.3, 4.0];

/** One short line per Bortle class, plain words first (Bortle 2001). */
export const BORTLE_WORDS: readonly string[] = [
  'Excellent dark site',
  'Truly dark site',
  'Rural sky',
  'Rural and suburban transition',
  'Suburban sky',
  'Bright suburban sky',
  'Suburban and urban transition',
  'City sky',
  'Inner-city sky',
];

export type SkyQualitySettings = Pick<Settings, 'skyQuality' | 'skyBortle' | 'skyNelm'>;

/**
 * The sky to send the deep-sky engine (`conditions_json`) for these settings: the same
 * sky the Sky view draws, so its estimates and its stars agree. Other views (Tonight)
 * use this too.
 */
export function skyConditions(s: SkyQualitySettings): SkyConditionsInput {
  switch (s.skyQuality) {
    case 'bortle':
      return { bortle: Math.min(9, Math.max(1, Math.round(s.skyBortle))) };
    case 'nelm':
      return { nelm: Math.min(8, Math.max(1, s.skyNelm)) };
    default:
      return { nelm: DARK_SKY_NELM };
  }
}

/** The naked-eye limit these settings stand for, without asking the engine. */
export function settingsNelm(s: SkyQualitySettings): number {
  if (s.skyQuality === 'bortle') return BORTLE_NELM[Math.min(9, Math.max(1, Math.round(s.skyBortle))) - 1]!;
  if (s.skyQuality === 'nelm') return Math.min(8, Math.max(1, s.skyNelm));
  return DARK_SKY_NELM;
}

/**
 * The faintest magnitude seen at the zenith: twilight's limit for the Sun's altitude,
 * and in the `bortle` and `nelm` settings no fainter than the site's own limit.
 */
export function zenithLimit(sunAltDeg: number, quality: Settings['skyQuality'], siteNelm: number): number {
  const twilight = limitingMagnitude(sunAltDeg);
  if (quality === 'auto' || !Number.isFinite(siteNelm)) return twilight;
  return Math.min(twilight, siteNelm);
}

/**
 * How much of the Milky Way's glow shows, 0 to 1, for a zenith limit: none below a limit
 * of 4.8 (a suburban-to-city sky, or nautical twilight), all of it at 6.5. A display rule
 * of thumb: the band is a naked-eye sight in a Bortle 4 sky and gone by Bortle 7.
 */
export function milkyWayVisibility(limit: number): number {
  const v = (limit - 4.8) / (DARK_SKY_NELM - 4.8);
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

/**
 * Extinction relative to the zenith, per degree of apparent altitude 0…90 (91 values,
 * magnitudes): `extinction_mag(h) − extinction_mag(90°)`.
 */
export function relativeExtinction(table: Pick<ExtinctionTable, 'extinction_mag'>): Float32Array {
  const e = table.extinction_mag;
  const n = Math.min(91, e.length);
  const out = new Float32Array(91);
  const zenith = e[n - 1] ?? 0;
  for (let i = 0; i < 91; i += 1) out[i] = Math.max(0, (e[Math.min(i, n - 1)] ?? zenith) - zenith);
  return out;
}

/** `rel` at an apparent altitude in radians (linear between whole degrees; the horizon's value below it). */
export function extinctionAt(rel: Float32Array, altRad: number): number {
  const h = (altRad * 180) / Math.PI;
  if (!(h > 0)) return rel[0]!;
  if (h >= 90) return 0;
  const i = Math.floor(h);
  const f = h - i;
  return rel[i]! + (rel[i + 1]! - rel[i]!) * f;
}

/** The engine's answer for one sky, kept until the settings change (no engine call per frame). */
export interface SkyModel {
  key: string;
  /** Resolved by the engine (or `settingsNelm` when it has no deep-sky calls). */
  nelm: number;
  conditions: SkyConditions | null;
  /** Relative extinction per degree, or null when the engine has no table. */
  extinction: Float32Array | null;
  /** The engine's model sentence, for the Layers menu. */
  model: string;
  /** Why the engine could not answer, or null. */
  error: string | null;
}

/** Ask the engine for this sky (once per settings; the memoised engine keeps the table). */
export function skyModel(engine: ExplorerEngine, s: SkyQualitySettings): SkyModel {
  const conditions = skyConditions(s);
  const key = JSON.stringify(conditions);
  if (!isDeepSkyEngine(engine)) {
    return {
      key,
      nelm: settingsNelm(s),
      conditions: null,
      extinction: null,
      model: '',
      error: 'Extinction and light pollution are not available in this engine.',
    };
  }
  try {
    const table = engine.extinction(conditions);
    return {
      key,
      nelm: table.conditions.nelm,
      conditions: table.conditions,
      extinction: relativeExtinction(table),
      model: table.model,
      error: null,
    };
  } catch (error) {
    return {
      key,
      nelm: settingsNelm(s),
      conditions: null,
      extinction: null,
      model: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
