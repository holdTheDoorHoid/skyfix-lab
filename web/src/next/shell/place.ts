/**
 * The place service: loads the offline gazetteer and the country polygons (the map-data
 * agent's `geo/` modules) in the background, and keeps the observer's time zone right.
 * OWNER: shell-design agent.
 *
 * Rules
 * - A zone that was guessed follows the place: whenever the position moves, it is guessed
 *   again (`geo/timezone.ts` `guessZone`). A zone the person pinned never changes by itself
 *   (`zonePinned`, state.ts).
 * - Whoever moves the place may set a zone in the same patch (the search box uses the
 *   chosen place's own zone); that choice is kept rather than guessed over.
 * - Without the gazetteer (still loading, or failed offline), a moved place gets its
 *   nautical zone time, which needs nothing but the longitude.
 * - Nothing here stores or sends the place (EXPLORER_PLAN §1).
 */

import {
  describeLocation,
  guessZone,
  interpretQuery,
  loadGazetteer,
  loadRegionIndex,
  prepareSearch,
  resolveIntlZone,
  type Gazetteer,
  type QueryResult,
  type RegionIndex,
  type ZoneGuess,
} from '../geo/index.js';
import type { Notices } from '../notices.js';
import { shallowEqual, zonePinned, type ExplorerStore, type ObserverState } from '../state.js';
import type { ZoneChoice } from '../time.js';

export interface PlaceData {
  gazetteer: Gazetteer | null;
  regions: RegionIndex | null;
  /** Set when the gazetteer could not be loaded. */
  error: string | null;
}

export interface PlaceService {
  data(): PlaceData;
  /** Called when the gazetteer or the polygons finish loading. */
  subscribe(listener: () => void): () => void;
  /** The zone guess for a position, with its reason; null until the gazetteer has loaded. */
  guess(lat: number, lon: number): ZoneGuess | null;
  /** "near Philadelphia, Pennsylvania, United States"; null until the gazetteer has loaded. */
  describe(lat: number, lon: number): string | null;
  /** What the search box should offer for `text`; null until the gazetteer has loaded. */
  search(text: string, near?: { lat_deg: number; lon_deg: number }): QueryResult | null;
  destroy(): void;
}

/** A zone choice from a guess: follows the place. Zones the browser does not know fall back to nautical time. */
export function zoneChoiceFromGuess(guess: ZoneGuess | null): ZoneChoice {
  if (!guess || guess.zone.kind === 'nautical') return { kind: 'nautical', guessed: true };
  if (guess.zone.kind === 'utc') return { kind: 'utc' };
  const id = resolveIntlZone(guess.zone.id);
  return id ? { kind: 'iana', zone: id, guessed: true } : { kind: 'nautical', guessed: true };
}

/** A zone choice for a named place with a known zone (the search box). */
export function zoneChoiceForPlace(zone: string | null): ZoneChoice | null {
  if (!zone) return null;
  const id = resolveIntlZone(zone);
  return id ? { kind: 'iana', zone: id, guessed: true } : null;
}

export function sameZone(a: ZoneChoice, b: ZoneChoice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'iana' && b.kind === 'iana' && a.zone !== b.zone) return false;
  return zonePinned(a) === zonePinned(b);
}

/**
 * Whether a change of observer calls for a new guess: the position moved, the zone
 * follows the place, and the same change did not already set a zone.
 */
export function needsZoneGuess(prev: ObserverState, next: ObserverState): boolean {
  if (zonePinned(next.zone)) return false;
  if (prev.lat_deg === next.lat_deg && prev.lon_deg === next.lon_deg) return false;
  return sameZone(prev.zone, next.zone);
}

export interface PlaceServiceOptions {
  loadGazetteer?: () => Promise<Gazetteer>;
  loadRegions?: () => Promise<RegionIndex>;
  /** Run a task when the page is idle (the search index takes ~0.2 s to build). */
  idle?: (task: () => void) => void;
}

function whenIdle(task: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(task, { timeout: 3000 });
  else setTimeout(task, 200);
}

export function startPlaceService(store: ExplorerStore, notices: Notices, options: PlaceServiceOptions = {}): PlaceService {
  const data: PlaceData = { gazetteer: null, regions: null, error: null };
  const listeners = new Set<() => void>();
  let stopped = false;

  const emit = (): void => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch (error) {
        console.error('place listener failed', error);
      }
    }
  };

  const guess = (lat: number, lon: number): ZoneGuess | null =>
    data.gazetteer ? guessZone(lat, lon, data.gazetteer, data.regions) : null;

  /** Guess for the current place (when its zone follows the place) and store it if it differs. */
  const refreshZone = (): void => {
    const o = store.get().observer;
    if (zonePinned(o.zone)) return;
    const next = data.gazetteer || data.error ? zoneChoiceFromGuess(guess(o.lat_deg, o.lon_deg)) : null;
    if (next && !sameZone(next, o.zone)) store.patch({ observer: { zone: next } });
  };

  const stopSelect = store.select(
    (s) => s.observer,
    (next, prev) => {
      if (!needsZoneGuess(prev, next)) return;
      if (data.gazetteer || data.error) refreshZone();
    },
    { equals: shallowEqual },
  );

  void (options.loadGazetteer ?? (() => loadGazetteer()))()
    .then((g) => {
      if (stopped) return;
      data.gazetteer = g;
      refreshZone();
      emit();
      (options.idle ?? whenIdle)(() => {
        if (!stopped) prepareSearch(g);
      });
    })
    .catch((error: unknown) => {
      if (stopped) return;
      data.error = error instanceof Error ? error.message : String(error);
      notices.push(
        'caution',
        'Place names and time zones could not be loaded, so searching by name is off and a place you choose gets its nautical zone time. Typed coordinates still work.',
        { key: 'place-data' },
      );
      refreshZone();
      emit();
    });

  void (options.loadRegions ?? (() => loadRegionIndex()))()
    .then((r) => {
      if (stopped) return;
      data.regions = r;
      refreshZone(); // country and state borders make the guess better
      emit();
    })
    .catch(() => {
      // The guess still works from places alone (within 150 NM); nothing to tell the person.
    });

  return {
    data: () => data,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    guess,
    describe(lat, lon) {
      if (!data.gazetteer) return null;
      const atSea = data.regions ? data.regions.locateCountry(lat, lon, 0) === null : undefined;
      const text = describeLocation(data.gazetteer, lat, lon, atSea === undefined ? {} : { atSea }).text;
      return text || null;
    },
    search(text, near) {
      if (!data.gazetteer) return null;
      return interpretQuery(data.gazetteer, text, near ? { limit: 8, near } : { limit: 8 });
    },
    destroy() {
      stopped = true;
      stopSelect();
      listeners.clear();
    },
  };
}
