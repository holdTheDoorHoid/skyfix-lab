#!/usr/bin/env node
// Builds the explorer's offline map data from pinned public-domain sources:
//
//   web/public/data/basemap/*.geojson     Natural Earth layers for MapLibre, reduced
//   web/public/data/basemap/manifest.json what was built, from what, how big
//   web/public/data/gazetteer.json        places, countries, regions, time-zone anchors
//
// Reproduce from a clean checkout (development time only; needs Node 20+ and network for
// the first command):
//
//   node tools/mapdata/fetch.mjs     # download + verify the pinned inputs (sources.json)
//   node tools/mapdata/build.mjs     # regenerate every output file
//
// Inputs: Natural Earth 5.1.2 (public domain) and IANA tzdata 2026d (public domain). What
// each output contains, and every processing decision, is documented in
// docs/THIRD_PARTY.md ("Basemap and gazetteer") and in the manifest. The time-zone rules
// used to clean Natural Earth's TIMEZONE field come from this Node's ICU data; the
// manifest records the version.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import * as G from './lib/geometry.mjs';
import * as TZ from './lib/tzdata.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const cacheDir = join(here, 'cache');
const outData = join(root, 'web', 'public', 'data');
const outBasemap = join(outData, 'basemap');
const sources = JSON.parse(readFileSync(join(here, 'sources.json'), 'utf8'));
const BUILD_DATE = sources.recorded; // date the inputs were retrieved and pinned

/** 12 nautical miles, the territorial sea: "near enough" for coasts and islands. */
const MARGIN_KM = (12 * 1852) / 1000;

// ---------------------------------------------------------------------------------------
// Inputs

function input(name, meta) {
  const buf = readFileSync(join(cacheDir, name));
  const digest = createHash('sha256').update(buf).digest('hex');
  if (digest !== meta.sha256) throw new Error(`${name}: sha256 ${digest} does not match sources.json; run fetch.mjs`);
  return buf;
}
const ne = (name) => JSON.parse(input(name, sources.natural_earth.files[name]).toString('utf8')).features;

const tarFiles = TZ.readTarGz(input(sources.tzdata.file, sources.tzdata));
const tzText = (f) => tarFiles[f].toString('utf8');
const zoneTab = TZ.parseZoneTab(tzText('zone.tab'));
const links = TZ.parseLinks(
  ['africa', 'antarctica', 'asia', 'australasia', 'backward', 'etcetera', 'europe', 'northamerica', 'southamerica'].map(tzText),
);
const iso3166 = new Map(
  tzText('iso3166.tab')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t')),
);
const zoneTabIds = new Set(zoneTab.map((z) => z.zone));
for (const z of zoneTab) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: z.zone });
  } catch {
    throw new Error(`zone.tab zone ${z.zone} is unknown to this Node's ICU; use a newer Node`);
  }
}

// ---------------------------------------------------------------------------------------
// Geometry processing

const vertexCount = (g) => {
  switch (g.type) {
    case 'Point':
      return 1;
    case 'LineString':
      return g.coordinates.length;
    case 'MultiLineString':
    case 'Polygon':
      return g.coordinates.reduce((a, r) => a + r.length, 0);
    case 'MultiPolygon':
      return g.coordinates.reduce((a, p) => a + p.reduce((b, r) => b + r.length, 0), 0);
    default:
      throw new Error(g.type);
  }
};

/**
 * Clean, simplify and rewind polygon features. Vertices on the antimeridian seam or at the
 * pole are never removed, so polygons still meet exactly at +/-180. With `lockShared`,
 * vertices where the set of polygons sharing a border changes are kept too, so a border
 * shared by two polygons is simplified identically in both (no slivers or gaps).
 */
function processPolygons(features, { decimals, tol, lockShared = false, densifyPoles = false }) {
  const cleaned = features.map((f) =>
    G.polygonsOf(f.geometry).map((rings) =>
      rings.map((r) => {
        let ring = G.dedupe(r.map((v) => G.cleanVertex(v, decimals)));
        if (densifyPoles) ring = G.densifyPolarEdges(ring);
        const [first, last] = [ring[0], ring[ring.length - 1]];
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
        return ring;
      }),
    ),
  );
  let ownersKey = null;
  if (lockShared) {
    const owners = new Map();
    cleaned.forEach((polys, fi) =>
      polys.forEach((rings) =>
        rings.forEach((r) =>
          r.forEach(([x, y]) => {
            const k = `${x},${y}`;
            const s = owners.get(k);
            if (!s) owners.set(k, new Set([fi]));
            else s.add(fi);
          }),
        ),
      ),
    );
    ownersKey = (v) => [...owners.get(`${v[0]},${v[1]}`)].sort((a, b) => a - b).join(' ');
  }
  const out = [];
  cleaned.forEach((polys, fi) => {
    const keptPolys = [];
    for (const rings of polys) {
      const keptRings = [];
      rings.forEach((ring, ri) => {
        const n = ring.length;
        // Closed ring: positions 0..n-2 are distinct, ring[n-1] repeats ring[0].
        const lockedAt = (v, i) => {
          if (G.isSeamLon(v[0]) || Math.abs(v[1]) >= G.POLE_LAT) return true;
          if (!ownersKey) return false;
          const here = ownersKey(v);
          const prev = ring[(i - 1 + n - 1) % (n - 1)];
          const next = ring[(i + 1) % (n - 1)];
          return here !== ownersKey(prev) || here !== ownersKey(next);
        };
        const simplified = tol > 0 ? G.simplifyRing(ring, tol, lockedAt) : ring.length >= 4 ? ring : null;
        if (!simplified || G.signedArea(simplified) === 0) return; // collapsed at this scale
        if (ri === 0 || keptRings.length > 0) keptRings.push(simplified);
      });
      if (keptRings.length) keptPolys.push(G.rewindPolygon(keptRings));
    }
    if (keptPolys.length) out.push({ index: fi, polygons: keptPolys });
  });
  return out;
}

