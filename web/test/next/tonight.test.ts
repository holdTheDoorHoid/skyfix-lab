/**
 * The Tonight view (expansion programme Q2): which night a moment belongs to, the stretches
 * of the night, and every card's words against the engine that produced them (the mock
 * engine, whose numbers are illustrative but come through the same contract), the fortnight
 * ahead, the tab strip with Tonight and without About, the tour card and the Sky link.
 * The page itself is checked in Chrome by web/scripts/ui-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { memoEngine } from '../../src/next/component.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { DayEvents, ExplorerEngine, Observer, PhaseSegment, PlanetTonight, Tonight } from '../../src/next/engine/types.js';
import { hashForView, viewFromHash } from '../../src/next/shell/router.js';
import { registry } from '../../src/next/shell/registry.js';
import { TOUR_STEPS } from '../../src/next/shell/tour.js';
import { hasTab, TABS, VIEW_META } from '../../src/next/shell/views.js';
import { createExplorerStore, VIEW_IDS } from '../../src/next/state.js';
import { jdFromIso, UTC_ZONE, type Zone } from '../../src/next/time.js';
import { COMING_SOURCES, conjunctionTitle, mergeComing, yearsOf, type ComingResult } from '../../src/next/tonight/coming.js';
import { chooseNight, darknessOf, loadCore, loadDetail, nightQuery, queryKey, sunWindow, type NightCore } from '../../src/next/tonight/data.js';
import { clock, clockRange, degrees, duration, percentLit, type Fmt } from '../../src/next/tonight/format.js';
import {
  darknessSentence,
  dsoRows,
  headerModel,
  lightRows,
  milkyWayModel,
  moonlessDark,
  moonModel,
  moonSentence,
  moonUp,
  phaseWords,
  planetLine,
  planetsModel,
  planetsSentence,
  planetWhen,
  planetWindow,
  relativeNight,
  showerRows,
} from '../../src/next/tonight/model.js';
import {
  darkRun,
  intersect,
  localNoonBefore,
  MINUTE,
  nightProbe,
  nightStartFor,
  nightSwitch,
  spanDays,
  subtract,
  upSpans,
  type SunWindow,
} from '../../src/next/tonight/night.js';
import { showInSky, skyTargets } from '../../src/next/tonight/sky-link.js';
import { timelineModel, timelineSpan } from '../../src/next/tonight/timeline.js';

const PHILLY: Observer = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 };
const jd = (iso: string): number => jdFromIso(iso)!;
const EDT: Zone = { kind: 'iana', zone: 'America/New_York' };
const F: Fmt = { zone: EDT, angle: 'dm', units: 'metric' };

/** Local mean noon at Philadelphia on 2026-09-24 (12:00 LMT is 17:00:40 UT). */
const N24 = localNoonBefore(PHILLY.lon_deg, jd('2026-09-24T18:00:00Z'));
const N25 = N24 + 1;

const engine = memoEngine(new MockEngine({ syntheticStars: 0 }));
const ctx = { engine };

function state(iso: string) {
  const store = createExplorerStore({
    storage: null,
    now: () => Date.UTC(2026, 8, 25, 8, 48),
    initial: { observer: { lat_deg: PHILLY.lat_deg, lon_deg: PHILLY.lon_deg, height_m: 0, label: 'Philadelphia', zone: { kind: 'iana', zone: 'America/New_York' } }, time: { jd_utc: jd(iso), live: false } },
  });
  return { store, s: store.get() };
}

function seg(a: number, b: number, phase: PhaseSegment['phase']): PhaseSegment {
  return { jd_start: a, jd_end: b, phase };
}

// -------------------------------------------------------------------------------------
// Which night
// -------------------------------------------------------------------------------------

