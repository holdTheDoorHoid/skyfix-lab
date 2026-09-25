/**
 * The Selected card's photographer and astronomer tools (expansion programme Q8, photo
 * agent): reading bearings and tolerances, the direction to a point picked on the map
 * (Vincenty on WGS84, against Geoscience Australia's worked example), the words and rows
 * each tool shows (from the mock engine's answers and from hand-made ones), the map picker,
 * the shared bearing and its ray, and the settle logic that keeps the card under 5 ms a
 * frame while the time bar is dragged. The DOM is checked in a real browser by
 * web/scripts/ui-check.mjs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import type {
  AlignmentResult,
  GalacticCentreWindows,
  GalacticWindow,
  MoonSyzygy,
  Observer,
  SunHours,
  SunLightWindow,
} from '../../src/next/engine/types.js';
import { mapServiceFor } from '../../src/next/map/overlays.js';
import { createMapPicker, mapPickerFor } from '../../src/next/map/pick.js';
import { alignmentRows, offsetWords } from '../../src/next/panel/alignment.js';
import { axisWords, distanceWords, librationValue, librationWords, nextApsides, sizeWords, supermoonNote } from '../../src/next/panel/moon-tools.js';
import {
  bestNights,
  coordText,
  deltaTNote,
  outsideWords,
  galacticNight,
  lightTable,
  magneticText,
  Motion,
  nightWindow,
  photoBearing,
  RAY_ID,
  Settler,
  tideHeight,
  tideLineModel,
  type SettlerClock,
} from '../../src/next/panel/photo.js';
import { INSTANT, turning } from '../../src/next/time/chip.js';
import {
  bearingDifference,
  formatDecSigned,
  formatRa,
  geodesicInverse,
  magneticFromTrue,
  minutesText,
  normBearing,
  parseBearing,
  parseTolerance,
  rayPoints,
  timeRange,
} from '../../src/next/panel/sun-tools.js';
import { setHourCycle } from '../../src/next/shell/format.js';
import { createExplorerStore } from '../../src/next/state.js';
import { jdFromIso, UTC_ZONE, type Zone } from '../../src/next/time.js';

const jd = (iso: string): number => jdFromIso(iso)!;
const NY: Zone = { kind: 'iana', zone: 'America/New_York' };
const PHILLY: Observer = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 };
/** 42nd Street at Fifth Avenue, the worked example of the guide. */
const MANHATTAN: Observer = { lat_deg: 40.7527, lon_deg: -73.9772, height_m: 0 };

const mock = new MockEngine({ syntheticStars: 0 });

beforeEach(() => setHourCycle('h23'));

// ---------------------------------------------------------------------------------
// Reading what is typed
// ---------------------------------------------------------------------------------

describe('a bearing typed for the tools', () => {
  it('reads degrees, degrees and minutes, and compass points', () => {
    expect(parseBearing('299')).toBe(299);
    expect(parseBearing(' 299.5° ')).toBe(299.5);
    expect(parseBearing('299 30')).toBe(299.5);
    expect(parseBearing('299° 30′')).toBe(299.5);
    expect(parseBearing('0')).toBe(0);
    expect(parseBearing('360')).toBe(0);
    expect(parseBearing('45,5')).toBe(45.5);
    expect(parseBearing('WNW')).toBe(292.5);
    expect(parseBearing('n')).toBe(0);
    expect(parseBearing('245 T')).toBe(245);
  });

  it('refuses what is not a bearing', () => {
    for (const bad of ['', 'west-ish', '-5', '361', '299 60', '299.5 10', '1 2 3', 'NNNW']) expect(parseBearing(bad), bad).toBeNull();
  });

  it('reads a tolerance within the finder’s range', () => {
    expect(parseTolerance('0.5')).toBe(0.5);
    expect(parseTolerance('0,3°')).toBe(0.3);
    for (const bad of ['', '0', '0.01', '11', '-1', 'x']) expect(parseTolerance(bad), bad).toBeNull();
  });

  it('turns a true bearing into a magnetic one with the variation east positive', () => {
    // Variation 11.8° W: a compass points west of true north, so magnetic bearings are larger.
    expect(magneticFromTrue(245, -11.8)).toBeCloseTo(256.8, 10);
    expect(magneticFromTrue(355, 10)).toBeCloseTo(345, 10);
    expect(magneticFromTrue(5, -11.8)).toBeCloseTo(16.8, 10);
    expect(normBearing(-0.5)).toBeCloseTo(359.5, 12);
    expect(bearingDifference(350, 10)).toBeCloseTo(20, 12);
    expect(bearingDifference(10, 350)).toBeCloseTo(-20, 12);
  });
});

// ---------------------------------------------------------------------------------
// The direction to a point picked on the map
// ---------------------------------------------------------------------------------