/** Clean and simplify line features; lines that cross the antimeridian are split there. */
function processLines(features, { decimals, tol, wrap = false }) {
  return features.map((f, fi) => {
    const lines = [];
    for (const line of G.linesOf(f.geometry)) {
      let pts = line.map(([x, y]) => {
        let lon = x;
        if (wrap) {
          if (lon > 180) lon -= 360;
          if (lon < -180) lon += 360;
        }
        return G.cleanVertex([lon, y], decimals);
      });
      pts = G.dedupe(pts);
      for (let piece of G.splitAtAntimeridian(pts)) {
        piece = G.dedupe(piece.map((v) => G.cleanVertex(v, decimals)));
        if (piece.length < 2) continue;
        const locked = piece.map((v) => G.isSeamLon(v[0]));
        piece = tol > 0 ? G.simplifyOpen(piece, tol, locked) : piece;
        if (piece.length >= 2) lines.push(piece);
      }
    }
    return { index: fi, lines };
  });
}

function validate(file, features) {
  for (const f of features) {
    const g = f.geometry;
    const check = (c) => {
      if (!Number.isFinite(c[0]) || !Number.isFinite(c[1]) || c[0] < -180 || c[0] > 180 || c[1] < -90 || c[1] > 90)
        throw new Error(`${file}: coordinate out of range ${c}`);
    };
    if (g.type === 'Point') check(g.coordinates);
    else if (g.type === 'LineString') g.coordinates.forEach(check);
    else if (g.type === 'MultiLineString') g.coordinates.forEach((l) => l.forEach(check));
    else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      for (const rings of G.polygonsOf(g)) {
        rings.forEach((r, i) => {
          r.forEach(check);
          if (r.length < 4) throw new Error(`${file}: ring with ${r.length} vertices`);
          const [a, b] = [r[0], r[r.length - 1]];
          if (a[0] !== b[0] || a[1] !== b[1]) throw new Error(`${file}: open ring`);
          if ((G.signedArea(r) > 0) !== (i === 0)) throw new Error(`${file}: winding is not RFC 7946`);
        });
      }
    }
    if (G.maxLonStep(g) > 180) throw new Error(`${file}: a segment spans more than 180 degrees of longitude`);
  }
}

const manifestFiles = [];
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function writeCollection(file, features, info) {
  validate(file, features);
  const body = `{"type":"FeatureCollection","features":[\n${features.map((f) => JSON.stringify(f)).join(',\n')}\n]}\n`;
  writeFileSync(join(outBasemap, file), body);
  const gz = zlib.gzipSync(body, { level: 9 }).length;
  const vertices = features.reduce((a, f) => a + vertexCount(f.geometry), 0);
  manifestFiles.push({
    path: file,
    ...info,
    features: features.length,
    vertices,
    bytes: Buffer.byteLength(body),
    gzip_bytes: gz,
    sha256: sha256(body),
  });
  console.log(`${file.padEnd(28)} ${String(features.length).padStart(5)} features ${String(vertices).padStart(7)} vertices ${(Buffer.byteLength(body) / 1024).toFixed(0).padStart(6)} KB  gz ${(gz / 1024).toFixed(0).padStart(5)} KB`);
}

const feature = (geometry, properties = {}) => ({ type: 'Feature', properties, geometry });
const nameOrNull = (s) => (typeof s === 'string' && s.trim() ? s.trim() : null);
const titleIfShouting = (s) =>
  s && s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : s;
const num = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? G.round(v, d) : null);

mkdirSync(outBasemap, { recursive: true });

// ---------------------------------------------------------------------------------------
// Land and coastline. Polygons for fills, derived lines for strokes (no seam artefacts).

function landAndCoast(scale, srcName, decimals, tol) {
  const src = ne(srcName);
  const polys = processPolygons(src, { decimals, tol, densifyPoles: true });
  const land = polys.map((p) => feature(G.polygonGeometry(p.polygons)));
  const coastLines = [];
  for (const p of polys) for (const rings of p.polygons) for (const r of rings) coastLines.push(...G.coastFromRing(r));
  const coast = coastLines.filter((l) => l.length >= 2).map((l) => feature({ type: 'LineString', coordinates: l }));
  const common = { source: srcName.replace('.geojson', ''), precision_deg: 10 ** -decimals, simplify_deg: tol };
  writeCollection(`land-${scale}.geojson`, land, {
    layer: 'land',
    geometry: 'Polygon',
    ...common,
    use: 'Land fill. Polygons are split at the antimeridian (RFC 7946); fill only, stroke the coastline file instead.',
  });
  writeCollection(`coastline-${scale}.geojson`, coast, {
    layer: 'coastline',
    geometry: 'LineString',
    ...common,
    derived_from: `land-${scale}.geojson`,
    use: 'Coast strokes: the land rings minus their artificial edges along +/-180 and the South Pole, so they align exactly with the land fill.',
  });
}
landAndCoast('110m', 'ne_110m_land.geojson', 2, 0);
landAndCoast('50m', 'ne_50m_land.geojson', 3, 0.005);

// ---------------------------------------------------------------------------------------
// Water: lakes and rivers

