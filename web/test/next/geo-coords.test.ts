/**
 * Coordinate parsing and formatting (web/src/next/geo/coords.ts). Longitude is east-positive
 * everywhere (CONVENTIONS section 2); west is negative.
 */
import { describe, expect, it } from 'vitest';
import {
  formatLatitude,
  formatLatLon,
  formatLongitude,
  normalizeLongitude,
  parseLatitude,
  parseLatLon,
  parseLongitude,
  type CoordStyle,
} from '../../src/next/geo/coords.js';

function ok(input: string) {
  const r = parseLatLon(input);
  if (!r.ok) throw new Error(`"${input}" did not parse: ${r.error}`);
  return r.value;
}

function err(input: string): string {
  const r = parseLatLon(input);
  if (r.ok) throw new Error(`"${input}" parsed as ${JSON.stringify(r.value)}, expected an error`);
  return r.error;
}

const PHILA = { lat_deg: 39.9526, lon_deg: -75.1652 };
const DM = { lat_deg: 39 + 56.4 / 60, lon_deg: -(75 + 10.2 / 60) };
const DMS = { lat_deg: 39 + 56 / 60 + 24 / 3600, lon_deg: -(75 + 10 / 60 + 12 / 3600) };

describe('parseLatLon: decimal degrees', () => {
  it.each([
    '39.9526, -75.1652',
    '39.9526 -75.1652',
    '39.9526,-75.1652',
    '  39.9526 ,  -75.1652  ',
    '+39.9526, -75.1652',
    '(39.9526, -75.1652)',
    '39.9526N 75.1652W',
    '39.9526 N, 75.1652 W',
    'N39.9526 W75.1652',
    'N 39.9526, W 75.1652',
    '39.9526° N, 75.1652° W',
    '39.9526°N 75.1652°W',
    '39.9526 north 75.1652 west',
    'lat 39.9526 lon -75.1652',
    'Latitude: 39.9526, Longitude: -75.1652',
    'lng=-75.1652 lat=39.9526',
    'geo:39.9526,-75.1652',
    'geo:39.9526,-75.1652;u=35',
    '39,9526; -75,1652',
    '39,9526 -75,1652',
    '39.9526 / -75.1652',
  ])('%s', (input) => {
    const p = ok(input);
    expect(p.lat_deg).toBeCloseTo(PHILA.lat_deg, 10);
    expect(p.lon_deg).toBeCloseTo(PHILA.lon_deg, 10);
  });

  it('takes the unicode minus sign and en dash as minus', () => {
    expect(ok('39.9526, −' + '75.1652').lon_deg).toBeCloseTo(-75.1652, 10);
    expect(ok('39.9526, –' + '75.1652').lon_deg).toBeCloseTo(-75.1652, 10);
  });

  it('keeps in-range values bit for bit', () => {
    expect(ok('39.9526, -75.1652')).toEqual({ lat_deg: 39.9526, lon_deg: -75.1652 });
  });

  it('puts longitude where the letters or labels say, whatever the order', () => {
    expect(ok('75.1652 W 39.9526 N')).toEqual(ok('39.9526 N 75.1652 W'));
    expect(ok('lon -75.1652, lat 39.9526')).toEqual(PHILA);
    expect(ok('W75.1652, 39.9526')).toEqual(PHILA);
  });

  it('southern and eastern hemispheres', () => {
    const syd = ok('33.8568 S, 151.2153 E');
    expect(syd.lat_deg).toBeCloseTo(-33.8568, 10);
    expect(syd.lon_deg).toBeCloseTo(151.2153, 10);
    expect(ok('-33.8568, 151.2153')).toEqual(syd);
  });

  it('normalises 180 W to +180 and never returns -0', () => {
    expect(ok('0, 180 W')).toEqual({ lat_deg: 0, lon_deg: 180 });
    expect(ok('0, -180')).toEqual({ lat_deg: 0, lon_deg: 180 });
    const z = ok('-0, -0');
    expect(Object.is(z.lat_deg, -0)).toBe(false);
    expect(Object.is(z.lon_deg, -0)).toBe(false);
    expect(ok('90 N, 0')).toEqual({ lat_deg: 90, lon_deg: 0 });
  });
});

