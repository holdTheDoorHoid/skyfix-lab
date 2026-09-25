/**
 * The new Events lists' logic (events2 agent): what each list says about the engine's
 * answers, with the mock engine (illustrative numbers, the real shapes) and with hand-made
 * answers where a case must be exact — perigee and supermoons, occultations here and
 * elsewhere, close approaches, retrograde loops, transits, Jupiter's moons, meteor showers,
 * the Earth's perihelion and aphelion; the tables they save; the coverage in words and the
 * uncertainty of far dates (deeptime.ts). Node environment: no DOM.
 */

import { describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import type {
  Conjunction,
  ExplorerCoverage,
  GalileanPhenomenon,
  MoonSyzygy,
  Occultation,
  OccultationContact,
  PlanetStation,
  ShowerNight,
  TimeInfo,
} from '../../src/next/engine/types.js';
import { chipsIn, coverageYears, coveredSentence, listUncertaintySentence, wireYear, yearText } from '../../src/next/events/deeptime.js';
import { eclipseIdDate } from '../../src/next/events/eclipses.js';
import { csvComments, csvOfItems, screenWords, utcDate, type EventItem, type Words } from '../../src/next/events/items.js';
import { nightStart, nightStarts } from '../../src/next/events/jupiter.js';
import {
  apsidesItems,
  apsidesLead,
  betterOccultation,
  clockPosition,
  elsewhereItem,
  hoursFromPerigee,
  moonPartner,
  occultationId,
  occultationItem,
  occultationTitle,
  occultedSomewhere,
  syzygyItem,
  whereSeen,
} from '../../src/next/events/moon-model.js';
import {
  conjunctionItem,
  conjunctionJump,
  conjunctionSeen,
  galileanId,
  galileanItem,
  galileanSeen,
  retrogradeAt,
  retrogradePeriods,
  separationWords,
  skyDirection,
  skyReason,
  stationItem,
  transitItem,
  transitPosition,
  transitSentence,
} from '../../src/next/events/planet-model.js';
import { earthApsisItem, moonGlare, moonWords, phaseItem, rateText, seasonItem, showerItem, tonightLine } from '../../src/next/events/sky-model.js';
import { defaultState, type ExplorerState } from '../../src/next/state.js';
import { UTC_ZONE } from '../../src/next/time.js';

const JD_UNIX = 2_440_587.5;
const jdOf = (iso: string): number => Date.parse(iso) / 86_400_000 + JD_UNIX;
const PHILLY = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 12 };

/** The explorer at Philadelphia, times in UTC (so the words are the same on every machine). */
function stateAt(iso: string): ExplorerState {
  const s = defaultState(Date.parse(iso));
  return { ...s, time: { ...s.time, live: false }, settings: { ...s.settings, timeDisplay: 'utc' } };
}

const S = stateAt('2026-09-25T16:00:00Z');
const W: Words = screenWords(S);
const mock = new MockEngine();

// ---------------------------------------------------------------------------------------
// Perigee, apogee and supermoons
// ---------------------------------------------------------------------------------------