describe('the direction to a picked point (Vincenty on WGS84)', () => {
  const dms = (d: number, m: number, s: number): number => Math.sign(d || 1) * (Math.abs(d) + m / 60 + s / 3600);

  it('reproduces Geoscience Australia’s worked example: Flinders Peak to Buninyong', () => {
    // GDA technical manual, Vincenty's inverse formula: 54 972.271 m at 306° 52′ 05.37″ (GRS80,
    // whose flattening differs from WGS84's by 5e-12: under 0.1 mm here).
    const flinders = { lat_deg: -dms(37, 57, 3.7203), lon_deg: dms(144, 25, 29.5244) };
    const buninyong = { lat_deg: -dms(37, 39, 10.1561), lon_deg: dms(143, 55, 35.3839) };
    const g = geodesicInverse(flinders, buninyong);
    expect(g.method).toBe('vincenty');
    expect(Math.abs(g.distance_m - 54_972.271)).toBeLessThan(0.001);
    expect(Math.abs(g.azimuth_deg - dms(306, 52, 5.37))).toBeLessThan(0.5 / 3600);
    // And back: 127° 10′ 25.07″.
    const back = geodesicInverse(buninyong, flinders);
    expect(Math.abs(back.azimuth_deg - dms(127, 10, 25.07))).toBeLessThan(0.5 / 3600);
  });

  it('agrees with the sphere to a few tenths of a degree, and says when it falls back to it', () => {
    const a = geodesicInverse(MANHATTAN, { lat_deg: 40.759, lon_deg: -73.99 });
    expect(a.azimuth_deg).toBeGreaterThan(290);
    expect(a.azimuth_deg).toBeLessThan(310);
    expect(a.distance_m).toBeGreaterThan(1000);
    expect(a.distance_m).toBeLessThan(1400);
    // Nearly antipodal points: Vincenty's iteration does not converge.
    const far = geodesicInverse({ lat_deg: 0, lon_deg: 0 }, { lat_deg: 0.5, lon_deg: 179.7 });
    expect(far.method).toBe('sphere');
    expect(Number.isFinite(far.azimuth_deg)).toBe(true);
    expect(Number.isNaN(geodesicInverse(MANHATTAN, MANHATTAN).azimuth_deg)).toBe(true);
  });

  it('draws the ray from the place along the bearing', () => {
    const pts = rayPoints(MANHATTAN, 299, 3000, 15);
    expect(pts.length).toBe(201);
    expect(pts[0]!.lat_deg).toBeCloseTo(MANHATTAN.lat_deg, 12);
    expect(pts[0]!.lon_deg).toBeCloseTo(MANHATTAN.lon_deg, 12);
    // Its first step leaves on the bearing (sphere): within 0.01°.
    const first = geodesicInverse(pts[0]!, pts[1]!);
    expect(Math.abs(bearingDifference(299, first.azimuth_deg))).toBeLessThan(0.2);
    // 3000 km of great circle.
    const total = pts.slice(1).reduce((sum, p, i) => sum + geodesicInverse(pts[i]!, p).distance_m, 0);
    expect(Math.abs(total / 1000 - 3000)).toBeLessThan(15);
  });
});

// ---------------------------------------------------------------------------------
// Words and numbers
// ---------------------------------------------------------------------------------

describe('the uncertainty of a time and the years the core covers (time-ui helpers)', () => {
  it('adds the ± text only where what sets the time carries enough of the Earth’s rotation’s uncertainty (chip2)', () => {
    const ctx = { engine: mock };
    // An instant of the bodies' own motion (a perigee): the whole σ(ΔT), over 30 s.
    expect(deltaTNote(ctx, jd('2026-09-24T12:00:00Z'), INSTANT)).toBe('');
    expect(deltaTNote(ctx, jd('2500-06-01T12:00:00Z'), INSTANT)).toMatch(/^ ±\d+ min$/);
    // Golden hour is the Sun's turning: in 2026 nothing; in 2500 the mock cannot place the Sun
    // (it covers 1990-2060), so the whole σ stands, as before the rule.
    expect(deltaTNote(ctx, jd('2026-09-24T12:00:00Z'), turning('Sun'))).toBe('');
    expect(deltaTNote(ctx, jd('2500-06-01T12:00:00Z'), turning('Sun'))).toMatch(/^ ±\d+ min$/);
    expect(deltaTNote({ engine: {} as never }, jd('2500-06-01T12:00:00Z'), INSTANT)).toBe('');
  });

  it('names the covered years when a day is outside them', () => {
    expect(outsideWords({ engine: mock }, 'Sat 1 Jun')).toBe('Sat 1 Jun is outside the years the core covers (1 January 1990 to 31 December 2060).');
  });
});

