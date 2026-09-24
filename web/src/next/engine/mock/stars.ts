/**
 * MOCK ENGINE ONLY — stars for developing the interface.
 *
 * - The 58 navigational stars: positions from the project's own catalogue extract
 *   (`fixtures/reference/navigational_stars_hip.json`, Hipparcos; attribution and
 *   licence decision in docs/THIRD_PARTY.md), propagated from J1991.25 to J2000.0 with
 *   the catalogue proper motions and rounded to 0.0001 deg. A test checks this table
 *   against the fixture so the two cannot drift apart. B-V colours are approximate.
 * - Fourteen more bright stars, so that four constellation figures (Orion, the Plough
 *   in Ursa Major, Crux, Cassiopeia) can be drawn: approximate J2000 positions rounded
 *   to 0.01 deg, magnitudes to 0.01. Illustrative.
 * - A deterministic synthetic field (pseudo-random positions, magnitudes 3-6.5 with a
 *   realistic count-magnitude slope, plausible colours): NOT real stars.
 * - `constellationAt`: along the ecliptic, the zodiac constellation by ecliptic
 *   longitude (approximate IAU boundaries); elsewhere, the constellation of the nearest
 *   named star. Illustrative only.
 */

import type { ConstellationBoundary, ConstellationFigure, StarfieldCatalog } from '../types.js';
import { equatorialToEcliptic, norm360, obliquityDeg, unitVector, type Vec3 } from './astro.js';

/** name, HIP, RA J2000 (deg), Dec J2000 (deg), V, B-V, designation, constellation. */
type StarRow = readonly [string, number, number, number, number, number, string, string];

