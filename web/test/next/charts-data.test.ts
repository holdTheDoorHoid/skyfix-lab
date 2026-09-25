/**
 * Charts: shaping the engine's answers for the day, year, Moon and planet charts
 * (web/src/next/charts/*-data.ts), against the mock engine. The mock's astronomy is only
 * illustrative, so these tests check the shaping (what is asked, what is kept, where it is
 * put) and broad facts any correct sky must satisfy, never precise event times.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { BodyEvents, ExplorerEngine, PhaseEvent, PhaseSegment } from '../../src/next/engine/types.js';
import { jdFromUnixMs } from '../../src/next/engine/types.js';
import type { Zone } from '../../src/next/time.js';
import {
  computeDay,
  curveAt,
  DAY_STEP_MINUTES,
  nearestSample,
  phaseRank,
  starSightWindows,
} from '../../src/next/charts/day-data.js';
import { computeMoonMonth, monthGrid, moonAge, phaseName, waxingAt } from '../../src/next/charts/moon-data.js';
import {
  ALL_PLANETS,
  darkSpansIn,
  placement,
  planetYearJob,
  upIntervals,
  visibilityRuns,
  visibleHours,
} from '../../src/next/charts/planet-data.js';
import { OutsideCoverageError, outsideCoverage } from '../../src/next/charts/coverage.js';
import { localDay, localDayAt, wallHours } from '../../src/next/charts/windows.js';
import { atLeast, computeYear, computeYearSky, eventOf, polarRuns } from '../../src/next/charts/year-data.js';

const engine = new MockEngine();
const PHILLY = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 };
const TROMSO = { lat_deg: 69.6492, lon_deg: 18.9553, height_m: 0 };
const SYDNEY = { lat_deg: -33.8568, lon_deg: 151.2153, height_m: 0 };
const NEW_YORK: Zone = { kind: 'iana', zone: 'America/New_York' };
const OSLO: Zone = { kind: 'iana', zone: 'Europe/Oslo' };
const SYD: Zone = { kind: 'iana', zone: 'Australia/Sydney' };
const OPTIONS = { horizon: 'standard', height_of_eye_m: 0 } as const;
const BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Vega'];

const seg = (phase: PhaseSegment['phase'], a: number, b: number): PhaseSegment => ({ phase, jd_start: a, jd_end: b });

/** Wrap an engine so each call is counted (and still answered). */
function spied(inner: ExplorerEngine) {
  const calls = { dayEventsBatch: [] as number[], dayEvents: 0, sampleBodies: 0, moonPhases: 0, seasons: 0, skyState: 0 };
  const e: ExplorerEngine = {
    ...inner,
    kind: inner.kind,
    description: inner.description,
    bodies: () => inner.bodies(),
    coverage: () => inner.coverage(),
    skyState: (...a) => {
      calls.skyState += 1;
      return inner.skyState(...a);
    },
    sampleBodies: (...a) => {
      calls.sampleBodies += 1;
      return inner.sampleBodies(...a);
    },
    dayEvents: (...a) => {
      calls.dayEvents += 1;
      return inner.dayEvents(...a);
    },
    dayEventsBatch: (o, w, b, opt) => {
      calls.dayEventsBatch.push(w.length);
      return inner.dayEventsBatch(o, w, b, opt);
    },
    moonPhases: (...a) => {
      calls.moonPhases += 1;
      return inner.moonPhases(...a);
    },
    seasons: (y) => {
      calls.seasons += 1;
      return inner.seasons(y);
    },
  };
  return { engine: e, calls };
}