describe('coordinates and times as the card writes them', () => {
  it('writes right ascension in hours and declination with its sign', () => {
    // 188.736° = 12h 34m 56.64s.
    expect(formatRa(188.736, 'dm')).toBe('12h 34m 57s');
    expect(formatRa(188.736, 'dms')).toBe('12h 34m 56.6s');
    expect(formatRa(188.736, 'decimal')).toBe('188.736°');
    expect(formatRa(359.99999, 'dm')).toBe('0h 00m 00s');
    expect(formatRa(-15, 'dm')).toBe('23h 00m 00s');
    expect(formatDecSigned(12.5833, 'dm')).toBe('+12° 35′');
    expect(formatDecSigned(-0.5, 'dm')).toBe('−0° 30′');
    expect(formatDecSigned(-0.0001, 'dm')).toBe('+0° 00′');
    expect(formatDecSigned(-29.0078, 'dms')).toBe('−29° 00′ 28″');
    expect(formatDecSigned(27.1283, 'decimal')).toBe('+27.128°');
  });

  it('gives a body’s place with the navigator’s SHA', () => {
    const sky = mock.skyState(PHILLY, jd('2026-09-24T12:00:00Z'), ['Sirius']);
    const b = sky.bodies[0]!;
    const t = coordText(b, 'dm');
    expect(t.ra).toBe(formatRa(b.ra_deg, 'dm'));
    expect(t.dec.startsWith('−16°')).toBe(true);
    expect(b.sha_deg + b.ra_deg).toBeCloseTo(360, 6);
  });

  it('writes time ranges and durations on either clock', () => {
    const a = jd('2026-09-24T10:23:14Z');
    const b = jd('2026-09-24T10:33:42Z');
    expect(timeRange(a, b, NY)).toBe('06:23–06:34');
    setHourCycle('h12');
    expect(timeRange(a, b, NY)).toBe('6:23–6:34 AM');
    expect(timeRange(jd('2026-09-24T15:40:00Z'), jd('2026-09-24T16:20:00Z'), NY)).toBe('11:40 AM–12:20 PM');
    // UTC stays on the 24-hour clock.
    expect(timeRange(a, b, UTC_ZONE)).toBe('10:23–10:34');
    expect(minutesText(52.2)).toBe('52 min');
    expect(minutesText(63)).toBe('1 h 03 min');
  });
});

// ---------------------------------------------------------------------------------
// Golden and blue hour
// ---------------------------------------------------------------------------------

function win(kind: SunLightWindow['kind'], period: SunLightWindow['period'], a: string, b: string, open: [boolean, boolean] = [false, false]): SunLightWindow {
  const ja = jd(a);
  const jb = jd(b);
  return { kind, period, jd_start: ja, utc_start: a, jd_end: jb, utc_end: b, duration_min: (jb - ja) * 1440, open_start: open[0], open_end: open[1] };
}

describe('golden and blue hour on the Sun card', () => {
  it('gives the morning and evening windows of the engine’s day', () => {
    const [a, b] = [jd('2026-09-24T04:00:00Z'), jd('2026-09-25T04:00:00Z')];
    const model = lightTable(mock.sunHours(PHILLY, a, b), NY);
    expect(model.note).toBeNull();
    expect(model.rows.map((r) => r.kind)).toEqual(['golden', 'blue']);
    for (const r of model.rows) {
      expect(r.whole).toBeNull();
      expect(r.morning.text).toMatch(/^0[5-7]:\d\d–0[6-7]:\d\d$/);
      expect(r.evening.text).toMatch(/^(18|19):\d\d–(18|19):\d\d$/);
      expect(r.morning.jd).not.toBeNull();
    }
    // Blue hour comes before golden hour in the morning and after it in the evening.
    const [golden, blue] = model.rows;
    expect(blue!.morning.jd!).toBeLessThan(golden!.morning.jd!);
    expect(blue!.evening.jd!).toBeGreaterThan(golden!.evening.jd!);
  });

  it('writes the exact times of hand-made windows, and the uncertainty after them', () => {
    const hours: SunHours = {
      jd_start: 0,
      jd_end: 1,
      windows: [
        win('blue', 'morning', '2026-09-24T10:23:14Z', '2026-09-24T10:33:42Z'),
        win('golden', 'morning', '2026-09-24T10:33:42Z', '2026-09-24T11:25:59Z'),
        win('golden', 'evening', '2026-09-24T22:18:37Z', '2026-09-24T23:10:49Z'),
        win('blue', 'evening', '2026-09-24T23:10:49Z', '2026-09-24T23:21:15Z'),
      ],
      boundaries: [],
      sun: { body: 'Sun', events: [], always_above: false, always_below: false, day_length_h: 12 },
      phases: [],
    };
    const m = lightTable(hours, NY, ' ±12 min');
    expect(m.rows[0]!.morning.text).toBe('06:34–07:26 ±12 min');
    expect(m.rows[0]!.evening.text).toBe('18:19–19:11 ±12 min');
    expect(m.rows[1]!.morning.text).toBe('06:23–06:34 ±12 min');
    expect(m.rows[1]!.evening.tip).toBe('10 min, 19:11 to 19:21.');
  });

  it('uses the polar words: around noon, around midnight, cut by the day’s edge, none', () => {
    const polar: SunHours = {
      jd_start: 0,
      jd_end: 1,
      windows: [
        win('golden', 'midday', '2026-12-21T09:30:00Z', '2026-12-21T12:30:00Z'),
        win('blue', 'morning', '2026-12-21T04:00:00Z', '2026-12-21T05:10:00Z', [true, false]),
      ],
      boundaries: [],
      sun: { body: 'Sun', events: [], always_above: false, always_below: true, day_length_h: 0 },
      phases: [],
    };
    const m = lightTable(polar, UTC_ZONE);
    expect(m.rows[0]!.whole?.text).toBe('Around noon, 09:30–12:30');
    expect(m.rows[1]!.morning.text).toBe('to 05:10');
    const none = lightTable(
      { ...polar, windows: [], boundaries: [{ altitude_deg: 6, crossings: [], always_above: true, always_below: false }] },
      UTC_ZONE,
    );
    expect(none.note).toMatch(/more than 6° up all day/);
  });
});