/** The 58 navigational stars in catalogue order (the Rust `catalog::names()` order). */
export const NAV_STAR_ROWS: readonly StarRow[] = [
  ['Acamar', 13847, 44.5653, -40.3047, 2.88, 0.13, 'θ¹ Eri', 'Eri'],
  ['Achernar', 7588, 24.4285, -57.2368, 0.45, -0.16, 'α Eri', 'Eri'],
  ['Acrux', 60718, 186.6496, -63.0991, 0.77, -0.24, 'α¹ Cru', 'Cru'],
  ['Adhara', 33579, 104.6565, -28.9721, 1.5, -0.21, 'ε CMa', 'CMa'],
  ['Aldebaran', 21421, 68.9802, 16.5093, 0.87, 1.54, 'α Tau', 'Tau'],
  ['Alioth', 62956, 193.5073, 55.9598, 1.76, -0.02, 'ε UMa', 'UMa'],
  ['Alkaid', 67301, 206.8852, 49.3133, 1.85, -0.19, 'η UMa', 'UMa'],
  ["Al Na'ir", 109268, 332.0583, -46.961, 1.73, -0.07, 'α Gru', 'Gru'],
  ['Alnilam', 26311, 84.0534, -1.2019, 1.69, -0.18, 'ε Ori', 'Ori'],
  ['Alphard', 46390, 141.8968, -8.6586, 1.99, 1.44, 'α Hya', 'Hya'],
  ['Alphecca', 76267, 233.672, 26.7147, 2.22, -0.02, 'α CrB', 'CrB'],
  ['Alpheratz', 677, 2.0969, 29.0904, 2.07, -0.11, 'α And', 'And'],
  ['Altair', 97649, 297.6958, 8.8683, 0.76, 0.22, 'α Aql', 'Aql'],
  ['Ankaa', 2081, 6.571, -42.306, 2.4, 1.09, 'α Phe', 'Phe'],
  ['Antares', 80763, 247.3519, -26.432, 1.06, 1.83, 'α Sco', 'Sco'],
  ['Arcturus', 69673, 213.9153, 19.1824, -0.05, 1.23, 'α Boo', 'Boo'],
  ['Atria', 82273, 252.1662, -69.0277, 1.91, 1.44, 'α TrA', 'TrA'],
  ['Avior', 41037, 125.6285, -59.5095, 1.86, 1.28, 'ε Car', 'Car'],
  ['Bellatrix', 25336, 81.2828, 6.3497, 1.64, -0.22, 'γ Ori', 'Ori'],
  ['Betelgeuse', 27989, 88.7929, 7.4071, 0.45, 1.85, 'α Ori', 'Ori'],
  ['Canopus', 30438, 95.988, -52.6957, -0.62, 0.15, 'α Car', 'Car'],
  ['Capella', 24608, 79.1723, 45.998, 0.08, 0.8, 'α Aur', 'Aur'],
  ['Deneb', 102098, 310.358, 45.2803, 1.25, 0.09, 'α Cyg', 'Cyg'],
  ['Denebola', 57632, 177.2649, 14.5721, 2.14, 0.09, 'β Leo', 'Leo'],
  ['Diphda', 3419, 10.8974, -17.9866, 2.04, 1.02, 'β Cet', 'Cet'],
  ['Dubhe', 54061, 165.932, 61.751, 1.81, 1.07, 'α UMa', 'UMa'],
  ['Elnath', 25428, 81.573, 28.6075, 1.65, -0.13, 'β Tau', 'Tau'],
  ['Eltanin', 87833, 269.1515, 51.4889, 2.24, 1.52, 'γ Dra', 'Dra'],
  ['Enif', 107315, 326.0465, 9.875, 2.38, 1.53, 'ε Peg', 'Peg'],
  ['Fomalhaut', 113368, 344.4127, -29.6222, 1.17, 0.09, 'α PsA', 'PsA'],
  ['Gacrux', 61084, 187.7915, -57.1132, 1.59, 1.6, 'γ Cru', 'Cru'],
  ['Gienah', 59803, 183.9515, -17.5419, 2.58, -0.11, 'γ Crv', 'Crv'],
  ['Hadar', 68702, 210.9559, -60.373, 0.61, -0.23, 'β Cen', 'Cen'],
  ['Hamal', 9884, 31.7934, 23.4624, 2.01, 1.15, 'α Ari', 'Ari'],
  ['Kaus Australis', 90185, 276.043, -34.3846, 1.79, -0.03, 'ε Sgr', 'Sgr'],
  ['Kochab', 72607, 222.6764, 74.1555, 2.07, 1.47, 'β UMi', 'UMi'],
  ['Markab', 113963, 346.1902, 15.2053, 2.49, -0.04, 'α Peg', 'Peg'],
  ['Menkar', 14135, 45.5699, 4.0897, 2.54, 1.64, 'α Cet', 'Cet'],
  ['Menkent', 68933, 211.6706, -36.37, 2.06, 1.01, 'θ Cen', 'Cen'],
  ['Miaplacidus', 45238, 138.2999, -69.7172, 1.67, 0.07, 'β Car', 'Car'],
  ['Mirfak', 15863, 51.0807, 49.8612, 1.79, 0.48, 'α Per', 'Per'],
  ['Nunki', 92855, 283.8164, -26.2967, 2.05, -0.13, 'σ Sgr', 'Sgr'],
  ['Peacock', 100751, 306.4119, -56.7351, 1.94, -0.2, 'α Pav', 'Pav'],
  ['Pollux', 37826, 116.329, 28.0262, 1.16, 1.0, 'β Gem', 'Gem'],
  ['Procyon', 37279, 114.8255, 5.225, 0.4, 0.42, 'α CMi', 'CMi'],
  ['Rasalhague', 86032, 263.7336, 12.56, 2.08, 0.16, 'α Oph', 'Oph'],
  ['Regulus', 49669, 152.093, 11.9672, 1.36, -0.11, 'α Leo', 'Leo'],
  ['Rigel', 24436, 78.6345, -8.2016, 0.18, -0.03, 'β Ori', 'Ori'],
  ['Rigil Kentaurus', 71683, 219.9021, -60.834, -0.01, 0.71, 'α¹ Cen', 'Cen'],
  ['Sabik', 84012, 257.5945, -15.7249, 2.43, 0.06, 'η Oph', 'Oph'],
  ['Schedar', 3179, 10.1268, 56.5373, 2.24, 1.17, 'α Cas', 'Cas'],
  ['Shaula', 85927, 263.4022, -37.1038, 1.62, -0.22, 'λ Sco', 'Sco'],
  ['Sirius', 32349, 101.2872, -16.7161, -1.44, 0.0, 'α CMa', 'CMa'],
  ['Spica', 65474, 201.2982, -11.1613, 0.98, -0.23, 'α Vir', 'Vir'],
  ['Suhail', 44816, 136.999, -43.4326, 2.23, 1.66, 'λ Vel', 'Vel'],
  ['Vega', 91262, 279.2347, 38.7837, 0.03, 0.0, 'α Lyr', 'Lyr'],
  ['Zubenelgenubi', 72622, 222.7196, -16.0418, 2.75, 0.15, 'α² Lib', 'Lib'],
  ['Polaris', 11767, 37.9545, 89.2641, 1.97, 0.6, 'α UMi', 'UMi'],
];

