/**
 * Naming a position the person put the observer on, and choosing its time zone. OWNER: map
 * agent. Pure (given the loaded gazetteer and region index); tested in map-place.test.ts.
 *
 * Time zones follow CONVENTIONS 13.8: an IANA zone guessed from the gazetteer, or the
 * nautical zone at sea. When the observer moves the zone is guessed again, unless the
 * person chose it: see `zonePinned`.
 */

import { describeLocation, type Gazetteer } from '../geo/gazetteer.js';
import type { RegionIndex } from '../geo/regions.js';
import { guessZone, resolveIntlZone, type ZoneGuess } from '../geo/timezone.js';
import { zonePinned } from '../state.js';
import type { ZoneChoice } from '../time.js';

/**
 * True when the zone is the person's own choice and must survive moving the observer: UTC
 * as the place's zone, or any zone marked `guessed: false` — an IANA zone or the nautical
 * zone picked by hand in the panel. A zone that came with a place (the default place, a
 * share link, a place search: `guessed` absent) or a guessed one (`guessed: true`) is
 * guessed again for the new position. The store's rule (state.ts), so the map, the panel and
 * the place service can never disagree about it.
 */
export { zonePinned };

/** The store's zone for a guess; a zone this browser cannot display falls back to the nautical zone. */
export function zoneChoiceFromGuess(guess: ZoneGuess): ZoneChoice {
  switch (guess.zone.kind) {
    case 'iana': {
      const id = resolveIntlZone(guess.zone.id);
      return id ? { kind: 'iana', zone: id, guessed: true } : { kind: 'nautical' };
    }
    case 'nautical':
      return { kind: 'nautical' };
    case 'utc':
      return { kind: 'utc' };
  }
}

export interface PlaceInfo {
  /** "near Philadelphia, Pennsylvania, United States", "At sea, 32 NM SE of …". */
  label: string;
  /** The zone to set, or null to keep the current (pinned) one. */
  zone: ZoneChoice | null;
  /** Why this zone, in one sentence (for a tooltip), or '' when kept. */
  reason: string;
}

/**
 * Name a position and guess its zone. Without the region index (still loading) the name
 * cannot say "At sea" and the guess uses nearby places only; call again once it loads.
 */
export function describePlace(g: Gazetteer, regions: RegionIndex | null, latDeg: number, lonDeg: number, current: ZoneChoice): PlaceInfo {
  const atSea = regions ? regions.locateCountry(latDeg, lonDeg, 0) === null : undefined;
  const description = describeLocation(g, latDeg, lonDeg, atSea === undefined ? {} : { atSea });
  if (zonePinned(current)) return { label: description.text, zone: null, reason: '' };
  const guess = guessZone(latDeg, lonDeg, g, regions);
  return { label: description.text, zone: zoneChoiceFromGuess(guess), reason: guess.reason };
}

/** Whether two zone choices are the same (so the store is not patched for nothing). */
export function sameZone(a: ZoneChoice, b: ZoneChoice): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'iana' || (b.kind === 'iana' && a.zone === b.zone && (a.guessed ?? null) === (b.guessed ?? null));
}