describe('day chart data', () => {
  const day = localDay(NEW_YORK, { year: 2026, month: 9, day: 24 });
  const data = computeDay(engine, { observer: PHILLY, zone: NEW_YORK, day, bodies: BODIES, options: OPTIONS });

  it('asks the engine for the local day at 5-minute steps, and keeps its numbers untouched', () => {
    expect(DAY_STEP_MINUTES).toBe(5);
    expect(data.times.length).toBe(289);
    expect(data.times[0]).toBe(day.jd_start);
    expect(data.times[288]).toBeCloseTo(day.jd_end, 9);
    expect(data.series.map((s) => s.body)).toEqual(BODIES);
    const direct = engine.sampleBodies(PHILLY, BODIES, day.jd_start, day.jd_end, 5);
    const sun = data.series.find((s) => s.body === 'Sun')!;
    expect(Array.from(sun.alt)).toEqual(Array.from(direct.bodies.find((b) => b.body === 'Sun')!.alt_apparent_deg));
    expect(data.series.find((s) => s.body === 'Vega')!.kind).toBe('star');
  });

  it('keeps the engine’s phases, which cover the day, and finds the peak of each curve', () => {
    expect(data.phases[0]!.jd_start).toBe(day.jd_start);
    expect(data.phases[data.phases.length - 1]!.jd_end).toBe(day.jd_end);
    for (let i = 1; i < data.phases.length; i += 1) expect(data.phases[i]!.jd_start).toBe(data.phases[i - 1]!.jd_end);
    const sun = data.series.find((s) => s.body === 'Sun')!;
    expect(sun.everUp).toBe(true);
    expect(sun.peakAlt).toBe(Math.max(...sun.alt));
    // Near the equinox in Philadelphia the Sun peaks near 50°, around 1 pm EDT.
    expect(sun.peakAlt).toBeGreaterThan(45);
    expect(sun.peakAlt).toBeLessThan(55);
    const peakClock = wallHours(day, data.times[sun.peakIndex]!, NEW_YORK);
    expect(peakClock).toBeGreaterThan(12.5);
    expect(peakClock).toBeLessThan(13.5);
  });

  it('marks rise, transit and set from the engine’s events', () => {
    const sunMarkers = data.markers.filter((m) => m.body === 'Sun').map((m) => m.kind);
    expect(sunMarkers).toEqual(['rise', 'transit', 'set']);
    for (const m of data.markers) expect(['rise', 'transit', 'set']).toContain(m.kind);
    expect(data.events.get('Sun')!.day_length_h).toBeGreaterThan(11.5);
  });

  it('finds a morning and an evening star-sight window: the nautical twilights', () => {
    expect(data.starSights.map((w) => w.when)).toEqual(['morning', 'evening']);
    const nautical = data.phases.filter((p) => p.phase === 'nautical');
    expect(data.starSights.map((w) => [w.jd_start, w.jd_end])).toEqual(nautical.map((p) => [p.jd_start, p.jd_end]));
    for (const w of data.starSights) {
      const minutes = (w.jd_end - w.jd_start) * 1440;
      expect(minutes).toBeGreaterThan(25);
      expect(minutes).toBeLessThan(40);
    }
  });

  it('puts markers on the line exactly where the polyline is', () => {
    const sun = data.series.find((s) => s.body === 'Sun')!;
    expect(curveAt(data.times, sun.alt, data.times[100]!)).toBe(sun.alt[100]);
    const mid = (data.times[100]! + data.times[101]!) / 2;
    expect(curveAt(data.times, sun.alt, mid)).toBeCloseTo((sun.alt[100]! + sun.alt[101]!) / 2, 5);
    expect(curveAt(data.times, sun.alt, day.jd_start - 1)).toBe(sun.alt[0]);
    expect(nearestSample(data.times, data.times[37]! + 1 / 1440)).toBe(37);
    expect(nearestSample(data.times, day.jd_end + 5)).toBe(288);
  });

  it('says in plain words when a day is outside the engine’s coverage', () => {
    const far = localDay(NEW_YORK, { year: 2080, month: 1, day: 1 });
    expect(() => computeDay(engine, { observer: PHILLY, zone: NEW_YORK, day: far, bodies: ['Sun', 'Moon'], options: OPTIONS })).toThrow(
      OutsideCoverageError,
    );
    // The bounds as dates, not sliced wire strings (time-ui agent: "-2000-01-01T…" sliced to ten characters broke).
    expect(outsideCoverage(engine)).toBe('This date is outside the time the engine can compute: 1 January 1990 to 31 December 2060.');
  });
});

