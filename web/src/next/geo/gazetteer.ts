/**
 * The offline gazetteer: find a place by name, and name a position ("near Philadelphia,
 * Pennsylvania, United States"). OWNER: map-data agent.
 *
 * Data: `data/gazetteer.json`, built by tools/mapdata/build.mjs from Natural Earth's 7 342
 * populated places (public domain) and the IANA zone.tab (public domain). Display-only
 * (CONVENTIONS 13.6). Coordinates are degrees, longitude east-positive (section 2).
 */

import type { LatLonDeg } from '../engine/types.js';
import { parseLatLon } from './coords.js';
import { dataUrl, fetchJson, type FetchLike } from './data.js';
import { greatCircleDistanceNm, initialCourseDeg } from './greatcircle.js';
import { boundedEditDistance, expandAbbreviations, foldName, squash } from './text.js';
import { registerZoneAlternatives } from './timezone.js';

export const GAZETTEER_FORMAT = 'skyfix.gazetteer/1';
export const GAZETTEER_FILE = 'gazetteer.json';

/** Bits of `Place.flags`. */
export const PLACE_FLAGS = {
  /** National capital. */
  capital: 1,
  /** Capital of a state, province or region. */
  admin1Capital: 2,
  /** Natural Earth's time zone for this place was wrong and was replaced at build time. */
  zoneCorrected: 4,
  /** A research station (Antarctica and similar). */
  station: 8,
} as const;

export interface Country {
  readonly index: number;
  /** Everyday English name ("United States", "Czech Republic"). */
  readonly name: string;
  /** ISO 3166-1 alpha-2, or "" when there is none (Somaliland, Northern Cyprus). */
  readonly iso: string;
  /** Natural Earth ADM0_A3. */
  readonly a3: string;
  /**
   * Index of the country whose polygon in `basemap/countries-50m.geojson` stands for this
   * one in point lookups: itself, or the surrounding country for a territory too small for
   * the 50 m polygons (Vatican City -> Italy, Gibraltar -> Spain), or -1 when there is none.
   */
  readonly lookup: number;
}

/** A state or province of a large multi-zone country (polygons in `basemap/admin1-50m.geojson`). */
export interface Region {
  readonly index: number;
  readonly name: string;
  readonly country: number;
  /** Postal abbreviation where Natural Earth has one ("PA", "QC", "NSW"), else "". */
  readonly code: string;
}

export interface Place {
  readonly index: number;
  readonly name: string;
  /** ASCII spelling when it differs from `name` ("Sao Paulo"), else "". */
  readonly ascii: string;
  /** Other names people type: English and other Latin-script languages, former names. */
  readonly alt: readonly string[];
  readonly country: number;
  /** State or province name as Natural Earth gives it; may be "". */
  readonly admin1: string;
  readonly lat_deg: number;
  readonly lon_deg: number;
  readonly population: number;
  /**
   * Natural Earth's LABELRANK (0-10), its own label-collision priority. Not a global order of
   * importance (London is 5, Paris 3): use `minZoom` or `population` to rank places.
   */
  readonly labelRank: number;
  /** Natural Earth's suggested zoom for showing the label (256-pixel tiles; subtract 1 for MapLibre). */
  readonly minZoom: number;
  /** IANA time zone, or null when the source has none. */
  readonly zone: string | null;
  /** Index into `regions` of the state polygon the place lies in, or -1. */
  readonly region: number;
  readonly flags: number;
}

/**
 * A point whose civil time zone is known: every place with a zone, plus the principal
 * location of every IANA zone (zone.tab). The time-zone guess picks among these.
 */
export interface ZoneAnchor {
  readonly zone: string;
  readonly country: number;
  readonly region: number;
  readonly lat_deg: number;
  readonly lon_deg: number;
  /** Index of the place, or -1 for a zone.tab principal location. */
  readonly place: number;
  /** The place's name, or the zone's city for a zone.tab location ("Indianapolis"). */
  readonly label: string;
  /** zone.tab's description of the zone's area ("Eastern - IN (most areas)"); "" for places. */
  readonly comment: string;
}

export interface ZoneCorrection {
  readonly place: string;
  readonly country: string;
  readonly from: string;
  readonly to: string;
  readonly rule: string;
}