describe('perigee and supermoons', () => {
  const year = mock.moonApsides(jdOf('2026-01-01T00:00:00Z'), jdOf('2027-01-01T00:00:00Z'));
  const items = apsidesItems(year, W);

  it('list every perigee and apogee and every full Moon, in time order, each once', () => {
    const perigees = items.filter((i) => i.kind === 'Perigee').length;
    const apogees = items.filter((i) => i.kind === 'Apogee').length;
    const fulls = items.filter((i) => i.title === 'Full Moon').length;
    expect(perigees).toBeGreaterThanOrEqual(12);
    expect(perigees).toBeLessThanOrEqual(14);
    expect(apogees).toBeGreaterThanOrEqual(12);
    expect(fulls).toBe(year.syzygies.filter((s) => s.kind === 'full_moon').length);
    for (let i = 1; i < items.length; i++) expect(items[i]!.start).toBeGreaterThanOrEqual(items[i - 1]!.start);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    for (const i of items) {
      expect(i.local).toBe(false);
      expect(i.body).toBe('Moon');
      expect(i.sentence.length).toBeGreaterThan(20);
    }
  });

  it('name a supermoon, a micromoon and the year’s largest and smallest full Moon in words', () => {
    for (const s of year.syzygies) {
      const item = syzygyItem(s, W);
      if (s.kind === 'new_moon' && !s.supermoon && !s.micromoon) {
        expect(item).toBeNull();
        continue;
      }
      expect(item).not.toBeNull();
      if (s.supermoon) expect(item!.sentence).toMatch(/^A supermoon/);
      if (s.micromoon) expect(item!.sentence).toMatch(/^A micromoon/);
      if (s.largest_of_year) expect(item!.sentence).toMatch(/The largest full Moon of 2026\./);
      if (s.smallest_of_year) expect(item!.sentence).toMatch(/The smallest full Moon of 2026\./);
      if (s.kind === 'new_moon') expect(item!.sentence).toMatch(/cannot be seen/);
    }
    expect(year.syzygies.some((s) => s.largest_of_year)).toBe(true);
  });

  it('lead with the next supermoon and the year’s extremes', () => {
    const s = (over: Partial<MoonSyzygy>): MoonSyzygy => ({
      kind: 'full_moon',
      jd_utc: jdOf('2026-11-24T15:00:00Z'),
      utc: '',
      distance_km: 360_765,
      diameter_arcmin: 33.1,
      diameter_vs_mean_percent: 6.6,
      perigee: { jd_utc: 0, utc: '', distance_km: 356_000 },
      apogee: { jd_utc: 0, utc: '', distance_km: 406_000 },
      hours_from_perigee: 30.2,
      perigee_fraction: 0.97,
      supermoon: true,
      micromoon: false,
      largest_of_year: false,
      smallest_of_year: false,
      ...over,
    });
    const list = [
      s({}),
      s({ jd_utc: jdOf('2026-12-24T01:00:00Z'), distance_km: 356_738, largest_of_year: true }),
      s({ jd_utc: jdOf('2026-05-31T08:00:00Z'), distance_km: 406_135, supermoon: false, micromoon: true, smallest_of_year: true }),
    ];
    const lead = apsidesLead(list, jdOf('2026-09-25T00:00:00Z'), W);
    expect(lead).toMatch(/^Next supermoon: the full Moon of Tue 24 Nov 2026, 6\.6% larger than average\./);
    expect(lead).toMatch(/The largest full Moon of 2026 is on Thu 24 Dec .* the smallest on Sun 31 May .*: the largest looks 14% bigger across\./);
    expect(hoursFromPerigee(30.2)).toBe('30 hours after perigee');
    expect(hoursFromPerigee(-1.2)).toBe('1 hour before perigee');
    expect(hoursFromPerigee(0.3)).toBe('within an hour of perigee');
  });
});

// ---------------------------------------------------------------------------------------
// Occultations
// ---------------------------------------------------------------------------------------

function contact(over: Partial<OccultationContact>): OccultationContact {
  return {
    kind: 'disappearance',
    jd_utc: jdOf('2026-10-07T03:08:17Z'),
    utc: '2026-10-07T03:08:17.000Z',
    position_angle_deg: 101,
    vertex_angle_deg: 60,
    cusp_angle_deg: 70,
    cusp: 'N',
    limb: 'dark',
    moon_alt_deg: 31.6,
    moon_az_deg: 102,
    moon_above_horizon: true,
    sun_alt_deg: -40,
    sky_phase: 'night',
    crossing_s: 0,
    ...over,
  };
}

function occultation(over: Partial<Occultation> = {}): Occultation {
  return {
    body: 'Regulus',
    kind: 'star',
    designation: 'α Leo',
    hr: 3982,
    magnitude: 1.35,
    navigational: true,
    occulted: true,
    graze: false,
    disappearance: contact({}),
    reappearance: contact({ kind: 'reappearance', jd_utc: jdOf('2026-10-07T04:01:02Z'), utc: '2026-10-07T04:01:02.000Z', limb: 'bright', position_angle_deg: 250, vertex_angle_deg: 200 }),
    closest: { jd_utc: jdOf('2026-10-07T03:35:00Z'), utc: '', limb_distance_arcmin: -9.3, position_angle_deg: 180, moon_alt_deg: 36 },
    duration_s: 3165,
    body_semidiameter_arcsec: 0,
    moon_illuminated_fraction: 0.18,
    waxing: false,
    visible: true,
    ...over,
  };
}

