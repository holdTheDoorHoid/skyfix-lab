/**
 * MOCK almanac pages, for developing the Almanac view without the WebAssembly core
 * (`?engine=mock`). Every number is illustrative: it comes from the mock engine's own
 * low-precision positions and events, never from the SkyFix Lab numerical core.
 *
 * The page is built only from public `ExplorerEngine` calls, with the same shape,
 * rounding and cell rules as `skyfix_almanac::pages` (CONVENTIONS 13.9), so the view
 * sees every kind of cell the real engine produces: times, `24 hh mm`, □, ■, ////, --.
 */

import { isoUtc, jdFromMs, utcMs } from '../../time.js';
import type {
  AlmanacBodyHour,
  AlmanacDay,
  AlmanacLatitudeRow,
  AlmanacMoonHour,
  AlmanacPlanetDay,
  AlmanacStar,
  AlmanacTime,
  AlmanacTimeKind,
  BodyError,
  BodyState,
  ExplorerEngine,
  PhaseEvent,
  SkyEvent,
} from '../types.js';

export const STANDARD_LATITUDES = [
  72, 70, 68, 66, 64, 62, 60, 58, 56, 54, 52, 50, 45, 40, 35, 30, 20, 10, 0, -10, -20, -30, -35, -40, -45,
  -50, -52, -54, -56, -58, -60,
] as const;

const PLANETS = ['Venus', 'Mars', 'Jupiter', 'Saturn'] as const;
const MOON_ADOPTED_DEG_PER_H = 14 + 19 / 60;
const PLANET_ADOPTED_DEG_PER_H = 15;
const SIDEREAL_DEG_PER_DAY = 360.98564736629;
const SUN_H0_DEG = -50 / 60;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const NOTES = [
  'MOCK ENGINE: every number on these pages is illustrative, from low-precision formulas; nothing here comes from the SkyFix Lab numerical core.',
  'UT is UTC with DUT1 = 0. v: excess of the hourly increase of GHA over 15° (planets) or 14° 19.0′ (Moon); d: hourly change of declination, printed without sign.',
  'Stars, planets’ SHA and magnitudes, SD, the Moon’s age and percentage illuminated are for 12h UT.',
  'Twilight, sunrise, sunset, moonrise and moonset: LMT at the Greenwich meridian (= UT), sea level.',
  '□ above the horizon all day; ■ below all day; //// twilight all night; 24 hh mm: the following date; --: not on the date nor the next.',
  'Simulation and analysis workbench. Not a navigation instrument.',
];

// ---------------------------------------------------------------------------
// Printing, as the printed almanac rounds (the same rules as pages.rs)
// ---------------------------------------------------------------------------

function norm360(x: number): number {
  return ((x % 360) + 360) % 360;
}