describe('star-sight windows from phases', () => {
  it('names each nautical stretch by what the sky does around it', () => {
    const d = (h: number): number => h / 24;
    expect(
      starSightWindows([seg('night', 0, d(5)), seg('astronomical', d(5), d(5.5)), seg('nautical', d(5.5), d(6)), seg('civil', d(6), d(6.5))], 0, 1),
    ).toEqual([{ jd_start: d(5.5), jd_end: d(6), when: 'morning', clippedStart: false, clippedEnd: false }]);
    // A white night far north: civil twilight, down into nautical, back to civil.
    const white = starSightWindows([seg('civil', 0, d(1)), seg('nautical', d(1), d(2.5)), seg('civil', d(2.5), 1)], 0, 1);
    expect(white.map((w) => w.when)).toEqual(['night']);
    // A polar winter noon: astronomical, up into nautical, back down.
    const noon = starSightWindows([seg('astronomical', 0, d(11)), seg('nautical', d(11), d(13)), seg('astronomical', d(13), 1)], 0, 1);
    expect(noon.map((w) => w.when)).toEqual(['midday']);
    // Cut by the window's edges.
    const cut = starSightWindows([seg('nautical', 0, d(1)), seg('astronomical', d(1), 1)], 0, 1);
    expect(cut).toEqual([{ jd_start: 0, jd_end: d(1), when: 'evening', clippedStart: true, clippedEnd: false }]);
    expect(starSightWindows([seg('nautical', 0, 1)], 0, 1)[0]!.when).toBe('night');
    expect(phaseRank('night')).toBeLessThan(phaseRank('day'));
  });
});