describe('which night a moment belongs to', () => {
  it('uses the engine’s local mean noon: 17:00:40 UT at Philadelphia', () => {
    const utcHours = ((N24 + 0.5) % 1) * 24;
    expect(utcHours).toBeCloseTo(17 + 0.68 / 60, 3);
    expect(localNoonBefore(PHILLY.lon_deg, N24 + 0.3)).toBeCloseTo(N24, 9);
    expect(localNoonBefore(PHILLY.lon_deg, N24 - 1e-6)).toBeCloseTo(N24 - 1, 9);
  });

  it('finds the darkness as the engine does: full night first, then the darkest twilight', () => {
    const n = 0;
    const full = [seg(n, n + 0.3, 'day'), seg(n + 0.3, n + 0.35, 'civil'), seg(n + 0.35, n + 0.4, 'nautical'), seg(n + 0.4, n + 0.45, 'astronomical'), seg(n + 0.45, n + 0.55, 'night'), seg(n + 0.55, n + 0.6, 'astronomical'), seg(n + 0.6, n + 1, 'day')];
    expect(darkRun(full)).toEqual({ kind: 'night', start: n + 0.45, end: n + 0.55 });
    const pale = [seg(n, n + 0.4, 'day'), seg(n + 0.4, n + 0.45, 'nautical'), seg(n + 0.45, n + 0.55, 'astronomical'), seg(n + 0.55, n + 0.6, 'nautical'), seg(n + 0.6, n + 1, 'day')];
    expect(darkRun(pale)).toEqual({ kind: 'astronomical_twilight', start: n + 0.45, end: n + 0.55 });
    expect(darkRun([seg(n, n + 0.45, 'day'), seg(n + 0.45, n + 0.55, 'civil'), seg(n + 0.55, n + 1, 'day')])).toBeNull();
  });

  it('switches at the end of the darkness, else sunrise, else midnight, else noon', () => {
    const n = 100;
    const phases = [seg(n, n + 0.3, 'day'), seg(n + 0.3, n + 0.4, 'nautical'), seg(n + 0.4, n + 0.7, 'night'), seg(n + 0.7, n + 0.75, 'civil'), seg(n + 0.75, n + 1, 'day')];
    const sun = { events: [{ kind: 'rise' as const, jd_utc: n + 0.75, utc: '', alt_deg: 0, az_deg: 0 }], always_above: false, always_below: false };
    expect(nightSwitch(n, { phases, sun })).toBeCloseTo(n + 0.7, 12);
    const bright = [seg(n, n + 0.45, 'day'), seg(n + 0.45, n + 0.55, 'civil'), seg(n + 0.55, n + 1, 'day')];
    expect(nightSwitch(n, { phases: bright, sun })).toBeCloseTo(n + 0.75, 12);
    expect(nightSwitch(n, { phases: [seg(n, n + 1, 'day')], sun: { events: [], always_above: true, always_below: false } })).toBe(n + 0.5);
    expect(nightSwitch(n, { phases: [seg(n, n + 1, 'night')], sun: { events: [], always_above: false, always_below: true } })).toBe(n + 1);
  });

  it('keeps the current night until astronomical dawn, then shows the coming one (the brief’s rule)', () => {
    const window = (n0: number): SunWindow => sunWindow(ctx, PHILLY, n0);
    const pick = (iso: string): number => nightStartFor(jd(iso), PHILLY.lon_deg, window);
    expect(pick('2026-09-24T16:00:00Z')).toBeCloseTo(N24, 9); // 12:00 EDT, before local mean noon: the coming night
    expect(pick('2026-09-24T23:30:00Z')).toBeCloseTo(N24, 9); // 19:30 EDT
    expect(pick('2026-09-25T06:00:00Z')).toBeCloseTo(N24, 9); // 02:00 EDT, dark
    const dawn = window(N24).sun!.events.find((e) => e.kind === 'astronomical_dawn')!.jd_utc;
    expect(nightStartFor(dawn - MINUTE, PHILLY.lon_deg, window)).toBeCloseTo(N24, 9);
    expect(nightStartFor(dawn + MINUTE, PHILLY.lon_deg, window)).toBeCloseTo(N25, 9);
    expect(pick('2026-09-25T14:00:00Z')).toBeCloseTo(N25, 9); // 10:00 EDT
  });

  it('asks the engine for the night it chose, where the engine’s own rule (sunrise) would not', () => {
    const window = sunWindow(ctx, PHILLY, N24);
    const dawn = window.sun!.events.find((e) => e.kind === 'astronomical_dawn')!.jd_utc;
    const rise = window.sun!.events.find((e) => e.kind === 'rise' && e.jd_utc > dawn)!.jd_utc;
    const between = (dawn + rise) / 2;
    const { s } = state(new Date((between - 2440587.5) * 86400000).toISOString());
    const n = chooseNight(ctx, s)!;
    expect(n).toBeCloseTo(N25, 9);
    // The engine, asked at that moment, would still give the night that is ending…
    expect(engine.tonight(PHILLY, between).night.start.jd_utc).toBeCloseTo(N24, 6);
    // …so the view asks just after the chosen night's noon.
    expect(engine.tonight(PHILLY, nightProbe(n)).night.start.jd_utc).toBeCloseTo(N25, 6);
  });

  it('names the night against the real one', () => {
    expect(relativeNight(N24, N24)).toBe('Tonight');
    expect(relativeNight(N25, N24)).toBe('Tomorrow night');
    expect(relativeNight(N24 - 1, N24)).toBe('Last night');
    expect(relativeNight(N24 + 5, N24)).toBe('The night of');
    expect(relativeNight(N24, null)).toBe('The night of');
  });
});