// ---------------------------------------------------------------------------------
// The Milky Way planner
// ---------------------------------------------------------------------------------

function gwin(a: string, b: string, moonUp: boolean, alt: number, fraction = 0.5): GalacticWindow {
  const ja = jd(a);
  const jb = jd(b);
  return {
    jd_start: ja,
    utc_start: a,
    jd_end: jb,
    utc_end: b,
    duration_h: (jb - ja) * 24,
    moon_up: moonUp,
    moon_illuminated_fraction: fraction,
    best: {
      jd_utc: ja,
      utc: a,
      alt_deg: alt,
      alt_apparent_deg: alt,
      az_deg: 190,
      arch_top_alt_deg: 70,
      arch_top_az_deg: 120,
      arch_ends_az_deg: [30, 210],
    },
  };
}

function gresult(windows: GalacticWindow[]): GalacticCentreWindows {
  return {
    jd_start: 0,
    jd_end: 1,
    min_altitude_deg: 10,
    sun_max_altitude_deg: -18,
    galactic_centre: { ra_j2000_deg: 266.416833, dec_j2000_deg: -29.007806 },
    galactic_pole: { ra_j2000_deg: 192.8595, dec_j2000_deg: 27.128333 },
    windows,
  };
}

describe('the Milky Way planner', () => {
  it('says when and where the core is up tonight, and what the Moon does', () => {
    const m = galacticNight(
      gresult([gwin('2026-07-15T02:00:00Z', '2026-07-15T03:00:00Z', true, 20, 0.6), gwin('2026-07-15T03:00:00Z', '2026-07-15T05:30:00Z', false, 25, 0.6)]),
      NY,
      'dm',
    );
    expect(m.best?.moon_up).toBe(false);
    expect(m.sentences[0]).toBe('The Milky Way’s core is up in a fully dark sky from 22:00 to 01:30 (3 h 30 min in all).');
    expect(m.sentences[1]).toMatch(/^Best at 23:00: 25° 00′ high in the south \(190°\)\.$/);
    expect(m.sentences[2]).toBe('Without the Moon: 23:00–01:30 (2 h 30 min); the Moon (60 % lit) is up for the rest.');
    expect(m.arch).toBe('At its best the band arches from the north-north-east (030°) to the south-south-west (210°), highest (70°) toward the east-south-east.');
  });

  it('says how much a Moon that is up the whole time matters', () => {
    const thin = galacticNight(gresult([gwin('2026-07-15T02:00:00Z', '2026-07-15T03:00:00Z', true, 20, 0.08)]), NY, 'dm');
    expect(thin.sentences[2]).toBe('The Moon (8 % lit) is up the whole time; a crescent this thin brightens the sky only a little.');
    const bright = galacticNight(gresult([gwin('2026-07-15T02:00:00Z', '2026-07-15T03:00:00Z', true, 20, 0.9)]), NY, 'dm');
    expect(bright.sentences[2]).toBe('The Moon (90 % lit) is up the whole time: its light will wash out the fainter parts.');
    expect(bright.best?.moon_up).toBe(true);
  });

  it('says so when the core never gets up in the dark', () => {
    const m = galacticNight(gresult([]), NY, 'dm');
    expect(m.best).toBeNull();
    expect(m.sentences[0]).toMatch(/does not climb 10° above the horizon/);
  });

  it('lists the Moon-free nights of a month and marks the best three', () => {
    const first = jd('2026-07-01T16:00:00Z');
    const nights = bestNights(
      gresult([
        gwin('2026-07-02T03:00:00Z', '2026-07-02T03:20:00Z', false, 20), // 20 min: too short
        gwin('2026-07-03T03:00:00Z', '2026-07-03T04:00:00Z', false, 20),
        gwin('2026-07-04T02:00:00Z', '2026-07-04T05:00:00Z', false, 22),
        gwin('2026-07-05T02:00:00Z', '2026-07-05T04:00:00Z', false, 21),
        gwin('2026-07-06T02:00:00Z', '2026-07-06T06:00:00Z', true, 24), // the Moon is up
        gwin('2026-07-07T02:00:00Z', '2026-07-07T03:30:00Z', false, 23),
      ]),
      first,
    );
    expect(nights.map((n) => Math.round(n.moon_free_min))).toEqual([60, 180, 120, 90]);
    expect(nights.filter((n) => n.top).map((n) => Math.round(n.moon_free_min))).toEqual([180, 120, 90]);
  });

  it('works from the mock engine’s month of nights', () => {
    const [a] = nightWindow(jd('2026-07-15T16:00:00Z'), NY, true);
    const result = mock.galacticCentreWindows(PHILLY, a, a + 30);
    const nights = bestNights(result, a);
    expect(nights.length).toBeGreaterThan(0);
    for (const n of nights) {
      expect(n.window.moon_up).toBe(false);
      expect(n.moon_free_min).toBeGreaterThanOrEqual(30);
    }
    expect(galacticNight(mock.galacticCentreWindows(PHILLY, a, a + 1), NY, 'dm').sentences.length).toBeGreaterThan(0);
  });

  it('takes the night from local noon: tonight after noon, last night before dawn', () => {
    const [a, b] = nightWindow(jd('2026-07-15T20:00:00Z'), NY, true); // 16:00 EDT
    expect(a).toBeCloseTo(jd('2026-07-15T16:00:00Z'), 6);
    expect(b).toBeCloseTo(jd('2026-07-16T16:00:00Z'), 6);
    const [c] = nightWindow(jd('2026-07-15T06:00:00Z'), NY, false); // 02:00 EDT, dark
    expect(c).toBeCloseTo(jd('2026-07-14T16:00:00Z'), 6);
    const [e] = nightWindow(jd('2026-07-15T14:00:00Z'), NY, true); // 10:00 EDT, day
    expect(e).toBeCloseTo(jd('2026-07-15T16:00:00Z'), 6);
  });
});

