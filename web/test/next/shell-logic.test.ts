/**
 * The shell's pure logic: display formatting, what it says about the sky, the passage of
 * a body around now, themes, the view fragment, the view registry and the time-zone
 * guess rules. The DOM components are checked visually (docs/design/).
 */

import { describe, expect, it, vi } from 'vitest';
import type { PhaseSegment, SkyEvent } from '../../src/next/engine/types.js';
import {
  bearing3,
  compassPoint,
  eventTime,
  formatAngle,
  formatAzimuth,
  formatDeclination,
  formatDistance,
  formatLength,
  formatMagnitude,
  otherDay,
  relative,
} from '../../src/next/shell/format.js';
import { needsZoneGuess, sameZone, zoneChoiceFromGuess } from '../../src/next/shell/place.js';
import { componentOf, createRegistry, registry } from '../../src/next/shell/registry.js';
import { hashForView, startRouter, viewFromHash } from '../../src/next/shell/router.js';
import { brightening, clipPhases, hoursIn, nextRun, passageAround, segmentAt, skyFacts, sunDay } from '../../src/next/shell/sky.js';
import { effectiveTheme } from '../../src/next/shell/themes.js';
import { createExplorerStore, DEFAULT_OBSERVER, type ObserverState } from '../../src/next/state.js';
import { jdFromIso } from '../../src/next/time.js';

const MINUS = '−';

describe('formatting', () => {
  it('writes angles in the three formats, coarse and fine', () => {
    expect(formatAngle(26.0381, 'dm', 'coarse')).toBe('26° 02′');
    expect(formatAngle(26.0381, 'dm')).toBe('26° 02.3′');
    expect(formatAngle(26.0381, 'dms', 'coarse')).toBe('26° 02′ 17″');
    expect(formatAngle(26.0381, 'decimal')).toBe('26.0381°');
    expect(formatAngle(-16.05, 'dm', 'coarse')).toBe(`${MINUS}16° 03′`);
    expect(formatAngle(-0.0001, 'dm', 'coarse')).toBe('0° 00′'); // no minus on a zero
    expect(formatAngle(59.99999, 'dm', 'coarse')).toBe('60° 00′'); // 60′ carries
    expect(formatAngle(Number.NaN, 'dm')).toBe('—');
  });

  it('never shows an azimuth as 360', () => {
    expect(formatAzimuth(359.9999, 'dm', 'coarse')).toBe('0° 00′');
    expect(formatAzimuth(-0.5, 'decimal', 'coarse')).toBe('359.50°');
    expect(formatAzimuth(244.725, 'dm', 'coarse')).toBe('244° 44′');
    expect(bearing3(90.04)).toBe('090°');
    expect(bearing3(359.6)).toBe('000°');
    expect(compassPoint(244.7)).toBe('WSW');
    expect(compassPoint(-10)).toBe('N');
  });

  it('writes declination, magnitude, lengths and distances', () => {
    expect(formatDeclination(-0.718, 'dm')).toBe('S 0° 43.1′');
    expect(formatMagnitude(-4.56)).toBe(`${MINUS}4.6`);
    expect(formatMagnitude(-0.04)).toBe('0.0');
    expect(formatMagnitude(null)).toBe('—');
    expect(formatLength(2, 'metric')).toBe('2 m');
    expect(formatLength(2.046, 'nautical')).toBe('2.0 m');
    expect(formatLength(2, 'imperial')).toBe('6.6 ft');
    expect(formatDistance(386_920, 'metric')).toBe('386 920 km');
    expect(formatDistance(386_920, 'nautical')).toBe('208 920 NM');
    expect(formatDistance(150_060_030, 'metric')).toBe('1.0031 AU');
    expect(formatDistance(null, 'metric')).toBe('—');
  });

  it('rounds event times to the minute and marks other days', () => {
    const ny = { kind: 'iana', zone: 'America/New_York' } as const;
    const jd = jdFromIso('2026-09-24T22:54:29Z')!; // 18:54:29 EDT
    expect(eventTime(jd, ny)).toBe('18:54');
    expect(eventTime(jd + 1 / 86_400, ny)).toBe('18:55');
    const next = jdFromIso('2026-09-25T09:37:00Z')!;
    expect(otherDay(next, jd, ny)).toBe('Fri');
    expect(otherDay(jd, jd, ny)).toBe('');
    expect(relative(jd, jd + 18 / 1440)).toBe('in 18 min');
    expect(relative(jd, jd + 125 / 1440)).toBe('in 2 h 05 min');
    expect(relative(jd, jd - 5 / 1440)).toBe('5 min ago');
  });
});

