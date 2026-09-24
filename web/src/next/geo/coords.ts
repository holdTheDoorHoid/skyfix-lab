/**
 * Reading and writing latitude and longitude. OWNER: map-data agent.
 *
 * Longitude is east-positive everywhere inside the program (CONVENTIONS section 2): what the
 * user writes as "75° 10.2′ W" is `lon_deg = -75.17`. Latitude is north-positive. Longitude
 * is normalised to (-180, 180], so 180° W is returned as +180.
 *
 * Accepted input, in any combination that is unambiguous:
 *   39.9526, -75.1652            decimal degrees, signed ("lat, lon")
 *   39.9526 N 75.1652 W          hemisphere letters after or before (N39.95 W75.17)
 *   39°56.4′N 75°10.2′W          degrees and decimal minutes (the navigator's form)
 *   39 56.4 N, 75 10.2 W         the same without symbols
 *   39°56′24″N 75°10′12″W        degrees, minutes, seconds; ASCII ' and " work too
 *   39d56m24s N                  letters for the units
 *   lon -75.17 lat 39.95         labels (lat, latitude, lon, long, lng, longitude)
 *   39,9526; -75,1652            decimal commas, when something else separates the pair
 *   geo:39.9526,-75.1652         RFC 5870 geo URIs
 *
 * Output styles:
 *   nav      39° 57.2′ N, 075° 09.9′ W   degrees and decimal minutes (the default)
 *   decimal  39.9526° N, 75.1652° W
 *   dms      39° 57′ 09″ N, 075° 09′ 55″ W
 *   signed   39.9526, -75.1652            (for copying into other software)
 */

import type { LatLonDeg } from '../engine/types.js';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type CoordStyle = 'nav' | 'decimal' | 'dms' | 'signed';

export interface FormatOptions {
  /**
   * Decimals of the last field: minutes for `nav` (default 1), degrees for `decimal` and
   * `signed` (default 4, about 11 m), seconds for `dms` (default 0).
   */
  digits?: number;
}

const DEG = '°';
const PRIME = '′';
const DOUBLE_PRIME = '″';

// ---------------------------------------------------------------------------------------
// Parsing

type Kind = 'lat' | 'lon';

type Token =
  | { t: 'num'; v: number; frac: boolean }
  | { t: 'unit'; u: 'd' | 'm' | 's' }
  | { t: 'hemi'; h: 'N' | 'S' | 'E' | 'W' }
  | { t: 'sign'; s: 1 | -1 }
  | { t: 'sep' }
  | { t: 'label'; k: Kind };

interface Group {
  sign: 1 | -1 | 0;
  hemi: 'N' | 'S' | 'E' | 'W' | null;
  label: Kind | null;
  deg: number | null;
  min: number | null;
  sec: number | null;
  /** Numbers in order, with the unit they were given (null = none). */
  parts: { v: number; frac: boolean; unit: 'd' | 'm' | 's' | null }[];
}

const newGroup = (): Group => ({ sign: 0, hemi: null, label: null, deg: null, min: null, sec: null, parts: [] });

/** A character class from code points (keeps invisible and look-alike characters readable). */
const anyOf = (...codes: number[]) => new RegExp(`[${String.fromCharCode(...codes)}]`, 'g');

// Degree look-alikes: degree sign, masculine ordinal, ring above, modifier small o,
// superscript zero, ring operator.
const DEGREE_LIKE = anyOf(0x00b0, 0x00ba, 0x02da, 0x1d52, 0x2070, 0x2218);
// Seconds: double prime, curly double quotes, modifier double prime, ditto mark, reversed double prime.
const SECONDS_LIKE = anyOf(0x2033, 0x201c, 0x201d, 0x02ba, 0x3003, 0x2036);
// Two primes, or two apostrophes, also mean seconds.
const TWO_PRIMES = new RegExp(`''|${String.fromCharCode(0x2032, 0x2032)}|${String.fromCharCode(0x2019, 0x2019)}`, 'g');
// Minutes: prime, curly single quotes, grave and acute accents, modifier primes, reversed prime.
const MINUTES_LIKE = anyOf(0x2032, 0x2018, 0x2019, 0x0060, 0x00b4, 0x02b9, 0x02bc, 0x2035);
// Minus look-alikes: minus sign, figure dash, en dash, em dash, small and fullwidth hyphen-minus.
const MINUS_LIKE = anyOf(0x2212, 0x2012, 0x2013, 0x2014, 0xfe63, 0xff0d);
// Plus look-alikes: fullwidth plus, superscript plus.
const PLUS_LIKE = anyOf(0xff0b, 0x207a);
// No-break, thin and narrow no-break spaces.
const SPACE_LIKE = anyOf(0x00a0, 0x2009, 0x202f);