// ---------------------------------------------------------------------------------
// The alignment finder
// ---------------------------------------------------------------------------------

describe('the alignment finder', () => {
  it('lists the days the mock Sun sets along Manhattan’s grid, two runs in May and July', () => {
    const result = mock.alignmentDays(MANHATTAN, { body: 'Sun', year: 2026, azimuth_deg: 299, tolerance_deg: 0.5, event: { kind: 'set' }, utc_offset_hours: -4 });
    const { rows, summary } = alignmentRows(result, NY, 'dm');
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const months = new Set(rows.map((r) => r.date.split(' ')[2]));
    expect([...months].sort()).toEqual(['Jul', 'May']);
    expect(rows.filter((r) => r.best).length).toBe(2);
    expect(summary).toMatch(/^The Sun sets within 0.5° of 299.0° on \d+ days of 2026, in 2 runs; the closest day of each is marked\./);
    for (const r of rows) {
      expect(r.what).toBe('sets');
      expect(r.time).toMatch(/^20:\d\d$/);
      expect(r.label).toContain(r.date);
    }
  });

  it('says how far off the nearest day is when none matches', () => {
    const base = mock.alignmentDays(MANHATTAN, { body: 'Sun', year: 2026, azimuth_deg: 299, tolerance_deg: 0.5, event: { kind: 'set' }, utc_offset_hours: -4 });
    const none: AlignmentResult = { ...base, azimuth_deg: 330, matches: [], closest: { ...base.matches[0]!, offset_deg: -27.4 } };
    const { rows, summary } = alignmentRows(none, NY, 'dm');
    expect(rows).toEqual([]);
    expect(summary).toMatch(/^The Sun never sets within 0.5° of 330.0° in 2026\. The nearest is .+, 27.4° left of the line/);
    const never: AlignmentResult = { ...none, closest: null, event: { kind: 'rise' } };
    expect(alignmentRows(never, NY, 'dm').summary).toBe('The Sun never rises here in 2026.');
  });

  it('writes a height for the "at a height" moment and the side of the line', () => {
    const base = mock.alignmentDays(MANHATTAN, { body: 'Sun', year: 2026, azimuth_deg: 299, tolerance_deg: 0.5, event: { kind: 'set' }, utc_offset_hours: -4 });
    const at: AlignmentResult = {
      ...base,
      event: { kind: 'at_altitude', altitude_deg: 0.5 },
      matches: [{ ...base.matches[0]!, kind: 'setting', offset_deg: 0.003, best: true }],
    };
    const { rows, summary } = alignmentRows(at, NY, 'dm');
    expect(rows[0]!.what).toBe('sinks through 0° 30′');
    expect(rows[0]!.offset).toBe('on the line');
    expect(summary).toMatch(/^The Sun stands 0° 30′ high within 0.5° of 299.0° on 1 day of 2026\./);
    expect(offsetWords(0.07)).toBe('0.07° right of the line');
    expect(offsetWords(-1.24)).toBe('1.2° left of the line');
  });
});