// A day at Philadelphia, 24 September 2026 (hours after local midnight), as day_events gives it.
const A = jdFromIso('2026-09-24T04:00:00Z')!;
const at = (h: number): number => A + h / 24;
const PHASES: PhaseSegment[] = (
  [
    [-24, 5.33, 'night'],
    [5.33, 5.86, 'astronomical'],
    [5.86, 6.39, 'nautical'],
    [6.39, 6.84, 'civil'],
    [6.84, 18.91, 'day'],
    [18.91, 19.35, 'civil'],
    [19.35, 19.88, 'nautical'],
    [19.88, 20.41, 'astronomical'],
    [20.41, 29.3, 'night'],
    [29.3, 29.9, 'astronomical'],
    [29.9, 30.4, 'nautical'],
  ] as const
).map(([s, e, phase]) => ({ jd_start: at(s), jd_end: at(e), phase }));

const ev = (kind: SkyEvent['kind'], h: number, az = 0): SkyEvent => ({ kind, jd_utc: at(h), utc: '', alt_deg: 0, az_deg: az });

describe('the sky now', () => {
  it('finds the phase, where it is going, and the next star sights', () => {
    expect(segmentAt(PHASES, at(16.5))!.phase).toBe('day');
    expect(brightening(PHASES, at(19))).toBe(false); // dusk
    expect(brightening(PHASES, at(6))).toBe(true); // dawn
    const afternoon = skyFacts(PHASES, at(16.5), 'day');
    expect(afternoon.phase).toBe('day');
    expect(afternoon.nautical!.jd_start).toBeCloseTo(at(19.35), 9);
    const inNautical = skyFacts(PHASES, at(19.6), 'nautical');
    expect(inNautical.phase).toBe('nautical');
    expect(inNautical.endsAt).toBeCloseTo(at(19.88), 9);
    const lateNight = skyFacts(PHASES, at(23), 'night');
    expect(lateNight.nautical!.jd_start).toBeCloseTo(at(29.9), 9); // tomorrow morning's
    expect(nextRun(PHASES, at(31), 'nautical')).toBeNull();
  });

  it('clips phases to the local day and adds up the daylight', () => {
    const day = clipPhases(PHASES, at(0), at(24));
    expect(day[0]!.jd_start).toBe(at(0));
    expect(day[day.length - 1]!.jd_end).toBe(at(24));
    expect(day.map((p) => p.phase)).toEqual(['night', 'astronomical', 'nautical', 'civil', 'day', 'civil', 'nautical', 'astronomical', 'night']);
    expect(hoursIn(day, 'day')).toBeCloseTo(12.07, 6);
  });

  it('reads the Sun’s twilight times for one local day', () => {
    const events = [ev('civil_dawn', 6.39), ev('rise', 6.84, 90), ev('transit', 12.88), ev('set', 18.91, 270), ev('civil_dusk', 19.35), ev('nautical_dusk', 19.88)];
    const d = sunDay(events, at(0), at(24));
    expect(d.rise!.az_deg).toBe(90);
    expect(d.civil[1]!.jd_utc).toBe(at(19.35));
    expect(d.astronomical).toEqual([null, null]); // not in the events: shown as "—"
  });
});

describe('a body’s passage around now', () => {
  // The Moon: set 04:30, rise 17:55, transit 23:40, set tomorrow 05:37, rise tomorrow 18:17.
  const moon = [ev('set', 4.51), ev('lower_transit', 11.3), ev('rise', 17.91, 99), ev('transit', 23.67), ev('set', 29.61, 265), ev('rise', 42.29, 91)];

  it('while it is up: the rise before, the set after and the transit between', () => {
    const p = passageAround(moon, at(19.6), true);
    expect(p.kind).toBe('up');
    expect(p.rise!.jd_utc).toBe(at(17.91));
    expect(p.transit!.jd_utc).toBe(at(23.67));
    expect(p.set!.jd_utc).toBe(at(29.61));
  });

  it('while it is down: the next rise and the set after it', () => {
    const p = passageAround(moon, at(12), false);
    expect(p.kind).toBe('down');
    expect(p.rise!.jd_utc).toBe(at(17.91));
    expect(p.set!.jd_utc).toBe(at(29.61));
    expect(p.transit!.jd_utc).toBe(at(23.67));
  });

  it('with no rise or set it is up or down all through', () => {
    expect(passageAround([ev('transit', 12), ev('lower_transit', 0)], at(3), true).kind).toBe('always-up');
    const down = passageAround([ev('transit', 12)], at(3), false);
    expect(down.kind).toBe('always-down');
    expect(down.transit!.jd_utc).toBe(at(12));
  });
});

