/**
 * The Sky view's star placement (src/next/sky/astro.ts): the pure geometry, then
 * agreement with the engine's own `skyState` for the 58 navigational stars — against the
 * mock always, and against the real WebAssembly core whenever a complete build is in
 * `src/wasm-pkg` (`npm run wasm`) or `SKYFIX_WASM_PKG` names one. Requirement: the
 * stars the view draws sit within 0.01° of where `sky_state` says they are.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { ExplorerEngine, Observer } from '../../src/next/engine/types.js';
import { inspectWasmModule, type WasmLoad } from '../../src/next/engine/wasm.js';
import {
  apparentAltitudeDeg,
  brightLimbScreenAngle,
  DEG,
  greatCircleUnits,
  horizonBatch,
  horizonMatrix,
  limitingMagnitude,
  localSiderealDeg,
  meanObliquityDeg,
  RAD,
  refractionArcmin,
  refractionScale,
  rotateUnits,
  starAltAz,
  unitFromRaDec,
  unitsFromRaDecArray,
} from '../../src/next/sky/astro.js';

// ---------------------------------------------------------------------------
// Pure geometry
// ---------------------------------------------------------------------------

describe('display refraction (CONVENTIONS 13.2)', () => {
  it('is Saemundsson evaluated at max(h, −1°), in arcminutes', () => {
    expect(refractionArcmin(0)).toBeCloseTo(1.02 / Math.tan((10.3 / 5.11) * DEG), 12);
    expect(refractionArcmin(0)).toBeCloseTo(28.98, 2);
    expect(refractionArcmin(45)).toBeCloseTo(1.0127, 3);
    // Below −1° the value at −1° is used, as in the engine.
    expect(refractionArcmin(-5)).toBe(refractionArcmin(-1));
    expect(refractionArcmin(-1)).toBeCloseTo(38.8, 1);
  });

  it('scales with pressure and temperature, 1 at 1010 hPa and 10 °C', () => {
    expect(refractionScale()).toBe(1);
    expect(refractionScale(1010, 10)).toBe(1);
    expect(refractionArcmin(10, refractionScale(505, 10))).toBeCloseTo(refractionArcmin(10) / 2, 12);
    expect(apparentAltitudeDeg(30)).toBeCloseTo(30 + refractionArcmin(30) / 60, 12);
  });
});

describe('horizon frame', () => {
  it('is a rotation (orthonormal rows)', () => {
    const m = horizonMatrix(123.4, -33.9);
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        const dot = m[3 * i]! * m[3 * j]! + m[3 * i + 1]! * m[3 * j + 1]! + m[3 * i + 2]! * m[3 * j + 2]!;
        expect(dot).toBeCloseTo(i === j ? 1 : 0, 14);
      }
    }
  });

  it('puts a star whose declination is the latitude, on the meridian, at the zenith', () => {
    const lst = 210;
    const lat = 39.9526;
    const r = starAltAz(lst * DEG, lat * DEG, lst - -75.1652, lat, -75.1652);
    expect(r.alt_deg).toBeCloseTo(90, 9);
  });

  it('measures azimuth from true north clockwise (CONVENTIONS 2)', () => {
    // On the equator, a star on the celestial equator 6 h east of the meridian rises due east.
    const east = starAltAz(90 * DEG, 0, 0, 0, 0);
    expect(east.alt_deg).toBeCloseTo(0, 9);
    expect(east.az_deg).toBeCloseTo(90, 9);
    const west = starAltAz(270 * DEG, 0, 0, 0, 0);
    expect(west.az_deg).toBeCloseTo(270, 9);
    // The celestial pole stands due north at the latitude's height.
    const pole = starAltAz(0, 90 * DEG, 17, 51.5, 0);
    expect(pole.alt_deg).toBeCloseTo(51.5, 9);
    expect(pole.az_deg === 0 || Math.abs(pole.az_deg - 360) < 1e-9).toBe(true);
    // A southern observer sees the south pole due south.
    const south = starAltAz(1, -90 * DEG, 17, -33.9, 151);
    expect(south.alt_deg).toBeCloseTo(33.9, 9);
    expect(south.az_deg).toBeCloseTo(180, 9);
  });

  it('agrees with the textbook formulas of CONVENTIONS 3 for arbitrary directions', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 200; k += 1) {
      const ra = 2 * Math.PI * rnd();
      const dec = Math.asin(2 * rnd() - 1);
      const gha = 360 * rnd();
      const lat = 180 * rnd() - 90;
      const lon = 360 * rnd() - 180;
      const r = starAltAz(ra, dec, gha, lat, lon);
      const lha = (localSiderealDeg(gha, lon) - ra * RAD) * DEG;
      const phi = lat * DEG;
      const sinH = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(lha);
      const n = Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(lha);
      const e = -Math.cos(dec) * Math.sin(lha);
      expect(r.alt_deg).toBeCloseTo(Math.asin(sinH) * RAD, 9);
      const zn = ((Math.atan2(e, n) * RAD) % 360 + 360) % 360;
      const dz = Math.abs(((r.az_deg - zn + 540) % 360) - 180) * Math.cos(r.alt_deg * DEG);
      expect(dz).toBeLessThan(1e-9);
    }
  });

  it('batch conversion equals the one-star reference, without allocating per star', () => {
    const count = 500;
    const radec = new Float64Array(2 * count);
    let seed = 11;
    const rnd = (): number => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i += 1) {
      radec[2 * i] = 2 * Math.PI * rnd();
      radec[2 * i + 1] = Math.asin(2 * rnd() - 1);
    }
    const units = new Float64Array(3 * count);
    unitsFromRaDecArray(radec, count, units);
    const gha = 211.7;
    const lat = -41.3;
    const lon = 174.8;
    const m = horizonMatrix(localSiderealDeg(gha, lon), lat);
    const alt = new Float64Array(count);
    const az = new Float64Array(count);
    horizonBatch(units, count, m, 1, alt, az);
    for (let i = 0; i < count; i += 1) {
      const r = starAltAz(radec[2 * i]!, radec[2 * i + 1]!, gha, lat, lon);
      expect(alt[i]! * RAD).toBeCloseTo(r.alt_apparent_deg, 9);
      expect(Math.abs(((az[i]! * RAD - r.az_deg + 540) % 360) - 180)).toBeLessThan(1e-7);
    }
  });

  it('rotates unit vectors with a row-major matrix', () => {
    const v = new Float64Array(3);
    unitFromRaDec(0, 0, v);
    const out = new Float64Array(3);
    rotateUnits([0, -1, 0, 1, 0, 0, 0, 0, 1], v, 1, out); // +90° about z
    expect([...out].map((x) => Math.round(x * 1e12) / 1e12)).toEqual([0, 1, 0]);
  });
});

describe('reference circles', () => {
  it('draws the equator at declination 0 and the ecliptic at the obliquity', () => {
    const eq = greatCircleUnits(0, 73);
    for (let k = 0; k < 73; k += 1) expect(eq[3 * k + 2]).toBeCloseTo(0, 15);
    const eps = meanObliquityDeg(2_461_308);
    expect(eps).toBeCloseTo(23.436, 3); // 2026: 23° 26′ 10″
    const ecl = greatCircleUnits(eps, 361);
    // Every point is 90° from the ecliptic pole (RA 270°, Dec 90° − ε).
    const pole = new Float64Array(3);
    unitFromRaDec(270 * DEG, (90 - eps) * DEG, pole);
    for (let k = 0; k < 361; k += 1) {
      const dot = ecl[3 * k]! * pole[0]! + ecl[3 * k + 1]! * pole[1]! + ecl[3 * k + 2]! * pole[2]!;
      expect(dot).toBeCloseTo(0, 14);
    }
    // Longitude 90° is the most northern point, at declination +ε.
    expect(Math.asin(ecl[3 * 90 + 2]!) * RAD).toBeCloseTo(eps, 10);
  });
});

describe('phase orientation on screen', () => {
  const up = { x: 0, y: -1 };
  it('turns counterclockwise from the zenith as the observer sees it', () => {
    // Bright limb toward the zenith.
    expect(brightLimbScreenAngle(30, 30, up.x, up.y)).toBeCloseTo(-Math.PI / 2, 12);
    // 90° counterclockwise from up is left on screen.
    expect(Math.abs(brightLimbScreenAngle(90, 0, up.x, up.y))).toBeCloseTo(Math.PI, 12);
    // 270° (= −90°) is right.
    expect(brightLimbScreenAngle(270, 0, up.x, up.y)).toBeCloseTo(0, 12);
    // In the dome, "up" at a point right of the centre points left.
    expect(Math.abs(brightLimbScreenAngle(0, 0, -1, 0))).toBeCloseTo(Math.PI, 12);
  });
});

describe('limiting magnitude', () => {
  it('fades from 6.5 at night to about −1.5 by day, monotonically', () => {
    expect(limitingMagnitude(-30)).toBe(6.5);
    expect(limitingMagnitude(-18)).toBe(6.5);
    expect(limitingMagnitude(30)).toBe(-1.5);
    let last = Infinity;
    for (let h = -25; h <= 20; h += 0.5) {
      const m = limitingMagnitude(h);
      expect(m).toBeLessThanOrEqual(last);
      last = m;
    }
    expect(limitingMagnitude(Number.NaN)).toBe(6.5);
  });
});

// ---------------------------------------------------------------------------
// Agreement with sky_state for the navigational stars
// ---------------------------------------------------------------------------

const PLACES: { name: string; observer: Observer }[] = [
  { name: 'Philadelphia', observer: { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 12 } },
  { name: 'Sydney', observer: { lat_deg: -33.8568, lon_deg: 151.2153, height_m: 0 } },
  { name: 'Quito', observer: { lat_deg: -0.1807, lon_deg: -78.4678, height_m: 2850 } },
  { name: 'Tromsø', observer: { lat_deg: 69.6492, lon_deg: 18.9553, height_m: 0 } },
  { name: 'McMurdo', observer: { lat_deg: -77.85, lon_deg: 166.67, height_m: 10 } },
  { name: 'Greenwich', observer: { lat_deg: 51.4779, lon_deg: -0.0015, height_m: 46 } },
];

const ISO_TIMES = [
  '1990-01-01T00:00:00Z',
  '2000-01-01T12:00:00Z',
  '2026-09-24T02:30:00Z',
  '2026-12-21T17:45:10Z',
  '2045-06-21T18:30:00Z',
  '2060-12-31T00:00:00Z',
];
const jdOf = (iso: string): number => Date.parse(iso) / 86_400_000 + 2_440_587.5;

interface Agreement {
  cases: number;
  /** Largest |Δ apparent altitude|, degrees. */
  maxAlt: number;
  /** Largest angle between the two apparent directions, degrees. */
  maxSep: number;
  /** Largest |Δ RA cos Dec| or |Δ Dec| between the star field and sky_state (catalogues), degrees. */
  maxRaDec: number;
  /**
   * The geometry alone: sky_state's own RA/Dec through this module, against its own
   * apparent altitude and azimuth (separation, degrees).
   */
  maxGeometry: number;
}