/** Unicode look-alikes -> the few symbols the tokenizer understands. */
function normaliseSymbols(input: string): string {
  return input
    .replace(DEGREE_LIKE, DEG)
    .replace(SECONDS_LIKE, '"')
    .replace(TWO_PRIMES, '"')
    .replace(MINUTES_LIKE, "'")
    .replace(MINUS_LIKE, '-')
    .replace(PLUS_LIKE, '+')
    .replace(SPACE_LIKE, ' ');
}

function tokenize(raw: string): ParseResult<Token[]> {
  let s = normaliseSymbols(raw).trim();
  s = s.replace(/^geo:/i, '').replace(/;(crs|u)=.*$/i, '');
  s = s.replace(/^\(|\)$/g, '').trim();
  if (!s) return { ok: false, error: 'Enter a position, for example 39° 57.2′ N, 075° 09.9′ W.' };

  // Decimal commas: a comma directly between two digits is a decimal comma when something
  // else separates the pair (a semicolon, slash, comma-and-space, whitespace or letters).
  if (/\d,\d/.test(s) && /[;/\sNSEWnsew]|,\s/.test(s)) s = s.replace(/(\d),(\d)/g, '$1.$2');

  const tokens: Token[] = [];
  // Unit letters (d, m, s and the words) may run straight into a hemisphere letter
  // ("24sN"); a lone letter is otherwise never part of a longer word.
  const re =
    /\s*(?:(\d+(?:\.\d*)?|\.\d+)|(°)|(')|(")|(latitude|lat|longitude|long|lng|lon)\s*[:=]?|(north|south|east|west|[NSEWnsew])(?![a-z])|(deg(?:rees?|s)?|d)(?=$|[^a-z]|[nsew](?![a-z]))|(min(?:utes?|s)?|m)(?=$|[^a-z]|[nsew](?![a-z]))|(sec(?:onds?|s)?|s)(?=$|[^a-z]|[nsew](?![a-z]))|([+-])|([,;/]))/iy;
  let pos = 0;
  let sawDegUnit = false;
  let sawMinUnit = false;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m || m[0].length === 0) {
      const rest = s.slice(pos).trim();
      if (!rest) break;
      const bad = rest.split(/\s+/)[0] ?? rest;
      return { ok: false, error: `"${bad}" is not part of a position. Use numbers, °, ′, ″, and N, S, E or W.` };
    }
    pos = re.lastIndex;
    const [, num, deg, min, sec, label, hemi, dWord, mWord, sWord, sign, sep] = m;
    if (num !== undefined) {
      tokens.push({ t: 'num', v: Number(num), frac: num.includes('.') });
    } else if (deg) {
      tokens.push({ t: 'unit', u: 'd' });
      sawDegUnit = true;
    } else if (min) {
      tokens.push({ t: 'unit', u: 'm' });
      sawMinUnit = true;
    } else if (sec) {
      tokens.push({ t: 'unit', u: 's' });
    } else if (label) {
      tokens.push({ t: 'label', k: /^lat/i.test(label) ? 'lat' : 'lon' });
    } else if (hemi) {
      // A lowercase "s" right after minutes is seconds ("24s"), not south.
      if (hemi === 's' && sawMinUnit && tokens[tokens.length - 1]?.t === 'num') {
        tokens.push({ t: 'unit', u: 's' });
      } else {
        const h = hemi[0]?.toUpperCase() as 'N' | 'S' | 'E' | 'W';
        tokens.push({ t: 'hemi', h });
      }
    } else if (dWord) {
      tokens.push({ t: 'unit', u: 'd' });
      sawDegUnit = true;
    } else if (mWord) {
      if (mWord.toLowerCase() === 'm' && !sawDegUnit) {
        return { ok: false, error: '"m" for minutes needs degrees first, as in 39d 56m N.' };
      }
      tokens.push({ t: 'unit', u: 'm' });
      sawMinUnit = true;
    } else if (sWord) {
      tokens.push({ t: 'unit', u: 's' });
    } else if (sign) {
      tokens.push({ t: 'sign', s: sign === '-' ? -1 : 1 });
    } else if (sep) {
      tokens.push({ t: 'sep' });
    }
  }
  return { ok: true, value: tokens };
}

function slotFree(g: Group, unit: 'd' | 'm' | 's'): boolean {
  return (unit === 'd' ? g.deg : unit === 'm' ? g.min : g.sec) === null;
}

