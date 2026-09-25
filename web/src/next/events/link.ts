/**
 * Opening the Events view on a list and an event, from another view (Tonight's "Coming up",
 * a link in the Selected card). OWNER: events2 agent (expansion programme Q4).
 *
 * The pattern of `tonight/sky-link.ts`: a per-explorer channel, `eventsRequests(store)`,
 * keyed by the store and outliving the views, so a request made while another view shows is
 * waiting when the Events view mounts, and a mounted Events view answers it at once.
 * `showEvents(store, target, ref)` is the one call a caller needs, as charts2's
 * `showCharts(store, tab, sub)` is for the Charts view: it sets the explorer's time to the
 * event and selects its body, opens the Events view, and posts the request (the tab, the
 * Moon's or the planets' list, and the card to open). The list is then built from the event,
 * so it heads an upcoming list.
 *
 * Light on purpose (the store, playback and time helpers, and types only), so another view
 * can import it without loading the Events view:
 *
 * ```ts
 * import { eventIds, eventsTargetFor, showEvents } from '../events/link.js';
 * showEvents(store, 'eclipses', { jd: e.greatest.jd_utc, body: 'Sun', id: eventIds.eclipse(e.id) });
 * showEvents(store, 'moon/occultations', { jd, body: 'Moon', id: eventIds.occultation(o.body, o.closest.jd_utc) });
 * showEvents(store, eventsTargetFor('station'), { jd: s.jd_utc, body: s.body });
 * ```
 */

import { setTime } from '../playback.js';
import type { ExplorerStore } from '../state.js';
import { isoUtc } from '../time.js';
import type { EventsTab, EventsUi, MoonSub, PlanetSub } from './env.js';

/** A tab of the Events view, or one of the Moon's or the planets' lists. */
export type EventsTarget = EventsTab | `moon/${MoonSub}` | `planets/${PlanetSub}`;

/** The event to show. Every field is optional: without any, the view opens on the list as it was. */
export interface EventsRef {
  /** The event's instant (UTC Julian date): the explorer's time is set to it and the list starts there. */
  jd?: number | null;
  /** The body to select (the Moon for its phases, the planet of a station…). */
  body?: string | null;
  /**
   * The event whose card to open, by the id the Events view gives it (the same as its
   * calendar files' UIDs, CONVENTIONS 15.8; build one with `eventIds`): an eclipse, an
   * occultation, a transit or a meteor shower. Lists without cards ignore it.
   */
  id?: string | null;
}

/** A request on the channel: the tab, its list, and the event. */
export interface EventsRequest {
  tab: EventsTab;
  sub: MoonSub | PlanetSub | null;
  ref: EventsRef;
}

export interface EventsRequests {
  /** The request not answered yet, or null. */
  get(): EventsRequest | null;
  set(request: EventsRequest | null): void;
  /** Takes the request (the Events view answers it): returns it and leaves null. */
  take(): EventsRequest | null;
  subscribe(listener: (request: EventsRequest | null) => void): () => void;
}

const TABS: readonly EventsTab[] = ['eclipses', 'moon', 'planets', 'meteors', 'seasons'];
const MOON_SUBS: readonly MoonSub[] = ['phases', 'apsides', 'occultations'];
const PLANET_SUBS: readonly PlanetSub[] = ['events', 'conjunctions', 'retrograde', 'transits', 'jupiter'];

/** `moon/occultations` → the tab and its list; null for a name the view does not have. */
export function parseEventsTarget(target: string): { tab: EventsTab; sub: MoonSub | PlanetSub | null } | null {
  const [tab, sub, ...rest] = target.split('/');
  if (rest.length || !TABS.includes(tab as EventsTab)) return null;
  if (sub === undefined) return { tab: tab as EventsTab, sub: null };
  if (tab === 'moon' && MOON_SUBS.includes(sub as MoonSub)) return { tab, sub: sub as MoonSub };
  if (tab === 'planets' && PLANET_SUBS.includes(sub as PlanetSub)) return { tab, sub: sub as PlanetSub };
  return null;
}

/**
 * The list that shows an event of a kind: `phase`, `apsis` (the Moon's perigee or apogee),
 * `eclipse`, `conjunction`, `occultation`, `shower`, `planet` (an opposition, elongation or
 * closest approach), `station`, `season`, `earth` (perihelion or aphelion), `transit`,
 * `galilean` (Jupiter's moons). The names are those of Tonight's "Coming up" items.
 */
export function eventsTargetFor(kind: string): EventsTarget | null {
  return KIND_TARGETS[kind] ?? null;
}

