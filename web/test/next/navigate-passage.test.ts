/**
 * navigate2 (expansion programme): the Passage tab's arithmetic — the plan of a route, the
 * dead-reckoning marks, the map's layers, GPX, the measuring tool's "Add as a leg", and the
 * legs handed to the running fix — with the mock engine, and against the real core when a
 * package is built (Bowditch's worked example, and the handover measured with the running
 * fix's own dead-reckoning model).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMockSailings } from '../../src/next/engine/mock-sailings.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { SailingsEngine } from '../../src/next/engine/types.js';
import { WasmEngine, type ExplorerWasmExports } from '../../src/next/engine/wasm.js';
import { greatCircleDistanceNm } from '../../src/next/geo/greatcircle.js';
import { measureActions, registerMeasureAction } from '../../src/next/map/measure.js';
import { hoursText, parseHours } from '../../src/next/navigate/methods/passage.js';
import { defaultPassageForm, type PassageForm, type RouteWaypoint } from '../../src/next/navigate/model.js';
import { emptyRouteData, routeOverlayLayers } from '../../src/next/navigate/passage/overlay.js';
import { addMeasuredLeg, newWaypointId } from '../../src/next/navigate/passage/page.js';
import { legAt, planPassage, positionsAt, routeGpx, runningFixLegs, tickTimes } from '../../src/next/navigate/passage/route.js';
import { jdFromIso } from '../../src/next/time.js';

const wp = (id: string, lat: number, lon: number, leg: RouteWaypoint['leg'] = 'great_circle', name = ''): RouteWaypoint => ({ id, name, lat_deg: lat, lon_deg: lon, leg });

/** Bowditch 2019 vol. 1 section 1208's great circle, then a rhumb line home to the Azores. */
const ROUTE: PassageForm = {
  ...defaultPassageForm(),
  waypoints: [wp('a', 36.9617, -75.7033, 'great_circle', 'Cape Henry'), wp('b', 45.6517, -1.4967, 'great_circle', 'Gironde'), wp('c', 38.7, -27.2167, 'rhumb', 'Angra <Azores>')],
  speedKn: 12,
  departureUtc: '2026-10-01T12:00:00Z',
};

function mock(): SailingsEngine {
  return new MockEngine();
}

describe('planning a passage', () => {
  it('works each leg the way it is sailed, and the times at the speed', () => {
    const plan = planPassage(mock(), ROUTE);
    expect(plan.legs).toHaveLength(2);
    expect(plan.failures).toEqual([]);
    const [gc, rl] = plan.legs;
    expect(gc!.kind).toBe('great_circle');
    expect(gc!.distanceNm).toBeCloseTo(gc!.report.great_circle.distance_nm, 9);
    expect(gc!.otherNm).toBeGreaterThan(gc!.distanceNm);
    expect(rl!.kind).toBe('rhumb');
    expect(rl!.initialCourseDeg).toBe(rl!.finalCourseDeg);
    expect(rl!.distanceNm).toBeCloseTo(rl!.report.rhumb_line.distance_nm, 9);
    expect(plan.totalNm).toBeCloseTo(gc!.distanceNm + rl!.distanceNm, 9);
    expect(plan.totalHours).toBeCloseTo(plan.totalNm / 12, 9);
    expect(gc!.endHours).toBeCloseTo(gc!.distanceNm / 12, 9);
    expect(rl!.startHours).toBe(gc!.endHours);
    expect(plan.arrivalJd! - plan.departureJd!).toBeCloseTo(plan.totalHours! / 24, 8);
    expect(gc!.steering.length).toBeGreaterThan(2);
    expect(legAt(plan, gc!.endHours! + 1)!.leg.index).toBe(1);
  });

  it('keeps going past a leg the engine refuses, and says which', () => {
    const plan = planPassage(mock(), { ...ROUTE, waypoints: [wp('a', 10, 20), wp('b', -10, -160), wp('c', 0, -150, 'rhumb')] });
    expect(plan.failures.map((f) => f.index)).toEqual([0]);
    expect(plan.failures[0]!.error).toMatch(/antipod/i);
    expect(plan.legs.map((l) => l.index)).toEqual([1]);
  });

  it('gives distances only without a speed, and no times without a departure', () => {
    const plan = planPassage(mock(), { ...ROUTE, speedKn: null });
    expect(plan.totalHours).toBeNull();
    expect(plan.legs[0]!.startHours).toBeNull();
    expect(runningFixLegs(mock(), plan, 0, 1)).toBeNull();
    const noDep = planPassage(mock(), { ...ROUTE, departureUtc: null });
    expect(noDep.totalHours).not.toBeNull();
    expect(noDep.arrivalJd).toBeNull();
    expect(tickTimes(noDep, 6)).toEqual([]);
  });

  it('marks the dead reckoning every so many hours, strictly between the departure and the arrival', () => {
    const plan = planPassage(mock(), ROUTE);
    const ticks = tickTimes(plan, 24);
    expect(ticks.length).toBe(Math.floor(plan.totalHours! / 24));
    expect(ticks[0]! - plan.departureJd!).toBeCloseTo(1, 12);
    expect(ticks.every((t) => t < plan.arrivalJd!)).toBe(true);
    const pts = positionsAt(mock(), plan, ticks);
    expect(pts).toHaveLength(ticks.length);
  });
});

