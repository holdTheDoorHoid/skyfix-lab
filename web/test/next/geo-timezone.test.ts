/**
 * Displayed time (CONVENTIONS 13.8, web/src/next/geo/timezone.ts): nautical zones, Intl
 * formatting, local-midnight day windows including the 23- and 25-hour days, the zone list,
 * and the zone guess at known places.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jdFromUnixMs } from '../../src/next/engine/types.js';
import { parseGazetteer } from '../../src/next/geo/gazetteer.js';
import { buildRegionIndex } from '../../src/next/geo/regions.js';
import {
  UTC_ZONE,
  addDays,
  dayWindow,
  dayWindowAt,
  formatOffsetIso,
  formatOffsetLabel,
  formatZoneDescription,
  formatZoned,
  guessZone,
  intlZoneId,
  isSupportedZone,
  listTimeZones,
  localDate,
  nauticalZone,
  parseLocalDate,
  registerZoneAlternatives,
  resolveIntlZone,
  startOfLocalDay,
  zoneDescription,
  zoneFromKey,
  zoneKey,
  zoneLetter,
  zoneName,
  zoneOffsetMinutes,
  zonedTime,
  type DisplayZone,
} from '../../src/next/geo/timezone.js';

const DATA = join(import.meta.dirname, '../../public/data');
const json = (f: string) => JSON.parse(readFileSync(join(DATA, f), 'utf8')) as unknown;
const g = parseGazetteer(json('gazetteer.json'));
const regions = buildRegionIndex(json('basemap/countries-50m.geojson'), json('basemap/admin1-50m.geojson'));

const iana = (id: string): DisplayZone => ({ kind: 'iana', id });
const NY = iana('America/New_York');
const MINUS = String.fromCharCode(0x2212);

describe('nautical zones', () => {
  it('ZD = round(lon / -15): 75 W is ZD +5, zone time + ZD = UTC', () => {
    expect(zoneDescription(-75)).toBe(5);
    expect(zoneDescription(-75.1652)).toBe(5);
    expect(zoneDescription(0)).toBe(0);
    expect(zoneDescription(139.7)).toBe(-9);
    const t = Date.UTC(2026, 8, 24, 12);
    expect(zoneOffsetMinutes(nauticalZone(-75), t)).toBe(-300);
    expect(zonedTime(t, nauticalZone(-75)).time).toBe('07:00:00');
  });

  it('boundaries fall on odd multiples of 7.5 degrees', () => {
    expect(zoneDescription(7.4)).toBe(0);
    expect(zoneDescription(7.6)).toBe(-1);
    expect(zoneDescription(-7.4)).toBe(0);
    expect(zoneDescription(-7.6)).toBe(1);
    // Exactly on a boundary Math.round decides; documented.
    expect(zoneDescription(7.5)).toBe(0);
    expect(zoneDescription(-7.5)).toBe(1);
  });

  it('the 180th meridian: ZD -12 east of it, +12 west of it', () => {
    expect(zoneDescription(180)).toBe(-12);
    expect(zoneDescription(-180)).toBe(-12); // -180 is the same meridian as +180
    expect(zoneDescription(179)).toBe(-12);
    expect(zoneDescription(-179)).toBe(12);
    expect(zoneDescription(172.4)).toBe(-11);
    expect(zoneDescription(-172.6)).toBe(12);
    expect(zoneDescription(540)).toBe(-12);
    expect(Object.is(zoneDescription(-0.1), -0)).toBe(false);
  });

  it('letters and notation', () => {
    expect(zoneLetter(0)).toBe('Z');
    expect(zoneLetter(-1)).toBe('A');
    expect(zoneLetter(-9)).toBe('I');
    expect(zoneLetter(-10)).toBe('K'); // J is skipped
    expect(zoneLetter(-12)).toBe('M');
    expect(zoneLetter(1)).toBe('N');
    expect(zoneLetter(5)).toBe('R');
    expect(zoneLetter(12)).toBe('Y');
    expect(formatZoneDescription(5)).toBe('+5');
    expect(formatZoneDescription(-3)).toBe(`${MINUS}3`);
    expect(formatZoneDescription(0)).toBe('0');
    expect(zoneName(nauticalZone(-75))).toBe('Nautical zone ZD +5 (R)');
  });

  it('maps to the matching Etc/GMT zone (whose sign is inverted by POSIX)', () => {
    expect(intlZoneId(nauticalZone(-75))).toBe('Etc/GMT+5');
    expect(intlZoneId(nauticalZone(150))).toBe('Etc/GMT-10');
    expect(intlZoneId(nauticalZone(0))).toBe('Etc/GMT');
    const t = Date.UTC(2026, 0, 1);
    for (const lon of [-179, -75, 0, 30, 150, 180]) {
      const z = nauticalZone(lon);
      expect(zoneOffsetMinutes(iana(intlZoneId(z)!), t)).toBe(zoneOffsetMinutes(z, t));
    }
  });
});

describe('offsets, abbreviations and formatting', () => {
  const summer = Date.UTC(2026, 6, 1, 12);
  const winter = Date.UTC(2026, 0, 15, 12);

  it('offsets follow daylight saving', () => {
    expect(zoneOffsetMinutes(NY, summer)).toBe(-240);
    expect(zoneOffsetMinutes(NY, winter)).toBe(-300);
    expect(zoneOffsetMinutes(iana('Asia/Kolkata'), summer)).toBe(330);
    expect(zoneOffsetMinutes(iana('Asia/Kathmandu'), summer)).toBe(345);
    expect(zoneOffsetMinutes(iana('Pacific/Chatham'), winter)).toBe(825); // +13:45 in the southern summer
    expect(zoneOffsetMinutes(iana('Pacific/Kiritimati'), summer)).toBe(14 * 60);
    expect(zoneOffsetMinutes(UTC_ZONE, summer)).toBe(0);
  });

  it('offset notation', () => {
    expect(formatOffsetIso(-240)).toBe('-04:00');
    expect(formatOffsetIso(330)).toBe('+05:30');
    expect(formatOffsetIso(0)).toBe('+00:00');
    expect(formatOffsetLabel(-240)).toBe(`UTC${MINUS}4`);
    expect(formatOffsetLabel(345)).toBe('UTC+5:45');
    expect(formatOffsetLabel(-150)).toBe(`UTC${MINUS}2:30`);
    expect(formatOffsetLabel(0)).toBe('UTC+0');
  });

  it('uses English abbreviations where they exist, the offset where they do not', () => {
    expect(zonedTime(summer, NY).abbreviation).toBe('EDT');
    expect(zonedTime(winter, NY).abbreviation).toBe('EST');
    expect(zonedTime(summer, iana('Europe/London')).abbreviation).toBe('BST');
    expect(zonedTime(winter, iana('Europe/London')).abbreviation).toBe('GMT');
    expect(zonedTime(summer, iana('Europe/Paris')).abbreviation).toBe('CEST');
    expect(zonedTime(summer, iana('Australia/Sydney')).abbreviation).toBe('AEST');
    expect(zonedTime(summer, iana('Asia/Kolkata')).abbreviation).toBe('IST');
    expect(zonedTime(summer, iana('Asia/Tokyo')).abbreviation).toBe('');
    expect(zonedTime(summer, UTC_ZONE).abbreviation).toBe('UTC');
    expect(zonedTime(summer, nauticalZone(-75)).abbreviation).toBe('ZD +5');
  });

  it('formats the wall clock with the zone beside it', () => {
    expect(formatZoned(summer, NY)).toBe(`2026-07-01 08:00 EDT (UTC${MINUS}4)`);
    expect(formatZoned(summer, iana('Asia/Tokyo'))).toBe('2026-07-01 21:00 UTC+9');
    expect(formatZoned(summer, UTC_ZONE, { seconds: true })).toBe('2026-07-01 12:00:00 UTC');
    expect(formatZoned(summer, nauticalZone(-75), { date: false })).toBe(`07:00 ZD +5 (UTC${MINUS}5)`);
    const t = zonedTime(Date.UTC(2026, 11, 31, 23, 30, 5), iana('Pacific/Auckland'));
    expect([t.date, t.time, t.offsetIso]).toEqual(['2027-01-01', '12:30:05', '+13:00']);
  });

  it('the date line: the same instant is a different date in Kiritimati and in Honolulu', () => {
    const t = Date.UTC(2026, 5, 1, 12);
    expect(localDate(t, iana('Pacific/Kiritimati'))).toEqual({ year: 2026, month: 6, day: 2 });
    expect(localDate(t, iana('Pacific/Honolulu'))).toEqual({ year: 2026, month: 6, day: 1 });
  });
});

describe('local days as Julian-date windows', () => {
  const hoursOf = (zone: DisplayZone, date: string) => dayWindow(zone, date).hours;

  it('an ordinary day is 24 hours from local midnight', () => {
    const w = dayWindow(NY, '2026-09-24');
    expect(w.hours).toBe(24);
    expect(new Date(w.start_ms).toISOString()).toBe('2026-09-24T04:00:00.000Z');
    expect(w.jd_start).toBe(jdFromUnixMs(w.start_ms));
    expect(w.jd_end - w.jd_start).toBeCloseTo(1, 12);
    expect(dayWindow(UTC_ZONE, '2026-09-24').jd_start).toBe(2461307.5);
  });

  it('spring forward makes a 23-hour day, fall back a 25-hour day (New York, London)', () => {
    expect(hoursOf(NY, '2026-03-08')).toBe(23);
    expect(hoursOf(NY, '2026-03-09')).toBe(24);
    expect(hoursOf(NY, '2026-11-01')).toBe(25);
    expect(hoursOf(iana('Europe/London'), '2026-03-29')).toBe(23);
    expect(hoursOf(iana('Europe/London'), '2026-10-25')).toBe(25);
    // The southern hemisphere changes in the opposite season.
    expect(hoursOf(iana('Australia/Sydney'), '2026-04-05')).toBe(25);
    expect(hoursOf(iana('Australia/Sydney'), '2026-10-04')).toBe(23);
  });

  it('half-hour daylight saving (Lord Howe Island) gives 23.5- and 24.5-hour days', () => {
    expect(hoursOf(iana('Australia/Lord_Howe'), '2026-04-05')).toBe(24.5);
    expect(hoursOf(iana('Australia/Lord_Howe'), '2026-10-04')).toBe(23.5);
  });

  it('where midnight is skipped the day starts at the change (Chile)', () => {
    // 2026-09-06 00:00 does not exist in Santiago: the clocks go from 23:59:59 to 01:00.
    const w = dayWindow(iana('America/Santiago'), '2026-09-06');
    expect(new Date(w.start_ms).toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(zonedTime(w.start_ms, iana('America/Santiago')).time).toBe('01:00:00');
    expect(zonedTime(w.start_ms - 1000, iana('America/Santiago')).date).toBe('2026-09-05');
    expect(w.hours).toBe(23);
    // In April the clocks go back from 24:00 to 23:00, so 4 April is 25 hours long.
    expect(hoursOf(iana('America/Santiago'), '2026-04-04')).toBe(25);
  });

  it('consecutive days tile time without gaps or overlaps', () => {
    for (const zone of [NY, iana('America/Santiago'), iana('Australia/Lord_Howe'), iana('Asia/Kolkata'), nauticalZone(-75), UTC_ZONE]) {
      let day = { year: 2026, month: 1, day: 1 };
      let prev = dayWindow(zone, day);
      for (let i = 0; i < 366; i++) {
        day = addDays(day, 1);
        const w = dayWindow(zone, day);
        expect(w.start_ms).toBe(prev.end_ms);
        expect(localDate(w.start_ms, zone)).toEqual(day);
        prev = w;
      }
    }
  });

  it('the day containing an instant', () => {
    const t = Date.UTC(2026, 8, 24, 2, 0); // 22:00 on the 23rd in New York
    expect(dayWindowAt(t, NY).date).toEqual({ year: 2026, month: 9, day: 23 });
    expect(dayWindowAt(t, UTC_ZONE).date).toEqual({ year: 2026, month: 9, day: 24 });
  });

  it('nautical zone days are always 24 hours', () => {
    const w = dayWindow(nauticalZone(-75), '2026-03-08');
    expect(w.hours).toBe(24);
    expect(new Date(w.start_ms).toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });

  it('dates', () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addDays({ year: 2028, month: 3, day: 1 }, -1)).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseLocalDate('2026-02-29')).toBeNull();
    expect(parseLocalDate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
    expect(() => dayWindow(NY, '24/09/2026')).toThrow(/Not a date/);
    expect(startOfLocalDay(UTC_ZONE, { year: 2026, month: 1, day: 1 })).toBe(Date.UTC(2026, 0, 1));
  });
});

describe('zone ids and the list for a picker', () => {
  it('stores and restores a choice', () => {
    for (const z of [UTC_ZONE, nauticalZone(-75), nauticalZone(150), nauticalZone(0), NY]) expect(zoneFromKey(zoneKey(z))).toEqual(z);
    expect(zoneKey(nauticalZone(-75))).toBe('zd:+5');
    expect(zoneKey(nauticalZone(150))).toBe('zd:-10');
    expect(zoneFromKey('zd:13')).toBeNull();
    expect(zoneFromKey('Mars/Olympus_Mons')).toBeNull();
  });

  it('falls back to a same-clock zone when the browser does not know a zone', () => {
    expect(isSupportedZone('Atlantis/Poseidonis')).toBe(false);
    expect(resolveIntlZone('Atlantis/Poseidonis')).toBeNull();
    registerZoneAlternatives(new Map([['Atlantis/Poseidonis', ['Nowhere/Else', 'Europe/Lisbon']]]));
    expect(resolveIntlZone('Atlantis/Poseidonis')).toBe('Europe/Lisbon');
    expect(zoneOffsetMinutes(iana('Atlantis/Poseidonis'), Date.UTC(2026, 6, 1))).toBe(60);
    // The gazetteer registers its own table: America/Coyhaique (2025) has one.
    expect(g.zoneAlternatives.get('America/Coyhaique')).toContain('America/Punta_Arenas');
  });

  it('throws a readable error for a zone it cannot show at all', () => {
    expect(() => zonedTime(0, iana('Nowhere/Nothing'))).toThrow(/does not know the time zone Nowhere\/Nothing/);
  });

  it('lists every zone once, preferring current IANA names, UTC first', () => {
    const list = listTimeZones(g.zones);
    expect(list[0]).toBe('UTC');
    expect(list).toContain('Asia/Kolkata');
    expect(list).not.toContain('Asia/Calcutta');
    expect(list).toContain('America/New_York');
    expect(new Set(list).size).toBe(list.length);
    expect(list.length).toBeGreaterThan(300);
    // Without preferences it still works (browser names).
    expect(listTimeZones()).toContain('Europe/London');
  });
});

describe('guessing the zone for a position', () => {
  const guess = (lat: number, lon: number) => guessZone(lat, lon, g, regions);

  it.each([
    ['Philadelphia', 39.9526, -75.1652, 'America/New_York'],
    ['Chicago', 41.8781, -87.6298, 'America/Chicago'],
    ['Denver', 39.7392, -104.9903, 'America/Denver'],
    ['Phoenix (no daylight saving)', 33.4484, -112.074, 'America/Phoenix'],
    ['Los Angeles', 34.0522, -118.2437, 'America/Los_Angeles'],
    ['Anchorage', 61.2181, -149.9003, 'America/Anchorage'],
    ['Honolulu', 21.3069, -157.8583, 'Pacific/Honolulu'],
    ['London', 51.5074, -0.1278, 'Europe/London'],
    ['Paris', 48.8566, 2.3522, 'Europe/Paris'],
    ['Moscow', 55.7558, 37.6173, 'Europe/Moscow'],
    ['Yekaterinburg', 56.8389, 60.6057, 'Asia/Yekaterinburg'],
    ['Vladivostok', 43.1155, 131.8855, 'Asia/Vladivostok'],
    ['Mumbai', 19.076, 72.8777, 'Asia/Kolkata'],
    ['Kathmandu', 27.7172, 85.324, 'Asia/Kathmandu'],
    ['Tokyo', 35.6762, 139.6503, 'Asia/Tokyo'],
    ['Sydney', -33.8688, 151.2093, 'Australia/Sydney'],
    ['Perth', -31.9505, 115.8605, 'Australia/Perth'],
    ['Broken Hill (NSW on Adelaide time)', -31.9539, 141.4539, 'Australia/Broken_Hill'],
    ['Manaus', -3.119, -60.0217, 'America/Manaus'],
    ['Santiago', -33.4489, -70.6693, 'America/Santiago'],
    ['Cayenne (France overseas)', 4.9224, -52.3135, 'America/Cayenne'],
    ['Longyearbyen (Svalbard)', 78.2232, 15.6267, 'Arctic/Longyearbyen'],
    ['Gibraltar', 36.1408, -5.3536, 'Europe/Gibraltar'],
    ['Las Palmas (Canary Islands)', 28.1235, -15.4363, 'Atlantic/Canary'],
    ['Kiritimati (UTC+14 at 157 W)', 1.87, -157.4, 'Pacific/Kiritimati'],
    ['Chatham Islands (+12:45)', -43.95, -176.55, 'Pacific/Chatham'],
    ['Suva (Fiji)', -18.1416, 178.4419, 'Pacific/Fiji'],
    ['Taveuni, east of 180 (Fiji)', -16.8, -179.95, 'Pacific/Fiji'],
  ])('%s', (_label, lat, lon, zone) => {
    const r = guess(lat, lon);
    expect(r.zone).toEqual(iana(zone));
    expect(r.source).not.toBe('sea');
    expect(r.reason).toContain(zone);
  });

  it('says why: one zone for a country, for a state, or the nearest place', () => {
    const tokyo = guess(35.6762, 139.6503);
    expect(tokyo.source).toBe('country');
    expect(tokyo.reason).toBe('Asia/Tokyo, the time zone of Japan.');
    expect(tokyo.country?.name).toBe('Japan');
    const phila = guess(39.9526, -75.1652);
    expect(phila.source).toBe('region');
    expect(phila.reason).toBe('America/New_York, the time zone of Pennsylvania, United States.');
    const broken = guess(-31.9539, 141.4539);
    expect(broken.source).toBe('nearest');
    expect(broken.anchor?.label).toBe('Broken Hill');
  });

  it('uses the nautical zone at sea', () => {
    const r = guess(0, -30);
    expect(r.zone).toEqual({ kind: 'nautical', zd: 2 });
    expect(r.source).toBe('sea');
    expect(r.country).toBeNull();
    expect(r.anchor).toBeNull();
    expect(r.reason).toBe(`At sea: nautical zone ZD +2 (O), zone time = UTC ${MINUS} 2 h.`);
    expect(guess(38.9, -74.5).zone).toEqual({ kind: 'nautical', zd: 5 }); // 30 NM off New Jersey
    expect(guess(45, -40).zone).toEqual({ kind: 'nautical', zd: 3 });
  });

  it('keeps the local zone within 12 NM of the coast', () => {
    const r = guess(39.3, -74.3); // a few miles off Atlantic City
    expect(r.zone).toEqual(NY);
    expect(r.country?.iso).toBe('US');
  });

  it('Antarctica has no civil time: nautical zone by longitude', () => {
    expect(guess(-80, 0).zone).toEqual({ kind: 'nautical', zd: 0 });
    expect(guess(-80, 0).country?.name).toBe('Antarctica');
    expect(guess(-85, 100).zone).toEqual({ kind: 'nautical', zd: -7 });
    // ...except right at a station with a zone of its own.
    expect(guess(-77.85, 166.67).zone).toEqual(iana('Antarctica/McMurdo'));
  });

  it('across the date line at sea, ZD +12 west of 180 and -12 east of it', () => {
    expect(guess(0, -179.5).zone).toEqual({ kind: 'nautical', zd: 12 });
    expect(guess(0, 179.5).zone).toEqual({ kind: 'nautical', zd: -12 });
  });

  it('still guesses without the country polygons (places within 150 NM, else nautical)', () => {
    const r = guessZone(39.9526, -75.1652, g, null);
    expect(r.zone).toEqual(NY);
    expect(r.source).toBe('nearby');
    expect(guessZone(0, -30, g, null).source).toBe('sea');
  });

  it('can leave a place out (the hold-out test uses this)', () => {
    const idx = g.places.findIndex((p) => p.name === 'Philadelphia');
    const p = g.places[idx]!;
    const withIt = guessZone(p.lat_deg, p.lon_deg, g, regions);
    const without = guessZone(p.lat_deg, p.lon_deg, g, regions, { excludePlace: idx });
    expect(withIt.anchor?.place).toBe(idx);
    expect(withIt.anchorDistanceNm).toBe(0);
    expect(without.anchor?.place).not.toBe(idx);
    expect(without.zone).toEqual(NY);
  });

  it('is fast enough to call on every click', () => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) guess(-60 + (i * 0.6) % 120, -180 + ((i * 7.3) % 360));
    expect((performance.now() - t0) / 200).toBeLessThan(20);
  });
});