function place(g: Group, v: number, frac: boolean, unit: 'd' | 'm' | 's' | null): 'd' | 'm' | 's' | null {
  const slot = unit ?? (g.deg === null ? 'd' : g.min === null ? 'm' : g.sec === null ? 's' : null);
  if (slot === null) return null;
  if (slot === 'd') g.deg = v;
  else if (slot === 'm') g.min = v;
  else g.sec = v;
  g.parts.push({ v, frac, unit });
  return slot;
}

function groupTokens(tokens: Token[]): ParseResult<Group[]> {
  const nums = tokens.filter((t) => t.t === 'num');
  // Bare numbers only ("39 56.4 75 10.2" is handled below; "39 56 75 10" needs this):
  // split evenly into two groups of 1, 2 or 3.
  const bare = tokens.every((t) => t.t === 'num' || t.t === 'sign');
  if (bare && [2, 4, 6].includes(nums.length) && nums.every((n) => !n.frac || n === nums[nums.length / 2 - 1] || n === nums[nums.length - 1])) {
    const half = nums.length / 2;
    const groups: Group[] = [newGroup(), newGroup()];
    let seen = 0;
    let pendingSign: 1 | -1 | 0 = 0;
    for (const t of tokens) {
      if (t.t === 'sign') {
        pendingSign = t.s;
        continue;
      }
      if (t.t !== 'num') continue;
      const g = groups[seen < half ? 0 : 1] as Group;
      if (g.parts.length === 0) {
        g.sign = pendingSign;
      } else if (pendingSign !== 0) {
        return { ok: false, error: 'A sign belongs in front of the degrees, not the minutes or seconds.' };
      }
      pendingSign = 0;
      place(g, t.v, t.frac, null);
      seen++;
    }
    return { ok: true, value: groups };
  }

  const firstHemi = tokens.findIndex((t) => t.t === 'hemi');
  const firstNum = tokens.findIndex((t) => t.t === 'num');
  const prefixStyle = firstHemi >= 0 && firstHemi < firstNum;

  const groups: Group[] = [];
  let g = newGroup();
  const hasContent = (x: Group) => x.parts.length > 0 || x.hemi !== null || x.label !== null || x.sign !== 0;
  const close = () => {
    if (hasContent(g)) groups.push(g);
    g = newGroup();
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    switch (t.t) {
      case 'sep':
        close();
        break;
      case 'label':
        if (g.parts.length || g.label) close();
        g.label = t.k;
        break;
      case 'sign':
        if (g.parts.length) close();
        if (g.sign !== 0) return { ok: false, error: 'Two signs in a row.' };
        g.sign = t.s;
        break;
      case 'hemi':
        if (prefixStyle) {
          if (g.parts.length || g.hemi) close();
          g.hemi = t.h;
        } else {
          if (!g.parts.length) return { ok: false, error: `"${t.h}" must follow its number (39.95 N) or lead every coordinate (N 39.95).` };
          if (g.hemi) return { ok: false, error: `Two hemisphere letters for one coordinate.` };
          g.hemi = t.h;
          close();
        }
        break;
      case 'unit':
        return { ok: false, error: 'A unit symbol (°, ′ or ″) must follow a number.' };
      case 'num': {
        const next = tokens[i + 1];
        const unit = next?.t === 'unit' ? next.u : null;
        if (unit) i++;
        const last = g.parts[g.parts.length - 1];
        // A number starts a new coordinate when its slot is taken, when the previous number
        // had a decimal fraction (39.95 75.17), or after three numbers.
        const full =
          (unit !== null && !slotFree(g, unit)) ||
          (unit === null && last !== undefined && (last.frac || g.parts.length >= 3)) ||
          (unit === 'd' && g.parts.length > 0);
        if (full) close();
        if (place(g, t.v, t.frac, unit) === null) return { ok: false, error: 'Too many numbers for one coordinate.' };
        break;
      }
    }
  }
  close();
  return { ok: true, value: groups };
}

interface Angle {
  value: number;
  kind: Kind | null;
}