{
  const src = ne('ne_50m_lakes.geojson');
  const polys = processPolygons(src, { decimals: 3, tol: 0.01 });
  const kind = { Lake: 'lake', 'Alkaline Lake': 'alkaline', Reservoir: 'reservoir' };
  const out = polys.map((p) => {
    const q = src[p.index].properties;
    return feature(G.polygonGeometry(p.polygons), {
      name: nameOrNull(q.name),
      kind: kind[q.featurecla] ?? 'lake',
      rank: q.scalerank,
      minzoom: num(q.min_label),
    });
  });
  writeCollection('lakes-50m.geojson', out, {
    layer: 'lakes',
    geometry: 'Polygon',
    source: 'ne_50m_lakes',
    precision_deg: 0.001,
    simplify_deg: 0.01,
    properties: 'name (null for unnamed), kind (lake | alkaline | reservoir), rank (Natural Earth scalerank, 0 = most important), minzoom (Natural Earth min_label)',
    use: 'Water fill over land; label large lakes by rank.',
  });
}
{
  const src = ne('ne_50m_rivers_lake_centerlines.geojson').filter((f) => f.properties.featurecla === 'River');
  const lines = processLines(src, { decimals: 3, tol: 0.01 });
  const out = lines
    .filter((l) => l.lines.length)
    .map((l) => {
      const q = src[l.index].properties;
      return feature(G.lineGeometry(l.lines), { name: nameOrNull(q.name), rank: q.scalerank, minzoom: num(q.min_zoom) });
    });
  writeCollection('rivers-50m.geojson', out, {
    layer: 'rivers',
    geometry: 'LineString',
    source: 'ne_50m_rivers_lake_centerlines (featurecla River; the centre lines drawn through lakes are left out)',
    precision_deg: 0.001,
    simplify_deg: 0.01,
    properties: 'name, rank (scalerank; width by rank), minzoom (Natural Earth min_zoom)',
    use: 'Thin water-coloured lines.',
  });
}

// ---------------------------------------------------------------------------------------
// Country boundaries (lines, for display)

{
  const src = ne('ne_50m_admin_0_boundary_lines_land.geojson');
  const kinds = {
    'International boundary (verify)': 'international',
    'Disputed (please verify)': 'disputed',
    'Indefinite (please verify)': 'indefinite',
    'Indeterminant frontier': 'indefinite',
    'Line of control (please verify)': 'line-of-control',
  };
  const lines = processLines(src, { decimals: 3, tol: 0.005 });
  const out = lines
    .filter((l) => l.lines.length)
    .map((l) => {
      const q = src[l.index].properties;
      const kind = kinds[q.FEATURECLA];
      if (!kind) throw new Error(`unknown boundary class ${q.FEATURECLA}`);
      return feature(G.lineGeometry(l.lines), { kind });
    });
  writeCollection('boundaries-50m.geojson', out, {
    layer: 'boundaries',
    geometry: 'LineString',
    source: 'ne_50m_admin_0_boundary_lines_land',
    precision_deg: 0.001,
    simplify_deg: 0.005,
    properties: 'kind: international | disputed | indefinite | line-of-control (draw the last three dashed)',
    use: "Land borders between countries, Natural Earth's default (de facto) view. Maritime borders are not drawn.",
  });
}

// ---------------------------------------------------------------------------------------
// Countries and states: polygons for "which country / state is this point in" (the
// time-zone guess) and optional fills. Lookup quality: 0.01 deg, borders shared exactly.

const countriesSrc = ne('ne_50m_admin_0_countries.geojson');
/**
 * Everyday English country names: the shortest of Natural Earth's NAME_EN, ADMIN, NAME_LONG
 * and NAME that is not abbreviated with a full stop. This gives "United States", "China",
 * "Russia", "South Korea", "Bosnia and Herzegovina", "Saint Lucia".
 */
function countryName(q) {
  const options = [q.NAME_EN, q.ADMIN, q.NAME_LONG, q.NAME].filter((n) => typeof n === 'string' && n.trim() && !n.includes('.'));
  return options.reduce((best, n) => (n.length < best.length ? n : best), options[0] ?? q.ADMIN).trim();
}
/** ISO codes used only to join a polygon to zone.tab, where Natural Earth has none. */
const ZONE_ISO_ALIASES = { SOL: 'SO', CYN: 'CY', KOS: 'RS' };

const countries = []; // rows: { name, iso, a3, lookup, zoneIso }
const countryByA3 = new Map();
for (const f of countriesSrc) {
  const q = f.properties;
  const iso = q.ISO_A2_EH && q.ISO_A2_EH !== '-99' ? q.ISO_A2_EH : '';
  const row = {
    name: countryName(q),
    iso,
    a3: q.ADM0_A3,
    lookup: countries.length,
    zoneIso: ZONE_ISO_ALIASES[q.ADM0_A3] ?? iso,
  };
  if (countryByA3.has(row.a3)) throw new Error(`duplicate country ${row.a3}`);
  countryByA3.set(row.a3, countries.length);
  countries.push(row);
}
const countryPolys = processPolygons(countriesSrc, { decimals: 2, tol: 0.01, lockShared: true });
const countryLocator = G.makeLocator(countryPolys.map((p) => ({ key: p.index, polygons: p.polygons })));
// A country too small to survive at 0.01 deg (the Vatican) is looked up as the country
// that surrounds its label point.
{
  const kept = new Set(countryPolys.map((p) => p.index));
  countriesSrc.forEach((f, i) => {
    if (kept.has(i)) return;
    const q = f.properties;
    const hit = countryLocator(q.LABEL_Y, q.LABEL_X, MARGIN_KM);
    countries[i].lookup = hit ? hit.key : -1;
    console.log(`country ${q.ADM0_A3} collapsed at lookup precision; looked up as ${hit ? countries[hit.key].a3 : 'sea'}`);
  });
}
{
  const out = countryPolys.map((p) => {
    const c = countries[p.index];
    return feature(G.polygonGeometry(p.polygons), { c: p.index, name: c.name, iso: c.iso, a3: c.a3 });
  });
  writeCollection('countries-50m.geojson', out, {
    layer: 'countries',
    geometry: 'Polygon',
    source: 'ne_50m_admin_0_countries',
    precision_deg: 0.01,
    simplify_deg: 0.01,
    properties: 'c (index into gazetteer.json countries), name, iso (ISO 3166-1 alpha-2, "" when none), a3',
    use: 'Point-in-country lookups for the time-zone guess; optional country fills or hover. Borders shared exactly between neighbours; within about 1 km of boundaries-50m.',
  });
}