describe('parseLatLon: degrees and minutes, degrees minutes seconds', () => {
  it.each([
    '39°56.4′N 75°10.2′W',
    "39°56.4'N 75°10.2'W",
    '39° 56.4′ N, 075° 10.2′ W',
    '39 56.4 N, 75 10.2 W',
    '39 56.4N 075 10.2W',
    'N 39 56.4, W 75 10.2',
    'N39°56.4 W75°10.2',
    '39 56.4 -75 10.2',
    '39º56,4′N 75º10,2′W',
    '39˚56.4’N 75˚10.2’W',
    '39d 56.4m N, 75d 10.2m W',
    '39 deg 56.4 min N 75 deg 10.2 min W',
  ])('%s', (input) => {
    const p = ok(input);
    expect(p.lat_deg).toBeCloseTo(DM.lat_deg, 10);
    expect(p.lon_deg).toBeCloseTo(DM.lon_deg, 10);
  });

  it.each([
    '39°56′24″N 75°10′12″W',
    `39°56'24"N 75°10'12"W`,
    "39°56'24''N 75°10'12''W",
    '39 56 24 N 75 10 12 W',
    '39d56m24s N 75d10m12s W',
    '39d56m24sN 75d10m12sW',
    '39 56 24, -75 10 12',
    '39°56′24.0″ N, 075°10′12.0″ W',
  ])('%s', (input) => {
    const p = ok(input);
    expect(p.lat_deg).toBeCloseTo(DMS.lat_deg, 10);
    expect(p.lon_deg).toBeCloseTo(DMS.lon_deg, 10);
  });

  it('splits bare whole numbers evenly', () => {
    const p = ok('39 56 75 10');
    expect(p.lat_deg).toBeCloseTo(39 + 56 / 60, 10);
    expect(p.lon_deg).toBeCloseTo(75 + 10 / 60, 10);
    const s = ok('-33 52 151 12');
    expect(s.lat_deg).toBeCloseTo(-(33 + 52 / 60), 10);
    expect(s.lon_deg).toBeCloseTo(151.2, 10);
  });

  it('a lowercase s after minutes is seconds, otherwise south', () => {
    expect(ok('33.86s 151.21e').lat_deg).toBeCloseTo(-33.86, 10);
    expect(ok('33d51m36s S, 151d12m36s E').lat_deg).toBeCloseTo(-(33 + 51 / 60 + 36 / 3600), 10);
  });
});

describe('parseLatLon: helpful errors', () => {
  it('empty input', () => {
    expect(err('')).toMatch(/Enter a position/);
    expect(err('   ')).toMatch(/Enter a position/);
  });

  it('names the text it does not understand', () => {
    expect(err('Philadelphia')).toMatch(/"Philadelphia" is not part of a position/);
    expect(err('39.95, -75.17 x')).toMatch(/"x"/);
  });

  it('latitude beyond the pole', () => {
    expect(err('95, 10')).toMatch(/Latitude 95° is beyond the pole/);
    expect(err('91 N, 10 E')).toMatch(/beyond the pole/);
  });

  it('suggests a swap when longitude came first', () => {
    expect(err('-175.17, 39.95')).toMatch(/did you swap them\?/);
  });

  it('longitude out of range', () => {
    expect(err('39.95, 190')).toMatch(/Longitude 190° is out of range/);
  });

  it('minutes and seconds must be below 60', () => {
    expect(err('39 61 N 75 10 W')).toMatch(/Minutes must be less than 60 \(got 61\)/);
    expect(err('39 56 61 N 75 10 12 W')).toMatch(/Seconds must be less than 60/);
  });

  it('fractional degrees or minutes cannot be followed by smaller units', () => {
    expect(err('39.5°30′N 75°W')).toMatch(/Degrees must be a whole number/);
    expect(err('39°56.4′24″N 75°W')).toMatch(/Minutes must be a whole number/);
  });

  it('a minus sign and a hemisphere letter together', () => {
    expect(err('-39.95 S, 75 W')).toMatch(/either a minus sign or S/);
    expect(err('-39.95 N, 75 W')).toMatch(/contradict/);
  });

  it('two latitudes or two longitudes', () => {
    expect(err('39.95 N, 40 S')).toMatch(/Both coordinates are latitudes/);
    expect(err('75 W 20 E')).toMatch(/Both coordinates are longitudes/);
  });

  it('one or too many coordinates', () => {
    expect(err('39.95')).toMatch(/Only one coordinate/);
    expect(err('39.95 N')).toMatch(/Only one coordinate/);
    expect(err('1, 2, 3')).toMatch(/Too many numbers/);
  });

  it('a label that contradicts a letter', () => {
    expect(err('lat 39.95 W, lon 75 N')).toMatch(/does not go with/);
  });
});

