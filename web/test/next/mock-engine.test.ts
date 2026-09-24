/**
 * The mock explorer engine: complete, contract-shaped, honest about being a mock, and
 * internally consistent (events sorted, phases covering the window, the Moon's cycle,
 * the seasons in order, typed arrays of the right length). Its astronomy is
 * low-precision; these tests check structure and physics sanity, not accuracy.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_SAMPLES, MockEngine } from '../../src/next/engine/mock.js';
import { NAV_STAR_ROWS } from '../../src/next/engine/mock/stars.js';
import type { BodyState, DayEvents, Observer } from '../../src/next/engine/types.js';
import { jdFromIso } from '../../src/next/time.js';

const engine = new MockEngine();
const PHILLY: Observer = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 };
const TROMSO: Observer = { lat_deg: 69.6492, lon_deg: 18.9553 };
const jd = (iso: string): number => jdFromIso(iso)!;
const T = jd('2026-09-24T12:00:00Z');
const wrap180 = (x: number): number => {
  const r = ((x % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
};
const body = (list: BodyState[], name: string): BodyState => {
  const b = list.find((x) => x.body === name);
  if (!b) throw new Error(`no ${name}`);
  return b;
};

describe('what the mock says about itself', () => {
  it('says plainly that it is a mock with illustrative numbers', () => {
    expect(engine.kind).toBe('mock');
    expect(engine.description).toMatch(/MOCK/);
    expect(engine.description).toMatch(/illustrative/);
    expect(engine.coverage().groups.every((g) => g.provider.startsWith('MOCK'))).toBe(true);
  });

  it('is not validated unless asked to pretend, for exercising the interface', () => {
    expect(engine.coverage().groups.every((g) => !g.validated)).toBe(true);
    expect(new MockEngine({ syntheticStars: 0, validated: true }).coverage().groups.every((g) => g.validated)).toBe(
      true,
    );
  });
});

describe('bodies and coverage', () => {
  it('lists the Sun, the Moon, seven planets and the 58 stars in canonical order', () => {
    const bodies = engine.bodies();
    expect(bodies).toHaveLength(67);
    expect(bodies.slice(0, 9).map((b) => b.body)).toEqual([
      'Sun',
      'Moon',
      'Mercury',
      'Venus',
      'Mars',
      'Jupiter',
      'Saturn',
      'Uranus',
      'Neptune',
    ]);
    expect(bodies.slice(9).map((b) => b.body)).toEqual(NAV_STAR_ROWS.map((r) => r[0]));
    expect(bodies.at(-1)!.body).toBe('Polaris');
    expect(bodies.filter((b) => !b.navigational).map((b) => b.body)).toEqual(['Mercury', 'Uranus', 'Neptune']);
    expect(bodies.filter((b) => b.kind === 'star').every((b) => typeof b.magnitude === 'number')).toBe(true);
    expect(bodies.filter((b) => b.kind !== 'star').every((b) => b.magnitude === null)).toBe(true);
  });

  it('assigns every body to exactly one coverage group', () => {
    const cov = engine.coverage();
    const named = cov.groups.flatMap((g) => g.bodies ?? []);
    expect(named.sort()).toEqual(engine.bodies().map((b) => b.body).sort());
    expect(cov.start_utc).toBe('1990-01-01T00:00:00Z');
    expect(cov.end_utc).toBe('2060-12-31T23:59:59Z');
  });
});

describe('sky state', () => {
  const state = engine.skyState(PHILLY, T, 'all');

  it('returns every body with the contract fields', () => {
    expect(state.bodies).toHaveLength(67);
    expect(state.errors).toEqual([]);
    expect(state.utc).toBe('2026-09-24T12:00:00.000Z');
    for (const b of state.bodies) {
      for (const v of [b.gha_deg, b.sha_deg, b.ra_deg, b.az_deg, b.zn_deg]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(360);
      }
      expect(Math.abs(b.dec_deg)).toBeLessThanOrEqual(90);
      expect(b.gp.lat_deg).toBe(b.dec_deg);
      expect(b.gp.lon_deg).toBeCloseTo(wrap180(-b.gha_deg), 9);
      expect(b.gp.lon_deg).toBeGreaterThan(-180);
      expect(wrap180(b.gha_deg - (state.gha_aries_deg - b.ra_deg))).toBeCloseTo(0, 9);
      expect(wrap180(b.sha_deg - (360 - b.ra_deg))).toBeCloseTo(0, 9);
      expect(b.alt_apparent_deg).toBeGreaterThanOrEqual(b.alt_deg);
      expect(b.above_horizon).toBe(b.alt_apparent_deg + b.semidiameter_arcmin / 60 > 0);
      expect(b.parallactic_angle_deg).toBeGreaterThan(-180);
      expect(b.parallactic_angle_deg).toBeLessThanOrEqual(180);
      expect(typeof b.constellation).toBe('string');
    }
  });

  it('fills distance, phase and limb only where they mean something', () => {
    for (const b of state.bodies) {
      const disc = b.kind === 'moon' || b.kind === 'planet';
      expect(b.distance_km === null).toBe(b.kind === 'star');
      expect(b.illuminated_fraction === null).toBe(!disc);
      expect(b.phase_angle_deg === null).toBe(!disc);
      expect(b.elongation_deg === null).toBe(!disc);
      expect(b.bright_limb_angle_deg === null).toBe(!disc);
      if (b.kind === 'star') {
        expect(b.semidiameter_arcmin).toBe(0);
        expect(b.horizontal_parallax_arcmin).toBe(0);
      }
    }
    expect(body(state.bodies, 'Sirius').constellation).toBe('CMa');
  });

  it('agrees with sidereal() and classifies the sky phase from the Sun', () => {
    expect(engine.sidereal(T).gha_aries_deg).toBe(state.gha_aries_deg);
    const sun = body(state.bodies, 'Sun');
    expect(state.sun_altitude_deg).toBe(sun.alt_deg);
    expect(state.sky_phase).toBe('day');
    const night = engine.skyState(PHILLY, jd('2026-09-24T05:00:00Z'), ['Moon']);
    expect(night.sun_altitude_deg).toBeLessThan(-18);
    expect(night.sky_phase).toBe('night');
  });

  it('keeps navigation Hc/Zn close to the topocentric values for stars, and shows the Moon lower', () => {
    for (const b of state.bodies.filter((x) => x.kind === 'star' && x.alt_deg > 5)) {
      // Geodetic vs geocentric latitude: at most about 0.2 deg apart.
      expect(Math.abs(b.alt_deg - b.hc_deg)).toBeLessThan(0.25);
      expect(Math.abs(wrap180(b.az_deg - b.zn_deg))).toBeLessThan(0.5);
    }
    const moon = body(engine.skyState(PHILLY, jd('2026-09-25T02:00:00Z'), ['Moon']).bodies, 'Moon');
    const expected = (moon.horizontal_parallax_arcmin / 60) * Math.cos((moon.hc_deg * Math.PI) / 180);
    expect(moon.hc_deg - moon.alt_deg).toBeGreaterThan(expected * 0.8);
    expect(moon.hc_deg - moon.alt_deg).toBeLessThan(expected * 1.2 + 0.2);
  });

  it('resolves names like the real engine and rejects unknown ones', () => {
    const s = engine.skyState(PHILLY, T, ['  sUn ', 'al nair', 'HIP 91262', 'Vega', 'kausaustralis']);
    expect(s.bodies.map((b) => b.body)).toEqual(['Sun', "Al Na'ir", 'Vega', 'Kaus Australis']);
    expect(() => engine.skyState(PHILLY, T, ['Vulcan'])).toThrow(/unknown body/);
    expect(engine.skyState(PHILLY, T, 'solar_system').bodies).toHaveLength(9);
    expect(engine.skyState(PHILLY, T, 'navigational').bodies).toHaveLength(64);
    expect(engine.skyState(PHILLY, T, []).bodies).toEqual([]);
  });

  it('throws on malformed input', () => {
    expect(() => engine.skyState({ lat_deg: 91, lon_deg: 0 }, T, 'all')).toThrow(/lat_deg/);
    expect(() => engine.skyState(PHILLY, Number.NaN, 'all')).toThrow(/jd_utc/);
    expect(() => engine.skyState(PHILLY, T, 'everything' as 'all')).toThrow(/bodies/);
  });

  it('reports bodies outside the coverage window as errors, not results', () => {
    const s = engine.skyState(PHILLY, jd('2075-01-01T00:00:00Z'), ['Sun', 'Moon']);
    expect(s.bodies).toEqual([]);
    expect(s.errors.map((e) => e.body)).toEqual(['Sun', 'Moon']);
    expect(s.errors[0]!.message).toMatch(/coverage/);
  });

  it('keeps the planets where they can be: Mercury and Venus near the Sun', () => {
    let mercury = 0;
    let venus = 0;
    for (let d = 0; d < 800; d += 7) {
      const s = engine.skyState(PHILLY, jd('2025-01-01T00:00:00Z') + d, ['Mercury', 'Venus']);
      mercury = Math.max(mercury, body(s.bodies, 'Mercury').elongation_deg!);
      venus = Math.max(venus, body(s.bodies, 'Venus').elongation_deg!);
    }
    expect(mercury).toBeGreaterThan(17);
    expect(mercury).toBeLessThan(28.5);
    expect(venus).toBeGreaterThan(44);
    expect(venus).toBeLessThan(47.5);
  });

  it('puts the Sun on the tropic at the June solstice', () => {
    const june = engine.seasons(2026).find((e) => e.kind === 'june_solstice')!;
    const sun = body(engine.skyState(PHILLY, june.jd_utc, ['Sun']).bodies, 'Sun');
    expect(sun.dec_deg).toBeCloseTo(23.436, 1);
  });
});

describe('sampled tracks', () => {
  it('returns typed arrays of one length that match sky_state', () => {
    const t0 = jd('2026-09-24T04:00:00Z');
    const s = engine.sampleBodies(PHILLY, ['Sun', 'Moon', 'Vega'], t0, t0 + 1, 10);
    expect(s.jd_utc).toBeInstanceOf(Float64Array);
    expect(s.jd_utc.length).toBe(145);
    expect(s.jd_utc[144]).toBeCloseTo(t0 + 1, 9);
    for (const track of s.bodies) {
      for (const arr of [track.alt_deg, track.alt_apparent_deg, track.az_deg, track.gha_deg, track.dec_deg]) {
        expect(arr).toBeInstanceOf(Float64Array);
        expect(arr.length).toBe(145);
      }
    }
    const k = 50;
    const st = engine.skyState(PHILLY, s.jd_utc[k]!, ['Moon']).bodies[0]!;
    const moon = s.bodies[1]!;
    expect(moon.alt_deg[k]).toBeCloseTo(st.alt_deg, 9);
    expect(moon.az_deg[k]).toBeCloseTo(st.az_deg, 9);
    expect(moon.gha_deg[k]).toBeCloseTo(st.gha_deg, 9);
    expect(moon.alt_apparent_deg[k]).toBeCloseTo(st.alt_apparent_deg, 9);
  });

  it('enforces the 20 000-sample limit and rejects a bad step', () => {
    const t0 = jd('2026-01-01T00:00:00Z');
    expect(() => engine.sampleBodies(PHILLY, ['Sun'], t0, t0 + 20_000 / 1440, 1)).toThrow(/limit/);
    expect(engine.sampleBodies(PHILLY, ['Sun'], t0, t0 + (MAX_SAMPLES - 1) / 1440, 1).jd_utc.length).toBe(MAX_SAMPLES);
    expect(() => engine.sampleBodies(PHILLY, ['Sun'], t0, t0 + 1, 0)).toThrow(/step/);
    expect(engine.sampleBodies(PHILLY, ['Sun'], t0, t0, 5).jd_utc.length).toBe(1);
  });
});

function checkPhases(d: DayEvents): void {
  expect(d.phases.length).toBeGreaterThan(0);
  expect(d.phases[0]!.jd_start).toBe(d.jd_start);
  expect(d.phases.at(-1)!.jd_end).toBe(d.jd_end);
  d.phases.forEach((p, i) => {
    expect(p.jd_end).toBeGreaterThan(p.jd_start);
    if (i > 0) {
      expect(p.jd_start).toBe(d.phases[i - 1]!.jd_end);
      expect(p.phase).not.toBe(d.phases[i - 1]!.phase);
    }
  });
}

function checkSorted(d: DayEvents): void {
  for (const b of d.bodies) {
    for (let i = 1; i < b.events.length; i += 1) {
      expect(b.events[i]!.jd_utc).toBeGreaterThanOrEqual(b.events[i - 1]!.jd_utc);
    }
    for (const e of b.events) {
      expect(e.jd_utc).toBeGreaterThan(d.jd_start);
      expect(e.jd_utc).toBeLessThan(d.jd_end);
    }
  }
}

describe('day events', () => {
  const t0 = jd('2026-09-24T04:00:00Z'); // local midnight, EDT
  const day = engine.dayEvents(PHILLY, t0, t0 + 1, 'all');

  it('covers the window with contiguous, time-ordered sky phases', () => {
    checkPhases(day);
    expect(day.phases.map((p) => p.phase)).toEqual([
      'night',
      'astronomical',
      'nautical',
      'civil',
      'day',
      'civil',
      'nautical',
      'astronomical',
      'night',
    ]);
  });

  it('sorts every body events and keeps them inside the window', () => {
    checkSorted(day);
    expect(day.bodies).toHaveLength(67);
    expect(day.errors).toEqual([]);
  });

  it('gives the Sun its full sequence of a mid-latitude day', () => {
    const sun = day.bodies[0]!;
    expect(sun.events.map((e) => e.kind)).toEqual([
      'lower_transit',
      'astronomical_dawn',
      'nautical_dawn',
      'civil_dawn',
      'rise',
      'transit',
      'set',
      'civil_dusk',
      'nautical_dusk',
      'astronomical_dusk',
    ]);
    expect(sun.day_length_h!).toBeGreaterThan(11.9);
    expect(sun.day_length_h!).toBeLessThan(12.3);
    const rise = sun.events.find((e) => e.kind === 'rise')!;
    expect(rise.alt_deg).toBeCloseTo(-50 / 60, 3);
    expect(rise.az_deg).toBeGreaterThan(85);
    expect(rise.az_deg).toBeLessThan(95);
    const transit = sun.events.find((e) => e.kind === 'transit')!;
    expect(transit.az_deg).toBeCloseTo(180, 0);
    // The day phase starts exactly at sunrise (same threshold, same root finder).
    expect(day.phases[4]!.jd_start).toBeCloseTo(rise.jd_utc, 9);
    expect(day.bodies.filter((b) => b.body !== 'Sun').every((b) => b.day_length_h === null)).toBe(true);
  });

  it('sets the Moon on its own horizon: -34 minutes minus its semidiameter', () => {
    const moon = day.bodies[1]!;
    for (const e of moon.events.filter((x) => x.kind === 'rise' || x.kind === 'set')) {
      const sd = engine.skyState(PHILLY, e.jd_utc, ['Moon']).bodies[0]!.semidiameter_arcmin;
      expect(e.alt_deg).toBeCloseTo((-34 - sd) / 60, 3);
    }
  });

  it('lowers the horizon with dip: earlier rise, later set, longer day; twilight unchanged', () => {
    const dip = engine.dayEvents(PHILLY, t0, t0 + 1, ['Sun'], { horizon: 'dip', height_of_eye_m: 10 });
    const std = day.bodies[0]!;
    const low = dip.bodies[0]!;
    const at = (b: typeof std, kind: string): number => b.events.find((e) => e.kind === kind)!.jd_utc;
    expect(at(low, 'rise')).toBeLessThan(at(std, 'rise'));
    expect(at(low, 'set')).toBeGreaterThan(at(std, 'set'));
    expect(low.day_length_h!).toBeGreaterThan(std.day_length_h!);
    expect(at(low, 'civil_dawn')).toBe(at(std, 'civil_dawn'));
    expect(dip.phases).toEqual(day.phases);
  });

  it('handles the midnight Sun and the polar night', () => {
    const june = jd('2026-06-21T00:00:00Z');
    const summer = engine.dayEvents(TROMSO, june, june + 1, ['Sun']);
    checkPhases(summer);
    expect(summer.bodies[0]!).toMatchObject({ always_above: true, always_below: false });
    expect(summer.bodies[0]!.day_length_h).toBeCloseTo(24, 6);
    expect(summer.phases).toHaveLength(1);
    expect(summer.bodies[0]!.events.map((e) => e.kind)).toEqual(['transit', 'lower_transit']);

    const dec = jd('2026-12-21T00:00:00Z');
    const winter = engine.dayEvents(TROMSO, dec, dec + 1, ['Sun']);
    checkPhases(winter);
    expect(winter.bodies[0]!).toMatchObject({ always_above: false, always_below: true, day_length_h: 0 });
    expect(winter.phases.some((p) => p.phase === 'day')).toBe(false);
  });

  it('batches windows (a year of days) and enforces the 400-window limit', () => {
    const windows: [number, number][] = Array.from({ length: 5 }, (_, i) => [t0 + i, t0 + i + 1]);
    const batch = engine.dayEventsBatch(PHILLY, windows, ['Sun']);
    expect(batch).toHaveLength(5);
    batch.forEach(checkPhases);
    const tooMany: [number, number][] = Array.from({ length: 401 }, (_, i) => [t0 + i, t0 + i + 1]);
    expect(() => engine.dayEventsBatch(PHILLY, tooMany, ['Sun'])).toThrow(/400/);
  });

  it('reports out-of-coverage windows as body errors and rejects empty windows', () => {
    const late = jd('2061-06-01T00:00:00Z');
    const d = engine.dayEvents(PHILLY, late, late + 1, ['Sun']);
    expect(d.bodies).toEqual([]);
    expect(d.errors[0]!.body).toBe('Sun');
    checkPhases(d);
    expect(() => engine.dayEvents(PHILLY, t0, t0, ['Sun'])).toThrow(/after/);
  });
});

describe('altitude crossings (reverse calculation)', () => {
  it('finds when the Sun is 30 degrees up, on the way up and on the way down', () => {
    const t0 = jd('2026-09-24T04:00:00Z');
    const hits = engine.findAltitude(PHILLY, 'sun', t0, t0 + 1, 30);
    expect(hits.map((h) => h.rising)).toEqual([true, false]);
    for (const h of hits) {
      const s = engine.skyState(PHILLY, h.jd_utc, ['Sun']).bodies[0]!;
      expect(s.alt_apparent_deg).toBeCloseTo(30, 3);
      expect(h.alt_deg).toBeCloseTo(30, 3);
    }
    expect(engine.findAltitude(PHILLY, 'Sun', t0, t0 + 1, 80)).toEqual([]);
  });
});

describe('Moon phases and seasons', () => {
  const phases = engine.moonPhases(jd('2026-01-01T00:00:00Z'), jd('2027-01-01T00:00:00Z'));

  it('cycles new, first quarter, full, last quarter in order', () => {
    const order = ['new_moon', 'first_quarter', 'full_moon', 'last_quarter'];
    for (let i = 1; i < phases.length; i += 1) {
      expect(phases[i]!.jd_utc).toBeGreaterThan(phases[i - 1]!.jd_utc);
      const prev = order.indexOf(phases[i - 1]!.kind);
      expect(phases[i]!.kind).toBe(order[(prev + 1) % 4]);
    }
    expect(phases.length).toBeGreaterThanOrEqual(48);
    expect(phases.length).toBeLessThanOrEqual(50);
  });

  it('repeats every 29.53 days on average', () => {
    // One year is too short for the mean: 2026's lunations really average 29.47 days.
    const decade = engine.moonPhases(jd('2020-01-01T00:00:00Z'), jd('2030-01-01T00:00:00Z'));
    const news = decade.filter((p) => p.kind === 'new_moon').map((p) => p.jd_utc);
    expect(news).toHaveLength(123);
    const gaps = news.slice(1).map((t, i) => t - news[i]!);
    for (const g of gaps) {
      expect(g).toBeGreaterThan(29.2);
      expect(g).toBeLessThan(29.9);
    }
    const mean = (news.at(-1)! - news[0]!) / (news.length - 1);
    expect(Math.abs(mean - 29.5306)).toBeLessThan(0.01);
  });

  it('lights the Moon fully at full moon and not at all at new moon', () => {
    const full = phases.find((p) => p.kind === 'full_moon')!;
    const fresh = phases.find((p) => p.kind === 'new_moon')!;
    const lit = (t: number): number => engine.skyState(PHILLY, t, ['Moon']).bodies[0]!.illuminated_fraction!;
    expect(lit(full.jd_utc)).toBeGreaterThan(0.99);
    expect(lit(fresh.jd_utc)).toBeLessThan(0.01);
    const quarter = phases.find((p) => p.kind === 'first_quarter')!;
    expect(lit(quarter.jd_utc)).toBeCloseTo(0.5, 1);
  });

  it('puts the seasons in order on their usual dates', () => {
    const s = engine.seasons(2026);
    expect(s.map((e) => e.kind)).toEqual([
      'march_equinox',
      'june_solstice',
      'september_equinox',
      'december_solstice',
    ]);
    expect(s.map((e) => e.utc.slice(0, 10))).toEqual(['2026-03-20', '2026-06-21', '2026-09-23', '2026-12-21']);
    expect(() => engine.seasons(2070)).toThrow(/coverage/);
    expect(() => engine.seasons(2026.5)).toThrow(/integer/);
  });
});

describe('star field (display only)', () => {
  const cat = engine.starfieldCatalog();

  it('has typed arrays and per-star lists of one length', () => {
    expect(cat.count).toBe(58 + 14 + 2000);
    expect(cat.hr).toBeInstanceOf(Int32Array);
    expect(cat.vmag).toBeInstanceOf(Float32Array);
    expect(cat.bv).toBeInstanceOf(Float32Array);
    for (const arr of [cat.hr, cat.vmag, cat.bv]) expect(arr.length).toBe(cat.count);
    expect(cat.designations).toHaveLength(cat.count);
    expect([...cat.bv].some((v) => Number.isNaN(v))).toBe(true); // "unknown" is exercised
    expect([...cat.hr].every((v) => v < 0)).toBe(true); // placeholders, never real HR numbers
    expect(cat.source).toMatch(/MOCK/);
  });

  it('indexes the 58 navigational stars by their canonical names', () => {
    expect(cat.navigational).toHaveLength(58);
    const byIndex = new Map(cat.names.map((n) => [n.index, n.name]));
    for (const nav of cat.navigational) expect(byIndex.get(nav.index)).toBe(nav.name);
    expect(cat.navigational.map((n) => n.name)).toEqual(NAV_STAR_ROWS.map((r) => r[0]));
  });

  it('draws constellation figures between real indices', () => {
    expect(cat.constellations.map((c) => c.abbr)).toEqual(['Ori', 'UMa', 'Cru', 'Cas']);
    for (const c of cat.constellations) {
      for (const [a, b] of c.lines) {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(cat.count);
      }
      expect(Math.abs(c.label_dec_deg)).toBeLessThanOrEqual(90);
    }
    for (const b of engine.constellationBoundaries()) {
      expect(b.ra_deg).toBeInstanceOf(Float64Array);
      expect(b.ra_deg.length).toBe(b.dec_deg.length);
      expect(b.ra_deg[0]).toBe(b.ra_deg.at(-1));
    }
  });

  it('gives apparent places in radians, in the same frame as sky_state', () => {
    const apparent = engine.starfieldApparent(T);
    expect(apparent).toBeInstanceOf(Float64Array);
    expect(apparent.length).toBe(2 * cat.count);
    for (let i = 0; i < cat.count; i += 1) {
      expect(apparent[2 * i]).toBeGreaterThanOrEqual(0);
      expect(apparent[2 * i]).toBeLessThan(2 * Math.PI);
      expect(Math.abs(apparent[2 * i + 1]!)).toBeLessThanOrEqual(Math.PI / 2);
    }
    const sirius = cat.navigational.find((n) => n.name === 'Sirius')!.index;
    const s = engine.skyState(PHILLY, T, ['Sirius']).bodies[0]!;
    expect((apparent[2 * sirius]! * 180) / Math.PI).toBeCloseTo(s.ra_deg, 9);
    expect((apparent[2 * sirius + 1]! * 180) / Math.PI).toBeCloseTo(s.dec_deg, 9);
  });

  it('is deterministic', () => {
    const again = new MockEngine();
    expect(again.starfieldCatalog().vmag).toEqual(cat.vmag);
    expect(again.starfieldApparent(T)).toEqual(engine.starfieldApparent(T));
  });

  it('names constellations plausibly (illustrative)', () => {
    expect(engine.constellationAt(88.79, 7.41, T)).toBe('Ori');
    expect(engine.constellationAt(37.95, 89.26, T)).toBe('UMi');
    const june = engine.skyState(PHILLY, jd('2026-06-10T00:00:00Z'), ['Sun']).bodies[0]!;
    expect(june.constellation).toBe('Tau');
    const march = engine.skyState(PHILLY, jd('2026-03-25T00:00:00Z'), ['Sun']).bodies[0]!;
    expect(march.constellation).toBe('Psc');
    expect(() => engine.constellationAt(0, 100, T)).toThrow();
  });
});

describe('the mock star table matches the project catalogue', () => {
  it('agrees with fixtures/reference/navigational_stars_hip.json to within 1 arcsecond', () => {
    const path = resolve(import.meta.dirname, '../../../fixtures/reference/navigational_stars_hip.json');
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as {
      cases: {
        name: string;
        hip: number;
        ra_deg: number;
        dec_deg: number;
        mag: number;
        pm_ra_cosdec_mas_yr: number;
        pm_dec_mas_yr: number;
      }[];
    };
    expect(fixture.cases.map((c) => c.name)).toEqual(NAV_STAR_ROWS.map((r) => r[0]));
    const mas = Math.PI / 180 / 3_600_000;
    const years = 2000 - 1991.25;
    fixture.cases.forEach((c, i) => {
      const row = NAV_STAR_ROWS[i]!;
      const ra = (c.ra_deg * Math.PI) / 180;
      const dec = (c.dec_deg * Math.PI) / 180;
      // Unit-vector proper motion, J1991.25 -> J2000.0 (as the Rust loader does).
      const p = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
      const eRa = [-Math.sin(ra), Math.cos(ra), 0];
      const eDec = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)];
      const a = c.pm_ra_cosdec_mas_yr * mas * years;
      const b = c.pm_dec_mas_yr * mas * years;
      const v = p.map((x, k) => x + a * eRa[k]! + b * eDec[k]!);
      const r = Math.hypot(v[0]!, v[1]!, v[2]!);
      const ra2000 = ((Math.atan2(v[1]!, v[0]!) * 180) / Math.PI + 360) % 360;
      const dec2000 = (Math.asin(v[2]! / r) * 180) / Math.PI;
      const cosd = Math.cos(dec);
      expect(Math.abs(wrap180(row[2] - ra2000)) * cosd * 3600).toBeLessThan(1);
      expect(Math.abs(row[3] - dec2000) * 3600).toBeLessThan(1);
      expect(row[1]).toBe(c.hip);
      expect(row[4]).toBeCloseTo(c.mag, 2);
    });
  });
});