describe('the route on the map', () => {
  it('draws great circles solid and rhumb lines dashed, the vertices with the waypoints', () => {
    const data = emptyRouteData();
    data.legs = [
      { kind: 'great_circle', track: [{ lat_deg: 0, lon_deg: 0 }, { lat_deg: 1, lon_deg: 1 }], label: 'great circle 85 NM' },
      { kind: 'rhumb', track: [{ lat_deg: 1, lon_deg: 1 }, { lat_deg: 2, lon_deg: 1 }], label: 'rhumb line 60 NM' },
    ];
    data.waypoints = [{ position: { lat_deg: 0, lon_deg: 0 }, label: 'WP 1' }];
    data.vertices = [{ position: { lat_deg: 48, lon_deg: -27 }, label: 'vertex 48.6° N' }];
    data.now = { position: { lat_deg: 0.5, lon_deg: 0.5 }, label: 'DR now (the time bar)' };
    const layers = routeOverlayLayers(data);
    expect(layers.map((l) => l.id)).toEqual(['passage-route-gc', 'passage-route-rhumb', 'passage-waypoints', 'passage-dr-now']);
    expect(layers[0]!.style.dash).toBeUndefined();
    expect(layers[1]!.style.dash).toEqual([8, 5]);
    expect(layers[2]!.data.features).toHaveLength(2);
    expect(layers.every((l) => l.id.startsWith('passage-') && l.style.labelProperty === 'label')).toBe(true);
  });

  it('writes the route as GPX 1.1, with the great circle’s steering points and escaped names', () => {
    const plan = planPassage(mock(), ROUTE);
    const gpx = routeGpx(plan, ROUTE, { name: 'Trial & error', sessionKind: 'simulated', time: '2026-10-01T00:00:00Z' });
    expect(gpx).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<gpx version="1.1"/);
    expect(gpx).toContain('<name>Trial &amp; error</name>');
    expect(gpx).toContain('<name>Angra &lt;Azores&gt;</name>');
    const rtepts = gpx.match(/<rtept /g)!.length;
    expect(rtepts).toBe(3 + plan.legs[0]!.steering.length - 2);
    expect(gpx).toContain('<type>great-circle point</type>');
    expect(gpx).toContain('SIMULATED session.');
    expect(gpx).toContain('Not a navigation instrument.');
  });
});

describe('"Add as a leg of the passage" (the map’s measuring tool)', () => {
  const a = { lat_deg: 36, lon_deg: -75 };
  const b = { lat_deg: 40, lon_deg: -60 };
  it('adds A and B to an empty route, B alone when A is its end, and A then B elsewhere', () => {
    const first = addMeasuredLeg(defaultPassageForm(), a, b);
    expect(first.added).toBe(2);
    expect(first.connecting).toBe(false);
    const next = addMeasuredLeg(first.form, { lat_deg: 40.001, lon_deg: -60.001 }, { lat_deg: 45, lon_deg: -40 });
    expect(next.added).toBe(1);
    expect(next.form.waypoints.map((w) => w.id)).toEqual(['wp-1', 'wp-2', 'wp-3']);
    const away = addMeasuredLeg(next.form, a, b);
    expect(away.added).toBe(2);
    expect(away.connecting).toBe(true);
    expect(new Set(away.form.waypoints.map((w) => w.id)).size).toBe(5);
    expect(newWaypointId([wp('wp-2', 0, 0)])).toBe('wp-3');
  });

  it('registers once per page and replaces an action with the same id', () => {
    const page = {};
    const calls: string[] = [];
    registerMeasureAction(page, { id: 'x', label: 'One', run: () => calls.push('one') });
    const withdraw = registerMeasureAction(page, { id: 'x', label: 'Two', run: () => calls.push('two') });
    expect(measureActions(page).map((m) => m.label)).toEqual(['Two']);
    measureActions(page)[0]!.run(a, b);
    expect(calls).toEqual(['two']);
    withdraw();
    expect(measureActions(page)).toEqual([]);
    expect(measureActions({})).toEqual([]);
  });
});

describe('words for the tab', () => {
  it('reads hours as navigators type them, and writes long passages in days', () => {
    expect(parseHours('4.5')).toEqual({ ok: true, value: 4.5 });
    expect(parseHours('4:30')).toEqual({ ok: true, value: 4.5 });
    expect(parseHours('4 h 30 min')).toEqual({ ok: true, value: 4.5 });
    expect(parseHours('-2')).toEqual({ ok: true, value: -2 });
    expect(parseHours('')).toEqual({ ok: true, value: null });
    expect(parseHours('4:75').ok).toBe(false);
    expect(parseHours('soon').ok).toBe(false);
    expect(hoursText(6.7)).toBe('6 h 42 min');
    expect(hoursText(76)).toBe('3 d 04 h');
  });
});