/** Angle between two (altitude, azimuth) directions, radians in, degrees out; exact for tiny angles. */
function separationDeg(h1: number, a1: number, h2: number, a2: number): number {
  const u = [Math.cos(h1) * Math.sin(a1), Math.cos(h1) * Math.cos(a1), Math.sin(h1)] as const;
  const v = [Math.cos(h2) * Math.sin(a2), Math.cos(h2) * Math.cos(a2), Math.sin(h2)] as const;
  const cross = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  return Math.atan2(cross, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) * RAD;
}

/** What the Sky view does per frame, for every star, compared with `skyState` for the 58. */
function agreement(engine: ExplorerEngine): Agreement {
  const catalog = engine.starfieldCatalog();
  const n = catalog.count;
  const units = new Float64Array(3 * n);
  const alt = new Float64Array(n);
  const az = new Float64Array(n);
  const m = new Float64Array(9);
  const out: Agreement = { cases: 0, maxAlt: 0, maxSep: 0, maxRaDec: 0, maxGeometry: 0 };
  for (const iso of ISO_TIMES) {
    const jd = jdOf(iso);
    const apparent = engine.starfieldApparent(jd);
    unitsFromRaDecArray(apparent, n, units);
    const gha = engine.sidereal(jd).gha_aries_deg;
    for (const { observer } of PLACES) {
      horizonMatrix(localSiderealDeg(gha, observer.lon_deg), observer.lat_deg, m);
      horizonBatch(units, n, m, refractionScale(), alt, az);
      const state = engine.skyState(observer, jd, 'navigational');
      expect(Math.abs(((state.gha_aries_deg - gha + 540) % 360) - 180)).toBeLessThan(1e-9);
      const stars = new Map(state.bodies.filter((b) => b.kind === 'star').map((b) => [b.body, b]));
      expect(stars.size).toBe(58);
      for (const { name, index } of catalog.navigational) {
        const b = stars.get(name);
        expect(b, name).toBeDefined();
        if (!b) continue;
        const h2 = b.alt_apparent_deg * DEG;
        const a2 = b.az_deg * DEG;
        out.maxAlt = Math.max(out.maxAlt, Math.abs(alt[index]! * RAD - b.alt_apparent_deg));
        out.maxSep = Math.max(out.maxSep, separationDeg(alt[index]!, az[index]!, h2, a2));
        const ra = apparent[2 * index]! * RAD;
        const dec = apparent[2 * index + 1]! * RAD;
        const dRa = Math.abs(((ra - b.ra_deg + 540) % 360) - 180) * Math.cos(dec * DEG);
        out.maxRaDec = Math.max(out.maxRaDec, dRa, Math.abs(dec - b.dec_deg));
        const g = starAltAz(b.ra_deg * DEG, b.dec_deg * DEG, gha, observer.lat_deg, observer.lon_deg);
        out.maxGeometry = Math.max(out.maxGeometry, separationDeg(g.alt_apparent_deg * DEG, g.az_deg * DEG, h2, a2));
        out.cases += 1;
      }
    }
  }
  return out;
}

