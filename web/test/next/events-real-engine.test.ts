/**
 * The Events view's new lists on the built WebAssembly package (skipped without one; build
 * it with `npm run wasm`):
 *
 * 1. **"Hidden somewhere on Earth"** (moon-model.ts `occultedSomewhere`, `whereSeen`), the
 *    rule that sorts the Moon's close passes into occultations seen elsewhere, checked
 *    against the engine's own local occultation search (`occultations`, validated to 1.4 s
 *    against Skyfield): for every pass of the Moon within 1.6° of a planet or of the seven
 *    navigational stars it can cover, 2026-2027, the search is asked at the place where the
 *    Moon's shadow cast by the body comes nearest the Earth's centre (the line through the
 *    Moon's centre parallel to the body's direction, where it meets the Earth, or the
 *    Earth's edge under it). The rule must agree with what the search finds there whenever
 *    the pass is more than 1′ from the rule's threshold (the Earth's flattening and the
 *    hours the shadow takes to cross move the threshold by fractions of an arcminute), and
 *    "north"/"south" must name the side of the sub-lunar point that place is on.
 * 2. **Real lists as files**: a year of each list's events at Philadelphia, written as a
 *    calendar file, passes the RFC 5545 reader; the table has one row per event.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Conjunction } from '../../src/next/engine/types.js';
import { inspectWasmModule, type WasmEngine, type WasmLoad } from '../../src/next/engine/wasm.js';
import { csvComments, csvOfItems, icsOfItems, screenWords, fileWords, type EventItem } from '../../src/next/events/items.js';
import { apsidesItems, moonPartner, occultationItem, occultedSomewhere, whereSeen } from '../../src/next/events/moon-model.js';
import { OCCULTABLE_STARS } from '../../src/next/events/occultations.js';
import { conjunctionItem, galileanItem, retrogradePeriods, stationItem, transitItem } from '../../src/next/events/planet-model.js';
import { eventIds } from '../../src/next/events/link.js';
import { earthApsisItem, eclipseItem, showerItem } from '../../src/next/events/sky-model.js';
import { defaultState } from '../../src/next/state.js';
import { validate } from './ics-reader.js';

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const JD_UNIX = 2_440_587.5;
const jdOf = (iso: string): number => Date.parse(iso) / 86_400_000 + JD_UNIX;
const PHILLY = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 12 };

function unit(raDeg: number, decDeg: number): [number, number, number] {
  const ra = raDeg * D2R;
  const dec = decDeg * D2R;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
}

describe.skipIf(!hasPackage)('the Events view’s new lists on the built WebAssembly package', () => {
  let engine: WasmEngine;

  beforeAll(async () => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as {
      initSync: (input: { module: BufferSource }) => unknown;
      init?: () => void;
    };
    glue.initSync({ module: readFileSync(WASM_FILE) });
    glue.init?.();
    const load: WasmLoad = inspectWasmModule(glue);
    if (load.status !== 'ready') throw new Error(`the package is ${load.status}`);
    engine = load.engine;
  });

  it('“hidden somewhere on Earth” agrees with the local occultation search, and names the right side', { timeout: 180_000 }, () => {
    const t0 = jdOf('2026-01-01T00:00:00Z');
    const t1 = jdOf('2028-01-01T00:00:00Z');
    const passes: Conjunction[] = [];
    for (let a = t0; a < t1; a += 365.25) {
      const r = engine.conjunctions(a, Math.min(t1, a + 365.25), { moon: true, stars: [...OCCULTABLE_STARS], max_separation_deg: 1.6 });
      passes.push(...r.conjunctions.filter((c) => moonPartner(c) !== null));
    }
    let agree = 0;
    let nearThreshold = 0;
    let sides = 0;
    const faults: string[] = [];
    for (const c of passes) {
      const body = moonPartner(c)!;
      const st = engine.skyState({ lat_deg: 0, lon_deg: 0 }, c.jd_utc, ['Moon', body]);
      const moon = st.bodies.find((b) => b.body === 'Moon')!;
      const other = st.bodies.find((b) => b.body === body)!;
      const hp = moon.horizontal_parallax_arcmin / 60;
      const sd = moon.semidiameter_arcmin / 60;
      const sdBody = other.semidiameter_arcmin / 60;
      const somewhere = occultedSomewhere(c.separation_deg, hp, sd, sdBody);
      const reach = Math.asin(Math.min(1, Math.sin(hp * D2R) + Math.sin(sd * D2R))) * R2D + sdBody;
      const marginArcmin = (reach - c.separation_deg) * 60;
      // Where the line through the Moon's centre, parallel to the body's direction, meets
      // the Earth (in Earth radii; the Moon at 1/sin HP), else the Earth's edge under it.
      const m = unit(moon.ra_deg, moon.dec_deg);
      const s = unit(other.ra_deg, other.dec_deg);
      const dist = 1 / Math.sin(hp * D2R);
      const cos = m[0] * s[0] + m[1] * s[1] + m[2] * s[2];
      const p = [0, 1, 2].map((i) => dist * (m[i]! - cos * s[i]!));
      const pl = Math.hypot(p[0]!, p[1]!, p[2]!);
      const r = pl < 1 ? p.map((v, i) => v + Math.sqrt(1 - pl * pl) * s[i]!) : p.map((v) => v / pl);
      const lat = Math.asin(r[2]!) * R2D;
      const lon = ((((Math.atan2(r[1]!, r[0]!) * R2D - st.gha_aries_deg) % 360) + 540) % 360) - 180;
      const found = engine.occultations({ lat_deg: lat, lon_deg: lon }, c.jd_utc - 0.3, c.jd_utc + 0.3, {
        bodies: [body],
        include_below_horizon: true,
        include_near_misses: true,
        max_magnitude: 6.5,
      });
      const hidden = found.events.some((e) => e.body === body && e.occulted);
      if (Math.abs(marginArcmin) <= 1) nearThreshold += 1;
      else if (hidden === somewhere) agree += 1;
      else faults.push(`${body} ${c.utc}: the rule says ${somewhere}, the search at ${lat.toFixed(1)}, ${lon.toFixed(1)} says ${hidden} (margin ${marginArcmin.toFixed(2)}′)`);
      // The side: north of the sub-lunar point when the Moon passes north of the body.
      const where = whereSeen(c.separation_deg, c.position_angle_deg, sd);
      if (where !== 'middle' && Math.abs(Math.cos(c.position_angle_deg * D2R)) > 0.3) {
        const north = lat > moon.dec_deg;
        if (north !== (where === 'north')) faults.push(`${body} ${c.utc}: said ${where}, the nearest place is at ${lat.toFixed(1)} with the Moon overhead at ${moon.dec_deg.toFixed(1)}`);
        else sides += 1;
      }
    }
    console.info(`occulted somewhere: ${passes.length} Moon passes 2026-2027, ${agree} agree, ${nearThreshold} within 1′ of the threshold, ${sides} sides right`);
    expect(faults).toEqual([]);
    expect(passes.length).toBeGreaterThan(100);
    expect(agree).toBeGreaterThan(100);
    expect(sides).toBeGreaterThan(100);
  });

  it('a year of every list, at Philadelphia, makes valid calendar files and tables', { timeout: 180_000 }, () => {
    const state = { ...defaultState(Date.parse('2026-09-25T16:00:00Z')), settings: { ...defaultState().settings, timeDisplay: 'utc' as const } };
    const w = screenWords(state);
    const f = fileWords(state);
    const a = jdOf('2026-09-25T00:00:00Z');
    const b = a + 365.25;
    const lists: Record<string, (words: typeof w) => EventItem[]> = {
      apsides: (x) => apsidesItems(engine.moonApsides(a, b), x),
      occultations: (x) => engine.occultations(PHILLY, a, b, { include_below_horizon: true }).events.map((o) => occultationItem(o, x)),
      conjunctions: (x) => engine.conjunctions(a, b, { observer: PHILLY }).conjunctions.map((c) => conjunctionItem(c, x)),
      stations: (x) => {
        const r = engine.stations(a, b);
        const shown = r.stations.filter((s) => s.coordinate === r.ui_coordinate);
        const periods = retrogradePeriods(shown, r.ui_coordinate);
        return shown.map((s) => stationItem(s, periods.find((p) => p.begins === s || p.ends === s) ?? null, x));
      },
      transits: (x) => engine.transits(jdOf('1990-01-01T00:00:00Z'), jdOf('2060-12-31T00:00:00Z'), PHILLY).transits.map((t) => transitItem(t, x)),
      jupiter: (x) => engine.galileanEvents(a, a + 3).phenomena.map((p) => galileanItem(p, x, null)),
      showers: (x) => engine.meteorShowers(2026, PHILLY).showers.map((s) => showerItem(s, x)),
      earth: () => {
        const e = engine.earthApsides(2027).events;
        return e.map((x) => earthApsisItem(x, e.find((y) => y !== x) ?? null));
      },
    };
    const counts: Record<string, number> = {};
    for (const [name, make] of Object.entries(lists)) {
      const items = make(f);
      expect(items.length, name).toBeGreaterThan(0);
      counts[name] = items.length;
      // Screen and file words name the same events.
      expect(make(w).map((i) => i.id)).toEqual(items.map((i) => i.id));
      const ics = icsOfItems(items, name, { engine, place: { label: 'Philadelphia', lat_deg: 39.9526, lon_deg: -75.1652 }, format: 'dm' }, Date.parse('2026-09-25T12:00:00Z'));
      const read = validate(ics);
      // One entry per distinct event (an event found twice would share its UID).
      expect(read.events.length, name).toBe(new Set(items.map((i) => i.id)).size);
      for (const e of read.events) expect(e.description!.length).toBeGreaterThan(40);
      const csv = csvOfItems(items, state, engine, csvComments(name, state, null, true));
      const lines = csv.slice(1).split('\r\n').filter((l) => l !== '');
      const header = lines.findIndex((l) => l.startsWith('Instant,'));
      expect(lines.length - header - 1, name).toBe(items.length);
    }
    console.info(`a year of events as files: ${JSON.stringify(counts)}`);
  });

  it('the ids other views open cards by (link.ts `eventIds`) are the lists’ own', () => {
    const w = fileWords(defaultState(Date.parse('2026-09-25T16:00:00Z')));
    const eclipses = engine.eclipses(jdOf('2024-01-01T00:00:00Z'), jdOf('2027-01-01T00:00:00Z')).eclipses;
    expect(eclipses.length).toBeGreaterThan(4);
    for (const e of eclipses) expect(eclipseItem(e, null, w).id).toBe(eventIds.eclipse(e.id));
    const transits = engine.transits(jdOf('2016-01-01T00:00:00Z'), jdOf('2033-01-01T00:00:00Z'), PHILLY).transits;
    expect(transits.length).toBe(3);
    for (const t of transits) expect(transitItem(t, w).id).toBe(eventIds.transit(t.id));
    const a = jdOf('2026-09-25T00:00:00Z');
    const occultations = engine.occultations(PHILLY, a, a + 365.25, { include_below_horizon: true }).events;
    expect(occultations.length).toBeGreaterThan(10);
    for (const o of occultations) expect(occultationItem(o, w).id).toBe(eventIds.occultation(o.body, o.closest.jd_utc));
    for (const sd of engine.meteorShowers(2026).showers) expect(showerItem(sd, w).id).toBe(eventIds.shower(sd.shower.code, sd.peak.jd_utc));
  });
});