const KIND_TARGETS: Readonly<Record<string, EventsTarget>> = {
  phase: 'moon/phases',
  apsis: 'moon/apsides',
  eclipse: 'eclipses',
  conjunction: 'planets/conjunctions',
  occultation: 'moon/occultations',
  shower: 'meteors',
  planet: 'planets/events',
  station: 'planets/retrograde',
  season: 'seasons',
  earth: 'seasons',
  transit: 'planets/transits',
  galilean: 'planets/jupiter',
};

/** The UTC date of an instant as the ids write it (ISO expanded years outside 0000-9999). */
function idDate(jd: number): string {
  const iso = isoUtc(jd);
  return iso.slice(0, iso.indexOf('T'));
}

/**
 * The ids the Events view's cards answer to: the same as the lists' own (`items.ts`,
 * `moon-model.ts`, `sky-model.ts`; tested equal) and their calendar files' UIDs.
 */
export const eventIds = {
  /** An eclipse, from the engine's id (`2024-04-08-solar`). */
  eclipse: (engineId: string): string => `eclipse-${engineId}`,
  /** An occultation, from the body hidden and the instant of the Moon's closest approach. */
  occultation: (body: string, closestJd: number): string => `occultation-${body}-${idDate(closestJd)}`,
  /** A transit of Mercury or Venus, from the engine's id. */
  transit: (engineId: string): string => `transit-${engineId}`,
  /** A meteor shower's peak, from the shower's code (`PER`) and the peak's instant. */
  shower: (code: string, peakJd: number): string => `meteors-${code}-${idDate(peakJd)}`,
};

const channels = new WeakMap<object, EventsRequests>();

/** The explorer's channel (keyed by its store), created on first use. */
export function eventsRequests(store: object): EventsRequests {
  let channel = channels.get(store);
  if (!channel) {
    let current: EventsRequest | null = null;
    const listeners = new Set<(r: EventsRequest | null) => void>();
    channel = {
      get: () => current,
      set(request) {
        current = request;
        for (const listener of [...listeners]) {
          try {
            listener(current);
          } catch (error) {
            console.error('events request listener failed', error);
          }
        }
      },
      take() {
        const r = current;
        current = null;
        return r;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    channels.set(store, channel);
  }
  return channel;
}

/**
 * Open the Events view on a list at an event: the explorer's time moves to the event (when
 * `ref.jd` is given) and its body is selected, the view opens, and the list and card follow
 * the request. An unknown target opens the view as it was.
 */
export function showEvents(store: ExplorerStore, target: EventsTarget, ref: EventsRef = {}): void {
  const parsed = parseEventsTarget(target);
  store.batch(() => {
    if (typeof ref.jd === 'number' && Number.isFinite(ref.jd)) setTime(store, ref.jd);
    if (ref.body) store.patch({ selection: { body: ref.body } });
    if (store.get().view !== 'events') store.patch({ view: 'events' });
  });
  if (parsed) eventsRequests(store).set({ ...parsed, ref: { ...ref } });
}

/**
 * What the Events view's own state becomes for a request: the tab and list; the list built
 * from the event and running forward (so the event heads it); the card opened. Pure.
 */
export function requestPatch(r: EventsRequest): Partial<EventsUi> {
  const p: Partial<EventsUi> = { tab: r.tab };
  const at = typeof r.ref.jd === 'number' && Number.isFinite(r.ref.jd) ? r.ref.jd : null;
  const id = r.ref.id || null;
  if (at !== null) p.anchor = at;
  switch (r.tab) {
    case 'eclipses':
      if (at !== null) p.eclipseDirection = 'upcoming';
      if (id) p.selected = id.replace(/^eclipse-/, '');
      break;
    case 'moon': {
      const sub = r.sub as MoonSub | null;
      if (sub) p.moonSub = sub;
      if (sub === 'apsides' && at !== null) p.apsisDirection = 'upcoming';
      if (sub === 'occultations') {
        if (at !== null) p.occultationDirection = 'upcoming';
        if (id) p.occultation = id;
      }
      break;
    }
    case 'planets': {
      const sub = r.sub as PlanetSub | null;
      if (sub) p.planetSub = sub;
      if (at !== null) {
        if (sub === 'events') p.planetDirection = 'upcoming';
        if (sub === 'conjunctions') p.conjunctionDirection = 'upcoming';
        if (sub === 'transits') p.transitDirection = 'upcoming';
      }
      if (sub === 'transits' && id) p.transit = id;
      break;
    }
    case 'meteors':
      // The year of the list follows the anchor; the card is the shower's (its code).
      if (at !== null) p.showerYear = null;
      if (id) p.shower = /^meteors-([^-]+)-/.exec(id)?.[1] ?? id;
      break;
    case 'seasons':
      break;
  }
  return p;
}