function evaluate(g: Group): ParseResult<Angle> {
  if (g.deg === null) return { ok: false, error: 'A coordinate has no degrees.' };
  const { deg, min, sec } = g;
  const degFrac = !Number.isInteger(deg);
  if (min !== null && degFrac) return { ok: false, error: 'Degrees must be a whole number when minutes follow them.' };
  if (sec !== null && min === null) return { ok: false, error: 'Seconds need minutes in front of them.' };
  if (sec !== null && min !== null && !Number.isInteger(min))
    return { ok: false, error: 'Minutes must be a whole number when seconds follow them.' };
  if (min !== null && min >= 60) return { ok: false, error: `Minutes must be less than 60 (got ${min}).` };
  if (sec !== null && sec >= 60) return { ok: false, error: `Seconds must be less than 60 (got ${sec}).` };
  let value = deg + (min ?? 0) / 60 + (sec ?? 0) / 3600;
  const hemiSign = g.hemi === 'S' || g.hemi === 'W' ? -1 : g.hemi ? 1 : 0;
  if (g.sign === -1 && hemiSign !== 0) {
    return {
      ok: false,
      error:
        hemiSign === -1
          ? `Use either a minus sign or ${g.hemi}, not both.`
          : `A minus sign and ${g.hemi} contradict each other.`,
    };
  }
  if (g.sign === -1 || hemiSign === -1) value = -value;
  const kind: Kind | null = g.hemi === 'N' || g.hemi === 'S' ? 'lat' : g.hemi === 'E' || g.hemi === 'W' ? 'lon' : null;
  if (kind && g.label && kind !== g.label) {
    return { ok: false, error: `"${g.label === 'lat' ? 'lat' : 'lon'}" does not go with ${g.hemi}.` };
  }
  return { ok: true, value: { value, kind: kind ?? g.label } };
}

const fmtDeg = (v: number) => `${Number(v.toFixed(6))}°`;

function checkLatitude(v: number): string | null {
  if (!Number.isFinite(v)) return 'Latitude is not a number.';
  if (Math.abs(v) > 90) return `Latitude ${fmtDeg(v)} is beyond the pole: it must be between 90° S and 90° N.`;
  return null;
}

function checkLongitude(v: number): string | null {
  if (!Number.isFinite(v)) return 'Longitude is not a number.';
  if (Math.abs(v) > 180) return `Longitude ${fmtDeg(v)} is out of range: it must be between 180° W and 180° E.`;
  return null;
}

/** (-180, 180], and never -0. Values already in range come back unchanged (bit for bit). */
export function normalizeLongitude(lonDeg: number): number {
  if (lonDeg > -180 && lonDeg <= 180) return lonDeg === 0 ? 0 : lonDeg;
  let x = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  if (x === -180) x = 180;
  return x === 0 ? 0 : x;
}

/** Parse a latitude-and-longitude pair. Latitude comes first unless letters or labels say otherwise. */
export function parseLatLon(input: string): ParseResult<LatLonDeg> {
  const tok = tokenize(input);
  if (!tok.ok) return tok;
  const grouped = groupTokens(tok.value);
  if (!grouped.ok) return grouped;
  const groups = grouped.value;
  if (groups.length < 2) {
    return { ok: false, error: 'Only one coordinate found. Enter latitude and longitude, for example 39.95, -75.17.' };
  }
  if (groups.length > 2) {
    return { ok: false, error: 'Too many numbers. Enter latitude, then longitude, for example 39° 57.2′ N, 075° 09.9′ W.' };
  }
  const a = evaluate(groups[0] as Group);
  if (!a.ok) return a;
  const b = evaluate(groups[1] as Group);
  if (!b.ok) return b;
  let lat: Angle;
  let lon: Angle;
  const [ka, kb] = [a.value.kind, b.value.kind];
  if (ka && kb && ka === kb) {
    return { ok: false, error: ka === 'lat' ? 'Both coordinates are latitudes (N or S). One must be E or W.' : 'Both coordinates are longitudes (E or W). One must be N or S.' };
  }
  if (ka === 'lon' || kb === 'lat') {
    lat = b.value;
    lon = a.value;
  } else {
    lat = a.value;
    lon = b.value;
  }
  const latErr = checkLatitude(lat.value);
  if (latErr) {
    const swapHint =
      !ka && !kb && Math.abs(lat.value) <= 180 && Math.abs(lon.value) <= 90
        ? ' Latitude comes first, then longitude; did you swap them?'
        : '';
    return { ok: false, error: latErr + swapHint };
  }
  const lonErr = checkLongitude(lon.value);
  if (lonErr) return { ok: false, error: lonErr };
  return { ok: true, value: { lat_deg: lat.value === 0 ? 0 : lat.value, lon_deg: normalizeLongitude(lon.value) } };
}

function parseOne(input: string, kind: Kind): ParseResult<number> {
  const tok = tokenize(input);
  if (!tok.ok) return tok;
  const grouped = groupTokens(tok.value);
  if (!grouped.ok) return grouped;
  if (grouped.value.length !== 1) {
    return { ok: false, error: `Enter one ${kind === 'lat' ? 'latitude' : 'longitude'}.` };
  }
  const a = evaluate(grouped.value[0] as Group);
  if (!a.ok) return a;
  if (a.value.kind && a.value.kind !== kind) {
    return { ok: false, error: kind === 'lat' ? 'Latitude takes N or S, not E or W.' : 'Longitude takes E or W, not N or S.' };
  }
  const err = kind === 'lat' ? checkLatitude(a.value.value) : checkLongitude(a.value.value);
  if (err) return { ok: false, error: err };
  const v = kind === 'lon' ? normalizeLongitude(a.value.value) : a.value.value;
  return { ok: true, value: v === 0 ? 0 : v };
}