// States and provinces, only for large countries that span several time zones. Natural
// Earth's 50m admin-1 layer covers nine countries; India and South Africa are one zone each.
const REGION_COUNTRIES = new Set(['USA', 'CAN', 'RUS', 'BRA', 'AUS', 'IDN', 'CHN']);
const admin1Src = ne('ne_50m_admin_1_states_provinces.geojson').filter((f) => REGION_COUNTRIES.has(f.properties.adm0_a3));
const regions = []; // rows: { name, country, code }
for (const f of admin1Src) {
  const q = f.properties;
  const c = countryByA3.get(q.adm0_a3);
  if (c === undefined) throw new Error(`admin-1 country ${q.adm0_a3} not in countries`);
  const code = typeof q.postal === 'string' && /^[A-Z0-9]{1,3}$/.test(q.postal) ? q.postal : '';
  regions.push({ name: q.name, country: c, code });
}
const regionPolys = processPolygons(admin1Src, { decimals: 2, tol: 0.01, lockShared: true });
const regionLocator = G.makeLocator(regionPolys.map((p) => ({ key: p.index, polygons: p.polygons })));
{
  const out = regionPolys.map((p) => {
    const r = regions[p.index];
    return feature(G.polygonGeometry(p.polygons), { r: p.index, c: r.country, name: r.name, code: r.code });
  });
  writeCollection('admin1-50m.geojson', out, {
    layer: 'admin1',
    geometry: 'Polygon',
    source: `ne_50m_admin_1_states_provinces (${[...REGION_COUNTRIES].join(', ')} only)`,
    precision_deg: 0.01,
    simplify_deg: 0.01,
    properties: 'r (index into gazetteer.json regions), c (country index), name, code (postal abbreviation, e.g. "PA")',
    use: 'Point-in-state lookups for the time-zone guess in large multi-zone countries; optional state outlines.',
  });
}
const regionsOfCountry = (c) => {
  const s = new Set();
  regions.forEach((r, i) => r.country === c && s.add(i));
  return s;
};
function locateRegion(lat, lon, country) {
  if (!REGION_COUNTRIES.has(countries[country].a3)) return -1;
  const allowed = regionsOfCountry(country);
  const hit = regionLocator(lat, lon, MARGIN_KM, (k) => allowed.has(k));
  return hit ? hit.key : -1;
}

// ---------------------------------------------------------------------------------------
// Pretty extras: urban areas, ice, marine and physical labels, geographic lines

{
  const src = ne('ne_50m_urban_areas.geojson');
  const polys = processPolygons(src, { decimals: 3, tol: 0.01 });
  writeCollection(
    'urban-50m.geojson',
    polys.map((p) => feature(G.polygonGeometry(p.polygons), { minzoom: num(src[p.index].properties.min_zoom) })),
    {
      layer: 'urban',
      geometry: 'Polygon',
      source: 'ne_50m_urban_areas',
      precision_deg: 0.001,
      simplify_deg: 0.01,
      properties: 'minzoom (Natural Earth min_zoom)',
      use: 'Built-up areas, a subtle fill.',
    },
  );
}
{
  const src = ne('ne_50m_glaciated_areas.geojson');
  const polys = processPolygons(src, { decimals: 3, tol: 0.01 });
  writeCollection('glaciers-50m.geojson', polys.map((p) => feature(G.polygonGeometry(p.polygons))), {
    layer: 'glaciers',
    geometry: 'Polygon',
    source: 'ne_50m_glaciated_areas',
    precision_deg: 0.001,
    simplify_deg: 0.01,
    use: 'Ice caps and glaciers (Greenland, Antarctica), a white fill. Fill only: polygons meet at +/-180.',
  });
}
{
  const src = ne('ne_50m_antarctic_ice_shelves_polys.geojson');
  const polys = processPolygons(src, { decimals: 3, tol: 0.01 });
  writeCollection('ice-shelves-50m.geojson', polys.map((p) => feature(G.polygonGeometry(p.polygons))), {
    layer: 'ice-shelves',
    geometry: 'Polygon',
    source: 'ne_50m_antarctic_ice_shelves_polys',
    precision_deg: 0.001,
    simplify_deg: 0.01,
    use: 'Floating ice shelves around Antarctica. Fill only: polygons meet at +/-180.',
  });
}
{
  const src = ne('ne_50m_geography_marine_polys.geojson');
  const out = [];
  for (const f of src) {
    const q = f.properties;
    const name = titleIfShouting(nameOrNull(q.name));
    if (!name) continue;
    // Label the largest part, at its pole of inaccessibility, kept within 78 degrees of the
    // equator so polar oceans are labelled where a Mercator map can show them.
    let best = null;
    for (const rings of G.polygonsOf(f.geometry)) {
      const [minX, minY, maxX, maxY] = G.bboxOfRings([rings[0]]);
      const lat0 = Math.max(-60, Math.min(60, (minY + maxY) / 2));
      const k = Math.cos((lat0 * Math.PI) / 180);
      const proj = rings.map((r) => r.map(([x, y]) => [x * k, y]));
      const precision = Math.max(0.02, Math.min((maxX - minX) * k, maxY - minY) / 200);
      const [px, py, d] = G.poleOfInaccessibility(proj, precision, (_x, y) => 78 - Math.abs(y));
      if (!best || d > best.d) best = { lon: px / k, lat: py, d };
    }
    out.push(
      feature(
        { type: 'Point', coordinates: [G.round(best.lon, 2), G.round(best.lat, 2)] },
        { name, kind: q.featurecla, rank: q.scalerank, minzoom: num(q.min_label) },
      ),
    );
  }
  writeCollection('marine-labels.geojson', out, {
    layer: 'marine-labels',
    geometry: 'Point',
    source: 'ne_50m_geography_marine_polys (label point computed: pole of inaccessibility of the largest part, |lat| <= 78)',
    precision_deg: 0.01,
    properties: 'name, kind (ocean | sea | bay | gulf | strait | channel | sound | reef | river), rank (scalerank), minzoom (Natural Earth min_label)',
    use: 'Italic water labels for oceans, seas and gulfs.',
  });
}
{
  const src = ne('ne_50m_geography_regions_points.geojson');
  const out = src
    .filter((f) => nameOrNull(f.properties.name))
    .map((f) => {
      const q = f.properties;
      const [x, y] = G.cleanVertex(f.geometry.coordinates, 3);
      return feature({ type: 'Point', coordinates: [x, y] }, { name: nameOrNull(q.name), kind: q.featurecla, rank: q.scalerank, minzoom: num(q.min_zoom) });
    });
  writeCollection('physical-labels.geojson', out, {
    layer: 'physical-labels',
    geometry: 'Point',
    source: 'ne_50m_geography_regions_points',
    precision_deg: 0.001,
    properties: 'name, kind (cape | island | pole | waterfall | plain), rank (scalerank), minzoom (Natural Earth min_zoom)',
    use: 'Capes, islands and the poles: landmarks a navigator knows.',
  });
}
{
  const src = ne('ne_50m_geographic_lines.geojson');
  const kinds = {
    Equator: 'equator',
    'Tropic of Cancer': 'tropic',
    'Tropic of Capricorn': 'tropic',
    'Arctic Circle': 'polar-circle',
    'Antarctic Circle': 'polar-circle',
    'International Date Line': 'date-line',
  };
  const lines = processLines(src, { decimals: 3, tol: 0, wrap: true });
  const out = lines.map((l) => {
    const q = src[l.index].properties;
    const kind = kinds[q.name];
    if (!kind) throw new Error(`unknown geographic line ${q.name}`);
    return feature(G.lineGeometry(l.lines), { name: q.name, kind });
  });
  writeCollection('geolines-50m.geojson', out, {
    layer: 'geolines',
    geometry: 'LineString',
    source: 'ne_50m_geographic_lines (the date line wrapped into [-180, 180] and split at the antimeridian)',
    precision_deg: 0.001,
    simplify_deg: 0,
    properties: 'name, kind (equator | tropic | polar-circle | date-line)',
    use: "Reference lines. The tropics and polar circles are Natural Earth's fixed values (23.44 / 66.56 deg); the date line is the civil one, not the 180th meridian.",
  });
}