describe('year chart data', () => {
  const { engine: e, calls } = spied(engine);
  const t0 = performance.now();
  const year = computeYear(e, { observer: PHILLY, zone: NEW_YORK, year: 2026, options: OPTIONS });
  const ms = performance.now() - t0;

  it('makes one day_events_batch call for the whole year, and nothing else', () => {
    expect(calls.dayEventsBatch).toEqual([365]);
    expect(calls.dayEvents + calls.sampleBodies + calls.moonPhases + calls.seasons + calls.skyState).toBe(0);
    expect(year.days).toHaveLength(365);
    expect(year.timing.batchMs).toBeGreaterThan(0);
    expect(ms).toBeLessThan(5000); // sanity only; see the performance notes in the report
  });

  it('matches day_events for the same local day exactly', () => {
    for (const i of [0, 66, 266, 304, 364]) {
      const d = year.days[i]!;
      const single = engine.dayEvents(PHILLY, d.day.jd_start, d.day.jd_end, ['Sun'], OPTIONS);
      expect(d.phases).toEqual(single.phases);
      expect(d.events.map((x) => x.jd)).toEqual(single.bodies[0]!.events.filter((x) => x.kind !== 'lower_transit').map((x) => x.jd_utc));
      expect(d.dayLengthH).toBe(single.bodies[0]!.day_length_h);
    }
  });

  it('lays each day on its clock face from midnight to midnight', () => {
    for (const d of year.days) {
      expect(d.spans[0]!.from).toBe(0);
      expect(d.spans[d.spans.length - 1]!.to).toBeCloseTo(24, 6);
      const day = atLeast(d, 4, phaseRank);
      expect(day).toHaveLength(1); // one daylight stretch a day in Philadelphia
      expect(eventOf(d, 'rise')!.hour).toBeCloseTo(day[0]![0], 6);
      expect(eventOf(d, 'set')!.hour).toBeCloseTo(day[0]![1], 6);
    }
  });

  it('shows the clock changes as jumps of an hour in sunrise', () => {
    expect(year.clockChanges.map((c) => c.day.key)).toEqual(['2026-03-08', '2026-11-01']);
    const rise = (key: string): number => eventOf(year.days.find((d) => d.day.key === key)!, 'rise')!.hour;
    expect(rise('2026-03-08') - rise('2026-03-07')).toBeGreaterThan(0.9);
    expect(rise('2026-03-08') - rise('2026-03-07')).toBeLessThan(1.0);
    expect(rise('2026-11-01') - rise('2026-10-31')).toBeLessThan(-0.95);
  });

  it('finds the longest and shortest days near the solstices, and no polar runs', () => {
    expect(year.days[year.longest!.index]!.day.date.month).toBe(6);
    expect(year.days[year.shortest!.index]!.day.date.month).toBe(12);
    expect(year.longest!.hours).toBeGreaterThan(15);
    expect(year.shortest!.hours).toBeLessThan(9.5);
    expect(year.polar).toEqual([]);
  });

  it('brackets the midnight sun and the polar night at Tromsø', () => {
    const tromso = computeYear(engine, { observer: TROMSO, zone: OSLO, year: 2026, options: OPTIONS });
    const runs = tromso.polar.map((r) => ({
      kind: r.kind,
      first: tromso.days[r.first]!.day.key,
      last: tromso.days[r.last]!.day.key,
    }));
    const sun = runs.find((r) => r.kind === 'midnight_sun')!;
    expect(sun.first >= '2026-05-15' && sun.first <= '2026-05-22').toBe(true);
    expect(sun.last >= '2026-07-20' && sun.last <= '2026-07-27').toBe(true);
    const night = runs.filter((r) => r.kind === 'polar_night');
    expect(night.map((r) => r.first < '2026-02-01' || r.first >= '2026-11-20')).toEqual(night.map(() => true));
    const summer = tromso.days.find((d) => d.day.key === '2026-06-21')!;
    expect(summer.alwaysAbove).toBe(true);
    expect(summer.spans).toEqual([{ phase: 'day', from: 0, to: 24 }]);
    expect(summer.dayLengthH).toBeCloseTo(24, 6);
  });

  it('sends only the days the engine covers, and leaves the rest blank', () => {
    // New York's 31 December 2060 ends at 05:00 UTC on 1 January 2061, past the mock's
    // coverage: that day is left out of the batch, so the batch does not fail.
    const { engine: e2, calls: c2 } = spied(engine);
    const edge = computeYear(e2, { observer: PHILLY, zone: NEW_YORK, year: 2060, options: OPTIONS });
    expect(c2.dayEventsBatch).toEqual([365]);
    expect(edge.days[365]!.error).toMatch(/coverage/);
    expect(edge.days[364]!.error).toBeNull();
    expect(edge.errors[0]).toMatch(/^1 day is left blank\./);
    expect(() => computeYear(engine, { observer: PHILLY, zone: NEW_YORK, year: 2080, options: OPTIONS })).toThrow(OutsideCoverageError);
  });

  it('groups polar days into runs', () => {
    const flags = (s: string) =>
      [...s].map((c) => ({ alwaysAbove: c === 'A', alwaysBelow: c === 'B', error: c === 'x' ? 'no' : null }));
    expect(polarRuns(flags('..AAA.BB.AxA'))).toEqual([
      { kind: 'midnight_sun', first: 2, last: 4 },
      { kind: 'polar_night', first: 6, last: 7 },
      { kind: 'midnight_sun', first: 9, last: 9 },
      { kind: 'midnight_sun', first: 11, last: 11 },
    ]);
  });

  it('gets the Moon’s phases and the seasons separately, independent of the place', () => {
    const { engine: e2, calls: c2 } = spied(engine);
    const sky = computeYearSky(e2, NEW_YORK, 2026);
    expect(c2.moonPhases).toBe(1);
    expect(c2.seasons).toBe(1);
    expect(sky.seasons.map((s) => s.kind)).toEqual(['march_equinox', 'june_solstice', 'september_equinox', 'december_solstice']);
    expect(sky.moonPhases.length).toBeGreaterThanOrEqual(48);
    expect(sky.moonPhases.length).toBeLessThanOrEqual(51);
    const first = year.days[0]!.day.jd_start;
    const last = year.days[364]!.day.jd_end;
    for (const p of sky.moonPhases) expect(p.jd_utc >= first && p.jd_utc < last).toBe(true);
  });
});