describe('agreement with the mock engine’s sky_state (always runs)', () => {
  it('places the 58 navigational stars exactly where the mock’s sky_state does', () => {
    const a = agreement(new MockEngine({ syntheticStars: 0 }));
    expect(a.cases).toBe(58 * PLACES.length * ISO_TIMES.length);
    expect(a.maxSep).toBeLessThan(1e-6);
    expect(a.maxAlt).toBeLessThan(1e-6);
  });
});

const PKG = process.env.SKYFIX_WASM_PKG
  ? resolve(process.env.SKYFIX_WASM_PKG)
  : resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('agreement with the real core’s sky_state (needs a WASM build)', () => {
  let load: WasmLoad;

  beforeAll(async () => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as {
      initSync: (input: { module: BufferSource }) => unknown;
      init?: () => void;
    };
    glue.initSync({ module: readFileSync(WASM_FILE) });
    glue.init?.();
    load = inspectWasmModule(glue);
  });

  it('draws every navigational star within 0.01° of sky_state (apparent altitude and azimuth)', ({ skip }) => {
    if (load.status !== 'ready') {
      skip();
      return;
    }
    const a = agreement(load.engine);
    // Reported in the sky agent's final report; printed so a run shows the numbers.
    console.info(
      `sky vs sky_state, ${a.cases} star-place-times: max |Δ apparent altitude| ${(a.maxAlt * 3600).toFixed(2)}″, ` +
        `max separation ${(a.maxSep * 3600).toFixed(2)}″ (star field vs ephemeris catalogue up to ` +
        `${(a.maxRaDec * 3600).toFixed(2)}″, Rigil Kentaurus); geometry alone ${(a.maxGeometry * 3600).toExponential(1)}″`,
    );
    expect(a.cases).toBe(58 * PLACES.length * ISO_TIMES.length);
    expect(a.maxSep).toBeLessThan(0.01);
    expect(a.maxAlt).toBeLessThan(0.01);
    // The conversion itself adds nothing: what is left is the two catalogues' difference.
    expect(a.maxGeometry).toBeLessThan(1e-7);
  });
});
