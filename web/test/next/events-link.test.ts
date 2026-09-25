/**
 * Opening the Events view from another view (events/link.ts): the targets, the kinds of
 * event each list shows, the ids its cards answer to (equal to the lists' own), the
 * request channel, and what the view's state becomes for a request.
 */

import { describe, expect, it, vi } from 'vitest';
import { eventIds, eventsRequests, eventsTargetFor, parseEventsTarget, requestPatch, showEvents } from '../../src/next/events/link.js';
import { occultationId } from '../../src/next/events/moon-model.js';
import { showerId } from '../../src/next/events/sky-model.js';
import { createExplorerStore } from '../../src/next/state.js';

const JD_UNIX = 2_440_587.5;
const jdOf = (iso: string): number => Date.parse(iso) / 86_400_000 + JD_UNIX;

describe('opening the Events view on a list at an event', () => {
  it('reads targets as the tab and its list, and refuses names the view does not have', () => {
    expect(parseEventsTarget('eclipses')).toEqual({ tab: 'eclipses', sub: null });
    expect(parseEventsTarget('moon/occultations')).toEqual({ tab: 'moon', sub: 'occultations' });
    expect(parseEventsTarget('planets/jupiter')).toEqual({ tab: 'planets', sub: 'jupiter' });
    expect(parseEventsTarget('moon/transits')).toBeNull();
    expect(parseEventsTarget('planets/transits/x')).toBeNull();
    expect(parseEventsTarget('comets')).toBeNull();
  });

  it('knows which list shows each kind of Tonight’s "Coming up" items', () => {
    const kinds = ['phase', 'apsis', 'eclipse', 'conjunction', 'occultation', 'shower', 'planet', 'station', 'season', 'earth', 'transit', 'galilean'];
    const targets = kinds.map(eventsTargetFor);
    expect(targets).toEqual([
      'moon/phases',
      'moon/apsides',
      'eclipses',
      'planets/conjunctions',
      'moon/occultations',
      'meteors',
      'planets/events',
      'planets/retrograde',
      'seasons',
      'seasons',
      'planets/transits',
      'planets/jupiter',
    ]);
    for (const t of targets) expect(parseEventsTarget(t!)).not.toBeNull();
    expect(eventsTargetFor('comet')).toBeNull();
  });

  it('builds the same ids as the lists do, far dates included', () => {
    for (const iso of ['2026-10-07T03:12:00Z', '-0584-05-28T12:00:00Z', '12026-01-01T00:00:00Z']) {
      const jd = iso.startsWith('-') ? 1507905.5 : iso.startsWith('12026') ? 6113843.5 : jdOf(iso);
      expect(eventIds.occultation('Regulus', jd)).toBe(occultationId({ body: 'Regulus', closest: { jd_utc: jd } as never }));
      expect(eventIds.shower('PER', jd)).toBe(showerId({ shower: { code: 'PER' } as never, peak: { jd_utc: jd } as never }));
    }
    expect(eventIds.occultation('Regulus', 1507905.5)).toBe('occultation-Regulus--0584-05-28');
    expect(eventIds.eclipse('2024-04-08-solar')).toBe('eclipse-2024-04-08-solar');
  });

  it('turns a request into the view’s state: the list, built from the event, and the card', () => {
    const jd = jdOf('2024-04-08T18:17:00Z');
    expect(requestPatch({ tab: 'eclipses', sub: null, ref: { jd, id: eventIds.eclipse('2024-04-08-solar') } })).toEqual({
      tab: 'eclipses',
      anchor: jd,
      eclipseDirection: 'upcoming',
      selected: '2024-04-08-solar',
    });
    expect(requestPatch({ tab: 'moon', sub: 'occultations', ref: { jd, id: 'occultation-Regulus-2024-04-08' } })).toEqual({
      tab: 'moon',
      moonSub: 'occultations',
      anchor: jd,
      occultationDirection: 'upcoming',
      occultation: 'occultation-Regulus-2024-04-08',
    });
    expect(requestPatch({ tab: 'planets', sub: 'transits', ref: { jd, id: 'transit-x' } })).toEqual({
      tab: 'planets',
      planetSub: 'transits',
      anchor: jd,
      transitDirection: 'upcoming',
      transit: 'transit-x',
    });
    expect(requestPatch({ tab: 'meteors', sub: null, ref: { jd, id: eventIds.shower('GEM', jd) } })).toEqual({ tab: 'meteors', anchor: jd, showerYear: null, shower: 'GEM' });
    expect(requestPatch({ tab: 'meteors', sub: null, ref: { id: 'PER' } })).toEqual({ tab: 'meteors', shower: 'PER' });
    // Without an instant the list keeps its direction and anchor; a list without cards ignores an id.
    expect(requestPatch({ tab: 'planets', sub: 'retrograde', ref: { id: 'station-Mars-direct-2027-01-01' } })).toEqual({ tab: 'planets', planetSub: 'retrograde' });
    expect(requestPatch({ tab: 'seasons', sub: null, ref: { jd } })).toEqual({ tab: 'seasons', anchor: jd });
  });

  it('keeps one request per explorer until the view takes it, and tells a mounted view at once', () => {
    const a = eventsRequests({});
    const store = {};
    const b = eventsRequests(store);
    expect(eventsRequests(store)).toBe(b);
    const heard = vi.fn();
    const stop = b.subscribe(heard);
    b.set({ tab: 'seasons', sub: null, ref: {} });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(a.get()).toBeNull();
    expect(b.take()).toEqual({ tab: 'seasons', sub: null, ref: {} });
    expect(b.get()).toBeNull();
    stop();
    b.set(null);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('showEvents moves the time to the event, selects its body, opens the view and posts the request', () => {
    const store = createExplorerStore({ storage: null, now: () => Date.parse('2026-09-25T16:00:00Z') });
    const jd = jdOf('2026-10-07T03:12:00Z');
    const seen: string[] = [];
    store.select(
      (s) => s.view,
      (v) => seen.push(v),
    );
    showEvents(store, 'moon/occultations', { jd, body: 'Moon', id: eventIds.occultation('Regulus', jd) });
    const s = store.get();
    expect(s.view).toBe('events');
    expect(s.time.jd_utc).toBe(jd);
    expect(s.time.live).toBe(false);
    expect(s.selection.body).toBe('Moon');
    expect(eventsRequests(store).get()).toEqual({ tab: 'moon', sub: 'occultations', ref: { jd, body: 'Moon', id: 'occultation-Regulus-2026-10-07' } });
    // An unknown target opens the view as it was, with no request.
    eventsRequests(store).take();
    showEvents(store, 'comets' as never);
    expect(eventsRequests(store).get()).toBeNull();
    expect(seen).toEqual(['events']);
  });
});