describe('stretches of time', () => {
  it('intersects, subtracts and measures', () => {
    expect(intersect([0, 2], [1, 3])).toEqual([1, 2]);
    expect(intersect([0, 1], [1, 2])).toBeNull();
    expect(subtract([0, 10], [[2, 3], [5, 12]])).toEqual([[0, 2], [3, 5]]);
    expect(subtract([0, 10], [])).toEqual([[0, 10]]);
    expect(spanDays([[0, 1], [2, 2.5]])).toBe(1.5);
  });

  it('turns rises and sets into the spans a body is up', () => {
    const ev = (kind: 'rise' | 'set', t: number) => ({ kind, jd_utc: t, utc: '', alt_deg: 0, az_deg: 0 });
    expect(upSpans([0, 1], { events: [ev('rise', 0.2), ev('set', 0.6)], always_above: false, always_below: false })).toEqual([[0.2, 0.6]]);
    expect(upSpans([0, 1], { events: [ev('set', 0.3), ev('rise', 0.8)], always_above: false, always_below: false })).toEqual([[0, 0.3], [0.8, 1]]);
    expect(upSpans([0, 1], { events: [], always_above: true, always_below: false })).toEqual([[0, 1]]);
    expect(upSpans([0, 1], { events: [], always_above: false, always_below: true })).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------
// The cards against the engine
// -------------------------------------------------------------------------------------

function coreFor(n: number, eng: Pick<typeof ctx, 'engine'> = ctx): NightCore {
  const { s } = state('2026-09-24T23:30:00Z');
  return loadCore(eng, nightQuery(s, n, { bortle: 5 }));
}

describe('the night’s numbers are the engine’s', () => {
  const core = coreFor(N24);
  const t = core.tonight!;

  it('asks each engine for the chosen night', () => {
    expect(core.covered).toBe(true);
    expect(core.errors).toEqual([]);
    expect(t.night.start.jd_utc).toBeCloseTo(N24, 6);
    expect(core.day!.jd_start).toBe(N24);
    expect(core.sunHours!.jd_start).toBe(N24);
    expect(core.galactic!.jd_start).toBe(N24);
    expect(queryKey(core.q)).toContain(String(N24));
  });

  it('says when it is dark, to the minute of the engine’s darkness', () => {
    const d = t.night.darkness!;
    expect(darknessOf(core)).toEqual({ kind: d.kind, start: d.start.jd_utc, end: d.end.jd_utc, hours: d.hours });
    expect(darknessSentence(core, F)).toBe(`Clear-sky darkness ${clockRange(d.start.jd_utc, d.end.jd_utc, F)} (${duration(d.end.jd_utc - d.start.jd_utc)}).`);
  });

  it('gives the Moon’s light and its rises and sets from the engines', () => {
    const detail = loadDetail(ctx, core);
    const sentence = moonSentence(core, detail, F)!;
    expect(sentence).toContain(`(${percentLit(t.night.moon.illuminated_fraction)} lit)`);
    const moon = core.day!.bodies.find((b) => b.body === 'Moon')!;
    const m = moonModel(core, detail, F)!;
    for (const e of moon.events.filter((x) => x.kind === 'rise' || x.kind === 'set')) {
      expect(m.rows.some((r) => r.jd === e.jd_utc)).toBe(true);
    }
    // Moonless darkness is the darkness less the Moon's spans above the horizon.
    const free = moonlessDark(core);
    const d = darknessOf(core)!;
    expect(spanDays(free) + spanDays(moonUp(core).map((u) => intersect(u, [d.start, d.end])).filter((x): x is [number, number] => x !== null))).toBeCloseTo(d.end - d.start, 9);
  });

  it('writes the Moon’s phase as days from the nearest principal phase', () => {
    const phases = [
      { kind: 'first_quarter' as const, jd_utc: 100, utc: '' },
      { kind: 'full_moon' as const, jd_utc: 107.4, utc: '' },
    ];
    expect(phaseWords(phases, 103.2)).toBe('3 days past first quarter');
    expect(phaseWords(phases, 104.1)).toBe('3 days before full');
    expect(phaseWords(phases, 107.2)).toBe('full');
    expect(phaseWords(phases, 100.3)).toBe('at first quarter');
    expect(phaseWords(phases, 101.2)).toBe('a day past first quarter');
    expect(phaseWords(null, 1)).toBeNull();
  });

  it('draws the timeline from the day’s phases, golden hours, the Moon and the core', () => {
    const tl = timelineModel(core, F);
    const [a, b] = timelineSpan(core);
    expect(tl.start).toBe(a);
    expect(tl.end).toBe(b);
    const sun = core.day!.bodies.find((x) => x.body === 'Sun')!;
    const set = sun.events.find((e) => e.kind === 'set')!;
    expect(tl.start).toBeCloseTo(set.jd_utc - 1 / 24, 9);
    expect(tl.moments.find((m) => m.key === 'sun-set')!.jd).toBe(set.jd_utc);
    expect(tl.moments.find((m) => m.key === 'sun-astronomical_dusk')!.jd).toBe(sun.events.find((e) => e.kind === 'astronomical_dusk')!.jd_utc);
    for (const band of tl.sky) expect(band.end).toBeGreaterThan(band.start);
    // Every phase band lies inside the bar, and together they cover it.
    expect(tl.sky.reduce((sum, band) => sum + (band.end - band.start), 0)).toBeCloseTo(tl.end - tl.start, 9);
    const golden = core.sunHours!.windows.filter((w) => w.kind === 'golden');
    expect(tl.light.filter((l) => l.kind === 'golden').length).toBe(golden.filter((w) => w.jd_end > a && w.jd_start < b).length);
    expect(tl.ticks.every((k) => k.jd >= a && k.jd < b)).toBe(true);
    expect(tl.summary).toContain(`Sunset ${clock(set.jd_utc, F)}`);
  });

  it('lists golden and blue hours as the sun tools gave them', () => {
    const rows = lightRows(core, F)!;
    expect(rows).toHaveLength(core.sunHours!.windows.length);
    rows.forEach((r, i) => {
      const w = core.sunHours!.windows[i]!;
      expect(r.jd).toBe(w.jd_start);
      expect(r.range).toContain(clock(w.jd_start, F));
      expect(r.label).toBe(w.kind === 'golden' ? 'Golden hour' : 'Blue hour');
    });
  });

  it('puts the Milky Way’s dark windows in words', () => {
    const m = milkyWayModel(core, F)!;
    const ws = core.galactic!.windows;
    if (ws.length) {
      for (const w of ws) expect(m.headline).toContain(clockRange(w.jd_start, w.jd_end, F));
      const best = ws.reduce((x, w) => (w.best.alt_deg > x.best.alt_deg ? w : x), ws[0]!);
      expect(m.best!.jd).toBe(best.best.jd_utc);
      expect(m.best!.text).toContain(degrees(best.best.alt_apparent_deg));
    } else {
      expect(m.headline).toMatch(/not 10° up/);
      expect(m.best).toBeNull();
    }
  });

  it('ranks deep-sky objects as the engine did, with the catalogue’s words', () => {
    const catalog = engine.dsoCatalog().objects;
    const rows = dsoRows(core, catalog, new Map([['And', 'Andromeda']]), F);
    expect(rows.map((r) => r.id)).toEqual(t.deep_sky.map((d) => d.id));
    rows.forEach((r, i) => {
      const d = t.deep_sky[i]!;
      expect(r.when).toContain(clock(d.best.jd_utc, F));
      expect(r.when).toContain(degrees(d.best.alt_deg));
      expect(r.when).toContain(`${d.hours_above_20.toFixed(1)} h above 20°`);
      expect(r.description).toBe(catalog.find((c) => c.id === d.id)?.description ?? null);
    });
  });

  it('gives each active shower the engine’s rate and best time', () => {
    const rows = showerRows(core, F);
    expect(rows.map((r) => r.code)).toEqual(t.showers.map((s) => s.code));
    rows.forEach((r, i) => {
      const s = t.showers[i]!;
      expect(r.rate).toContain(`ZHR ${Math.round(s.zhr)}`);
      if (s.best) expect(r.when).toContain(clock(s.best.jd_utc, F));
      expect(r.reason).toBe(s.reason);
    });
  });

  it('puts the header together from the cards’ sentences', () => {
    const h = headerModel(core, null, F, jd('2026-09-25T08:48:00Z'), N24);
    expect(h.kicker).toBe('Tonight');
    expect(h.date).toBe('Thursday 24 September');
    expect(h.sentences[0]).toBe(darknessSentence(core, F));
  });
});

describe('planets: when and where, from the engine’s ranking', () => {
  const base = coreFor(N24);
  const w = planetWindow(base)!;
  const sighting = (t: number, alt: number) => ({ jd_utc: t, utc: '', alt_deg: alt, az_deg: 100, direction: 'E' as const });
  const planet = (body: string, from: number, until: number, best: number, mag: number | null): PlanetTonight => ({
    body,
    magnitude: mag,
    best: sighting(best, 61.4),
    up_from: { jd_utc: from, utc: '' },
    up_until: { jd_utc: until, utc: '' },
    hours_up: (until - from) * 24,
    reason: '',
  });
  const mid = (w[0] + w[1]) / 2;
  const planets = [
    planet('Jupiter', w[0], w[1], mid, -2.7),
    planet('Saturn', w[0], w[1], mid - 0.05, 0.6),
    planet('Venus', w[0], w[0] + 0.1, w[0], -4.1),
    planet('Mars', mid + 0.1, w[1], w[1], 1.2),
    planet('Uranus', mid - 0.1, w[1], mid, 5.7),
    { body: 'Mercury', magnitude: 0.1, best: null, up_from: null, up_until: null, hours_up: 0, reason: 'Mercury: not up while the sky is dark' },
  ];
  const core: NightCore = { ...base, tonight: { ...base.tonight!, planets } as Tonight };

  it('says when each is up in the dark', () => {
    expect(planetWhen(planets[0]!, w, F)).toBe('all night');
    expect(planetWhen(planets[2]!, w, F)).toBe('in the evening');
    expect(planetWhen(planets[3]!, w, F)).toBe('in the morning');
    expect(planetWhen(planets[4]!, w, F)).toBe(`from ${clock(mid - 0.1, F)}`);
    expect(planetsSentence(core, F)).toBe('Planets: Jupiter and Saturn all night; Venus in the evening; Mars in the morning.');
  });

  it('writes each planet’s line from its best moment and magnitude', () => {
    const line = planetLine(core, planets[0]!, F);
    expect(line).toMatch(/^Jupiter, east, /);
    expect(line).toContain(`highest ${clock(mid, F)} at 61°`);
    expect(line).toContain('magnitude −2.7');
    // At the window's end the planet is still climbing: the line says so.
    expect(planetLine(core, planets[3]!, F)).toContain(`61° up by ${clock(w[1], F)}, as dawn comes`);
    const m = planetsModel(core, null, F)!;
    expect(m.rows.map((r) => r.body)).toEqual(['Jupiter', 'Saturn', 'Venus', 'Mars', 'Uranus']);
    expect(m.others).toBe('Not up in the dark tonight: Mercury.');
  });
});

// -------------------------------------------------------------------------------------
// Coming up
// -------------------------------------------------------------------------------------

describe('the fortnight ahead', () => {
  const { s } = state('2026-09-24T23:30:00Z');
  const q = nightQuery(s, N24, { bortle: 5 });

  it('takes each event from its engine, and names the engines this build lacks', () => {
    const results = new Map<string, ComingResult>();
    const missing: string[] = [];
    for (const source of COMING_SOURCES) {
      if (!source.available(ctx)) missing.push(source.label);
      else results.set(source.id, source.run(ctx, q, F));
    }
    const phases = engine.moonPhases(N24, N24 + 14);
    expect(results.get('phases')!.items.map((i) => i.jd)).toEqual(phases.map((p) => p.jd_utc));
    const seasons = yearsOf(q).flatMap((y) => engine.seasons(y)).filter((x) => x.jd_utc >= N24 && x.jd_utc < N24 + 14);
    expect(results.get('seasons')!.items.map((i) => i.jd)).toEqual(seasons.map((x) => x.jd_utc));
    // The mock has no eclipses or planet events: those are named, not faked.
    expect(missing).toEqual(expect.arrayContaining(['eclipses', 'planet events']));
    const list = mergeComing(results);
    expect(list.map((i) => i.jd)).toEqual([...list.map((i) => i.jd)].sort((a, b) => a - b));
    expect(list.every((i) => i.jd >= N24 && i.jd < N24 + 14)).toBe(true);
  });

  it('adds a supermoon to the full Moon it belongs to', () => {
    const results = new Map<string, ComingResult>([
      ['phases', { items: [{ kind: 'phase', jd: 10, title: 'Full Moon', detail: '', body: 'Moon', seen: true }] }],
      ['apsides', { items: [{ kind: 'apsis', jd: 10.2, title: 'The Moon at its closest (perigee)', detail: '', body: 'Moon', seen: true }], notes: [{ jd: 10, note: 'a supermoon' }] }],
    ]);
    expect(mergeComing(results).map((i) => i.title)).toEqual(['Full Moon: a supermoon', 'The Moon at its closest (perigee)']);
  });

  it('writes a conjunction from the position angle', () => {
    const c = { body: 'Moon', other: 'Jupiter', separation_deg: 2.14, position_angle_deg: 350 } as Parameters<typeof conjunctionTitle>[0];
    expect(conjunctionTitle(c)).toBe('The Moon 2.1° north of Jupiter');
    expect(conjunctionTitle({ ...c, body: 'Venus', other: 'Saturn', separation_deg: 0.42, position_angle_deg: 181 })).toBe('Venus 0.4° south of Saturn');
  });
});

// -------------------------------------------------------------------------------------
// Engines the build lacks
// -------------------------------------------------------------------------------------

describe('a build without the new engines', () => {
  it('still draws the night from the core engine, and says what is missing', () => {
    const bare = new MockEngine({ syntheticStars: 0 });
    const only: ExplorerEngine = {
      kind: bare.kind,
      description: bare.description,
      bodies: () => bare.bodies(),
      coverage: () => bare.coverage(),
      skyState: (...a) => bare.skyState(...a),
      sampleBodies: (...a) => bare.sampleBodies(...a),
      dayEvents: (...a): DayEvents => bare.dayEvents(...a),
      dayEventsBatch: (...a) => bare.dayEventsBatch(...a),
      findAltitude: (...a) => bare.findAltitude(...a),
      moonPhases: (...a) => bare.moonPhases(...a),
      seasons: (...a) => bare.seasons(...a),
      sidereal: (...a) => bare.sidereal(...a),
      starfieldCatalog: () => bare.starfieldCatalog(),
      starfieldApparent: (...a) => bare.starfieldApparent(...a),
      constellationAt: (...a) => bare.constellationAt(...a),
      constellationBoundaries: () => bare.constellationBoundaries(),
    };
    const core = coreFor(N24, { engine: only });
    expect(core.tonight).toBeNull();
    expect(core.missing).toEqual(['deep sky', 'sun tools']);
    expect(darknessOf(core)).not.toBeNull(); // from the day's phases
    expect(timelineModel(core, F).moments.length).toBeGreaterThan(4);
    expect(lightRows(core, F)).toBeNull();
    expect(planetsModel(core, null, F)).toBeNull();
    const detail = loadDetail({ engine: only }, core);
    expect(detail.orientation).toBeNull();
    expect(detail.galilean).toBeNull();
    expect(detail.phases!.length).toBeGreaterThan(0);
  });

  it('says so when the night is outside the engine’s years', () => {
    const core = coreFor(jd('2090-01-01T17:00:00Z'));
    expect(core.covered).toBe(false);
    expect(core.tonight).toBeNull();
  });
});

// -------------------------------------------------------------------------------------
// The tab strip, the router, the tour, the Sky link
// -------------------------------------------------------------------------------------

describe('the tab strip with Tonight', () => {
  it('has eight tabs, Tonight among them and About no longer', () => {
    expect(TABS).toHaveLength(8);
    expect(TABS.map((t) => t.tab)).toEqual(['map', 'sky', 'tonight', 'charts', 'navigate', 'almanac', 'events', 'learn']);
    expect(hasTab('about')).toBe(false);
    expect(hasTab('globe')).toBe(true);
    expect(VIEW_META.about.title).toBe('About');
  });

  it('still opens About and Tonight from the address', () => {
    expect(VIEW_IDS).toContain('tonight');
    expect(viewFromHash('#about')).toBe('about');
    expect(viewFromHash('#tonight')).toBe('tonight');
    expect(hashForView('tonight')).toBe('#tonight');
    expect(registry.view('tonight')).not.toBeNull();
    expect(registry.view('about')).not.toBeNull();
  });

  it('gives the tour a card for the Tonight tab', () => {
    const card = TOUR_STEPS.find((s) => s.title === 'Tonight')!;
    expect(card.target).toBe('.sf-views__tab[data-view="tonight"]');
    expect(TOUR_STEPS.find((s) => s.title === 'Ways to look')!.text).toContain('Tonight');
  });
});

describe('show in Sky', () => {
  it('moves the explorer to the moment, selects the body, opens the Sky view and posts the target', () => {
    const { store } = state('2026-09-24T23:30:00Z');
    const c = { store };
    const at = jd('2026-09-25T05:00:00Z');
    const seen: unknown[] = [];
    const stop = skyTargets(c).subscribe((t) => seen.push(t));
    showInSky(c, { kind: 'body', name: 'Jupiter' }, at);
    expect(store.get().view).toBe('sky');
    expect(store.get().selection.body).toBe('Jupiter');
    expect(store.get().time.jd_utc).toBe(at);
    expect(store.get().time.live).toBe(false);
    expect(skyTargets(c).get()).toEqual({ kind: 'body', name: 'Jupiter', jd_utc: at });
    showInSky(c, { kind: 'deep_sky', id: 'M31', label: 'M31', ra_j2000_deg: 10.68, dec_j2000_deg: 41.27 }, null);
    expect(store.get().time.jd_utc).toBe(at); // null keeps the time
    expect(store.get().selection.body).toBe('Jupiter'); // an object is not a body
    expect(seen).toHaveLength(2);
    stop();
  });
});

describe('the explorer’s UTC zone', () => {
  it('writes times in the display zone', () => {
    const t = jd('2026-09-25T02:30:00Z');
    expect(clock(t, F)).toBe('22:30');
    expect(clock(t, { ...F, zone: UTC_ZONE })).toBe('02:30');
  });
});