describe('Moon calendar data', () => {
  const month = computeMoonMonth(engine, { observer: PHILLY, zone: NEW_YORK, year: 2026, month: 9, options: OPTIONS });

  it('covers the month, with one principal phase of each kind on its local date', () => {
    expect(month.days).toHaveLength(30);
    expect(month.events.map((e) => e.kind).sort()).toEqual(['first_quarter', 'full_moon', 'last_quarter', 'new_moon']);
    for (const ev of month.events) {
      const d = month.days.find((x) => x.principal === ev)!;
      expect(ev.jd_utc >= d.day.jd_start && ev.jd_utc < d.day.jd_end).toBe(true);
    }
    expect(month.days.filter((d) => d.principal).length).toBe(4);
  });

  it('draws each day from the engine’s Moon at local noon', () => {
    const d = month.days[23]!;
    const noon = engine.skyState(PHILLY, d.noonJd, ['Moon']).bodies[0]!;
    expect(d.illuminated).toBe(noon.illuminated_fraction);
    expect(d.brightLimbDeg).toBe(noon.bright_limb_angle_deg);
    expect(wallHours(d.day, d.noonJd, NEW_YORK)).toBeCloseTo(12, 6);
  });

  it('is waxing between new and full moon, and names the days between the phases', () => {
    const newMoon = month.events.find((e) => e.kind === 'new_moon')!;
    const full = month.events.find((e) => e.kind === 'full_moon')!;
    for (const d of month.days) {
      if (d.noonJd > newMoon.jd_utc && d.noonJd < full.jd_utc) expect(d.waxing).toBe(true);
      if (d.principal) continue;
      expect(d.name).toMatch(/^(Waxing|Waning) (crescent|gibbous)$/);
    }
    const lit = month.days.map((d) => d.illuminated!);
    const newDay = month.days.find((d) => d.principal?.kind === 'new_moon')!;
    const fullDay = month.days.find((d) => d.principal?.kind === 'full_moon')!;
    expect(newDay.illuminated!).toBeLessThan(0.03);
    expect(fullDay.illuminated!).toBeGreaterThan(0.97);
    expect(Math.min(...lit)).toBe(newDay.illuminated);
  });

  it('keeps moonrise and moonset per local day (some days have none)', () => {
    const counts = month.days.map((d) => d.rises.length);
    expect(counts.filter((n) => n === 0).length).toBeGreaterThanOrEqual(1);
    expect(counts.every((n) => n <= 2)).toBe(true);
    for (const d of month.days) for (const jd of [...d.rises, ...d.sets]) expect(jd >= d.day.jd_start && jd < d.day.jd_end).toBe(true);
  });

  it('lays a month out in weeks starting on the chosen weekday', () => {
    // September 2026 starts on a Tuesday.
    const sunday = monthGrid(month.days, 0);
    expect(sunday[0]!.slice(0, 2)).toEqual([null, null]);
    expect(sunday[0]![2]!.day.date.day).toBe(1);
    const monday = monthGrid(month.days, 1);
    expect(monday[0]![0]).toBeNull();
    expect(monday[0]![1]!.day.date.day).toBe(1);
    for (const grid of [sunday, monday]) {
      expect(grid.every((row) => row.length === 7)).toBe(true);
      expect(grid.flat().filter(Boolean)).toHaveLength(30);
    }
  });

  it('reads waxing, age and names from principal phases', () => {
    const events: PhaseEvent[] = [
      { kind: 'new_moon', jd_utc: 10, utc: '' },
      { kind: 'first_quarter', jd_utc: 17, utc: '' },
      { kind: 'full_moon', jd_utc: 25, utc: '' },
      { kind: 'last_quarter', jd_utc: 32, utc: '' },
    ];
    expect(waxingAt(events, 5)).toBeNull();
    expect(waxingAt(events, 12)).toBe(true);
    expect(waxingAt(events, 26)).toBe(false);
    expect(moonAge(events, 12.5)).toBe(2.5);
    expect(moonAge(events, 9)).toBeNull();
    expect(phaseName(0.3, true)).toBe('Waxing crescent');
    expect(phaseName(0.8, false)).toBe('Waning gibbous');
    expect(phaseName(null, true)).toBe('—');
  });

  it('draws the southern hemisphere’s month from the same engine calls', () => {
    const syd = computeMoonMonth(engine, { observer: SYDNEY, zone: SYD, year: 2026, month: 9, options: OPTIONS });
    expect(syd.days).toHaveLength(30);
    expect(syd.errors).toEqual([]);
  });
});