export interface Gazetteer {
  readonly format: string;
  readonly sources: Readonly<Record<string, string>>;
  readonly places: readonly Place[];
  readonly countries: readonly Country[];
  readonly regions: readonly Region[];
  /** Every zone id used in the file. */
  readonly zones: readonly string[];
  readonly anchors: readonly ZoneAnchor[];
  /** Zones with the same clock today, for browsers that do not know a newer zone id. */
  readonly zoneAlternatives: ReadonlyMap<string, readonly string[]>;
  /** Natural Earth time zones replaced at build time, with the rule that replaced them. */
  readonly corrections: readonly ZoneCorrection[];
}

// ---------------------------------------------------------------------------------------
// Parsing

const EXPECTED_FIELDS = {
  countries: ['name', 'iso', 'a3', 'lookup'],
  regions: ['name', 'country', 'code'],
  anchors: ['zone', 'country', 'region', 'lat', 'lon', 'comment'],
  places: ['name', 'ascii', 'alt', 'country', 'admin1', 'lat', 'lon', 'pop', 'rank', 'minzoom', 'zone', 'region', 'flags'],
} as const;

function fail(msg: string): never {
  throw new Error(`gazetteer.json: ${msg}`);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, what: string): string => (typeof v === 'string' ? v : fail(`${what} is not a string`));
const num = (v: unknown, what: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail(`${what} is not a number`));
const int = (v: unknown, what: string): number => (Number.isInteger(v) ? (v as number) : fail(`${what} is not an integer`));
const rows = (v: unknown, what: string, width: number): unknown[][] => {
  if (!Array.isArray(v)) fail(`${what} is not an array`);
  return v.map((r, i) => {
    if (!Array.isArray(r) || r.length !== width) fail(`${what}[${i}] does not have ${width} fields`);
    return r;
  });
};