// ---------------------------------------------------------------------------------------
// Gazetteer: places, their time zones (cleaned), and zone.tab anchors

const placesSrc = ne('ne_10m_populated_places.geojson');
/** Natural Earth uses different ADM0_A3 codes in places and in country polygons here. */
const PLACE_A3_ALIASES = { SSD: 'SDS' };
/** Territories that have places but no 50m polygon: [ISO 3166 code]. */
const PLACE_ONLY_ISO = { GIB: 'GI', SJM: 'SJ', TKL: 'TK' };

function countryOfPlace(q, lat, lon) {
  const a3 = PLACE_A3_ALIASES[q.ADM0_A3] ?? q.ADM0_A3;
  if (countryByA3.has(a3)) return countryByA3.get(a3);
  const iso = PLACE_ONLY_ISO[a3];
  if (!iso) throw new Error(`place ${q.NAME}: country ${a3} has no polygon and no ISO mapping`);
  const hit = countryLocator(lat, lon, MARGIN_KM);
  const row = { name: q.ADM0NAME, iso, a3, lookup: hit ? hit.key : -1, zoneIso: iso };
  countryByA3.set(a3, countries.length);
  countries.push(row);
  return countries.length - 1;
}

const zoneTabByIso = new Map();
for (const z of zoneTab) {
  if (!zoneTabByIso.has(z.country)) zoneTabByIso.set(z.country, []);
  zoneTabByIso.get(z.country).push(z);
}
const canon = (z) => TZ.canonicalZone(z, links);

/**
 * Clean one Natural Earth TIMEZONE value (see THIRD_PARTY.md for the reasoning):
 *   A. a legacy name (not in zone.tab) becomes the zone.tab name it links to;
 *   B. a zone that belongs to none of the place's countries (zone.tab) is kept only if it
 *      shows the same clock as that country's nearest zone today, or if its own zone.tab
 *      location is nearer to the place than any of the country's zones (overseas
 *      territories, border towns); otherwise it is replaced by the country's nearest zone;
 *   C. a place within 30 km of a zone.tab principal location of its own country (by the
 *      place's own attributes, not the coarse polygons, so border towns are not pulled across)
 *      takes that location's zone when the two show different clocks today (Natural Earth
 *      predates Punta Arenas 2017 and Khandyga 2014, and still files Matamoros under
 *      Monterrey); with the same clock it only takes the better name when the place is the
 *      zone's namesake (Anchorage was filed under America/Juneau) or its zone belongs to
 *      another country (Andorra under Europe/Madrid).
 */
const NEAR_PRINCIPAL_KM = 30;
const zoneCityKey = (z) => foldName((z.split('/').pop() ?? z).replace(/_/g, ' '));
function cleanZone(zone, lat, lon, isoCodes, ownCodes, names) {
  const res = cleanZoneAB(zone, lat, lon, isoCodes);
  const own = [...ownCodes].flatMap((c) => zoneTabByIso.get(c) ?? []);
  let near = null;
  let nearKm = NEAR_PRINCIPAL_KM;
  for (const e of own) {
    const d = G.haversineKm(lat, lon, e.lat, e.lon);
    if (d <= nearKm) {
      nearKm = d;
      near = e;
    }
  }
  if (!near || near.zone === res.zone) return res;
  if (TZ.rulesSignature(near.zone) !== TZ.rulesSignature(res.zone)) {
    return { zone: near.zone, modernised: res.modernised, corrected: { from: zone, to: near.zone, rule: 'C' } };
  }
  const namesake = names.some((n) => n && foldName(n) === zoneCityKey(near.zone));
  const ownHasCurrent = own.some((e) => e.zone === res.zone || canon(e.zone) === canon(res.zone));
  if (namesake || !ownHasCurrent) return { zone: near.zone, modernised: true, corrected: res.corrected };
  return res;
}