describe('themes, the view fragment and the registry', () => {
  it('follows the device until a theme is picked, and never picks night by itself', () => {
    expect(effectiveTheme('system', true)).toBe('dark');
    expect(effectiveTheme('system', false)).toBe('light');
    expect(effectiveTheme('night', false)).toBe('night');
  });

  it('reads and writes only view names in the fragment', () => {
    expect(viewFromHash('#sky')).toBe('sky');
    expect(viewFromHash('#SKY')).toBe('sky');
    expect(viewFromHash('#v=1&lat=10&lon=20')).toBeNull();
    expect(viewFromHash('')).toBeNull();
    expect(hashForView('charts')).toBe('#charts');

    const store = createExplorerStore({ storage: null, now: () => Date.UTC(2026, 8, 24) });
    const replace = vi.fn();
    const win = {
      location: { hash: '#charts', pathname: '/next/', search: '' },
      history: { state: null, replaceState: replace },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const stop = startRouter(store, win as never);
    expect(store.get().view).toBe('charts'); // the address chose the view
    store.patch({ view: 'sky' });
    expect(replace).toHaveBeenLastCalledWith(null, '', '/next/#sky');
    stop();
  });

  it('finds views by folder, shares one for map and globe, and tolerates missing ones', async () => {
    const mapView = () => ({ destroy() {} });
    const reg = createRegistry(
      { '../map/view.ts': async () => ({ default: mapView }), '../about/view.ts': async () => ({ view: mapView }) },
      { '../plan/slots/star-sights.ts': async () => ({ default: mapView }) },
    );
    expect(reg.view('map')).not.toBeNull();
    expect(reg.view('globe')).toBe(reg.view('map'));
    expect(reg.view('sky')).toBeNull();
    expect(componentOf(await reg.view('about')!())).toBe(mapView);
    expect(reg.slot('star-sights')).not.toBeNull();
    expect(createRegistry({}, {}).slot('star-sights')).toBeNull();
    // An entry by folder wins over a view.ts (Charts is charts/index.ts).
    const chartsEntry = async () => ({ default: mapView });
    expect(createRegistry({}, {}, { charts: chartsEntry }).view('charts')).toBe(chartsEntry);
  });

  it('mounts the merged views from their entry files (one module for Map and Globe)', () => {
    for (const id of ['map', 'globe', 'sky', 'charts', 'almanac', 'about'] as const) expect(registry.view(id), id).not.toBeNull();
    expect(registry.view('globe')).toBe(registry.view('map'));
  });
});

describe('the time-zone guess rules', () => {
  const moved = (o: ObserverState, patch: Partial<ObserverState>): ObserverState => ({ ...o, ...patch });

  it('guesses again when a place whose zone follows it moves', () => {
    const home = DEFAULT_OBSERVER;
    expect(needsZoneGuess(home, moved(home, { lat_deg: 35.68, lon_deg: 139.69 }))).toBe(true);
    expect(needsZoneGuess(home, moved(home, { label: 'renamed' }))).toBe(false);
  });

  it('keeps a pinned zone, and a zone set together with the new place', () => {
    const pinned = moved(DEFAULT_OBSERVER, { zone: { kind: 'iana', zone: 'Europe/London', guessed: false } });
    expect(needsZoneGuess(pinned, moved(pinned, { lat_deg: 0, lon_deg: 0 }))).toBe(false);
    const withZone = moved(DEFAULT_OBSERVER, { lat_deg: 35.68, lon_deg: 139.69, zone: { kind: 'iana', zone: 'Asia/Tokyo', guessed: true } });
    expect(needsZoneGuess(DEFAULT_OBSERVER, withZone)).toBe(false);
  });

  it('turns a guess into a zone that follows the place, nautical at sea', () => {
    expect(zoneChoiceFromGuess(null)).toEqual({ kind: 'nautical', guessed: true });
    const guess = { zone: { kind: 'iana', id: 'Asia/Tokyo' }, source: 'country', reason: '', anchor: null, anchorDistanceNm: 0, country: null } as const;
    expect(zoneChoiceFromGuess(guess)).toEqual({ kind: 'iana', zone: 'Asia/Tokyo', guessed: true });
    expect(sameZone({ kind: 'iana', zone: 'Asia/Tokyo', guessed: true }, { kind: 'iana', zone: 'Asia/Tokyo', guessed: false })).toBe(false);
    // No flag: the zone came with a place and follows it, like a guess (the map's rule too).
    expect(sameZone({ kind: 'iana', zone: 'Asia/Tokyo', guessed: true }, { kind: 'iana', zone: 'Asia/Tokyo' })).toBe(true);
  });
});