describe('occultations seen from here', () => {
  it('tell in words where and when the star goes in and comes out', () => {
    const item = occultationItem(occultation(), W);
    expect(item.title).toBe('The Moon hides Regulus');
    expect(item.term).toBe('occultation');
    expect(item.id).toBe('occultation-Regulus-2026-10-07');
    expect(item.local).toBe(true);
    expect(item.end).toBeCloseTo(jdOf('2026-10-07T04:01:02Z'), 9);
    expect(item.sentence).toBe(
      'Regulus disappears at the Moon’s dark edge at 03:08 and reappears at its bright edge at 04:01, 52 min 45 s later. At the start the Moon is 32° up in the east-south-east, in a dark sky; it is 18% lit and waning.',
    );
    expect(item.jump).toBe(item.start);
  });

  it('flag grazes and near misses, and a Moon below the horizon', () => {
    expect(occultationTitle({ body: 'Alcyone', occulted: true, graze: true }).title).toBe('Alcyone grazes the Moon’s edge');
    expect(occultationTitle({ body: 'Alcyone', occulted: false, graze: true }).title).toBe('Alcyone just misses the Moon');
    const miss = occultationItem(occultation({ occulted: false, graze: true, disappearance: null, reappearance: null, closest: { jd_utc: jdOf('2026-10-28T00:33:00Z'), utc: '', limb_distance_arcmin: 0.86, position_angle_deg: 10, moon_alt_deg: 20 } }), W);
    expect(miss.sentence).toMatch(/^From here it passes 0\.9′ outside the Moon’s edge at 00:33/);
    expect(miss.kind).toBe('Near miss');
    const low = occultationItem(occultation({ visible: false, disappearance: contact({ moon_above_horizon: false, moon_alt_deg: -10 }) }), W);
    expect(low.sentence).toMatch(/At the start the Moon is below the horizon here/);
  });

  it('prefer the find with both contacts when two search windows meet it', () => {
    const one = occultation({ reappearance: null });
    expect(betterOccultation(one, occultation())).toBe(true);
    expect(betterOccultation(occultation(), one)).toBe(false);
    expect(occultationId(one)).toBe(occultationId(occultation()));
  });

  it('put a contact on the Moon’s clock face, 12 toward the zenith, 3 to the right', () => {
    expect(clockPosition(0)).toBe(12);
    expect(clockPosition(90)).toBe(9); // vertex angle runs anticlockwise on the sky: east of the zenith is left
    expect(clockPosition(180)).toBe(6);
    expect(clockPosition(270)).toBe(3);
    expect(clockPosition(359)).toBe(12);
  });

  it('come from the mock engine in the same shape', () => {
    const r = mock.occultations(PHILLY, jdOf('2026-09-25T00:00:00Z'), jdOf('2026-12-25T00:00:00Z'), { include_below_horizon: true });
    for (const o of r.events) {
      const item = occultationItem(o, W);
      expect(item.local).toBe(true);
      expect(item.title).toContain(o.body);
      expect(item.sentence.length).toBeGreaterThan(30);
    }
    expect(r.limb_note).toMatch(/limb/i);
  });
});