describe('parseLatitude and parseLongitude', () => {
  it('parse single angles', () => {
    expect(parseLatitude('39° 57.2′ N')).toEqual({ ok: true, value: 39 + 57.2 / 60 });
    expect(parseLatitude('S 33 51.5')).toEqual({ ok: true, value: -(33 + 51.5 / 60) });
    expect(parseLatitude('-12.5')).toEqual({ ok: true, value: -12.5 });
    expect(parseLongitude('075° 09.9′ W')).toEqual({ ok: true, value: -(75 + 9.9 / 60) });
    expect(parseLongitude('E 151 12.6')).toEqual({ ok: true, value: 151 + 12.6 / 60 });
    expect(parseLongitude('-180')).toEqual({ ok: true, value: 180 });
  });

  it('reject the wrong letters and out-of-range values', () => {
    expect(parseLatitude('75 W')).toMatchObject({ ok: false, error: expect.stringMatching(/Latitude takes N or S/) });
    expect(parseLongitude('39 N')).toMatchObject({ ok: false, error: expect.stringMatching(/Longitude takes E or W/) });
    expect(parseLatitude('91')).toMatchObject({ ok: false });
    expect(parseLongitude('180.5')).toMatchObject({ ok: false });
    expect(parseLatitude('39, 75')).toMatchObject({ ok: false, error: 'Enter one latitude.' });
  });
});

describe('formatting', () => {
  it('navigator style is the default: degrees and decimal minutes, padded', () => {
    expect(formatLatLon(PHILA)).toBe('39° 57.2′ N, 075° 09.9′ W');
    expect(formatLatLon({ lat_deg: -33.8568, lon_deg: 151.2153 })).toBe('33° 51.4′ S, 151° 12.9′ E');
    expect(formatLatitude(5.5, 'nav', { digits: 2 })).toBe('05° 30.00′ N');
  });

  it('decimal, DMS and signed styles', () => {
    expect(formatLatLon(PHILA, 'decimal')).toBe('39.9526° N, 75.1652° W');
    expect(formatLatLon(PHILA, 'dms')).toBe('39° 57′ 09″ N, 075° 09′ 55″ W');
    expect(formatLatLon(PHILA, 'signed')).toBe('39.9526, -75.1652');
    expect(formatLatLon(PHILA, 'dms', { digits: 1 })).toBe('39° 57′ 09.4″ N, 075° 09′ 54.7″ W');
    expect(formatLatLon(PHILA, 'signed', { digits: 6 })).toBe('39.952600, -75.165200');
  });

  it('carries 59.96′ up to the next degree', () => {
    expect(formatLatitude(10.99999)).toBe('11° 00.0′ N');
    expect(formatLatitude(10.999999, 'dms')).toBe('11° 00′ 00″ N');
    expect(formatLongitude(-179.99999)).toBe('180° 00.0′ W');
  });

  it('a value that rounds to zero is N or E, never S or W', () => {
    expect(formatLatitude(-0.00001)).toBe('00° 00.0′ N');
    expect(formatLongitude(-0.00001, 'decimal')).toBe('0.0000° E');
    expect(formatLongitude(-0.00001, 'signed')).toBe('0.0000');
    expect(formatLatitude(-0.00001, 'dms')).toBe('00° 00′ 00″ N');
  });

  it('180 is east; -180 is shown as 180 E', () => {
    expect(formatLongitude(180)).toBe('180° 00.0′ E');
    expect(formatLongitude(-180)).toBe('180° 00.0′ E');
    expect(normalizeLongitude(-180)).toBe(180);
    expect(normalizeLongitude(540)).toBe(180);
    expect(normalizeLongitude(-190)).toBe(170);
    expect(normalizeLongitude(359)).toBe(-1);
  });

  it('non-finite input is echoed, not dressed up', () => {
    expect(formatLatitude(Number.NaN)).toBe('NaN');
  });
});

describe('round trips: parse(format(x)) = x within the printed precision', () => {
  // A deterministic spread of positions, including the poles, the equator and the antimeridian.
  const points: { lat_deg: number; lon_deg: number }[] = [
    { lat_deg: 90, lon_deg: 0 },
    { lat_deg: -90, lon_deg: 180 },
    { lat_deg: 0, lon_deg: -179.99 },
    { lat_deg: 0.0001, lon_deg: 0.0001 },
  ];
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 400; i++) points.push({ lat_deg: rand() * 180 - 90, lon_deg: rand() * 360 - 180 });

  const tolerance: Record<CoordStyle, number> = {
    nav: 0.05 / 60 + 1e-12,
    decimal: 0.00005 + 1e-12,
    dms: 0.5 / 3600 + 1e-12,
    signed: 0.00005 + 1e-12,
  };

  for (const style of ['nav', 'decimal', 'dms', 'signed'] as const) {
    it(style, () => {
      for (const p of points) {
        const text = formatLatLon(p, style);
        const back = ok(text);
        expect(Math.abs(back.lat_deg - p.lat_deg), text).toBeLessThanOrEqual(tolerance[style]);
        let dLon = Math.abs(back.lon_deg - p.lon_deg);
        if (dLon > 180) dLon = 360 - dLon;
        expect(dLon, text).toBeLessThanOrEqual(tolerance[style]);
      }
    });
  }
});