describe('planet visibility data', () => {
  it('cuts the dark phases into one night, merged across midnight', () => {
    const phases = [
      seg('day', 0, 0.3),
      seg('astronomical', 0.3, 0.35),
      seg('night', 0.35, 0.5),
      seg('night', 0.5, 0.7), // the next window starts at midnight
      seg('astronomical', 0.7, 0.75),
      seg('day', 0.75, 1),
    ];
    expect(darkSpansIn(phases, 0.2, 0.9)).toEqual([
      { phase: 'astronomical', jd_start: 0.3, jd_end: 0.35 },
      { phase: 'night', jd_start: 0.35, jd_end: 0.7 },
      { phase: 'astronomical', jd_start: 0.7, jd_end: 0.75 },
    ]);
    expect(darkSpansIn(phases, 0.4, 0.6)).toEqual([{ phase: 'night', jd_start: 0.4, jd_end: 0.6 }]);
  });

  it('reads when a body is up inside a window from its rises and sets', () => {
    const ev = (kind: 'rise' | 'set', jd: number) => ({ kind, jd_utc: jd, utc: '', alt_deg: 0, az_deg: 0 });
    const be = (events: ReturnType<typeof ev>[], above = false, below = false): BodyEvents => ({
      body: 'Mars',
      events,
      always_above: above,
      always_below: below,
      day_length_h: null,
    });
    expect(upIntervals(be([ev('rise', 3)]), 0, 10)).toEqual([[3, 10]]);
    expect(upIntervals(be([ev('set', 4)]), 0, 10)).toEqual([[0, 4]]);
    expect(upIntervals(be([ev('set', 2), ev('rise', 8)]), 0, 10)).toEqual([
      [0, 2],
      [8, 10],
    ]);
    expect(upIntervals(be([], true), 0, 10)).toEqual([[0, 10]]);
    expect(upIntervals(be([], false, true), 0, 10)).toEqual([]);
  });

  it('says where in the night a planet is', () => {
    const span = (a: number, b: number) => ({ jd_start: a, jd_end: b, from: 0, to: 0 });
    expect(placement([span(0, 0.2)], [0, 0.4])).toBe('evening');
    expect(placement([span(0.3, 0.4)], [0, 0.4])).toBe('morning');
    expect(placement([span(0, 0.4)], [0, 0.4])).toBe('all night');
    expect(placement([span(0.1, 0.2)], [0, 0.4])).toBe('midnight');
    expect(placement([], [0, 0.4])).toBeNull();
    expect(visibleHours([span(0, 0.25), span(0.5, 0.75)])).toBeCloseTo(12, 9);
  });

  it('asks only about the dark hours, primary planets first, in month-sized batches', () => {
    const year = computeYear(engine, { observer: PHILLY, zone: NEW_YORK, year: 2026, options: OPTIONS });
    const { engine: e, calls } = spied(engine);
    const batchSpy = vi.spyOn(e, 'dayEventsBatch');
    const job = planetYearJob(e, { observer: PHILLY, zone: NEW_YORK, year: 2026, options: OPTIONS, planets: ['Venus', 'Jupiter', 'Uranus'] }, year);
    expect(calls.dayEvents).toBe(1); // the next New Year's Day, to finish the last night
    expect(job.done).toBe(false);
    expect(job.data.nights).toHaveLength(365);
    const [lo, hi] = job.data.hourRange!;
    expect(lo).toBeGreaterThanOrEqual(5); // darkness starts after 17:00
    expect(hi).toBeLessThanOrEqual(19); // and ends before 07:00
    job.step(1); // at least one chunk
    expect(batchSpy.mock.calls[0]![2]).toEqual(['Venus', 'Jupiter']);
    expect(job.has('Venus')).toBe(false);
    while (!job.step(1e9));
    expect(job.progress).toBe(1);
    const planetsAsked = batchSpy.mock.calls.map((c) => (c[2] as string[]).join(','));
    expect(planetsAsked.slice(0, 12).every((p) => p === 'Venus,Jupiter')).toBe(true);
    expect(planetsAsked[planetsAsked.length - 1]).toBe('Uranus');
    expect(job.has('Venus') && job.has('Uranus')).toBe(true);
    // Every window is a night's darkness, and every answer lies inside it.
    for (const call of batchSpy.mock.calls) for (const [a, b] of call[1] as [number, number][]) expect(b - a).toBeLessThan(0.6);
    for (const n of job.data.nights) {
      expect(n.computed).toBe(true);
      for (const spans of n.visible.values()) {
        for (const s of spans) {
          expect(s.jd_start >= n.darkWindow![0] - 1e-9 && s.jd_end <= n.darkWindow![1] + 1e-9).toBe(true);
          expect(s.to).toBeGreaterThan(s.from);
        }
      }
    }
    // Jupiter is up in the dark on some nights and not on others over a year.
    const jupiterNights = job.data.nights.filter((n) => visibleHours(n.visible.get('Jupiter') ?? []) > 0.1).length;
    expect(jupiterNights).toBeGreaterThan(100);
    expect(jupiterNights).toBeLessThan(365);
    const runs = visibilityRuns(job.data.nights, 'Jupiter');
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r.last).toBeGreaterThanOrEqual(r.first);
  });

  it('has nothing to ask on nights that never get dark (Tromsø in June)', () => {
    const year = computeYear(engine, { observer: TROMSO, zone: OSLO, year: 2026, options: OPTIONS });
    const job = planetYearJob(engine, { observer: TROMSO, zone: OSLO, year: 2026, options: OPTIONS, planets: ['Saturn'] }, year);
    const june = job.data.nights.filter((n) => n.night.date.month === 6);
    expect(june.every((n) => n.darkWindow === null && n.computed)).toBe(true);
    const december = job.data.nights.filter((n) => n.night.date.month === 12);
    expect(december.every((n) => n.darkWindow !== null)).toBe(true);
    while (!job.step(1e9));
    expect(job.data.nights.every((n) => n.computed)).toBe(true);
  });

  it('lists every planet, the four naked-eye navigational ones first', () => {
    expect(ALL_PLANETS).toEqual(['Venus', 'Mars', 'Jupiter', 'Saturn', 'Mercury', 'Uranus', 'Neptune']);
  });
});

describe('the display zone decides the windows', () => {
  it('asks for UTC days when the display is in UTC', () => {
    const utc: Zone = { kind: 'fixed', offsetMs: 0, name: 'UTC' };
    const jd = jdFromUnixMs(Date.UTC(2026, 8, 24, 2));
    const day = localDayAt(jd, utc);
    expect(day.jd_start).toBe(jdFromUnixMs(Date.UTC(2026, 8, 24)));
    const local = localDayAt(jd, NEW_YORK);
    expect(local.key).toBe('2026-09-23');
  });
});