function cleanZoneAB(zone, lat, lon, isoCodes) {
  let z = zone;
  let modernised = false;
  if (!zoneTabIds.has(z)) {
    const target = canon(z);
    const same = zoneTab.filter((e) => canon(e.zone) === target);
    const pref = same.filter((e) => isoCodes.has(e.country));
    const pick = (pref.length ? pref : same).sort((a, b) => G.haversineKm(lat, lon, a.lat, a.lon) - G.haversineKm(lat, lon, b.lat, b.lon))[0];
    if (pick && pick.zone !== z) {
      z = pick.zone;
      modernised = true;
    }
  }
  const allowed = [...isoCodes].flatMap((c) => zoneTabByIso.get(c) ?? []);
  if (!allowed.length || allowed.some((e) => e.zone === z || canon(e.zone) === canon(z))) return { zone: z, modernised, corrected: null };
  const byDist = (e) => G.haversineKm(lat, lon, e.lat, e.lon);
  const nearestAllowed = allowed.slice().sort((a, b) => byDist(a) - byDist(b))[0];
  if (TZ.rulesSignature(z) === TZ.rulesSignature(nearestAllowed.zone)) return { zone: z, modernised, corrected: null };
  const own = zoneTab.filter((e) => canon(e.zone) === canon(z));
  const dOwn = own.length ? Math.min(...own.map(byDist)) : Infinity;
  if (dOwn < byDist(nearestAllowed)) return { zone: z, modernised, corrected: null };
  return { zone: nearestAllowed.zone, modernised, corrected: { from: zone, to: nearestAllowed.zone, rule: 'B' } };
}

const zones = [];
const zoneIndex = new Map();
const zoneIdx = (z) => {
  if (!zoneIndex.has(z)) {
    zoneIndex.set(z, zones.length);
    zones.push(z);
  }
  return zoneIndex.get(z);
};

const FLAG_CAPITAL = 1;
const FLAG_ADMIN1_CAPITAL = 2;
const FLAG_ZONE_CORRECTED = 4;
const FLAG_STATION = 8;

/** Collapse runs of whitespace ("St.  Petersburg" in Natural Earth). */
const tidy = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/**
 * Natural Earth's ADM1NAME has encoding damage for about 45 states (mostly Vietnam and
 * Azerbaijan, where letters became "?"; a few truncated or with a stray capital). Those with
 * an obvious original are repaired; the rest are dropped, so the label leaves the state out.
 */
const ADMIN1_REPAIRS = {
  Guinaa: 'Guyane',
  Ghardaaa: 'Ghardaïa',
  'Ãstfold': 'Østfold',
  'Los R': 'Los Ríos',
  'Thanh H': 'Thanh Hóa',
  Moyotte: 'Mayotte',
  'ThMi Bmnh': 'Thái Bình',
  'TrM Vinh': 'Trà Vinh',
  'StMng Tr': 'Stung Treng',
  HuRnuco: 'Huánuco',
  BiO: 'Bío-Bío',
  HuOla: 'Huila',
  GrandKru: 'Grand Kru',
  GrandGedeh: 'Grand Gedeh',
};
function cleanAdmin1(raw) {
  const t = tidy(raw);
  if (ADMIN1_REPAIRS[t]) return ADMIN1_REPAIRS[t];
  // "?" or U+FFFD for a letter, UTF-8 read as Latin-1 ("Ã"), or cut off after one letter.
  if (/[?\uFFFD]|Ã|Â/.test(t) || /\s\S$/.test(t)) return '';
  return t;
}

/** Latin-script names worth searching by: English first, then the languages most readers type. */
const ALT_NAME_FIELDS = ['NAME_EN', 'NAME_DE', 'NAME_ES', 'NAME_FR', 'NAME_IT', 'NAME_PT', 'NAME_NL', 'NAME_PL', 'NAME_SV', 'NAME_TR', 'NAME_ID', 'NAME_VI', 'NAME_HU'];
/** The search key the browser uses too (web/src/next/geo/text.ts): no accents, no case, no punctuation. */
function foldName(s) {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/[øǿ]/g, 'o')
    .replace(/[đð]/g, 'd')
    .replace(/ł/g, 'l')
    .replace(/þ/g, 'th')
    .replace(/ı/g, 'i')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const corrections = [];
let modernisedCount = 0;
const places = [];
for (const f of placesSrc) {
  const q = f.properties;
  // Geometry, not LATITUDE/LONGITUDE: Natural Earth corrected ~300 positions in the
  // geometry only (Karlskrona, Scottsdale and Lisburn are 18-40 km off in the attributes).
  const [lon, lat] = G.cleanVertex(f.geometry.coordinates, 4);
  const country = countryOfPlace(q, lat, lon);
  const name = tidy(q.NAME);
  const ascii = q.NAMEASCII && tidy(q.NAMEASCII) !== name ? tidy(q.NAMEASCII) : '';
  let flags = 0;
  const isStation = /station/i.test(q.FEATURECLA);
  // Other names, for search. NAME_xx come from Wikidata via Natural Earth and are clean;
  // NAMEALT has encoding damage ("Ciudad de M", "F-s"), so fragments of three characters or
  // fewer, or ending in a lone letter, are dropped; NAMEPAR holds the operating country for
  // Antarctic stations ("USA"), so it is skipped for them. MEGANAME and LS_NAME are unused
  // (damaged: "Ciudad de Mdxico", "St. Petersburg1").
  const alt = [];
  const seen = new Set([foldName(name), foldName(ascii || name)]);
  const addAlt = (s) => {
    const t = tidy(s);
    const k = foldName(t);
    if (!t || !k || seen.has(k)) return;
    seen.add(k);
    alt.push(t);
  };
  for (const l of ALT_NAME_FIELDS) addAlt(q[l]);
  if (!isStation) addAlt(q.NAMEPAR);
  for (const s of q.NAMEALT ? q.NAMEALT.split(/[|,;]/) : []) {
    const t = s.trim();
    if (t.length > 3 && !/\s\S$/u.test(t)) addAlt(t);
  }
  if (/^Admin-0 capital/.test(q.FEATURECLA)) flags |= FLAG_CAPITAL;
  if (/^Admin-1 (region )?capital|^Admin-0 region capital/.test(q.FEATURECLA)) flags |= FLAG_ADMIN1_CAPITAL;
  if (isStation) flags |= FLAG_STATION;

  let zone = -1;
  if (q.TIMEZONE) {
    const ownIso = new Set();
    if (/^[A-Z]{2}$/.test(q.ISO_A2 ?? '')) ownIso.add(q.ISO_A2);
    if (countries[country].zoneIso) ownIso.add(countries[country].zoneIso);
    const iso = new Set(ownIso);
    const hit = countryLocator(lat, lon, MARGIN_KM);
    if (hit && countries[hit.key].zoneIso) iso.add(countries[hit.key].zoneIso);
    const res = cleanZone(q.TIMEZONE, lat, lon, iso, ownIso, [name, ascii]);
    if (res.modernised) modernisedCount++;
    if (res.corrected) {
      flags |= FLAG_ZONE_CORRECTED;
      corrections.push({ place: name, country: countries[country].name, from: res.corrected.from, to: res.corrected.to, rule: res.corrected.rule });
    }
    zone = zoneIdx(res.zone);
  }
  const lookup = countries[country].lookup;
  const region = lookup >= 0 ? locateRegion(lat, lon, lookup) : -1;
  const rank = Number.isInteger(q.LABELRANK) && q.LABELRANK >= 0 && q.LABELRANK <= 10 ? q.LABELRANK : 10;
  places.push({
    name,
    ascii,
    alt: alt.join('|'),
    country,
    admin1: cleanAdmin1(q.ADM1NAME),
    lat,
    lon,
    pop: Math.max(0, Math.round(q.POP_MAX ?? 0)),
    rank,
    minzoom: num(q.MIN_ZOOM) ?? 10,
    zone,
    region,
    flags,
  });
}
places.sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name, 'en') || a.lat - b.lat);