// ---------------------------------------------------------------------------------
// The Moon
// ---------------------------------------------------------------------------------

describe('the Moon card’s words', () => {
  it('says which edge is tipped toward us', () => {
    expect(librationWords({ lon_deg: -5.58, lat_deg: -0.3 }).sentence).toBe(
      'Tipped to show more of its western edge (the Grimaldi side), by 5.6°, and of its south pole, by 0.3°.',
    );
    expect(librationWords({ lon_deg: 6.1, lat_deg: 0 }).sentence).toBe('Tipped to show more of its eastern edge (the Mare Crisium side), by 6.1°.');
    expect(librationWords({ lon_deg: 0.05, lat_deg: 4.2 }).sentence).toBe('Tipped to show more of its north pole, by 4.2°.');
    expect(librationWords({ lon_deg: 0.3, lat_deg: -0.4 }).sentence).toMatch(/almost squarely/);
    expect(librationValue({ lon_deg: -5.58, lat_deg: 0.8 })).toBe('5.6° W, 0.8° N');
    expect(librationValue({ lon_deg: 6.1, lat_deg: -3.04 })).toBe('6.1° E, 3.0° S');
  });

  it('gives the axis from celestial north and as it looks from here', () => {
    const a = axisWords({ axis_position_angle_deg: 340.28, north_pole_disc: { east: 0, north: 0, x: 0.913, y: 0.409, visible: false }, alt_deg: -20 });
    expect(a.value).toBe('20° west of north');
    expect(a.tip).toMatch(/340\.3°/);
    expect(a.tip).toMatch(/66° right of straight up \(the Moon is below the horizon now\)/);
    expect(axisWords({ axis_position_angle_deg: 12, north_pole_disc: { east: 0, north: 1, x: -0.1, y: 0.99, visible: true }, alt_deg: null }).value).toBe('12° east of north');
  });

  it('compares the distance and the size with the average', () => {
    expect(distanceWords(388_979)).toBe('1.2 % farther than average');
    expect(distanceWords(357_000)).toBe('7.1 % closer than average');
    expect(sizeWords(-2.164)).toBe('2.2 % smaller than average');
    expect(sizeWords(7.0)).toBe('7.0 % larger than average');
  });

  it('finds the next perigee, apogee and full Moon, and the supermoon note', () => {
    const t0 = jd('2026-09-24T12:00:00Z');
    const aps = mock.moonApsides(t0 - 1, t0 + 45);
    const next = nextApsides(aps, t0);
    expect(next.perigee && next.perigee.jd_utc > t0).toBe(true);
    expect(next.apogee && next.apogee.jd_utc > t0).toBe(true);
    expect(next.perigee!.jd_utc - t0).toBeLessThan(28);
    expect(next.full?.kind).toBe('full_moon');
    const full = next.full!;
    const sup: MoonSyzygy = { ...full, supermoon: true, micromoon: false, largest_of_year: true, diameter_arcmin: 33.26, diameter_vs_mean_percent: 6.97 };
    expect(supermoonNote(sup, full.jd_utc - 10, NY)).toMatch(/^The full Moon of \w{3} \d+ \w{3} is a supermoon: 33.3′ across, 7.0 % larger than average, the largest of the year\.$/);
    expect(supermoonNote(sup, full.jd_utc - 0.5, NY)).toMatch(/^This full Moon is a supermoon/);
    expect(supermoonNote({ ...full, supermoon: false, micromoon: false, largest_of_year: false, smallest_of_year: false }, t0, NY)).toBeNull();
    expect(supermoonNote({ ...full, supermoon: false, micromoon: true, largest_of_year: false, smallest_of_year: false }, full.jd_utc - 10, NY)).toMatch(/is a micromoon/);
  });
});

// ---------------------------------------------------------------------------------
// The magnetic bearing and the tides line
// ---------------------------------------------------------------------------------