function norm180(x: number): number {
  const y = norm360(x + 180) - 180;
  return y === -180 ? 180 : y;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function fmtAngle(deg: number): string {
  const tenths = Math.round(norm360(deg) * 600) % 216000;
  return `${Math.floor(tenths / 600)} ${pad2(Math.floor((tenths % 600) / 10))}.${tenths % 10}`;
}

export function fmtDec(deg: number): string {
  const tenths = Math.round(Math.abs(deg) * 600);
  return `${deg < 0 ? 'S' : 'N'} ${Math.floor(tenths / 600)} ${pad2(Math.floor((tenths % 600) / 10))}.${tenths % 10}`;
}

export function fmtArcmin(arcmin: number): string {
  const tenths = Math.round(arcmin * 10);
  const a = Math.abs(tenths);
  return `${tenths < 0 ? '-' : ''}${Math.floor(a / 10)}.${a % 10}`;
}

export function fmtMagnitude(mag: number): string {
  const tenths = Math.round(mag * 10);
  const a = Math.abs(tenths);
  return `${tenths < 0 ? '-' : tenths > 0 ? '+' : ''}${Math.floor(a / 10)}.${a % 10}`;
}

export function fmtHm(hours: number): string {
  const minutes = Math.round(hours * 60);
  const m = Math.abs(minutes);
  return `${minutes < 0 ? '-' : ''}${pad2(Math.floor(m / 60))} ${pad2(m % 60)}`;
}

function fmtHmTenths(hours: number): string {
  const t = Math.abs(Math.round(hours * 600));
  return `${pad2(Math.floor(t / 600))} ${pad2(Math.floor((t % 600) / 10))}.${t % 10}`;
}

function fmtMs(seconds: number): string {
  const s = Math.round(Math.abs(seconds));
  return `${pad2(Math.floor(s / 60))} ${pad2(s % 60)}`;
}

export function latitudeLabel(lat: number): string {
  return lat > 0 ? `N ${lat}` : lat < 0 ? `S ${-lat}` : '0';
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

const SYMBOLS: Record<Exclude<AlmanacTimeKind, 'time'>, string> = {
  above: '□',
  below: '■',
  all_night: '////',
  later: '--',
  unavailable: 'n/a',
};

function symbol(kind: Exclude<AlmanacTimeKind, 'time'>): AlmanacTime {
  return { kind, jd_utc: null, utc: null, hours: null, printed: SYMBOLS[kind] };
}

function at(jd: number, day0: number, tenths = false): AlmanacTime {
  const hours = (jd - day0) * 24;
  return { kind: 'time', jd_utc: jd, utc: isoUtc(jd), hours, printed: tenths ? fmtHmTenths(hours) : fmtHm(hours) };
}

function sunCells(ev: SkyEvent[], day0: number): AlmanacTime[] {
  const noon = ev.find((e) => e.kind === 'transit' && e.jd_utc >= day0 && e.jd_utc < day0 + 1);
  if (!noon) return Array.from({ length: 6 }, () => symbol('unavailable'));
  const before = [...ev].reverse().find((e) => e.kind === 'lower_transit' && e.jd_utc < noon.jd_utc);
  const after = ev.find((e) => e.kind === 'lower_transit' && e.jd_utc > noon.jd_utc);
  const from = before?.jd_utc ?? -Infinity;
  const to = after?.jd_utc ?? Infinity;
  const cell = (threshold: number, kind: SkyEvent['kind'], morning: boolean): AlmanacTime => {
    const found = morning
      ? ev.find((e) => e.kind === kind && e.jd_utc > from && e.jd_utc <= noon.jd_utc)
      : [...ev].reverse().find((e) => e.kind === kind && e.jd_utc > noon.jd_utc && e.jd_utc <= to);
    if (found) return at(found.jd_utc, day0);
    const low = (morning ? before : after)?.alt_deg;
    if (noon.alt_deg < threshold) return symbol('below');
    if (low !== undefined && low > threshold) {
      return symbol(threshold !== SUN_H0_DEG && low <= SUN_H0_DEG ? 'all_night' : 'above');
    }
    return symbol('unavailable');
  };
  return [
    cell(-12, 'nautical_dawn', true),
    cell(-6, 'civil_dawn', true),
    cell(SUN_H0_DEG, 'rise', true),
    cell(SUN_H0_DEG, 'set', false),
    cell(-6, 'civil_dusk', false),
    cell(-12, 'nautical_dusk', false),
  ];
}

function moonCell(ev: SkyEvent[], alwaysAbove: boolean, kind: 'rise' | 'set', x0: number): AlmanacTime {
  const inDay = ev.filter((e) => e.jd_utc >= x0 && e.jd_utc < x0 + 1);
  const hit = inDay.find((e) => e.kind === kind);
  if (hit) return at(hit.jd_utc, x0);
  const rs = ev.filter((e) => e.kind === 'rise' || e.kind === 'set');
  if (!inDay.some((e) => e.kind === 'rise' || e.kind === 'set')) {
    const prior = [...rs].reverse().find((e) => e.jd_utc <= x0);
    const later = rs.find((e) => e.jd_utc > x0);
    const above = prior ? prior.kind === 'rise' : later ? later.kind === 'set' : alwaysAbove;
    return symbol(above ? 'above' : 'below');
  }
  const next = ev.find((e) => e.kind === kind && e.jd_utc >= x0 + 1 && e.jd_utc < x0 + 2);
  return next ? at(next.jd_utc, x0) : symbol('later');
}

function passage(ev: SkyEvent[], kind: SkyEvent['kind'], day0: number): AlmanacTime {
  const e =
    ev.find((x) => x.kind === kind && x.jd_utc >= day0 && x.jd_utc < day0 + 1) ??
    ev.find((x) => x.kind === kind && x.jd_utc >= day0 + 1 && x.jd_utc < day0 + 2);
  return e ? at(e.jd_utc, day0) : symbol('later');
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function parseDate(date: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof date === 'string' ? date.trim() : '');
  if (!match) throw new Error(`date must be a UT calendar date written YYYY-MM-DD, got ${JSON.stringify(date)}`);
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(utcMs(y, m, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() + 1 !== m || check.getUTCDate() !== d) {
    throw new Error(`${JSON.stringify(date)} is not a calendar date`);
  }
  return { y, m, d };
}

function dateOf(jd: number): string {
  return isoUtc(jd).slice(0, 10);
}

function gha(a: BodyState, b: BodyState, dtHours: number): number {
  const guess = (SIDEREAL_DEG_PER_DAY * dtHours) / 24;
  return guess + norm180(b.gha_deg - a.gha_deg - guess);
}

function bodyHour(s: BodyState): AlmanacBodyHour {
  return {
    body: s.body,
    gha_deg: s.gha_deg,
    dec_deg: s.dec_deg,
    printed: { gha: fmtAngle(s.gha_deg), dec: fmtDec(s.dec_deg) },
  };
}

/** Illustrative daily pages from any `ExplorerEngine` (the mock's own positions and events). */
export function mockAlmanacDay(engine: ExplorerEngine, date: string): AlmanacDay {
  const { y, m, d } = parseDate(date);
  const day0 = jdFromMs(utcMs(y, m, d));
  // The mock evaluates half a day before the date and three after it without the real
  // engine's care at the coverage edges, so it keeps that far inside them.
  const coverage = engine.coverage();
  const first = dateOf(jdFromMs(Date.parse(coverage.start_utc)) + 1);
  const last = dateOf(jdFromMs(Date.parse(coverage.end_utc)) - 3);
  const iso = dateOf(day0);
  if (iso < first || iso > last) {
    throw new Error(`the mock engine makes almanac pages from ${first} to ${last}; ${iso} is outside that`);
  }
  const noon = day0 + 0.5;
  const greenwich = { lat_deg: 0, lon_deg: 0 };
  const names = ['Sun', 'Moon', ...PLANETS];
  const errors: BodyError[] = [];

  const states = Array.from({ length: 25 }, (_, h) => engine.skyState(greenwich, day0 + h / 24, names));
  const get = (h: number, body: string): BodyState => {
    const b = states[h]!.bodies.find((x) => x.body === body);
    if (!b) throw new Error(`${body} is not available at ${isoUtc(day0 + h / 24)}`);
    return b;
  };

  const hours = Array.from({ length: 24 }, (_, h) => {
    const sun = get(h, 'Sun');
    const moonA = get(h, 'Moon');
    const moonB = get(h + 1, 'Moon');
    const v = (gha(moonA, moonB, 1) - MOON_ADOPTED_DEG_PER_H) * 60;
    const dd = (moonB.dec_deg - moonA.dec_deg) * 60;
    const moon: AlmanacMoonHour = {
      gha_deg: moonA.gha_deg,
      dec_deg: moonA.dec_deg,
      v_arcmin: v,
      d_arcmin: dd,
      hp_arcmin: moonA.horizontal_parallax_arcmin,
      printed: {
        gha: fmtAngle(moonA.gha_deg),
        v: fmtArcmin(v),
        dec: fmtDec(moonA.dec_deg),
        d: fmtArcmin(Math.abs(dd)),
        hp: fmtArcmin(moonA.horizontal_parallax_arcmin),
      },
    };
    const aries = states[h]!.gha_aries_deg;
    return {
      hour: h,
      jd_utc: day0 + h / 24,
      utc: isoUtc(day0 + h / 24),
      aries: { gha_deg: aries, printed: { gha: fmtAngle(aries) } },
      sun: bodyHour(sun),
      moon,
      planets: PLANETS.map((p) => bodyHour(get(h, p))),
    };
  });

  const noonState = engine.skyState(greenwich, noon, 'all');
  const noonBody = (body: string): BodyState => noonState.bodies.find((b) => b.body === body)!;

  // Events at the Greenwich meridian: one window for the Sun and Moon per latitude.
  const window: [number, number] = [day0 - 0.5, day0 + 3];
  const rows: AlmanacLatitudeRow[] = [];
  let sunGreenwich: SkyEvent[] = [];
  let moonGreenwich: SkyEvent[] = [];
  for (const lat of STANDARD_LATITUDES) {
    const events = engine.dayEvents({ lat_deg: lat, lon_deg: 0 }, window[0], window[1], ['Sun', 'Moon']);
    const sunEv = events.bodies.find((b) => b.body === 'Sun')!;
    const moonEv = events.bodies.find((b) => b.body === 'Moon')!;
    if (lat === 0) {
      sunGreenwich = sunEv.events;
      moonGreenwich = moonEv.events;
    }
    const [nautical_dawn, civil_dawn, sunrise, sunset, civil_dusk, nautical_dusk] = sunCells(sunEv.events, day0);
    rows.push({
      lat_deg: lat,
      label: latitudeLabel(lat),
      nautical_dawn: nautical_dawn!,
      civil_dawn: civil_dawn!,
      sunrise: sunrise!,
      sunset: sunset!,
      civil_dusk: civil_dusk!,
      nautical_dusk: nautical_dusk!,
      moonrise: [0, 1].map((k) => moonCell(moonEv.events, moonEv.always_above, 'rise', day0 + k)),
      moonset: [0, 1].map((k) => moonCell(moonEv.events, moonEv.always_above, 'set', day0 + k)),
    });
  }

  const planetEvents = engine.dayEvents(greenwich, day0, day0 + 2, [...PLANETS]);
  const planets: AlmanacPlanetDay[] = PLANETS.map((p) => {
    const s0 = get(0, p);
    const s24 = get(24, p);
    const v = (gha(s0, s24, 24) / 24 - PLANET_ADOPTED_DEG_PER_H) * 60;
    const dd = ((s24.dec_deg - s0.dec_deg) / 24) * 60;
    const n = noonBody(p);
    const ev = planetEvents.bodies.find((b) => b.body === p)?.events ?? [];
    return {
      body: p,
      magnitude: n.magnitude,
      v_arcmin: v,
      d_arcmin: dd,
      sha_deg: n.sha_deg,
      mer_pass: passage(ev, 'transit', day0),
      printed: {
        magnitude: n.magnitude === null ? '--' : fmtMagnitude(n.magnitude),
        v: fmtArcmin(v),
        d: fmtArcmin(Math.abs(dd)),
        sha: fmtAngle(n.sha_deg),
      },
    };
  });

  const stars: AlmanacStar[] = noonState.bodies
    .filter((b) => b.kind === 'star')
    .map((b) => ({
      body: b.body,
      sha_deg: b.sha_deg,
      dec_deg: b.dec_deg,
      magnitude: b.magnitude ?? 0,
      printed: { sha: fmtAngle(b.sha_deg), dec: fmtDec(b.dec_deg) },
    }));

  // Aries: GHA Aries = 0, by Newton on the mock's sidereal time.
  let t = day0 + norm360(-engine.sidereal(day0).gha_aries_deg) / SIDEREAL_DEG_PER_DAY;
  for (let k = 0; k < 3; k += 1) t += norm180(-engine.sidereal(t).gha_aries_deg) / SIDEREAL_DEG_PER_DAY;

  const eot = (h: number): number => norm180(get(h, 'Sun').gha_deg - 15 * (h - 12)) * 240;
  const sunNoon = noonBody('Sun');
  const moonNoon = noonBody('Moon');
  let phases: PhaseEvent[] = [];
  try {
    phases = engine.moonPhases(noon - 31, day0 + 1);
  } catch (error) {
    errors.push({ body: 'Moon', message: error instanceof Error ? error.message : String(error) });
  }
  const newMoon = phases.filter((p) => p.kind === 'new_moon' && p.jd_utc <= noon).pop();
  const age = newMoon ? noon - newMoon.jd_utc : null;
  const k = moonNoon.illuminated_fraction;
  const sunD = ((get(24, 'Sun').dec_deg - get(0, 'Sun').dec_deg) / 24) * 60;

  return {
    date: iso,
    weekday: WEEKDAYS[new Date(utcMs(y, m, d)).getUTCDay()]!,
    jd_utc: day0,
    noon_jd_utc: noon,
    hours,
    aries: { mer_pass: at(t, day0, true) },
    sun: {
      sd_arcmin: sunNoon.semidiameter_arcmin,
      d_arcmin: sunD,
      eot_00h_s: eot(0),
      eot_12h_s: eot(12),
      mer_pass: passage(sunGreenwich, 'transit', day0),
      printed: {
        sd: fmtArcmin(sunNoon.semidiameter_arcmin),
        d: fmtArcmin(Math.abs(sunD)),
        eot_00h: fmtMs(eot(0)),
        eot_12h: fmtMs(eot(12)),
      },
    },
    moon: {
      sd_arcmin: moonNoon.semidiameter_arcmin,
      mer_pass_upper: passage(moonGreenwich, 'transit', day0),
      mer_pass_lower: passage(moonGreenwich, 'lower_transit', day0),
      age_days: age,
      illuminated_fraction: k,
      phase: phases.find((p) => p.jd_utc >= day0 && p.jd_utc < day0 + 1) ?? null,
      printed: {
        sd: fmtArcmin(moonNoon.semidiameter_arcmin),
        age: age === null ? '--' : pad2(Math.floor(age)),
        illuminated: k === null ? '--' : String(Math.round(k * 100)),
      },
    },
    planets,
    stars,
    rise_set: { moon_dates: [iso, dateOf(day0 + 1)], rows },
    notes: [...NOTES],
    errors,
  };
}
