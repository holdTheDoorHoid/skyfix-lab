/**
 * The Events view's pure logic (events/model.ts), its map overlays (events/mapping.ts),
 * and the optional eclipse and planet-event methods of the memoised engine. The DOM is
 * checked visually (events/dev/screenshots.mjs). The last block runs against the built
 * WebAssembly package when there is one: every eclipse path of 2017-2030 must become
 * overlays the map can draw.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { memoEngine } from '../../src/next/component.js';
import {
  isEclipseEngine,
  isPlanetEventsEngine,
  type EclipseLocalEvent,
  type EclipseLocalEventKind,
  type EclipsePolyline,
  type ExplorerEngine,
  type LunarEclipse,
  type LunarEclipseLocal,
  type LunarEclipsePath,
  type PhaseEvent,
  type PlanetEvent,
  type SolarEclipse,
  type SolarEclipseLocal,
  type SolarEclipsePath,
} from '../../src/next/engine/types.js';
import { inspectWasmModule, type WasmLoad } from '../../src/next/engine/wasm.js';
import { eclipseIdDate, jumpTarget } from '../../src/next/events/eclipses.js';
import { bigDistance } from '../../src/next/events/lists.js';
import {
  clearEclipse,
  eclipseOnMap,
  fitTarget,
  joinSegments,
  lunarOverlays,
  OVERLAY_PREFIX,
  pathRing,
  polylineFeature,
  showEclipse,
  solarOverlays,
} from '../../src/next/events/mapping.js';
import {
  brightnessWords,
  covers,
  eclipseAtPhase,
  eclipsesAround,
  eclipseSpan,
  eclipseTitle,
  formatDuration,
  formatPercent,
  hereLabel,
  inProgress,
  lunarSummary,
  lunations,
  neededSpan,
  nextAfter,
  paddedSpan,
  planetEventTitle,
  planetEventWords,
  planetRows,
  seasonWords,
  solarSummary,
  SpanCache,
  type Words,
} from '../../src/next/events/model.js';
import { MapServiceImpl } from '../../src/next/map/overlays.js';

// ---------------------------------------------------------------------------
// Fixtures: 2024-04-08 from Dallas, 2025-03-14 from London (numbers from the engine)
// ---------------------------------------------------------------------------

const G = 2460409.262037; // 2024-04-08 greatest eclipse

function ev(
  kind: EclipseLocalEventKind,
  jd: number,
  alt: number,
  extra: Partial<EclipseLocalEvent> = {},
): EclipseLocalEvent {
  return {
    kind,
    jd_utc: jd,
    utc: '',
    alt_deg: alt,
    az_deg: 180,
    visible: alt > -0.83,
    position_angle_deg: null,
    vertex_angle_deg: null,
    magnitude: null,
    obscuration: null,
    ...extra,
  };
}

const solar2024: SolarEclipse = {
  kind: 'solar',
  id: '2024-04-08-solar',
  type: 'total',
  central: true,
  greatest: { jd_utc: G, utc: '2024-04-08T18:17:19.972Z', jd_tt: G + 69.184 / 86400, lat_deg: 25.289, lon_deg: -104.146, sun_alt_deg: 69.79, sun_az_deg: 149.39 },
  magnitude: 1.05656,
  gamma: 0.34312,
  saros: 139,
  lunation: 300,
  contacts: [
    { kind: 'p1', jd_utc: 2460409.154328, utc: '' },
    { kind: 'u1', jd_utc: 2460409.193649, utc: '' },
    { kind: 'u4', jd_utc: 2460409.330280, utc: '' },
    { kind: 'p4', jd_utc: 2460409.369686, utc: '' },
  ],
  path_width_km: 197.5,
  central_duration_s: 268,
  delta_t_s: 69.184,
};

const dallas: SolarEclipseLocal = {
  kind: 'solar',
  id: '2024-04-08-solar',
  observer: { lat_deg: 32.78, lon_deg: -96.8, height_m: 150 },
  visibility: 'visible',
  local_type: 'total',
  magnitude: 1.01471,
  obscuration: 1,
  duration_s: 9562.5,
  central_duration_s: 230.5,
  events: [
    ev('c1', 2460409.2245, 60.57),
    ev('c2', 2460409.2783, 64.7),
    ev('max', 2460409.2796, 64.6, { magnitude: 1.01471, obscuration: 1 }),
    ev('c3', 2460409.2810, 64.5),
    ev('c4', 2460409.3352, 56.7),
  ],
  visible_max: ev('max', 2460409.2796, 64.6, { magnitude: 1.01471, obscuration: 1 }),
  delta_t_s: 69.184,
};

const words: Words = {
  place: 'Dallas',
  time: (jd) => {
    const m = Math.round(((jd + 0.5) % 1) * 1440);
    return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  },
  altitude: (deg) => `${Math.round(deg)}°`,
  direction: () => 'south',
  position: (lat, lon) => `${lat.toFixed(1)}, ${lon.toFixed(1)}`,
};

const lunar2025: LunarEclipse = {
  kind: 'lunar',
  id: '2025-03-14-lunar',
  type: 'total',
  greatest: { jd_utc: 2460748.790814, utc: '', jd_tt: 2460748.791615, lat_deg: 2.682, lon_deg: -102.251 },
  umbral_magnitude: 1.17843,
  penumbral_magnitude: 2.2595,
  gamma: 0.34843,
  saros: 123,
  lunation: 311,
  contacts: [
    { kind: 'p1', jd_utc: 2460748.664912, utc: '' },
    { kind: 'p4', jd_utc: 2460748.916753, utc: '' },
  ],
  penumbral_duration_s: 21760.2,
  partial_duration_s: 13095.7,
  total_duration_s: 3924.1,
  delta_t_s: 69.184,
};

const london: LunarEclipseLocal = {
  kind: 'lunar',
  id: '2025-03-14-lunar',
  observer: { lat_deg: 51.5074, lon_deg: -0.1278, height_m: 0 },
  visibility: 'partly_below_horizon',
  events: [
    ev('p1', 2460748.6649, 21.2),
    ev('u1', 2460748.7148, 10.5),
    ev('moonset', 2460748.7659, -0.81),
    ev('u2', 2460748.7677, -1.29),
    ev('max', 2460748.7908, -5.5),
    ev('u3', 2460748.8132, -9.6),
  ],
  delta_t_s: 69.184,
};

// ---------------------------------------------------------------------------

describe('spans asked of the engine', () => {
  it('asks ahead for upcoming lists and back for past ones, with a lead for events in progress', () => {
    expect(neededSpan(100, 'upcoming', 10)).toEqual({ start: 99, end: 110 });
    expect(neededSpan(100, 'past', 10)).toEqual({ start: 90, end: 101 });
    expect(covers({ start: 0, end: 200 }, { start: 99, end: 110 })).toBe(true);
    expect(covers({ start: 100, end: 200 }, { start: 99, end: 110 })).toBe(false);
    expect(covers(null, { start: 1, end: 2 })).toBe(false);
    expect(paddedSpan({ start: 99.2, end: 110.7 }, 5)).toEqual({ start: 94, end: 116 });
  });

  it('computes once while the anchor moves inside the slack, and again beyond it', () => {
    const calls: [number, number][] = [];
    const cache = new SpanCache((s) => {
      calls.push([s.start, s.end]);
      return calls.length;
    }, 30);
    expect(cache.get(neededSpan(1000, 'upcoming', 365))).toBe(1);
    expect(cache.get(neededSpan(1010.5, 'upcoming', 365))).toBe(1);
    expect(cache.get(neededSpan(1029, 'upcoming', 365))).toBe(1);
    expect(cache.get(neededSpan(1040, 'upcoming', 365))).toBe(2);
    expect(cache.get(neededSpan(900, 'upcoming', 365))).toBe(3);
    cache.clear();
    expect(cache.get(neededSpan(900, 'upcoming', 365))).toBe(4);
  });
});

describe('which eclipses a list shows', () => {
  const a = { ...solar2024 };
  const b: SolarEclipse = { ...solar2024, id: '2024-10-02-solar', greatest: { ...solar2024.greatest, jd_utc: G + 177 }, contacts: [] };
  const c = { ...lunar2025 };

  it('lists upcoming eclipses soonest first, keeping one in progress', () => {
    const during = G + 0.05; // after greatest eclipse, before the last contact
    expect(inProgress(a, during)).toBe(true);
    expect(eclipseSpan(a)).toEqual({ start: 2460409.154328, end: 2460409.369686 });
    expect(eclipsesAround([c, b, a], during, 'upcoming').map((e) => e.id)).toEqual([a.id, b.id, c.id]);
    expect(eclipsesAround([c, b, a], during, 'upcoming', 'solar').map((e) => e.id)).toEqual([a.id, b.id]);
    expect(eclipsesAround([c, b, a], during, 'upcoming', 'lunar').map((e) => e.id)).toEqual([c.id]);
    expect(eclipsesAround([c, b, a], during, 'upcoming', 'all', 100).map((e) => e.id)).toEqual([a.id]);
  });

  it('lists past eclipses most recent first, only once they are over', () => {
    expect(eclipsesAround([a, b, c], G + 0.05, 'past')).toEqual([]);
    expect(eclipsesAround([a, b, c], G + 400, 'past').map((e) => e.id)).toEqual([c.id, b.id, a.id]);
  });

  it('names eclipses and reads their ids', () => {
    expect(eclipseTitle(a)).toBe('Total solar eclipse');
    expect(eclipseTitle({ ...lunar2025, type: 'penumbral' })).toBe('Penumbral lunar eclipse');
    expect(eclipseIdDate('2024-04-08-solar')).toBe(2460408.5);
    expect(eclipseIdDate('2024-04-08')).toBeNull();
  });
});

describe('what the place sees, in words', () => {
  it('formats durations and fractions without overclaiming', () => {
    expect(formatDuration(58.4)).toBe('58 s');
    expect(formatDuration(230.5)).toBe('3 min 51 s');
    expect(formatDuration(180)).toBe('3 min');
    expect(formatDuration(9562.5)).toBe('2 h 39 min');
    expect(formatDuration(null)).toBe('—');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.9996)).toBe('99.9%');
    expect(formatPercent(0.8912)).toBe('89%');
    expect(formatPercent(0.004)).toBe('under 1%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('says a place in the path is in totality, with the time it begins', () => {
    const label = hereLabel(solar2024, dallas, words.time);
    expect(label).toEqual({ seen: true, text: 'Total here at 18:41, for 3 min 51 s', tone: 'central' });
    expect(hereLabel(solar2024, dallas).text).toBe('Total here, for 3 min 51 s');
  });

  it('says how much is covered at a partial eclipse, and when the Sun is on the horizon', () => {
    const partial: SolarEclipseLocal = {
      ...dallas,
      local_type: 'partial',
      obscuration: 0.89,
      central_duration_s: null,
      events: dallas.events.filter((e) => e.kind !== 'c2' && e.kind !== 'c3'),
      visible_max: ev('max', G, 44, { obscuration: 0.89, magnitude: 0.9 }),
    };
    expect(hereLabel(solar2024, partial, words.time).text).toBe(`Partial here at ${words.time(G)}, 89% covered`);
    const atSunrise: SolarEclipseLocal = { ...partial, visibility: 'partly_below_horizon', visible_max: ev('sunrise', G, -0.83, { obscuration: 0.16 }) };
    expect(hereLabel(solar2024, atSunrise, words.time).text).toBe(`Partial here at sunrise (${words.time(G)}), 16% covered`);
    expect(hereLabel(solar2024, { ...partial, visibility: 'none' }).seen).toBe(false);
    expect(hereLabel(solar2024, { ...partial, visibility: 'below_horizon' }).text).toBe('Not seen here: the Sun is down');
  });

  it('tells a lunar eclipse seen until moonset', () => {
    const label = hereLabel(lunar2025, london, words.time);
    expect(label.seen).toBe(true);
    expect(label.text).toBe(`Seen here, until moonset at ${words.time(2460748.7659)}`);
    expect(hereLabel({ ...lunar2025, type: 'penumbral' }, { ...london, visibility: 'visible', events: [ev('max', 1, 30)] }, words.time).text).toBe(
      `Seen here (faint), greatest at ${words.time(1)}`,
    );
    expect(hereLabel(lunar2025, { ...london, visibility: 'below_horizon' }).text).toBe('Not seen here: the Moon is down');
  });

  it('writes a plain-language account of a total solar eclipse', () => {
    const text = solarSummary(solar2024, dallas, words).join(' ');
    expect(text).toContain('Dallas is inside the path of totality.');
    expect(text).toContain('completely for 3 min 51 s');
    expect(text).toContain('with the Sun 65° up in the south');
    expect(text).toContain('2 h 39 min in all');
  });

  it('says why nothing can be seen, and where the eclipse is', () => {
    const none = solarSummary(solar2024, { ...dallas, visibility: 'none', events: [], visible_max: null }, words);
    expect(none[0]).toBe('The Moon’s shadow misses Dallas: nothing of this eclipse can be seen there.');
    expect(none[1]).toContain('Greatest eclipse is at 25.3, -104.1');
    const night = solarSummary(solar2024, { ...dallas, visibility: 'below_horizon', visible_max: null }, words);
    expect(night[0]).toContain('while the Sun is below the horizon at Dallas');
  });

  it('writes the account of a lunar eclipse the Moon sets during', () => {
    const text = lunarSummary(lunar2025, london, { ...words, place: 'London' });
    expect(text[0]).toContain('At London the Moon sets at');
    expect(text[1]).toContain('Totality lasts 1 h 05 min');
    expect(text[1]).toContain('not all of it with the Moon up there');
    expect(text[1]).toContain('comes with the Moon below the horizon there');
    const down = lunarSummary(lunar2025, { ...london, visibility: 'below_horizon' }, words);
    expect(down[0]).toContain('The Moon is below the horizon at Dallas throughout');
  });

  it('jumps to the most the place sees: the local maximum, or the first moment the Moon is up', () => {
    expect(jumpTarget(solar2024, dallas)).toBe(2460409.2796);
    expect(jumpTarget(solar2024, null)).toBe(G);
    expect(jumpTarget(lunar2025, london)).toBe(2460748.6649);
    expect(jumpTarget(lunar2025, { ...london, visibility: 'below_horizon' })).toBe(lunar2025.greatest.jd_utc);
  });
});

describe('planet events', () => {
  const pe = (body: string, kind: PlanetEvent['kind'], jd: number, extra: Partial<PlanetEvent> = {}): PlanetEvent => ({
    kind,
    body,
    jd_utc: jd,
    utc: '',
    elongation_deg: kind === 'opposition' ? 179 : 20,
    distance_au: 1,
    distance_km: 149_597_870.7,
    magnitude: -2,
    ra_deg: 0,
    dec_deg: 0,
    transit: false,
    ...extra,
  });

  it('tells each closest approach with its opposition or inferior conjunction', () => {
    const events = [
      pe('Mars', 'perigee', 1000),
      pe('Mars', 'opposition', 1008),
      pe('Venus', 'inferior_conjunction', 1100),
      pe('Venus', 'perigee', 1101),
      pe('Jupiter', 'perigee', 1200),
      pe('Mercury', 'greatest_elongation_east', 1300),
    ];
    const rows = planetRows(events, 990, 'upcoming', 400);
    expect(rows.map((r) => `${r.event.body} ${r.event.kind} ${r.approach?.jd_utc ?? '-'}`)).toEqual([
      'Mars opposition 1000',
      'Venus inferior_conjunction 1101',
      'Jupiter perigee -',
      'Mercury greatest_elongation_east -',
    ]);
    // A partner outside the list leaves the approach on its own; past lists run backwards.
    expect(planetRows(events, 1005, 'past', 400).map((r) => r.event.kind)).toEqual(['perigee']);
    expect(planetRows(events, 2000, 'past', 1500).map((r) => r.event.body)).toEqual(['Mercury', 'Jupiter', 'Venus', 'Mars']);
  });

  it('names and explains the events in plain words', () => {
    const w = { angle: (d: number) => `${d.toFixed(1)}°`, magnitude: (m: number | null) => String(m), distance: (km: number) => `${Math.round(km)} km`, date: () => '9 Jan' };
    expect(planetEventTitle(pe('Mercury', 'inferior_conjunction', 1, { transit: true }))).toBe('Transit of Mercury');
    expect(planetEventTitle(pe('Jupiter', 'conjunction', 1))).toBe('Jupiter in conjunction with the Sun');
    expect(planetEventWords(pe('Mars', 'opposition', 1), w, pe('Mars', 'perigee', 0))).toContain('Closest to the Earth on 9 Jan: 149597871 km.');
    expect(planetEventWords(pe('Venus', 'greatest_elongation_east', 1, { elongation_deg: 46.5 }), w)).toContain('46.5°');
    expect(planetEventWords(pe('Venus', 'greatest_elongation_west', 1), w)).toContain('morning sky');
    expect(brightnessWords(7.7, String)).toContain('binoculars');
    expect(brightnessWords(5.6, String)).toContain('only just visible');
    expect(brightnessWords(-2.7, String)).toBe(' (magnitude -2.7)');
    expect(brightnessWords(null, String)).toBe('');
    expect(bigDistance(0.2728 * 149_597_870.7, 'metric')).toBe('0.273 AU, 40.8 million km');
    expect(bigDistance(28.876 * 149_597_870.7, 'imperial')).toBe('28.88 AU, 2.68 billion miles');
  });
});

describe('Moon phases and seasons', () => {
  const kinds: PhaseEvent['kind'][] = ['new_moon', 'first_quarter', 'full_moon', 'last_quarter'];
  const phases: PhaseEvent[] = [];
  for (let i = 0; i < 40; i++) phases.push({ kind: kinds[i % 4]!, jd_utc: 1000 + i * 7.38, utc: '' });

  it('starts with the lunation in progress and groups each from its new moon', () => {
    const months = lunations(phases, 1010, 3);
    expect(months.map((m) => m.start.jd_utc)).toEqual([1000, 1000 + 4 * 7.38, 1000 + 8 * 7.38]);
    expect(months[0]!.phases.map((p) => p.kind)).toEqual(kinds);
    expect(lunations(phases, 900, 1)[0]!.start.jd_utc).toBe(1000);
    expect(lunations([], 900)).toEqual([]);
  });

  it('marks the eclipse at a new or full moon', () => {
    expect(eclipseAtPhase({ kind: 'full_moon', jd_utc: lunar2025.greatest.jd_utc + 0.2, utc: '' }, [solar2024, lunar2025])?.id).toBe(lunar2025.id);
    expect(eclipseAtPhase({ kind: 'new_moon', jd_utc: lunar2025.greatest.jd_utc, utc: '' }, [lunar2025])).toBeNull();
    expect(eclipseAtPhase({ kind: 'first_quarter', jd_utc: G, utc: '' }, [solar2024])).toBeNull();
  });

  it('tells the seasons for the hemisphere the place is in', () => {
    expect(seasonWords('june_solstice', 40)).toContain('the longest day of the year where you are. Summer begins in the northern hemisphere');
    expect(seasonWords('june_solstice', -33)).toContain('the shortest day of the year where you are. Winter begins in the southern hemisphere');
    expect(seasonWords('march_equinox', -33)).toContain('Autumn begins in the southern hemisphere, where you are, and spring in the northern.');
    expect(nextAfter([{ jd_utc: 3 }, { jd_utc: 1 }, { jd_utc: 2 }], 1.5)).toEqual({ jd_utc: 2 });
    expect(nextAfter([{ jd_utc: 1 }], 2)).toBeNull();
  });
});

describe('eclipses on the map', () => {
  const line = (segments: [number, number][][]): EclipsePolyline => ({ segments, jd_utc: segments.map((s) => s.map(() => 0)) });

  it('undoes the antimeridian cuts to join a limit, and leaves separate pieces apart', () => {
    const across = line([
      [[170, 10], [180, 12]],
      [[-180, 12], [-170, 14]],
    ]);
    expect(joinSegments(across)).toEqual([
      [
        { lat_deg: 10, lon_deg: 170 },
        { lat_deg: 12, lon_deg: 180 },
        { lat_deg: 14, lon_deg: -170 },
      ],
    ]);
    expect(joinSegments(line([[[0, 0], [1, 1]], [[5, 5], [6, 6]]]))).toHaveLength(2);
    expect(polylineFeature(line([[[0, 0]]]), {})).toBeNull();
    expect(polylineFeature(across, { a: 1 })?.geometry.coordinates).toHaveLength(2);
  });

  it('outlines the path between the limits, and refuses rings that would go round a pole', () => {
    const north = line([[[-100, 31], [-90, 36], [-80, 41]]]);
    const south = line([[[-100, 29], [-90, 34], [-80, 39]]]);
    const ring = pathRing(north, south)!;
    expect(ring.map((p) => p.lon_deg)).toEqual([-100, -90, -80, -80, -90, -100]);
    // The second limit given the other way round is turned.
    const reversed = line([[[-80, 39], [-90, 34], [-100, 29]]]);
    expect(pathRing(north, reversed)!.map((p) => p.lat_deg)).toEqual([31, 36, 41, 39, 34, 29]);
    // Polar paths and limits in pieces are not filled.
    expect(pathRing(line([[[0, 80], [90, 87], [180, 80]]]), line([[[0, 78], [90, 84], [180, 78]]]))).toBeNull();
    expect(pathRing(line([[[0, 0], [1, 1]], [[5, 5], [6, 6]]]), south)).toBeNull();
    expect(pathRing(line([]), south)).toBeNull();
  });

  const path: SolarEclipsePath = {
    kind: 'solar',
    id: '2024-04-08-solar',
    type: 'total',
    central: true,
    greatest: solar2024.greatest,
    central_line: line([[[-100, 30], [-90, 35], [-80, 40]]]),
    umbra_north: line([[[-100, 31], [-90, 36], [-80, 41]]]),
    umbra_south: line([[[-100, 29], [-90, 34], [-80, 39]]]),
    umbra_horizon: line([]),
    penumbra_north: line([[[-120, 60], [-60, 70]]]),
    penumbra_south: line([[[-120, 0], [-60, 10]]]),
    penumbra_horizon: line([[[-130, 20], [-125, 40], [-130, 20]]]),
    delta_t_s: 69.184,
  };

  it('builds the solar overlays, each feature carrying the eclipse id', () => {
    const specs = solarOverlays(path, { greatest: 'Greatest eclipse 18:17 UTC' });
    expect(specs.map((s) => s.id.slice(OVERLAY_PREFIX.length))).toEqual([
      'partial',
      'partial-horizon',
      'path-fill',
      'path-limits',
      'path-ends',
      'central-line',
      'greatest',
    ]);
    for (const s of specs) for (const f of s.data.features) expect(f.properties?.['eclipse']).toBe(path.id);
    expect(specs.find((s) => s.id.endsWith('greatest'))!.data.features[0]!.properties!['label']).toBe('Greatest eclipse 18:17 UTC');
    expect(fitTarget(specs)).toBe(`${OVERLAY_PREFIX}path-limits`);
    // A partial eclipse has no path: the camera fits the partial limits.
    const partial = solarOverlays({ ...path, type: 'partial', central: false, central_line: line([]), umbra_north: line([]), umbra_south: line([]) }, { greatest: '' });
    expect(partial.map((s) => s.id.slice(OVERLAY_PREFIX.length))).toEqual(['partial', 'partial-horizon', 'greatest']);
    expect(fitTarget(partial)).toBe(`${OVERLAY_PREFIX}partial`);
  });

  it('builds the lunar overlays from the points under the Moon', () => {
    const lunar: LunarEclipsePath = {
      kind: 'lunar',
      id: '2025-03-14-lunar',
      type: 'total',
      sublunar: [
        { kind: 'p1', jd_utc: 1, utc: '', lat_deg: 3.4, lon_deg: -58 },
        { kind: 'u1', jd_utc: 2, utc: '', lat_deg: 3.2, lon_deg: -76 },
        { kind: 'max', jd_utc: 3, utc: '', lat_deg: 2.7, lon_deg: -102 },
        { kind: 'u4', jd_utc: 4, utc: '', lat_deg: 2.3, lon_deg: -127 },
      ],
      delta_t_s: 69.184,
    };
    const specs = lunarOverlays(lunar, { overhead: 'Moon overhead' });
    expect(specs.map((s) => s.id.slice(OVERLAY_PREFIX.length))).toEqual(['moon-up', 'moon-start', 'moon-end', 'overhead']);
    expect(specs[1]!.data.features[0]!.properties!['label']).toBe('Moon on the horizon as the partial eclipse begins');
    expect(fitTarget(specs)).toBe(`${OVERLAY_PREFIX}moon-up`);
  });

  it('replaces its own overlays on the map and leaves the others alone', () => {
    const map = new MapServiceImpl();
    map.addOverlay('fix-cops', { type: 'Point', coordinates: [0, 0] });
    const fit = showEclipse(map, solarOverlays(path, { greatest: 'g' }));
    expect(fit).toBe(`${OVERLAY_PREFIX}path-limits`);
    expect(eclipseOnMap(map)).toBe(path.id);
    // Empty overlays are not added (the umbral loops are empty here).
    expect(map.hasOverlay(`${OVERLAY_PREFIX}path-ends`)).toBe(false);
    showEclipse(map, solarOverlays({ ...path, id: '2023-10-14-solar' }, { greatest: 'g' }));
    expect(eclipseOnMap(map)).toBe('2023-10-14-solar');
    clearEclipse(map);
    expect(eclipseOnMap(map)).toBeNull();
    expect(map.overlays().map((o) => o.id)).toEqual(['fix-cops']);
  });
});

describe('the memoised engine forwards the optional wave-2 methods', () => {
  it('shares identical calls, and has them only when the engine does', () => {
    let calls = 0;
    const raw = {
      kind: 'wasm',
      description: '',
      eclipses: () => ({ n: ++calls }),
      eclipseLocal: () => ({ n: ++calls }),
      eclipsePath: () => ({ n: ++calls }),
      planetEvents: () => ({ n: ++calls }),
    } as unknown as ExplorerEngine;
    const memo = memoEngine(raw);
    expect(isEclipseEngine(memo) && isPlanetEventsEngine(memo)).toBe(true);
    if (!isEclipseEngine(memo) || !isPlanetEventsEngine(memo)) return;
    expect(memo.eclipses(1, 2)).toBe(memo.eclipses(1, 2));
    expect(memo.eclipseLocal('x', { lat_deg: 1, lon_deg: 2 })).toBe(memo.eclipseLocal('x', { lat_deg: 1, lon_deg: 2, height_m: 0 }));
    expect(memo.eclipseLocal('x', { lat_deg: 1, lon_deg: 3 })).not.toBe(memo.eclipseLocal('x', { lat_deg: 1, lon_deg: 2 }));
    expect(memo.eclipsePath('x')).toBe(memo.eclipsePath('x'));
    expect(memo.planetEvents(1, 2)).toBe(memo.planetEvents(1, 2));
    expect(calls).toBe(5);
    const plain = memoEngine({ kind: 'mock', description: '' } as unknown as ExplorerEngine);
    expect(isEclipseEngine(plain) || isPlanetEventsEngine(plain)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The real package, when one has been built
// ---------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('the Events view on the built WebAssembly package', () => {
  let load: WasmLoad;

  beforeAll(async () => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as {
      initSync: (input: { module: BufferSource }) => unknown;
      init?: () => void;
    };
    glue.initSync({ module: readFileSync(WASM_FILE) });
    glue.init?.();
    load = inspectWasmModule(glue);
  });

  it('turns every solar eclipse path of 2017-2030 into overlays the map can draw', ({ skip }) => {
    if (load.status !== 'ready' || typeof (load.engine as { eclipses?: unknown }).eclipses !== 'function') {
      skip();
      return;
    }
    const engine = load.engine;
    let list;
    try {
      list = engine.eclipses(2457754.5, 2462867.5);
    } catch {
      skip();
      return;
    }
    let filled = 0;
    const solar = list.eclipses.filter((e): e is SolarEclipse => e.kind === 'solar');
    expect(solar.length).toBe(32); // NASA: 2 to 4 a year, 32 in 2017-2030
    for (const e of solar) {
      const path = engine.eclipsePath(e.id) as SolarEclipsePath;
      const specs = solarOverlays(path, { greatest: 'g' });
      const map = new MapServiceImpl();
      const fit = showEclipse(map, specs);
      expect(fit, e.id).not.toBeNull();
      for (const s of specs) {
        for (const f of s.data.features) {
          const json = JSON.stringify(f.geometry);
          expect(json, `${e.id} ${s.id}`).not.toContain('null');
          const coords = json.match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number);
          expect(coords.every((c) => Math.abs(c) <= 180), `${e.id} ${s.id}`).toBe(true);
        }
      }
      if (specs.some((s) => s.id.endsWith('path-fill'))) filled += 1;
      if (e.central && e.type !== 'partial') expect(specs.some((s) => s.id.endsWith('path-limits')), e.id).toBe(true);
    }
    // The central paths that do not cross the polar regions are filled.
    expect(filled).toBeGreaterThanOrEqual(15);
    // 2024-04-08 is one of them; 2026-08-12, over the Arctic, is not.
    const fillOf = (id: string) => solarOverlays(engine.eclipsePath(id) as SolarEclipsePath, { greatest: '' }).some((s) => s.id.endsWith('path-fill'));
    expect(fillOf('2024-04-08-solar')).toBe(true);
    expect(fillOf('2026-08-12-solar')).toBe(false);
  }, 60_000);

  it('tells Dallas it was in totality on 2024-04-08, and London that the Moon set on 2025-03-14', ({ skip }) => {
    if (load.status !== 'ready') {
      skip();
      return;
    }
    const engine = load.engine;
    let local;
    try {
      local = engine.eclipseLocal('2024-04-08-solar', { lat_deg: 32.78, lon_deg: -96.8, height_m: 150 });
    } catch {
      skip();
      return;
    }
    const e = engine.eclipses(G - 1, G + 1).eclipses[0]!;
    expect(hereLabel(e, local).text).toMatch(/^Total here, for 3 min 5\d s$/);
    expect(solarSummary(e as SolarEclipse, local as SolarEclipseLocal, words).join(' ')).toContain('inside the path of totality');
    const l = engine.eclipses(2460747.5, 2460749.5).eclipses[0] as LunarEclipse;
    const ldn = engine.eclipseLocal(l.id, { lat_deg: 51.5074, lon_deg: -0.1278 }) as LunarEclipseLocal;
    expect(hereLabel(l, ldn).text).toBe('Seen here, until moonset');
  }, 30_000);
});