describe('the magnetic bearing beside the true one', () => {
  it('gives the magnetic bearing with the variation, the model and its uncertainty in words', () => {
    const f = mock.magneticField(PHILLY.lat_deg, PHILLY.lon_deg, 0, jd('2026-09-24T12:00:00Z'));
    if (!f.available) throw new Error('the mock gives a field for 2026');
    const t = magneticText(245, f, 'dm');
    expect(t.available).toBe(true);
    expect(t.line).toMatch(/° \d\d′ magnetic$/);
    expect(t.tip).toMatch(/^Variation \d+\.\d° [EW], World Magnetic Model 2025, ±\d\.\d°/);
    expect(t.tip).toMatch(/(add \d+\.\d° to|subtract \d+\.\d° from) a true bearing/);
    // The magnetic bearing is the true one minus the variation (east positive).
    expect(magneticText(245, { ...f, declination_deg: -11.8 }, 'decimal').line).toBe('256.80° magnetic');
    expect(magneticText(245, { ...f, declination_deg: -11.8 }, 'dm').tip).toMatch(/add 11\.8° to a true bearing/);
  });

  it('says why there is none before 1900', () => {
    const f = mock.magneticField(PHILLY.lat_deg, PHILLY.lon_deg, 0, jd('1850-01-01T00:00:00Z'));
    const t = magneticText(245, f, 'dm');
    expect(t.available).toBe(false);
    expect(t.line).toBe('Magnetic: not available before 1900');
    expect(t.tip).toMatch(/1900/);
  });
});

describe('the tides line', () => {
  it('gives the next high and low water after the time shown', () => {
    const t0 = jd('2026-09-24T12:00:00Z');
    const near = mock.tideStationsNear(PHILLY.lat_deg, PHILLY.lon_deg, 1)[0]!;
    expect(near.distance_nm).toBeLessThan(50);
    const ex = mock.tideExtremes(near.id, t0 - 1, t0 + 3, '');
    const m = tideLineModel(near, ex, t0);
    expect(m.nextHigh!.kind).toBe('high');
    expect(m.nextLow!.kind).toBe('low');
    expect(m.nextHigh!.jd_utc).toBeGreaterThan(t0);
    expect(m.nextLow!.jd_utc).toBeGreaterThan(t0);
    const first = Math.min(m.nextHigh!.jd_utc, m.nextLow!.jd_utc);
    expect(m.state).toBe(first === m.nextHigh!.jd_utc ? 'rising' : 'falling');
    // The same as the engine's own "tide now".
    const now = mock.tideNow(near.id, t0, '');
    expect(m.nextHigh!.jd_utc).toBeCloseTo(now.next_high!.jd_utc, 6);
    expect(m.state).toBe(now.state);
  });

  it('writes heights in the chosen units', () => {
    expect(tideHeight(1.94, 'metric')).toBe('1.9 m');
    expect(tideHeight(0.3048, 'imperial')).toBe('1.0 ft');
    expect(tideHeight(-0.0914, 'imperial')).toBe('−0.3 ft');
    expect(tideHeight(-0.01, 'nautical')).toBe('0.0 m');
  });
});

// ---------------------------------------------------------------------------------
// The map picker, the shared bearing and its ray
// ---------------------------------------------------------------------------------

describe('picking a point on the map', () => {
  it('gives the next click to the waiting request, once', () => {
    const picker = createMapPicker();
    expect(picker.offer({ lat_deg: 1, lon_deg: 2 })).toBe(false);
    const got: unknown[] = [];
    let cancelled = 0;
    let changes = 0;
    picker.subscribe(() => changes++);
    picker.request({ prompt: 'Click', onPick: (p) => got.push(p), onCancel: () => cancelled++ });
    expect(picker.active()?.prompt).toBe('Click');
    expect(picker.offer({ lat_deg: 40, lon_deg: 190 })).toBe(true);
    expect(got).toEqual([{ lat_deg: 40, lon_deg: -170 }]);
    expect(picker.active()).toBeNull();
    expect(picker.offer({ lat_deg: 40, lon_deg: 10 })).toBe(false);
    expect(cancelled).toBe(0);
    expect(changes).toBe(2);
  });

  it('cancels: the request’s own function, a newer request, or Cancel', () => {
    const picker = createMapPicker();
    const log: string[] = [];
    const stop = picker.request({ prompt: 'a', onPick: () => log.push('pick a'), onCancel: () => log.push('cancel a') });
    picker.request({ prompt: 'b', onPick: () => log.push('pick b'), onCancel: () => log.push('cancel b') });
    stop(); // a is no longer the waiting one: nothing happens
    picker.cancel();
    expect(log).toEqual(['cancel a', 'cancel b']);
    expect(picker.active()).toBeNull();
  });
});