describe('occultations elsewhere on Earth', () => {
  it('happen where the Moon’s shadow cast by the body meets the Earth: sin(sep) < sin(HP) + sin(SD)', () => {
    // HP 57′ and SD 15.5′: the Moon's edge reaches 1.2084° from the body for some observer.
    const hp = 57 / 60;
    const sd = 15.5 / 60;
    const reach = (Math.asin(Math.sin((hp * Math.PI) / 180) + Math.sin((sd * Math.PI) / 180)) * 180) / Math.PI;
    expect(reach).toBeCloseTo(1.2084, 3);
    expect(occultedSomewhere(1.2, hp, sd)).toBe(true);
    expect(occultedSomewhere(1.21, hp, sd)).toBe(false);
    // A planet counts once any of its disc is covered.
    expect(occultedSomewhere(1.21, hp, sd, 0.005)).toBe(true);
    expect(occultedSomewhere(Number.NaN, hp, sd)).toBe(false);
  });

  it('are seen from the north or south of the half of the Earth facing the Moon, or across its middle', () => {
    expect(whereSeen(0.8, 10, 0.26)).toBe('north');
    expect(whereSeen(0.8, 190, 0.26)).toBe('south');
    expect(whereSeen(0.2, 190, 0.26)).toBe('middle');
  });

  it('say so plainly, with the clock’s own name for the time', () => {
    const c: Conjunction = {
      kind: 'moon_star',
      body: 'Moon',
      other: 'Antares',
      jd_utc: jdOf('2026-10-14T21:02:47Z'),
      utc: '',
      separation_deg: 0.415,
      position_angle_deg: 187.6,
      ra_deg: 0,
      dec_deg: 0,
      body_elongation_deg: 60,
      other_elongation_deg: 60,
      body_magnitude: -10,
      other_magnitude: 1.06,
      visible: true,
      local: null,
    };
    expect(moonPartner(c)).toBe('Antares');
    const item = elsewhereItem({ conjunction: c, where: 'south' }, W, (jd) => W.time(jd));
    expect(item.title).toBe('The Moon hides Antares, elsewhere');
    expect(item.id).toBe('occultation-Antares-2026-10-14');
    expect(item.sentence).toMatch(/^Not seen from here\. Seen from the Earth’s centre the Moon passes 0° 25′ south of Antares around 21:03 UTC, so Antares is hidden for observers from the southern part/);
    expect(moonPartner({ ...c, kind: 'planet_planet', body: 'Venus', other: 'Jupiter' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Close approaches
// ---------------------------------------------------------------------------------------

describe('close approaches', () => {
  const list = mock.conjunctions(jdOf('2026-09-25T00:00:00Z'), jdOf('2026-12-25T00:00:00Z'), { observer: PHILLY }).conjunctions;

  it('read as one sentence each, with where and when to look from the place', () => {
    expect(list.length).toBeGreaterThan(5);
    for (const c of list) {
      const item = conjunctionItem(c, W);
      expect(item.title).toMatch(/ apart$/);
      expect(item.local).toBe(true);
      expect(item.jump).toBe(conjunctionJump(c));
      if (!c.visible) expect(item.sentence).toMatch(/Too close to the Sun/);
      else if (c.local?.best) expect(item.sentence).toMatch(/Best seen from here at /);
      else expect(item.sentence).toMatch(/Not seen from here/);
      expect(conjunctionSeen(c)).toBe(c.visible && !!c.local?.best);
    }
  });

  it('describe how close and which way in words people picture', () => {
    expect(separationWords(0.3)).toBe('closer than the width of the full Moon');
    expect(separationWords(1.1)).toBe('about 2 full-Moon widths apart');
    expect(separationWords(4)).toBe('close enough to share a view in binoculars');
    expect(skyDirection(0)).toBe('north');
    expect(skyDirection(170)).toBe('south');
    expect(skyDirection(95)).toBe('east');
    expect(skyDirection(350)).toBe('north');
  });
});

// ---------------------------------------------------------------------------------------
// Retrograde loops
// ---------------------------------------------------------------------------------------

function station(body: string, kind: PlanetStation['kind'], iso: string): PlanetStation {
  return {
    body,
    kind,
    coordinate: 'ecliptic_longitude',
    jd_utc: jdOf(iso),
    utc: iso,
    angle_deg: 100,
    ra_deg: 100,
    dec_deg: 10,
    ecliptic_longitude_deg: 100,
    elongation_deg: 120,
    magnitude: 0.5,
  };
}

describe('retrograde loops', () => {
  const stations = [
    station('Saturn', 'retrograde_ends', '2026-11-27T00:00:00Z'), // began before the search
    station('Mars', 'retrograde_begins', '2027-01-10T00:00:00Z'),
    station('Mars', 'retrograde_ends', '2027-04-01T00:00:00Z'),
    station('Jupiter', 'retrograde_begins', '2027-12-15T00:00:00Z'), // ends after it
    { ...station('Mars', 'retrograde_begins', '2027-01-11T00:00:00Z'), coordinate: 'right_ascension' as const },
  ];

  it('pair each planet’s stations, keeping loops cut by the edges of the search', () => {
    const p = retrogradePeriods(stations, 'ecliptic_longitude');
    expect(p.map((x) => `${x.body} ${x.begins?.utc.slice(0, 10) ?? '…'} ${x.ends?.utc.slice(0, 10) ?? '…'}`)).toEqual([
      'Saturn … 2026-11-27',
      'Mars 2027-01-10 2027-04-01',
      'Jupiter 2027-12-15 …',
    ]);
    expect(retrogradeAt(p, jdOf('2027-02-01T00:00:00Z')).map((x) => x.body)).toEqual(['Mars']);
    expect(retrogradeAt(p, jdOf('2026-10-01T00:00:00Z')).map((x) => x.body)).toEqual(['Saturn']);
  });

  it('say how long the loop lasts and why it happens', () => {
    const p = retrogradePeriods(stations, 'ecliptic_longitude');
    const mars = p.find((x) => x.body === 'Mars')!;
    const begin = stationItem(mars.begins!, mars, W);
    expect(begin.title).toBe('Mars turns retrograde');
    expect(begin.sentence).toMatch(/lasting 81 days until Thu 1 Apr 2027/);
    expect(begin.sentence).toMatch(/The Earth, on its faster inside track, is overtaking Mars/);
    const end = stationItem(mars.ends!, mars, W);
    expect(end.title).toBe('Mars resumes direct motion');
    expect(end.sentence).toMatch(/that began on Sun 10 Jan 2027 \(81 days\)/);
    const mercury = stationItem(station('Mercury', 'retrograde_begins', '2026-10-24T00:00:00Z'), null, W);
    expect(mercury.sentence).toMatch(/passing between the Earth and the Sun/);
  });

  it('pair the mock engine’s stations the same way', () => {
    const r = mock.stations(jdOf('2026-01-01T00:00:00Z'), jdOf('2028-01-01T00:00:00Z'));
    const p = retrogradePeriods(r.stations, r.ui_coordinate);
    const closed = p.filter((x) => x.begins && x.ends);
    expect(closed.length).toBeGreaterThan(3);
    for (const x of closed) expect(x.ends!.jd_utc).toBeGreaterThan(x.begins!.jd_utc);
  });
});

// ---------------------------------------------------------------------------------------
// Transits
// ---------------------------------------------------------------------------------------

describe('transits of Mercury and Venus', () => {
  const r = mock.transits(jdOf('2032-11-01T00:00:00Z'), jdOf('2032-12-01T00:00:00Z'), PHILLY);

  it('find the mock’s transit of 2032 and tell what the place sees', () => {
    expect(r.transits.length).toBe(1);
    const t = r.transits[0]!;
    const item = transitItem(t, W);
    expect(item.title).toBe('Transit of Mercury');
    expect(item.id).toBe(`transit-${t.id}`);
    expect(item.local).toBe(true);
    expect(item.end).not.toBeNull();
    expect(item.end!).toBeGreaterThan(item.start);
    const sentence = transitSentence(t, W);
    expect(sentence).toBe(item.sentence);
    expect(sentence).toMatch(/^(Not seen here|Seen here|Partly seen here)/);
  });

  it('place the planet on the Sun between the path’s points', () => {
    const path = [
      { jd_utc: 10, east_arcsec: -900, north_arcsec: 100 },
      { jd_utc: 11, east_arcsec: 900, north_arcsec: 300 },
    ];
    expect(transitPosition(path, 10.5)).toEqual({ east: 0, north: 200 });
    expect(transitPosition(path, 9)).toBeNull();
    expect(transitPosition(path, 11.5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Jupiter's moons
// ---------------------------------------------------------------------------------------

describe('Jupiter’s moons', () => {
  const p: GalileanPhenomenon = {
    moon: 'Europa',
    kind: 'eclipse',
    start: { jd_utc: jdOf('2026-09-26T10:08:59Z'), utc: '', observable: true },
    end: { jd_utc: jdOf('2026-09-26T13:02:43Z'), utc: '', observable: false },
    jupiter_elongation_deg: 60,
  };

  it('say what happens, when, and why a moment cannot be seen', () => {
    const dark = { jupiterAlt: 33.6, jupiterAz: 120, sunAlt: -9.1 };
    const day = { jupiterAlt: 53, jupiterAz: 160, sunAlt: 11.5 };
    const item = galileanItem(p, W, { start: dark, end: day });
    expect(item.title).toBe('Europa in Jupiter’s shadow');
    expect(item.sentence).toBe('Europa fades into the shadow at 10:09 and reappears from it at 13:03 (unseen: behind Jupiter then).');
    expect(galileanSeen(p, { start: dark, end: day })).toBe(true);
    expect(galileanSeen({ ...p, start: { ...p.start, observable: false } }, { start: dark, end: day })).toBe(false);
    expect(skyReason(day, 60)).toBe('it is daylight');
    expect(skyReason({ ...dark, jupiterAlt: -3 }, 60)).toBe('Jupiter is below the horizon');
    expect(skyReason({ ...dark, jupiterAlt: 2 }, 60)).toBe('Jupiter is too low');
    expect(skyReason(dark, 10)).toBe('Jupiter is too near the Sun');
    expect(skyReason(dark, 60)).toBe('');
    expect(galileanId(p)).toBe('jupiter-Europa-eclipse-2026-09-26');
  });

  it('come from the mock engine in the same shape, each named once', () => {
    const r = mock.galileanEvents(jdOf('2026-09-25T12:00:00Z'), jdOf('2026-09-27T12:00:00Z'));
    expect(r.phenomena.length).toBeGreaterThan(2);
    const ids = r.phenomena.map((x) => galileanId(x));
    expect(new Set(ids).size).toBe(ids.length);
    for (const x of r.phenomena) expect(galileanItem(x, W, null).sentence.length).toBeGreaterThan(20);
  });

  it('group events by night: local noon to local noon', () => {
    const noon = nightStart(jdOf('2026-09-26T03:00:00Z'), UTC_ZONE);
    expect(noon).toBeCloseTo(jdOf('2026-09-25T12:00:00Z'), 9);
    expect(nightStart(jdOf('2026-09-25T13:00:00Z'), UTC_ZONE)).toBeCloseTo(jdOf('2026-09-25T12:00:00Z'), 9);
    const starts = nightStarts(jdOf('2026-09-25T16:00:00Z'), UTC_ZONE, 3);
    expect(starts.map((jd) => utcDate(jd))).toEqual(['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']);
    const ny = { kind: 'iana', zone: 'America/New_York' } as const;
    // 01:00 EDT belongs to the night that began the afternoon before (16:00 UTC the day before).
    expect(nightStart(jdOf('2026-09-26T05:00:00Z'), ny)).toBeCloseTo(jdOf('2026-09-25T16:00:00Z'), 9);
  });
});

// ---------------------------------------------------------------------------------------
// Meteor showers
// ---------------------------------------------------------------------------------------

describe('meteor showers', () => {
  const year = mock.meteorShowers(2026, PHILLY, { bortle: 4 });

  it('give each shower’s dates, rate, the Moon and the rate here, marked as estimates', () => {
    expect(year.showers.length).toBeGreaterThan(3);
    for (const d of year.showers) {
      const item = showerItem(d, W);
      expect(item.title).toBe(`${d.shower.name} peak`);
      expect(item.id).toBe(`meteors-${d.shower.code}-${utcDate(d.peak.jd_utc)}`);
      expect(item.sentence).toMatch(/^Active /);
      expect(item.sentence).toMatch(/\(the ZHR\)/);
      expect(item.sentence).toMatch(/Moon \d+% lit/);
      if (d.at_site?.best) expect(item.sentence).toMatch(/At your place (about \d+|under 1) an hour at best, around /);
    }
  });

  it('say how much the Moon gets in the way, and rates as people read them', () => {
    expect(moonGlare(0.1)).toBe('dark');
    expect(moonGlare(0.4)).toBe('some');
    expect(moonGlare(0.97)).toBe('bright');
    expect(moonWords(0.97)).toBe('Moon 97% lit: its light hides the fainter meteors while it is up');
    expect(rateText(0.2)).toBe('under 1 an hour');
    expect(rateText(12.6)).toBe('about 13 an hour');
    const n: ShowerNight = {
      code: 'ORI',
      name: 'Orionids',
      lambda_deg: 204,
      zhr: 12,
      days_from_peak: -4.2,
      radiant_ra_deg: 95,
      radiant_dec_deg: 16,
      best: { jd_utc: jdOf('2026-10-17T09:30:00Z'), utc: '', alt_deg: 55, az_deg: 160, direction: 'SSE' },
      expected_rate_per_hour: 6.4,
      limiting_mag: 5.8,
      hours_radiant_above_20: 5,
      variable: false,
      reason: '',
    };
    expect(tonightLine(n, W)).toBe('Orionids (4 days before the peak): about 6 an hour at best, around 09:30');
  });
});

// ---------------------------------------------------------------------------------------
// Seasons and the Earth's apsides
// ---------------------------------------------------------------------------------------

describe('the seasons and the Earth’s perihelion and aphelion', () => {
  it('say how far the Earth is from the Sun, and that the tilt makes the seasons', () => {
    const r = mock.earthApsides(2026);
    const peri = r.events.find((e) => e.kind === 'perihelion')!;
    const aph = r.events.find((e) => e.kind === 'aphelion')!;
    expect(utcDate(peri.jd_utc).slice(0, 7)).toBe('2026-01');
    expect(utcDate(aph.jd_utc).slice(0, 7)).toBe('2026-07');
    const item = earthApsisItem(peri, aph);
    expect(item.title).toBe('Earth closest to the Sun');
    expect(item.term).toBe('perihelion');
    expect(item.sentence).toMatch(/^The Earth is closest to the Sun: 147\.\d\d million km \(0\.983\d\d AU\), 3\.\d% nearer than at aphelion/);
    expect(item.sentence).toMatch(/tilt of the Earth’s axis/);
    expect(earthApsisItem(aph, peri).sentence).toMatch(/farther than at perihelion/);
  });

  it('name phases and seasons for files, with stable ids', () => {
    const phase = phaseItem({ kind: 'full_moon', jd_utc: jdOf('2026-10-26T04:12:00Z'), utc: '' });
    expect(phase.id).toBe('full-moon-2026-10-26');
    expect(phase.title).toBe('Full Moon');
    const season = seasonItem({ kind: 'december_solstice', jd_utc: jdOf('2026-12-21T20:50:00Z'), utc: '' }, -33.9);
    expect(season.id).toBe('december-solstice-2026-12-21');
    expect(season.sentence).toMatch(/where you are/);
  });
});

// ---------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------

describe('tables (CSV)', () => {
  const items: EventItem[] = [
    occultationItem(occultation(), W),
    phaseItem({ kind: 'full_moon', jd_utc: jdOf('2026-10-26T04:12:00Z'), utc: '' }),
  ];

  it('carry the instant, its clock, the local time and each kind’s own columns', () => {
    const text = csvOfItems(items, S, mock, csvComments('Moon, next 12 months', S, { label: 'Philadelphia', lat_deg: 39.9526, lon_deg: -75.1652 }, true));
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\r\n');
    expect(lines.at(-1)).toBe('');
    expect(lines[0]).toBe('# SkyFix Lab: Moon, next 12 months');
    expect(lines[1]).toMatch(/^# Seen from Philadelphia \(39° 57\.2′ N, 075° 09\.9′ W\)$/);
    const header = lines.find((l) => l.startsWith('Instant,'))!;
    expect(header.split(',').slice(0, 11)).toEqual(['Instant', 'Scale', 'Local date', 'Local time', 'Zone', 'Kind', 'Event', 'End', 'Uncertainty', 'Body', 'Description']);
    expect(header).toContain('Disappearance limb');
    const rows = lines.slice(lines.indexOf(header) + 1, -1);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.startsWith('2026-10-07T03:08:17Z,UTC,Wed 7 Oct 2026,03:08,UTC,Occultation,The Moon hides Regulus (occultation),2026-10-07T04:01:02Z,,Regulus,')).toBe(true);
    // A row without an occultation's columns leaves them empty.
    expect(rows[1]!.startsWith('2026-10-26T04:12:00Z,UTC,Mon 26 Oct 2026,04:12,UTC,Moon phase,Full Moon,,,Moon,')).toBe(true);
    expect(rows[1]!.endsWith(',,,,,,,,,,,,,,,')).toBe(true);
  });

  it('never name the place when the person chose not to', () => {
    const lines = csvComments('Occultations', S, null, true);
    expect(lines.join('\n')).not.toMatch(/Philadelphia|39°/);
    expect(lines.join('\n')).toMatch(/not named in this file/);
  });
});

// ---------------------------------------------------------------------------------------
// Deep time: the coverage in words, far dates' uncertainty
// ---------------------------------------------------------------------------------------

function engineWith(coverage: Partial<ExplorerCoverage>, sigma: (jd: number) => number, tier: (jd: number) => TimeInfo['tier'] = () => 'validated') {
  return {
    coverage: () => ({ start_utc: '1990-01-01T00:00:00Z', end_utc: '2060-12-31T23:59:59Z', groups: [], ...coverage }),
    timeInfo: (jd: number) => ({ delta_t_sigma_s: sigma(jd), tier: tier(jd), scale: 'utc', jd_utc: jd }) as unknown as TimeInfo,
    setDut1: () => undefined,
    calendarConvert: () => {
      throw new Error('unused');
    },
  } as unknown as Parameters<typeof coverageYears>[0];
}

describe('deep time in the lists', () => {
  it('state the years the engine covers instead of a fixed span', () => {
    expect(coverageYears(engineWith({}, () => 0.001))).toBe('1990 to 2060');
    expect(coveredSentence(engineWith({}, () => 0.001), 'Eclipses')).toBe('Eclipses are computed for 1990 to 2060');
    const wide = engineWith({ start_utc: '-2000-01-01T00:00:00Z', end_utc: '3000-12-31T23:59:59Z' }, () => 0.001);
    expect(coverageYears(wide)).toBe('2001 BC to AD 3000');
    expect(yearText(-584)).toBe('585 BC');
    expect(wireYear(jdOf('2026-06-01T00:00:00Z'))).toBe(2026);
    expect(wireYear(1_507_900.5)).toBe(-584);
  });

  it('carry the ±ΔT uncertainty only where it counts, and say why', () => {
    const near = engineWith({}, () => 5);
    expect(chipsIn(near, jdOf('2026-01-01T00:00:00Z'), jdOf('2027-01-01T00:00:00Z'))).toBe(false);
    expect(listUncertaintySentence(near, [jdOf('2026-01-01T00:00:00Z')])).toBe('');
    const far = engineWith({}, (jd) => (jd > jdOf('2400-01-01T00:00:00Z') ? 400 : 5));
    expect(chipsIn(far, jdOf('2026-01-01T00:00:00Z'), jdOf('2500-01-01T00:00:00Z'))).toBe(true);
    expect(listUncertaintySentence(far, [jdOf('2450-01-01T00:00:00Z'), jdOf('2500-01-01T00:00:00Z')])).toBe(
      'the Earth’s rotation at these dates is known only roughly, so each clock time carries the uncertainty shown beside it (up to ±7 min).',
    );
    const labelled = engineWith({}, () => 3600, () => 'labelled');
    expect(listUncertaintySentence(labelled, [1_507_900.5])).toMatch(/^Estimates outside the validated years: .*\(up to ±1 h\)\.$/);
  });

  it('read eclipse ids in any year', () => {
    expect(eclipseIdDate('2024-04-08-solar')).toBeCloseTo(jdOf('2024-04-08T00:00:00Z'), 9);
    // The wire's dates are proleptic Gregorian: Thales's eclipse, 28 May 585 BC in the Julian
    // calendar (JD 1507900.1), is -0584-05-22 on the wire; -0584-05-28 there is six days later.
    expect(eclipseIdDate('-0584-05-22-solar')).toBeCloseTo(1_507_899.5, 6);
    expect(eclipseIdDate('-0584-05-28-solar')).toBeCloseTo(1_507_905.5, 6);
    expect(eclipseIdDate('+12345-01-01-lunar')).not.toBeNull();
    expect(eclipseIdDate('2024-04-08-venus')).toBeNull();
    expect(utcDate(1_507_900.1)).toBe('-0584-05-22');
  });
});
