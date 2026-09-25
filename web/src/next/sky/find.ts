/**
 * Finding things in the sky by name, without any drawing code: the engine call, what a
 * hit stands for, and where it is in plain words. OWNER: sky2 agent (expansion Q3). The
 * side panel's search imports this (it stays light); the Sky view's box is search.ts.
 *
 * Every match comes from the deep-sky engine's `sky_search` (EXPLORER_API "deep sky"):
 * star names (the star field's and the IAU's), Bayer and Flamsteed designations in any
 * spelling ("alpha cma", "61 cygni"), HR and HIP numbers, deep-sky ids and names ("M31",
 * "NGC 224", "Andromeda"), constellations, the Sun, Moon and planets, and meteor showers.
 */

import { isDeepSkyEngine, type ExplorerEngine, type Observer, type SearchHit, type SearchHitKind } from '../engine/types.js';
import { compassPoint } from './format.js';
import type { SkyTarget } from './requests.js';

export interface SkySearchResult {
  hits: SearchHit[];
  /** Why there are no hits other than no match, or null. */
  error: string | null;
  /** The engine has no `sky_search` (the mock without deep sky, an older module). */
  unavailable: boolean;
}

/** Ask the engine; never throws. */
export function runSkySearch(engine: ExplorerEngine, query: string, observer: Observer | null, jd: number | null, limit = 12): SkySearchResult {
  const q = query.trim();
  if (!isDeepSkyEngine(engine)) return { hits: [], error: 'Search is not available in this engine.', unavailable: true };
  if (!q) return { hits: [], error: null, unavailable: false };
  try {
    return { hits: engine.skySearch(q, observer, observer ? jd : null, limit).hits, error: null, unavailable: false };
  } catch (error) {
    return { hits: [], error: error instanceof Error ? error.message : String(error), unavailable: false };
  }
}

/** What the Sky view should show for a hit. */
export function targetOfHit(hit: Pick<SearchHit, 'kind' | 'id' | 'index' | 'label'>): SkyTarget {
  switch (hit.kind) {
    case 'sun':
    case 'moon':
    case 'planet':
      return { kind: 'body', id: hit.label };
    case 'star':
      return { kind: 'star', id: hit.index !== null ? String(hit.index) : hit.id };
    case 'deep_sky':
      return { kind: 'deep_sky', id: hit.id };
    case 'constellation':
      return { kind: 'constellation', id: hit.id };
    default:
      return { kind: 'shower', id: hit.id };
  }
}

export const KIND_WORDS: Record<SearchHitKind, string> = {
  star: 'Star',
  deep_sky: 'Deep-sky object',
  constellation: 'Constellation',
  sun: 'The Sun',
  moon: 'The Moon',
  planet: 'Planet',
  shower: 'Meteor shower',
};

/** Where a hit is now, in plain words: "34° up in the SW", "below the horizon", or '' without a place. */
export function hitWhere(hit: Pick<SearchHit, 'above_horizon' | 'alt_apparent_deg' | 'az_deg'>): string {
  if (hit.above_horizon === null || hit.alt_apparent_deg === null || hit.az_deg === null) return '';
  if (!hit.above_horizon) return 'below the horizon';
  return `${Math.max(0, Math.round(hit.alt_apparent_deg))}° up in the ${compassPoint(hit.az_deg)}`;
}

// ---------------------------------------------------------------------------------
// The side panel's "Sky objects" group
// ---------------------------------------------------------------------------------

export interface PanelSkyOption {
  hit: SearchHit;
  label: string;
  /** "Star · 34° up in the SW". */
  where: string;
}

/**
 * Up to `limit` sky objects for the panel's place search (names only when the query is
 * shorter than two letters: none). Empty when the engine has no search.
 */
export function panelSkyOptions(engine: ExplorerEngine, text: string, observer: Observer, jd: number, limit = 4): PanelSkyOption[] {
  const q = text.trim();
  if (q.length < 2) return [];
  const result = runSkySearch(engine, q, observer, jd, limit);
  // Only confident matches: a whole name or its start (the place list carries the rest).
  return result.hits
    .filter((hit) => hit.score >= 60)
    .map((hit) => {
      const where = hitWhere(hit);
      return { hit, label: hit.label, where: [KIND_WORDS[hit.kind], where].filter(Boolean).join(' · ') };
    });
}