// zone.tab principal locations become anchors of their country (and state) as well.
const anchors = [];
for (const e of zoneTab) {
  const [lat, lon] = [G.round(e.lat, 4), G.round(e.lon, 4)];
  let country = -1;
  const sameIso = countries.map((c, i) => (c.zoneIso === e.country && c.lookup === i ? i : -1)).filter((i) => i >= 0);
  if (sameIso.length === 1) country = sameIso[0];
  else if (sameIso.length > 1) {
    const hit = countryLocator(lat, lon, 1000, (k) => sameIso.includes(k));
    country = hit ? hit.key : sameIso[0];
  } else {
    const hit = countryLocator(lat, lon, MARGIN_KM);
    if (hit) country = hit.key;
    else {
      const existing = countries.findIndex((c) => c.iso === e.country);
      if (existing >= 0) country = existing;
      else {
        countries.push({ name: iso3166.get(e.country) ?? e.country, iso: e.country, a3: '', lookup: -1, zoneIso: e.country });
        country = countries.length - 1;
      }
    }
  }
  const lookup = countries[country].lookup;
  const region = lookup >= 0 ? locateRegion(lat, lon, lookup) : -1;
  anchors.push({ zone: zoneIdx(e.zone), country, region, lat, lon, comment: e.comment });
}

// Same-clock alternatives for every zone, for browsers whose Intl data predates a zone
// (America/Coyhaique was added in 2025): other zone.tab zones whose offsets agree on the
// 1st and 15th of every month of 2025-2026, same country first, then the most used.
const zoneUse = new Map();
for (const p of places) if (p.zone >= 0) zoneUse.set(p.zone, (zoneUse.get(p.zone) ?? 0) + 1);
const zoneCountry = new Map(zoneTab.map((e) => [e.zone, e.country]));
const zoneAlternatives = {};
for (const z of zones) {
  const sig = TZ.rulesSignature(z);
  const alts = zones
    .map((y, j) => ({ y, j }))
    .filter(({ y }) => y !== z && TZ.rulesSignature(y) === sig)
    .sort(
      (a, b) =>
        Number(zoneCountry.get(b.y) === zoneCountry.get(z)) - Number(zoneCountry.get(a.y) === zoneCountry.get(z)) ||
        (zoneUse.get(b.j) ?? 0) - (zoneUse.get(a.j) ?? 0) ||
        a.y.localeCompare(b.y),
    )
    .slice(0, 2)
    .map(({ y }) => y);
  if (alts.length) zoneAlternatives[z] = alts;
}

// Review aid: places whose zone's principal location is much farther away than the
// nearest zone of their own country (possible wrong zone within a country). Printed only.
{
  const suspects = [];
  for (const p of places) {
    if (p.zone < 0) continue;
    const iso = countries[p.country].zoneIso;
    const own = zoneTabByIso.get(iso) ?? [];
    if (own.length < 2) continue;
    const z = zones[p.zone];
    const locs = zoneTab.filter((e) => canon(e.zone) === canon(z));
    if (!locs.length) continue;
    const dz = Math.min(...locs.map((e) => G.haversineKm(p.lat, p.lon, e.lat, e.lon)));
    const dn = Math.min(...own.map((e) => G.haversineKm(p.lat, p.lon, e.lat, e.lon)));
    if (dz - dn > 1500) suspects.push(`${p.name} (${countries[p.country].name}) ${z}: ${dz.toFixed(0)} km vs nearest own-country zone ${dn.toFixed(0)} km`);
  }
  if (suspects.length) console.log(`\nreview (not changed): ${suspects.length} places far from their zone's principal location\n  ${suspects.join('\n  ')}\n`);
}

// ---------------------------------------------------------------------------------------
// Write the gazetteer