describe('with the mock sailings directly (no engine wrapper)', () => {
  it('plans the same', () => {
    const m = new MockEngine();
    const plan = planPassage(createMockSailings((o, jd) => m.skyState(o, jd, 'all')), ROUTE);
    expect(plan.legs).toHaveLength(2);
  });
});

const PKG = resolve(__dirname, '../../src/wasm-pkg/skyfix_wasm.js');

describe.skipIf(!existsSync(PKG))('against the built core (npm run wasm)', () => {
  async function engine(): Promise<WasmEngine | null> {
    const mod = (await import(pathToFileURL(PKG).href)) as Record<string, unknown> & { initSync: (o: { module: Buffer }) => void };
    mod.initSync({ module: readFileSync(resolve(__dirname, '../../src/wasm-pkg/skyfix_wasm_bg.wasm')) });
    if (typeof mod.sailing !== 'function') return null;
    return new WasmEngine(mod as unknown as ExplorerWasmExports);
  }

  it('reproduces Bowditch section 1208’s great circle (3264.54 NM, initial course 055.8°)', async () => {
    const e = await engine();
    if (!e) return;
    const plan = planPassage(e, ROUTE);
    expect(plan.legs[0]!.distanceNm).toBeCloseTo(3264.54, 2);
    expect(plan.legs[0]!.initialCourseDeg).toBeCloseTo(55.807, 3);
    expect(plan.legs[0]!.vertex!.lat_deg).toBeCloseTo(48.6297, 3);
    // The dead reckoning arrives at every waypoint: the leg's end from its own start and course.
    for (const leg of plan.legs) {
      const [end] = positionsAt(e, plan, [plan.departureJd! + leg.endHours! / 24]);
      expect(greatCircleDistanceNm(end!, leg.to)).toBeLessThan(0.01);
    }
  });

  it('hands the running fix legs whose dead reckoning follows the passage to under 5 m', async () => {
    const e = await engine();
    if (!e) return;
    const plan = planPassage(e, ROUTE);
    // Three-hour runs in the middle of the great circle (its course turns 53° over the leg),
    // across the change of leg, and in the middle of the rhumb line.
    const gc = plan.legs[0]!;
    const mids = [gc.endHours! / 2, gc.endHours! - 1.5, plan.legs[1]!.startHours! + 40];
    for (const mid of mids) {
      const lo = plan.departureJd! + (mid - 1.5) / 24;
      const hi = plan.departureJd! + (mid + 1.5) / 24;
      const out = runningFixLegs(e, plan, lo, hi)!;
      expect(out.legs.length).toBeGreaterThan(1);
      expect(out.legs.every((l) => typeof l.start_utc === 'string')).toBe(true);
      const [start] = positionsAt(e, plan, [lo]);
      const [truth] = positionsAt(e, plan, [hi]);
      // The running fix's own dead reckoning (route_positions, great_circle = Track::advance).
      const dr = e.routePositions({
        start: { lat_deg: start!.lat_deg, lon_deg: start!.lon_deg },
        start_utc: out.legs[0]!.start_utc!,
        legs: out.legs,
        method: 'great_circle',
        times_utc: [new Date((hi - 2440587.5) * 86_400_000).toISOString()],
      }).points[0]!;
      const miss = greatCircleDistanceNm(dr, truth!);
      if (process.env.SKYFIX_PRINT) console.log(`handover: 3 h around hour ${mid.toFixed(1)}: ${out.legs.length} legs, the running fix's DR misses the passage by ${(miss * 1852).toFixed(2)} m`);
      expect(miss * 1852).toBeLessThan(5);
    }
    // Why the pieces: one leg on the great circle's course at the window's start misses by far more.
    const lo = plan.departureJd! + (gc.endHours! / 2 - 1.5) / 24;
    const hi = lo + 3 / 24;
    const [start] = positionsAt(e, plan, [lo]);
    const [truth] = positionsAt(e, plan, [hi]);
    const naive = e.routePositions({
      start: { lat_deg: start!.lat_deg, lon_deg: start!.lon_deg },
      start_utc: new Date((lo - 2440587.5) * 86_400_000).toISOString(),
      legs: [{ course_deg: gc.initialCourseDeg!, speed_kn: 12 }],
      method: 'great_circle',
      times_utc: [new Date((hi - 2440587.5) * 86_400_000).toISOString()],
    }).points[0]!;
    if (process.env.SKYFIX_PRINT) console.log(`one leg on the course at the window's start instead: misses by ${greatCircleDistanceNm(naive, truth!).toFixed(2)} NM`);
    expect(greatCircleDistanceNm(naive, truth!)).toBeGreaterThan(5);
    // Times go over to the millisecond (RFC 3339).
    expect(Math.abs(jdFromIso(runningFixLegs(e, plan, lo, hi)!.legs[0]!.start_utc!)! - lo) * 86_400).toBeLessThan(0.001);
  });
});