describe('the shared bearing and its ray on the map', () => {
  it('draws the ray only while a tool holds it, and follows the place', () => {
    const store = createExplorerStore({ storage: null, now: () => Date.UTC(2026, 8, 24, 12) });
    const ctx = { store };
    const bearing = photoBearing(ctx);
    const map = mapServiceFor(ctx);
    bearing.setTyped('299', 299);
    expect(map.hasOverlay(RAY_ID)).toBe(false);
    const release = bearing.holdRay();
    expect(map.hasOverlay(RAY_ID)).toBe(true);
    const line = map.overlays().find((e) => e.id === RAY_ID)!.data.features[0]!;
    expect(line.properties?.label).toBe('299.0° true');
    const coords = (line.geometry as { coordinates: number[][][] }).coordinates[0]!;
    expect(coords[0]![0]).toBeCloseTo(store.get().observer.lon_deg, 9);
    // The place moves: the ray starts there.
    store.patch({ observer: { lat_deg: 51.5, lon_deg: -0.12 } });
    const moved = (map.overlays().find((e) => e.id === RAY_ID)!.data.features[0]!.geometry as { coordinates: number[][][] }).coordinates[0]!;
    expect(moved[0]![1]).toBeCloseTo(51.5, 9);
    bearing.setTyped('', null);
    expect(map.hasOverlay(RAY_ID)).toBe(false);
    bearing.setTyped('45', 45);
    expect(map.hasOverlay(RAY_ID)).toBe(true);
    release();
    expect(map.hasOverlay(RAY_ID)).toBe(false);
  });

  it('takes the bearing from a point picked on the map, and keeps it off the map once removed there', () => {
    const store = createExplorerStore({ storage: null, now: () => Date.UTC(2026, 8, 24, 12) });
    store.patch({ observer: { lat_deg: MANHATTAN.lat_deg, lon_deg: MANHATTAN.lon_deg } });
    const ctx = { store };
    const bearing = photoBearing(ctx);
    const map = mapServiceFor(ctx);
    const release = bearing.holdRay();
    let done = 0;
    bearing.pick(MANHATTAN, () => done++);
    expect(bearing.picking()).toBe(true);
    expect(mapPickerFor(ctx).offer({ lat_deg: 40.759, lon_deg: -73.99 })).toBe(true);
    expect(done).toBe(1);
    expect(bearing.picking()).toBe(false);
    const v = bearing.get();
    expect(v.azimuth).toBeCloseTo(normBearing(geodesicInverse(MANHATTAN, { lat_deg: 40.759, lon_deg: -73.99 }).azimuth_deg), 2);
    expect(v.distance_m).toBeGreaterThan(1000);
    const fc = map.overlays().find((e) => e.id === RAY_ID)!.data;
    expect(fc.features.map((f) => f.geometry.type)).toEqual(['MultiLineString', 'Point']);
    // The person removes it from the map (Layers → Remove): it stays off until the bearing changes.
    map.removeOverlay(RAY_ID);
    store.patch({ observer: { lat_deg: 40.76 } });
    expect(map.hasOverlay(RAY_ID)).toBe(false);
    bearing.setTyped('300', 300);
    expect(map.hasOverlay(RAY_ID)).toBe(true);
    release();
  });
});

// ---------------------------------------------------------------------------------
// Waiting for the time to settle
// ---------------------------------------------------------------------------------

class FakeClock implements SettlerClock {
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.timers.delete(h as number);
  };
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
    }
    this.t = end;
  }
}

describe('expensive rows wait for the time to settle', () => {
  it('knows a drag from a jump', () => {
    const clock = new FakeClock();
    const motion = new Motion(clock, 250);
    clock.t = 1000;
    expect(motion.note(1)).toBe(false); // the first time shown
    clock.t = 5000;
    expect(motion.note(2)).toBe(false); // a jump after a pause
    clock.t = 5016;
    expect(motion.note(2.001)).toBe(true); // frames of a drag
    clock.t = 5032;
    expect(motion.note(2.002)).toBe(true);
    clock.t = 5300;
    expect(motion.note(2.002)).toBe(false); // still for 250 ms
  });

  it('runs at once while still, defers while moving, and runs the last request once settled', () => {
    const clock = new FakeClock();
    const settler = new Settler(clock, 250, 2000);
    const ran: string[] = [];
    let stale = 0;
    expect(settler.request('a', false, () => ran.push('a'))).toBe(true);
    expect(settler.request('a', false, () => ran.push('a again'))).toBe(false);
    for (let i = 0; i < 10; i++) {
      clock.advance(16);
      settler.request(`k${i}`, true, () => ran.push(`k${i}`), () => stale++);
    }
    expect(ran).toEqual(['a']);
    expect(stale).toBe(10);
    clock.advance(260);
    expect(ran).toEqual(['a', 'k9']);
  });

  it('still runs every maxWait while the time keeps moving, unless told never to', () => {
    const clock = new FakeClock();
    const cheap = new Settler(clock, 250, 2000);
    const heavy = new Settler(clock, 250, Infinity);
    const cheapRuns: number[] = [];
    const heavyRuns: number[] = [];
    for (let i = 0; i < 300; i++) {
      clock.advance(16);
      cheap.request(`c${i}`, true, () => cheapRuns.push(clock.t));
      heavy.request(`h${i}`, true, () => heavyRuns.push(clock.t));
    }
    expect(cheapRuns.length).toBe(2); // 4.8 s of motion: twice
    expect(heavyRuns.length).toBe(0);
    clock.advance(300);
    expect(heavyRuns.length).toBe(1);
    heavy.cancel();
    cheap.cancel();
  });
});