const icu = `Node ${process.version} (ICU ${process.versions.icu}, tz ${process.versions.tz})`;
const gazetteer = {
  format: 'skyfix.gazetteer/1',
  about:
    'Places for search and "near ...", with IANA time zones, and the countries, states and zone anchors the time-zone guess uses. Display-only (CONVENTIONS 13.6). Built by tools/mapdata/build.mjs; see docs/THIRD_PARTY.md.',
  sources: {
    places: `Natural Earth ${sources.natural_earth.version} ne_10m_populated_places (public domain)`,
    countries: `Natural Earth ${sources.natural_earth.version} ne_50m_admin_0_countries`,
    regions: `Natural Earth ${sources.natural_earth.version} ne_50m_admin_1_states_provinces`,
    anchors: `IANA tzdata ${sources.tzdata.version} zone.tab (public domain)`,
    retrieved: BUILD_DATE,
    zone_rules_checked_with: icu,
  },
  fields: {
    countries: ['name', 'iso', 'a3', 'lookup'],
    regions: ['name', 'country', 'code'],
    anchors: ['zone', 'country', 'region', 'lat', 'lon', 'comment'],
    places: ['name', 'ascii', 'alt', 'country', 'admin1', 'lat', 'lon', 'pop', 'rank', 'minzoom', 'zone', 'region', 'flags'],
  },
  flags: { capital: FLAG_CAPITAL, admin1_capital: FLAG_ADMIN1_CAPITAL, zone_corrected: FLAG_ZONE_CORRECTED, station: FLAG_STATION },
  zone_corrections: corrections,
  zone_alternatives: zoneAlternatives,
  countries: countries.map((c) => [c.name, c.iso, c.a3, c.lookup]),
  regions: regions.map((r) => [r.name, r.country, r.code]),
  zones,
  anchors: anchors.map((a) => [a.zone, a.country, a.region, a.lat, a.lon, a.comment]),
  places: places.map((p) => [p.name, p.ascii, p.alt, p.country, p.admin1, p.lat, p.lon, p.pop, p.rank, p.minzoom, p.zone, p.region, p.flags]),
};
{
  const lines = [];
  lines.push('{');
  const keys = Object.keys(gazetteer);
  keys.forEach((k, i) => {
    const v = gazetteer[k];
    const comma = i < keys.length - 1 ? ',' : '';
    if (Array.isArray(v) && v.length && (Array.isArray(v[0]) || typeof v[0] === 'object')) {
      lines.push(`${JSON.stringify(k)}:[`);
      v.forEach((row, j) => lines.push(`${JSON.stringify(row)}${j < v.length - 1 ? ',' : ''}`));
      lines.push(`]${comma}`);
    } else {
      lines.push(`${JSON.stringify(k)}:${JSON.stringify(v)}${comma}`);
    }
  });
  lines.push('}');
  const body = `${lines.join('\n')}\n`;
  JSON.parse(body); // must stay valid JSON
  writeFileSync(join(outData, 'gazetteer.json'), body);
  const gz = zlib.gzipSync(body, { level: 9 }).length;
  manifestFiles.push({
    path: '../gazetteer.json',
    layer: 'gazetteer',
    source: 'ne_10m_populated_places + ne_50m_admin_0_countries + ne_50m_admin_1_states_provinces + tzdata zone.tab',
    places: places.length,
    places_with_zone: places.filter((p) => p.zone >= 0).length,
    zone_names_modernised: modernisedCount,
    zones_corrected: corrections.length,
    anchors: anchors.length,
    bytes: Buffer.byteLength(body),
    gzip_bytes: gz,
    sha256: sha256(body),
    use: 'Search, "near ...", and the time-zone guess (web/src/next/geo). Paths in this manifest are relative to it.',
  });
  console.log(`${'../gazetteer.json'.padEnd(28)} ${String(places.length).padStart(5)} places, ${anchors.length} anchors, ${zones.length} zones, ${(Buffer.byteLength(body) / 1024).toFixed(0)} KB  gz ${(gz / 1024).toFixed(0)} KB`);
  console.log(`  zones: ${places.filter((p) => p.zone >= 0).length} places have one; ${modernisedCount} legacy names modernised; ${corrections.length} corrected:`);
  for (const c of corrections) console.log(`    [${c.rule}] ${c.place} (${c.country}): ${c.from} -> ${c.to}`);
}

// ---------------------------------------------------------------------------------------
// Manifest

const total = manifestFiles.reduce((a, f) => a + f.bytes, 0);
const totalGz = manifestFiles.reduce((a, f) => a + f.gzip_bytes, 0);
const manifest = {
  format: 'skyfix.basemap/1',
  about:
    'Offline map data for the explorer. Display-only (CONVENTIONS 13.6): nothing here feeds sight reduction, the solver or any accuracy claim. Paths are relative to this file.',
  generated: BUILD_DATE,
  generator: 'node tools/mapdata/fetch.mjs && node tools/mapdata/build.mjs',
  built_with: icu,
  sources: [
    {
      name: 'Natural Earth',
      version: sources.natural_earth.version,
      url: sources.natural_earth.release,
      terms: sources.natural_earth.terms,
      licence: 'Public domain. "No permission is needed to use Natural Earth. Crediting the authors is unnecessary."',
      retrieved: BUILD_DATE,
    },
    {
      name: 'IANA time zone database',
      version: sources.tzdata.version,
      url: sources.tzdata.url,
      licence: 'Public domain (tzdata LICENSE)',
      retrieved: BUILD_DATE,
    },
  ],
  conventions: {
    coordinates: 'GeoJSON [lon, lat], degrees, longitude east-positive (CONVENTIONS section 2), within [-180, 180]',
    antimeridian:
      'Polygons are split at +/-180 and meet exactly there; no segment spans more than 180 degrees of longitude; stroke coastline-*.geojson, never the land polygons',
    winding: 'RFC 7946: exterior rings counter-clockwise, holes clockwise',
    minzoom: "Natural Earth's own suggested zoom, defined for 256-pixel tiles: subtract 1 for MapLibre's 512-pixel tiles",
  },
  total_bytes: total,
  total_gzip_bytes: totalGz,
  files: manifestFiles,
};
writeFileSync(join(outBasemap, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\ntotal ${(total / 1024).toFixed(0)} KB, gzip ${(totalGz / 1024).toFixed(0)} KB (budget 3072 KB)`);
if (totalGz > 3 * 1024 * 1024) {
  console.error('over the 3 MB gzip budget');
  process.exit(1);
}