/** More bright stars for the figures. Approximate; HIP 0 = not given. */
export const FIGURE_STAR_ROWS: readonly StarRow[] = [
  ['Mintaka', 0, 83.0, -0.3, 2.23, -0.22, 'δ Ori', 'Ori'],
  ['Alnitak', 0, 85.19, -1.94, 1.77, -0.21, 'ζ Ori', 'Ori'],
  ['Saiph', 0, 86.94, -9.67, 2.06, -0.17, 'κ Ori', 'Ori'],
  ['Meissa', 0, 83.78, 9.93, 3.39, -0.16, 'λ Ori', 'Ori'],
  ['Merak', 0, 165.46, 56.38, 2.37, -0.02, 'β UMa', 'UMa'],
  ['Phecda', 0, 178.46, 53.69, 2.44, 0.0, 'γ UMa', 'UMa'],
  ['Megrez', 0, 183.86, 57.03, 3.31, 0.08, 'δ UMa', 'UMa'],
  ['Mizar', 0, 200.98, 54.93, 2.27, 0.02, 'ζ UMa', 'UMa'],
  ['Mimosa', 0, 191.93, -59.69, 1.25, -0.23, 'β Cru', 'Cru'],
  ['Imai', 0, 183.79, -58.75, 2.79, -0.23, 'δ Cru', 'Cru'],
  ['Caph', 0, 2.29, 59.15, 2.28, 0.34, 'β Cas', 'Cas'],
  ['Navi', 0, 14.18, 60.72, 2.47, -0.15, 'γ Cas', 'Cas'],
  ['Ruchbah', 0, 21.45, 60.24, 2.68, 0.13, 'δ Cas', 'Cas'],
  ['Segin', 0, 28.6, 63.67, 3.37, -0.15, 'ε Cas', 'Cas'],
];

const FIGURES: readonly { abbr: string; name: string; lines: readonly (readonly [string, string])[] }[] = [
  {
    abbr: 'Ori',
    name: 'Orion',
    lines: [
      ['Meissa', 'Betelgeuse'],
      ['Meissa', 'Bellatrix'],
      ['Betelgeuse', 'Bellatrix'],
      ['Betelgeuse', 'Alnitak'],
      ['Bellatrix', 'Mintaka'],
      ['Mintaka', 'Alnilam'],
      ['Alnilam', 'Alnitak'],
      ['Alnitak', 'Saiph'],
      ['Mintaka', 'Rigel'],
      ['Saiph', 'Rigel'],
    ],
  },
  {
    abbr: 'UMa',
    name: 'Ursa Major',
    lines: [
      ['Dubhe', 'Merak'],
      ['Merak', 'Phecda'],
      ['Phecda', 'Megrez'],
      ['Megrez', 'Dubhe'],
      ['Megrez', 'Alioth'],
      ['Alioth', 'Mizar'],
      ['Mizar', 'Alkaid'],
    ],
  },
  {
    abbr: 'Cru',
    name: 'Crux',
    lines: [
      ['Acrux', 'Gacrux'],
      ['Mimosa', 'Imai'],
    ],
  },
  {
    abbr: 'Cas',
    name: 'Cassiopeia',
    lines: [
      ['Caph', 'Schedar'],
      ['Schedar', 'Navi'],
      ['Navi', 'Ruchbah'],
      ['Ruchbah', 'Segin'],
    ],
  },
];