/** "America/Argentina/Buenos_Aires" -> "Buenos Aires". */
function zoneCity(zone: string): string {
  return (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
}

/** Validate and index a parsed `gazetteer.json`. Throws a readable error on anything unexpected. */
export function parseGazetteer(json: unknown): Gazetteer {
  if (!isObj(json)) fail('not an object');
  if (json.format !== GAZETTEER_FORMAT) fail(`format is ${String(json.format)}, expected ${GAZETTEER_FORMAT}`);
  const fields = json.fields;
  if (!isObj(fields)) fail('fields missing');
  for (const [k, want] of Object.entries(EXPECTED_FIELDS)) {
    const got = fields[k];
    if (!Array.isArray(got) || got.join() !== want.join()) fail(`unsupported ${k} layout ${JSON.stringify(got)}`);
  }
  const zonesRaw = json.zones;
  if (!Array.isArray(zonesRaw)) fail('zones is not an array');
  const zones = zonesRaw.map((z, i) => str(z, `zones[${i}]`));
  const zoneAt = (i: number, what: string): string | null => (i < 0 ? null : (zones[i] ?? fail(`${what}: zone ${i} out of range`)));

  const countries: Country[] = rows(json.countries, 'countries', 4).map((r, index) => ({
    index,
    name: str(r[0], `countries[${index}].name`),
    iso: str(r[1], `countries[${index}].iso`),
    a3: str(r[2], `countries[${index}].a3`),
    lookup: int(r[3], `countries[${index}].lookup`),
  }));
  const checkCountry = (c: number, what: string) => (c >= 0 && c < countries.length ? c : fail(`${what}: country ${c} out of range`));
  for (const c of countries) if (c.lookup >= countries.length) fail(`countries[${c.index}].lookup out of range`);

  const regions: Region[] = rows(json.regions, 'regions', 3).map((r, index) => ({
    index,
    name: str(r[0], `regions[${index}].name`),
    country: checkCountry(int(r[1], `regions[${index}].country`), `regions[${index}]`),
    code: str(r[2], `regions[${index}].code`),
  }));
  const checkRegion = (r: number, what: string) => (r >= -1 && r < regions.length ? r : fail(`${what}: region ${r} out of range`));

  const places: Place[] = rows(json.places, 'places', 13).map((r, index) => {
    const what = `places[${index}]`;
    const alt = str(r[2], `${what}.alt`);
    const lat = num(r[5], `${what}.lat`);
    const lon = num(r[6], `${what}.lon`);
    if (Math.abs(lat) > 90 || lon <= -180 - 1e-9 || lon > 180) fail(`${what}: position out of range`);
    return {
      index,
      name: str(r[0], `${what}.name`),
      ascii: str(r[1], `${what}.ascii`),
      alt: alt ? alt.split('|') : [],
      country: checkCountry(int(r[3], `${what}.country`), what),
      admin1: str(r[4], `${what}.admin1`),
      lat_deg: lat,
      lon_deg: lon === -180 ? 180 : lon,
      population: num(r[7], `${what}.pop`),
      labelRank: num(r[8], `${what}.rank`),
      minZoom: num(r[9], `${what}.minzoom`),
      zone: zoneAt(int(r[10], `${what}.zone`), what),
      region: checkRegion(int(r[11], `${what}.region`), what),
      flags: int(r[12], `${what}.flags`),
    };
  });

  const anchors: ZoneAnchor[] = [];
  for (const p of places) {
    if (p.zone === null) continue;
    anchors.push({ zone: p.zone, country: p.country, region: p.region, lat_deg: p.lat_deg, lon_deg: p.lon_deg, place: p.index, label: p.name, comment: '' });
  }
  rows(json.anchors, 'anchors', 6).forEach((r, i) => {
    const what = `anchors[${i}]`;
    const zone = zoneAt(int(r[0], `${what}.zone`), what) ?? fail(`${what}: no zone`);
    const comment = str(r[5], `${what}.comment`);
    anchors.push({
      zone,
      country: checkCountry(int(r[1], `${what}.country`), what),
      region: checkRegion(int(r[2], `${what}.region`), what),
      lat_deg: num(r[3], `${what}.lat`),
      lon_deg: num(r[4], `${what}.lon`),
      place: -1,
      label: zoneCity(zone),
      comment,
    });
  });

  const alternatives = new Map<string, readonly string[]>();
  if (json.zone_alternatives !== undefined) {
    if (!isObj(json.zone_alternatives)) fail('zone_alternatives is not an object');
    for (const [z, alts] of Object.entries(json.zone_alternatives)) {
      if (!Array.isArray(alts)) fail(`zone_alternatives.${z} is not an array`);
      alternatives.set(z, alts.map((a, i) => str(a, `zone_alternatives.${z}[${i}]`)));
    }
  }
  registerZoneAlternatives(alternatives);

  const corrections: ZoneCorrection[] = Array.isArray(json.zone_corrections)
    ? json.zone_corrections.filter(isObj).map((c) => ({
        place: String(c.place),
        country: String(c.country),
        from: String(c.from),
        to: String(c.to),
        rule: String(c.rule ?? ''),
      }))
    : [];
  const sources: Record<string, string> = {};
  if (isObj(json.sources)) for (const [k, v] of Object.entries(json.sources)) if (typeof v === 'string') sources[k] = v;

  return { format: GAZETTEER_FORMAT, sources, places, countries, regions, zones, anchors, zoneAlternatives: alternatives, corrections };
}

const loaded = new Map<string, Promise<Gazetteer>>();

export interface LoadOptions {
  /** Absolute URL of the file; default `dataUrl('gazetteer.json')` relative to the page. */
  url?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/** Fetch and parse the gazetteer once per URL (later calls share the same promise). */
export function loadGazetteer(opts: LoadOptions = {}): Promise<Gazetteer> {
  const url = opts.url ?? dataUrl(GAZETTEER_FILE);
  let p = loaded.get(url);
  if (!p) {
    p = fetchJson(url, opts.fetch, opts.signal).then(parseGazetteer);
    p.catch(() => loaded.delete(url));
    loaded.set(url, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------
// Labels

/** "Philadelphia, Pennsylvania, United States" (the state is left out when it repeats the name). */
export function placeLabel(g: Gazetteer, place: Place, opts: { admin1?: boolean; country?: boolean } = {}): string {
  const parts = [place.name];
  if ((opts.admin1 ?? true) && place.admin1 && foldName(place.admin1) !== foldName(place.name)) parts.push(place.admin1);
  const country = g.countries[place.country];
  if ((opts.country ?? true) && country && foldName(country.name) !== foldName(place.name)) parts.push(country.name);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------------------
// Search

type How = 'exact' | 'prefix' | 'word' | 'contains' | 'typo' | 'country';

export interface PlaceMatch {
  readonly place: Place;
  /** Higher is better. Only the order is meaningful. */
  readonly score: number;
  /** The name that matched (may be an alternative name, e.g. "München" for Munich). */
  readonly matchedName: string;
  readonly how: How;
}

export interface SearchOptions {
  /** Maximum results, default 10. */
  limit?: number;
  /** Prefer places near here when names tie (e.g. the map's current centre). */
  near?: LatLonDeg;
}

interface NameKey {
  readonly key: string;
  readonly squashed: string;
  readonly name: string;
  readonly primary: boolean;
}

interface SearchIndex {
  readonly keys: readonly (readonly NameKey[])[];
  /** Per place: the part of the score that does not depend on the query. */
  readonly prominence: Float64Array;
  readonly countryKeys: readonly string[];
  readonly admin1Keys: readonly string[];
  readonly regionKeys: readonly string[];
}

const searchIndexes = new WeakMap<Gazetteer, SearchIndex>();

function searchIndex(g: Gazetteer): SearchIndex {
  let idx = searchIndexes.get(g);
  if (idx) return idx;
  const keys = g.places.map((p) => {
    const out: NameKey[] = [];
    const seen = new Set<string>();
    const add = (name: string, primary: boolean) => {
      const folded = foldName(name);
      for (const key of [folded, expandAbbreviations(folded)]) {
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ key, squashed: squash(key), name, primary });
      }
    };
    add(p.name, true);
    if (p.ascii) add(p.ascii, true);
    for (const a of p.alt) add(a, false);
    return out;
  });
  idx = {
    keys,
    prominence: Float64Array.from(g.places, prominence),
    countryKeys: g.countries.map((c) => foldName(c.name)),
    admin1Keys: g.places.map((p) => foldName(p.admin1)),
    regionKeys: g.regions.map((r) => foldName(r.name)),
  };
  searchIndexes.set(g, idx);
  return idx;
}

/**
 * Build the search index now (about 0.2 s for 7 342 places) instead of on the first
 * keystroke; call it when the page is idle after loading.
 */
export function prepareSearch(g: Gazetteer): void {
  searchIndex(g);
}

/** Everyday names for countries that differ from Natural Earth's. Keys are folded. */
const COUNTRY_ALIASES: ReadonlyMap<string, string> = new Map([
  ['usa', 'US'],
  ['us', 'US'],
  ['america', 'US'],
  ['united states of america', 'US'],
  ['uk', 'GB'],
  ['britain', 'GB'],
  ['great britain', 'GB'],
  ['england', 'GB'],
  ['scotland', 'GB'],
  ['wales', 'GB'],
  ['northern ireland', 'GB'],
  ['holland', 'NL'],
  ['czechia', 'CZ'],
  ['ivory coast', 'CI'],
  ['burma', 'MM'],
  ['east timor', 'TL'],
  ['uae', 'AE'],
  ['drc', 'CD'],
]);

const wordPrefix = (key: string, q: string) => key.startsWith(q) || key.includes(` ${q}`);

function qualifierMatches(g: Gazetteer, idx: SearchIndex, place: Place, q: string): boolean {
  const country = g.countries[place.country];
  if (!country) return false;
  const upper = q.toUpperCase();
  if (q.length === 2 && country.iso === upper) return true;
  if (q.length === 3 && country.a3 === upper) return true;
  const alias = COUNTRY_ALIASES.get(q);
  if (alias && country.iso === alias) return true;
  if (wordPrefix(idx.countryKeys[place.country] ?? '', q)) return true;
  if (wordPrefix(idx.admin1Keys[place.index] ?? '', q)) return true;
  const region = place.region >= 0 ? g.regions[place.region] : undefined;
  if (region && (region.code === upper || wordPrefix(idx.regionKeys[region.index] ?? '', q))) return true;
  return false;
}

const TIER: Record<How, number> = { exact: 5, prefix: 4, country: 4, word: 3, contains: 2, typo: 1 };

function matchName(k: NameKey, q: string, qs: string): How | null {
  if (k.key === q) return 'exact';
  if (k.key.startsWith(q) || (qs.length >= 3 && k.squashed.startsWith(qs))) return 'prefix';
  if (k.key.includes(` ${q}`)) return 'word';
  if (q.length >= 3 && k.key.includes(q)) return 'contains';
  return null;
}

function typoMatch(k: NameKey, q: string): boolean {
  if (q.length < 4) return false;
  const max = q.length >= 8 ? 2 : 1;
  // Against the same-length start of the name (typing "philadelpia") or the whole name.
  return boundedEditDistance(q, k.key.slice(0, q.length), max) <= max || boundedEditDistance(q, k.key, max) <= max;
}

/** Bigger places and capitals first: up to about 300 for population, 80 for a national capital. */
function prominence(p: Place): number {
  let s = 40 * Math.log10(p.population + 1);
  if (p.flags & PLACE_FLAGS.capital) s += 80;
  else if (p.flags & PLACE_FLAGS.admin1Capital) s += 25;
  return s;
}

function score(idx: SearchIndex, p: Place, how: How, primary: boolean, near: LatLonDeg | undefined): number {
  let s = TIER[how] * 1000 + (idx.prominence[p.index] ?? 0);
  if (primary) s += 20;
  if (near) s += 150 * Math.exp(-greatCircleDistanceNm(near, p) / 300);
  return s;
}

function runSearch(g: Gazetteer, nameQuery: string, qualifiers: string[], limit: number, near: LatLonDeg | undefined): PlaceMatch[] {
  const idx = searchIndex(g);
  const q0 = foldName(nameQuery);
  if (!q0) return [];
  const variants = [...new Set([q0, expandAbbreviations(q0)])].map((q) => ({ q, qs: squash(q) }));
  const passes = (p: Place) => qualifiers.length === 0 || qualifiers.every((q) => qualifierMatches(g, idx, p, q));
  const found: PlaceMatch[] = [];
  const scan = (match: (k: NameKey, q: string, qs: string) => How | null) => {
    g.places.forEach((p, i) => {
      let bestHow: How | null = null;
      let bestKey: NameKey | null = null;
      let bestRank = 0;
      for (const k of idx.keys[i] ?? []) {
        for (const v of variants) {
          const how = match(k, v.q, v.qs);
          if (!how) continue;
          // Higher tier wins; within a tier the place's own name beats an alternative.
          const rank = TIER[how] * 2 + (k.primary ? 1 : 0);
          if (rank > bestRank) {
            bestRank = rank;
            bestHow = how;
            bestKey = k;
          }
        }
      }
      if (bestHow && bestKey && passes(p)) {
        found.push({ place: p, score: score(idx, p, bestHow, bestKey.primary, near), matchedName: bestKey.name, how: bestHow });
      }
    });
  };
  scan(matchName);
  if (found.length === 0) scan((k, q) => (typoMatch(k, q) ? 'typo' : null));
  return found.sort((a, b) => b.score - a.score || a.place.name.localeCompare(b.place.name)).slice(0, limit);
}

function countryFor(g: Gazetteer, folded: string): Country | null {
  const alias = COUNTRY_ALIASES.get(folded);
  for (const c of g.countries) {
    if (alias ? c.iso === alias : foldName(c.name) === folded) return c;
  }
  return null;
}

/**
 * Places matching `query`, best first. Accents, case and punctuation are ignored; the
 * start of a name ranks above a word inside it, which ranks above any substring, which ranks
 * above a one- or two-letter typo; within a rank, bigger and capital cities come first.
 * After a comma, words narrow the search by country, state or state code: "Paris, TX",
 * "Portland, Maine", "Santiago, Chile". The comma may be left out when the name alone
 * matches nothing ("paris france"). A country's name alone lists its largest places.
 */
export function searchPlaces(g: Gazetteer, query: string, opts: SearchOptions = {}): PlaceMatch[] {
  const limit = opts.limit ?? 10;
  const parts = query
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return [];
  const [name, ...rest] = parts as [string, ...string[]];
  const qualifiers = rest.map(foldName).filter(Boolean);
  let results = runSearch(g, name, qualifiers, limit, opts.near);
  const strong = (r: PlaceMatch[]) => r.length > 0 && (r[0]?.how === 'exact' || r[0]?.how === 'prefix');

  // "paris france", "portland or": try the last one or two words as a qualifier.
  const words = foldName(name).split(' ');
  if (!strong(results) && qualifiers.length === 0 && words.length >= 2) {
    for (const k of [1, 2]) {
      if (words.length - k < 1) break;
      const split = runSearch(g, words.slice(0, -k).join(' '), [words.slice(-k).join(' ')], limit, opts.near);
      if (strong(split)) {
        results = split;
        break;
      }
    }
  }

  // "France", "USA": the country's largest places, capital first, unless a place has that
  // very name ("Georgia" is a country; there is no place called Georgia).
  if (results[0]?.how !== 'exact' && qualifiers.length === 0) {
    const country = countryFor(g, foldName(name));
    if (country) {
      const inCountry = g.places
        .filter((p) => p.country === country.index)
        .map((p) => ({ place: p, score: score(searchIndex(g), p, 'country', true, opts.near), matchedName: country.name, how: 'country' as const }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      if (inCountry.length) results = inCountry;
    }
  }
  return results;
}

export type QueryResult =
  | { kind: 'position'; position: LatLonDeg }
  | { kind: 'places'; matches: PlaceMatch[] }
  | { kind: 'none'; message: string };

/**
 * What a search box should do with `text`: a position when it reads as coordinates
 * (starts with a digit, sign, N/S/E/W or "lat"), otherwise a place search.
 */
export function interpretQuery(g: Gazetteer, text: string, opts: SearchOptions = {}): QueryResult {
  const t = text.trim();
  if (!t) return { kind: 'none', message: 'Type a place name or a position.' };
  const looksLikePosition = /^([+(-]|\d|[NSEW]\s*\d|lat|lon|geo:)/i.test(t) || t.startsWith(String.fromCharCode(0x2212));
  let positionError: string | null = null;
  if (looksLikePosition) {
    const pos = parseLatLon(t);
    if (pos.ok) return { kind: 'position', position: pos.value };
    positionError = pos.error;
  }
  const matches = searchPlaces(g, t, opts);
  if (matches.length) return { kind: 'places', matches };
  return { kind: 'none', message: positionError ?? `No place called "${t}" in the offline list.` };
}

// ---------------------------------------------------------------------------------------
// Nearest place and "near ..." descriptions

export interface NearestOptions {
  /** Only places with at least this population. */
  minPopulation?: number;
  /** Only places within this distance. */
  maxDistanceNm?: number;
  filter?: (p: Place) => boolean;
}

export interface NearestResult {
  readonly place: Place;
  readonly distanceNm: number;
  /** True course from the place to the position (the position lies this way from the place). */
  readonly bearingFromPlaceDeg: number;
}

/** The nearest place to a position (great-circle distance on the reference sphere). */
export function nearestPlace(g: Gazetteer, lat: number, lon: number, opts: NearestOptions = {}): NearestResult | null {
  const at = { lat_deg: lat, lon_deg: lon };
  let best: Place | null = null;
  let bestD = opts.maxDistanceNm ?? Infinity;
  for (const p of g.places) {
    if (opts.minPopulation !== undefined && p.population < opts.minPopulation) continue;
    if (opts.filter && !opts.filter(p)) continue;
    const d = greatCircleDistanceNm(at, p);
    if (d < bestD || (d === bestD && best === null)) {
      bestD = d;
      best = p;
    }
  }
  if (!best) return null;
  return { place: best, distanceNm: bestD, bearingFromPlaceDeg: initialCourseDeg(best, at) };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** 16-point compass name of a true bearing. */
export function compassPoint(bearingDeg: number): string {
  if (!Number.isFinite(bearingDeg)) return '';
  const i = Math.round((((bearingDeg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS[i] ?? 'N';
}

export interface LocationDescription {
  /** "near Philadelphia, Pennsylvania, United States" or "32 NM SW of Tonopah, Nevada, United States". */
  readonly text: string;
  readonly place: Place | null;
  readonly distanceNm: number;
  readonly bearingFromPlaceDeg: number;
}

/** Within this distance a position is simply "near" a place. */
export const NEAR_PLACE_NM = 8;
/** A much bigger place is preferred to the nearest one only this close (suburbs, not oceans). */
export const BIGGER_PLACE_WITHIN_NM = 30;

/**
 * Name a position after a nearby place. The nearest place wins unless a much larger one is
 * nearly as close: a place at least ten times as populous, no farther than twice the
 * nearest distance plus 10 NM (and never beyond 30 NM), is preferred, so a click in a
 * suburb reads "near Philadelphia" rather than "near" the suburb. `atSea` (from the
 * caller's land lookup) prefixes "At sea, ".
 */
export function describeLocation(g: Gazetteer, lat: number, lon: number, opts: { atSea?: boolean } = {}): LocationDescription {
  const nearest = nearestPlace(g, lat, lon);
  if (!nearest) return { text: opts.atSea ? 'At sea' : '', place: null, distanceNm: Number.NaN, bearingFromPlaceDeg: Number.NaN };
  const at = { lat_deg: lat, lon_deg: lon };
  let chosen = nearest;
  if (nearest.distanceNm <= BIGGER_PLACE_WITHIN_NM) {
    const limit = Math.min(2 * nearest.distanceNm + 10, BIGGER_PLACE_WITHIN_NM);
    const threshold = 10 * Math.max(1, nearest.place.population);
    for (const p of g.places) {
      if (p.population < threshold || p.population <= chosen.place.population) continue;
      const d = greatCircleDistanceNm(at, p);
      if (d <= limit) chosen = { place: p, distanceNm: d, bearingFromPlaceDeg: initialCourseDeg(p, at) };
    }
  }
  const label = placeLabel(g, chosen.place);
  const where =
    chosen.distanceNm <= NEAR_PLACE_NM
      ? `near ${label}`
      : `${Math.round(chosen.distanceNm)} NM ${compassPoint(chosen.bearingFromPlaceDeg)} of ${label}`;
  return {
    text: opts.atSea ? `At sea, ${where}` : where,
    place: chosen.place,
    distanceNm: chosen.distanceNm,
    bearingFromPlaceDeg: chosen.bearingFromPlaceDeg,
  };
}

// ---------------------------------------------------------------------------------------
// Map labels

export interface PlaceFeatureProperties {
  index: number;
  name: string;
  population: number;
  rank: number;
  minzoom: number;
  /** 2 = national capital, 1 = state capital, 0 = other. */
  capital: number;
}

export interface PlacePointFeature {
  type: 'Feature';
  properties: PlaceFeatureProperties;
  geometry: { type: 'Point'; coordinates: [number, number] };
}

/**
 * Places as a GeoJSON FeatureCollection for a MapLibre symbol layer (no data is duplicated
 * on disk). `maxMinZoom` keeps places Natural Earth labels at or below that zoom (its zooms
 * are for 256-pixel tiles: MapLibre zoom z corresponds to Natural Earth zoom z + 1).
 */
export function placesGeoJson(
  g: Gazetteer,
  opts: { maxMinZoom?: number; maxLabelRank?: number; minPopulation?: number } = {},
): { type: 'FeatureCollection'; features: PlacePointFeature[] } {
  const features: PlacePointFeature[] = [];
  for (const p of g.places) {
    if (opts.maxMinZoom !== undefined && p.minZoom > opts.maxMinZoom) continue;
    if (opts.maxLabelRank !== undefined && p.labelRank > opts.maxLabelRank) continue;
    if (opts.minPopulation !== undefined && p.population < opts.minPopulation) continue;
    features.push({
      type: 'Feature',
      properties: {
        index: p.index,
        name: p.name,
        population: p.population,
        rank: p.labelRank,
        minzoom: p.minZoom,
        capital: p.flags & PLACE_FLAGS.capital ? 2 : p.flags & PLACE_FLAGS.admin1Capital ? 1 : 0,
      },
      geometry: { type: 'Point', coordinates: [p.lon_deg, p.lat_deg] },
    });
  }
  return { type: 'FeatureCollection', features };
}