/** Parse one latitude: "39° 57.2′ N", "-33.86", "S 33 51.5". */
export function parseLatitude(input: string): ParseResult<number> {
  return parseOne(input, 'lat');
}

/** Parse one longitude: "075° 09.9′ W", "151.21", "E 151 12.6". East-positive result. */
export function parseLongitude(input: string): ParseResult<number> {
  return parseOne(input, 'lon');
}

// ---------------------------------------------------------------------------------------
// Formatting

function splitMinutes(abs: number, digits: number): { d: number; m: number } {
  const f = 10 ** digits;
  let d = Math.floor(abs);
  let m = Math.round((abs - d) * 60 * f) / f;
  if (m >= 60) {
    m -= 60;
    d += 1;
  }
  return { d, m };
}

function splitSeconds(abs: number, digits: number): { d: number; m: number; s: number } {
  const f = 10 ** digits;
  let d = Math.floor(abs);
  const rest = (abs - d) * 60;
  let m = Math.floor(rest);
  let s = Math.round((rest - m) * 60 * f) / f;
  if (s >= 60) {
    s -= 60;
    m += 1;
  }
  if (m >= 60) {
    m -= 60;
    d += 1;
  }
  return { d, m, s };
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const padFixed = (n: number, digits: number, intWidth: number) => {
  const t = n.toFixed(digits);
  const [i, f] = t.split('.');
  return f === undefined ? (i ?? '').padStart(intWidth, '0') : `${(i ?? '').padStart(intWidth, '0')}.${f}`;
};

function formatAngle(value: number, kind: Kind, style: CoordStyle, opts: FormatOptions): string {
  if (!Number.isFinite(value)) return String(value);
  const v = kind === 'lon' ? normalizeLongitude(value) : value;
  const degWidth = kind === 'lat' ? 2 : 3;
  const letters = kind === 'lat' ? (['N', 'S'] as const) : (['E', 'W'] as const);
  switch (style) {
    case 'signed': {
      const digits = opts.digits ?? 4;
      const t = v.toFixed(digits);
      return Number(t) === 0 ? (0).toFixed(digits) : t;
    }
    case 'decimal': {
      const digits = opts.digits ?? 4;
      const t = Math.abs(v).toFixed(digits);
      const hemi = v < 0 && Number(t) !== 0 ? letters[1] : letters[0];
      return `${t}${DEG} ${hemi}`;
    }
    case 'nav': {
      const digits = opts.digits ?? 1;
      const { d, m } = splitMinutes(Math.abs(v), digits);
      const hemi = v < 0 && (d !== 0 || m !== 0) ? letters[1] : letters[0];
      return `${pad(d, degWidth)}${DEG} ${padFixed(m, digits, 2)}${PRIME} ${hemi}`;
    }
    case 'dms': {
      const digits = opts.digits ?? 0;
      const { d, m, s } = splitSeconds(Math.abs(v), digits);
      const hemi = v < 0 && (d !== 0 || m !== 0 || s !== 0) ? letters[1] : letters[0];
      return `${pad(d, degWidth)}${DEG} ${pad(m, 2)}${PRIME} ${padFixed(s, digits, 2)}${DOUBLE_PRIME} ${hemi}`;
    }
  }
}

/** One latitude, e.g. `39° 57.2′ N` (nav), `39.9526° N`, `39° 57′ 09″ N`, `39.9526`. */
export function formatLatitude(latDeg: number, style: CoordStyle = 'nav', opts: FormatOptions = {}): string {
  return formatAngle(latDeg, 'lat', style, opts);
}

/** One longitude (east-positive in), e.g. `075° 09.9′ W` (nav), `75.1652° W`, `-75.1652`. */
export function formatLongitude(lonDeg: number, style: CoordStyle = 'nav', opts: FormatOptions = {}): string {
  return formatAngle(lonDeg, 'lon', style, opts);
}

/** A position, latitude first: `39° 57.2′ N, 075° 09.9′ W`. */
export function formatLatLon(p: LatLonDeg, style: CoordStyle = 'nav', opts: FormatOptions = {}): string {
  return `${formatLatitude(p.lat_deg, style, opts)}, ${formatLongitude(p.lon_deg, style, opts)}`;
}