/** Where the ecliptic enters each zodiac constellation, J2000 ecliptic longitude (approximate IAU boundaries). */
const ZODIAC: readonly (readonly [string, number])[] = [
  ['Ari', 28.7],
  ['Tau', 53.4],
  ['Gem', 90.1],
  ['Cnc', 118.0],
  ['Leo', 138.1],
  ['Vir', 174.1],
  ['Lib', 217.8],
  ['Sco', 241.1],
  ['Oph', 247.6],
  ['Sgr', 266.3],
  ['Cap', 299.7],
  ['Aqr', 327.6],
  ['Psc', 351.6],
];

// Deterministic pseudo-random numbers (mulberry32), the same generator the old mock uses.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MockStarfield {
  catalog: StarfieldCatalog;
  /** J2000 unit vectors, 3 per star. */
  unit: Float64Array;
  boundaries: ConstellationBoundary[];
  /** Named stars (navigational and figure) for the constellation look-up. */
  anchors: { unit: Vec3; con: string }[];
}

export interface StarfieldOptions {
  /** Number of synthetic stars. Default 2000. */
  synthetic?: number;
  seed?: number;
}

export function buildStarfield(options: StarfieldOptions = {}): MockStarfield {
  const synthetic = Math.max(0, Math.floor(options.synthetic ?? 2000));
  const rng = mulberry32(options.seed ?? 0x5eed5);
  const named = [...NAV_STAR_ROWS, ...FIGURE_STAR_ROWS];
  const count = named.length + synthetic;
  const hr = new Int32Array(count);
  const vmag = new Float32Array(count);
  const bv = new Float32Array(count);
  const unit = new Float64Array(3 * count);
  const designations: string[] = [];
  const names: { index: number; name: string }[] = [];
  const index = new Map<string, number>();

  const put = (i: number, ra: number, dec: number, v: number, colour: number): void => {
    const u = unitVector(ra, dec);
    unit[3 * i] = u[0];
    unit[3 * i + 1] = u[1];
    unit[3 * i + 2] = u[2];
    vmag[i] = v;
    bv[i] = colour;
    hr[i] = -(i + 1); // placeholder numbers: negative, so never mistaken for real HR numbers
  };

  named.forEach(([name, , ra, dec, v, colour, designation], i) => {
    put(i, ra, dec, v, colour);
    designations.push(designation);
    names.push({ index: i, name });
    index.set(name, i);
  });

  for (let k = 0; k < synthetic; k += 1) {
    const i = named.length + k;
    const z = 2 * rng() - 1;
    const ra = 360 * rng();
    const dec = (Math.asin(z) * 180) / Math.PI;
    // N(<m) grows as 10^(0.5 m): m = 6.5 + 2 log10(u), kept within 3..6.5.
    let m = 6.5 + 2 * Math.log10(Math.max(rng(), 1e-9));
    if (m < 3) m = 3 + 3.5 * rng();
    const g = Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) * Math.cos(2 * Math.PI * rng());
    const colour = rng() < 0.02 ? Number.NaN : Math.max(-0.3, Math.min(2.0, 0.6 + 0.45 * g));
    put(i, ra, dec, Math.round(m * 100) / 100, colour);
    designations.push('');
  }

  const at = (name: string): number => {
    const i = index.get(name);
    if (i === undefined) throw new Error(`mock star field: no star ${name}`);
    return i;
  };

  const constellations: ConstellationFigure[] = FIGURES.map((fig) => {
    const lines = fig.lines.map(([a, b]) => [at(a), at(b)] as [number, number]);
    const members = [...new Set(lines.flat())];
    const sum: Vec3 = [0, 0, 0];
    for (const i of members) {
      sum[0] += unit[3 * i]!;
      sum[1] += unit[3 * i + 1]!;
      sum[2] += unit[3 * i + 2]!;
    }
    const r = Math.hypot(sum[0], sum[1], sum[2]);
    return {
      abbr: fig.abbr,
      name: fig.name,
      lines,
      label_ra_deg: norm360((Math.atan2(sum[1], sum[0]) * 180) / Math.PI),
      label_dec_deg: (Math.asin(sum[2] / r) * 180) / Math.PI,
    };
  });

  // Illustrative boundaries: an RA/Dec box 3 deg larger than each figure.
  const boundaries: ConstellationBoundary[] = FIGURES.map((fig) => {
    const members = [...new Set(fig.lines.flat())].map((n) => named[at(n)]!);
    const ras = members.map((row) => row[2]);
    const decs = members.map((row) => row[3]);
    const [r0, r1] = [Math.min(...ras) - 3, Math.max(...ras) + 3];
    const [d0, d1] = [Math.max(-90, Math.min(...decs) - 3), Math.min(90, Math.max(...decs) + 3)];
    return {
      abbr: fig.abbr,
      ra_deg: Float64Array.from([r0, r1, r1, r0, r0].map(norm360)),
      dec_deg: Float64Array.from([d0, d0, d1, d1, d0]),
    };
  });

  const catalog: StarfieldCatalog = {
    count,
    hr,
    vmag,
    bv,
    names,
    designations,
    navigational: NAV_STAR_ROWS.map(([name]) => ({ name, index: at(name) })),
    constellations,
    source:
      'MOCK star field: the 58 navigational stars from the project catalogue, 14 more bright stars at approximate positions, and ' +
      `${synthetic} synthetic stars placed pseudo-randomly. Illustrative only; not a star catalogue.`,
    licence: 'Mock data for interface development (see docs/THIRD_PARTY.md, "Mock explorer engine").',
  };

  const anchors = named.map(([, , ra, dec, , , , con]) => ({ unit: unitVector(ra, dec), con }));
  return { catalog, unit, boundaries, anchors };
}

/**
 * Illustrative constellation look-up: zodiac by ecliptic longitude within 12 deg of the
 * ecliptic, else the constellation of the nearest named star.
 */
export function mockConstellationAt(
  field: MockStarfield,
  raDeg: number,
  decDeg: number,
  t: number,
): string {
  const { lon_deg, lat_deg } = equatorialToEcliptic(raDeg, decDeg, obliquityDeg(t));
  if (Math.abs(lat_deg) <= 12) {
    // Back to J2000 longitudes (general precession, 1.397 deg per century).
    const lon = norm360(lon_deg - 1.3969713 * t);
    let abbr = ZODIAC[ZODIAC.length - 1]![0];
    for (const [a, start] of ZODIAC) if (lon >= start) abbr = a;
    // Pisces also covers 0 .. 28.7, before Aries starts.
    return lon < ZODIAC[0]![1] ? 'Psc' : abbr;
  }
  const u = unitVector(raDeg, decDeg);
  let best = -2;
  let con = 'UMi';
  for (const a of field.anchors) {
    const dot = a.unit[0] * u[0] + a.unit[1] * u[1] + a.unit[2] * u[2];
    if (dot > best) {
      best = dot;
      con = a.con;
    }
  }
  return con;
}
