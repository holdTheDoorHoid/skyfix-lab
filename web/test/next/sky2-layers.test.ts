/**
 * The Sky view's astronomy layers (sky2 agent, expansion Q3), without a browser: the sky's
 * darkness and extinction (conditions.ts), the Milky Way's grid and raster (milkyway.ts),
 * deep-sky places, cut and hit-testing (deepsky.ts), meteor radiants (meteors.ts), fields
 * of view (fov.ts), rise times of fixed directions (astro.ts), the request, highlight and
 * added-body channels, and the search helpers — against the mock engine, and against the
 * built WebAssembly package where one exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import { inspectWasmModule, type WasmLoad } from '../../src/next/engine/wasm.js';
import {
  isDeepSkyEngine,
  isMoonDetailEngine,
  type DeepSkyEngine,
  type ExplorerEngine,
  type MilkyWayOutline,
  type OrbitalElements,
  type SearchHit,
  type ShowerYear,
} from '../../src/next/engine/types.js';
import { createExplorerStore } from '../../src/next/state.js';
import { DEG, horizonMatrix, localSiderealDeg, nextRise, RAD, SIDEREAL_DEG_PER_DAY, unitFromRaDec } from '../../src/next/sky/astro.js';
import {
  BORTLE_NELM,
  DARK_SKY_NELM,
  extinctionAt,
  milkyWayVisibility,
  relativeExtinction,
  settingsNelm,
  skyConditions,
  skyModel,
  zenithLimit,
} from '../../src/next/sky/conditions.js';
import { customBodies, fromMpc, MAX_CUSTOM_BODIES, MPC_CREDIT } from '../../src/next/sky/custom.js';
import { DeepSkyField, dsoKey, dsoReach, dsoShape, DsoShape, NO_MAGNITUDE_AS } from '../../src/next/sky/deepsky.js';
import { hitWhere, panelSkyOptions, runSkySearch, targetOfHit } from '../../src/next/sky/find.js';
import { formatDec, formatRa } from '../../src/next/sky/format.js';
import { cameraField, fovExtentDeg, fovLabel, fovOutline, sensorOf, type FovSettings } from '../../src/next/sky/fov.js';
import { highlightBodies, ringWhileShown, skyHighlights } from '../../src/next/sky/highlight.js';
import { activeShowers, lambdaFromPeak, radiantJ2000, rateWords, tonightFor, yearsFor } from '../../src/next/sky/meteors.js';
import {
  buildMilkyWayGrid,
  extinctionFade,
  galacticOf,
  GRID_B_MAX,
  horizonToGalactic,
  ICRS_TO_GALACTIC,
  matrixDelta,
  rasterMilkyWay,
  sampleGrid,
} from '../../src/next/sky/milkyway.js';
import { DomeProjector } from '../../src/next/sky/projection.js';
import { openUpClose, showInSky, skyRequests } from '../../src/next/sky/requests.js';
import { raDecGridUnits, SkyScene } from '../../src/next/sky/scene.js';

const PHILLY = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 };
const T0 = 2_461_308.5; // 2026-09-25T00:00Z
const mock = (): MockEngine & DeepSkyEngine => new MockEngine({ syntheticStars: 400 }) as MockEngine & DeepSkyEngine;

// ---------------------------------------------------------------------------------
// The sky's darkness and extinction
// ---------------------------------------------------------------------------------

describe('the sky’s darkness (conditions.ts)', () => {
  it('sends the engine the sky the settings name', () => {
    expect(skyConditions({ skyQuality: 'auto', skyBortle: 5, skyNelm: 6 })).toEqual({ nelm: DARK_SKY_NELM });
    expect(skyConditions({ skyQuality: 'bortle', skyBortle: 7.4, skyNelm: 6 })).toEqual({ bortle: 7 });
    expect(skyConditions({ skyQuality: 'bortle', skyBortle: 42, skyNelm: 6 })).toEqual({ bortle: 9 });
    expect(skyConditions({ skyQuality: 'nelm', skyBortle: 5, skyNelm: 9 })).toEqual({ nelm: 8 });
    expect(settingsNelm({ skyQuality: 'bortle', skyBortle: 1, skyNelm: 6 })).toBe(7.8);
    expect(settingsNelm({ skyQuality: 'bortle', skyBortle: 9, skyNelm: 6 })).toBe(4.0);
    expect(BORTLE_NELM).toHaveLength(9);
  });

  it('limits the zenith by twilight, and by the site in the Bortle and naked-eye settings', () => {
    // Automatic: the twilight curve alone (6.5 in full darkness).
    expect(zenithLimit(-30, 'auto', 4.3)).toBe(6.5);
    // A city sky at night: the site's limit.
    expect(zenithLimit(-30, 'bortle', 4.3)).toBe(4.3);
    // Civil twilight is brighter than any site: twilight's limit.
    const civil = zenithLimit(-3, 'bortle', 7.8);
    expect(civil).toBeLessThan(4);
    expect(zenithLimit(-3, 'auto', 7.8)).toBe(civil);
  });

  it('shows the Milky Way in a dark sky only', () => {
    expect(milkyWayVisibility(6.5)).toBe(1);
    expect(milkyWayVisibility(4.8)).toBe(0);
    expect(milkyWayVisibility(4.0)).toBe(0);
    expect(milkyWayVisibility(5.8)).toBeGreaterThan(0.5);
    expect(milkyWayVisibility(5.8)).toBeLessThan(0.7);
  });

  it('takes extinction relative to the zenith from the engine’s table', () => {
    const engine = mock();
    const table = engine.extinction({ nelm: 6 });
    const rel = relativeExtinction(table);
    expect(rel).toHaveLength(91);
    expect(rel[90]).toBe(0);
    for (let i = 1; i < 91; i += 1) expect(rel[i]!).toBeLessThanOrEqual(rel[i - 1]!);
    // Between whole degrees, linear; below the horizon, the horizon's value.
    expect(extinctionAt(rel, 10.5 * DEG)).toBeCloseTo((rel[10]! + rel[11]!) / 2, 6);
    expect(extinctionAt(rel, -3 * DEG)).toBe(rel[0]);
    expect(extinctionAt(rel, 90 * DEG)).toBe(0);
  });

  it('asks the engine once per sky and says when it cannot', () => {
    const engine = mock();
    const m = skyModel(engine, { skyQuality: 'bortle', skyBortle: 6, skyNelm: 6 });
    expect(m.error).toBeNull();
    expect(m.nelm).toBeCloseTo(5.3, 6);
    expect(m.extinction).toHaveLength(91);
    const plain = { ...new MockEngine({ syntheticStars: 10 }) } as unknown as ExplorerEngine; // no deep-sky methods
    const none = skyModel(plain, { skyQuality: 'nelm', skyBortle: 5, skyNelm: 5.5 });
    expect(none.extinction).toBeNull();
    expect(none.nelm).toBe(5.5);
    expect(none.error).toMatch(/not available in this engine/);
  });
});

// ---------------------------------------------------------------------------------
// The Milky Way
// ---------------------------------------------------------------------------------

/** A ring of constant galactic latitude, as ICRS degrees (every 5° of longitude, closed). */
function latitudeRing(b: number, level: number, reverse = false): MilkyWayOutline['rings'][number] {
  // Galactic → ICRS is the transpose of ICRS → galactic.
  const m = ICRS_TO_GALACTIC;
  const ra: number[] = [];
  const dec: number[] = [];
  for (let k = 0; k <= 72; k += 1) {
    const l = (reverse ? 72 - k : k) * 5 * DEG;
    const g = [Math.cos(b * DEG) * Math.cos(l), Math.cos(b * DEG) * Math.sin(l), Math.sin(b * DEG)];
    const x = m[0]! * g[0]! + m[3]! * g[1]! + m[6]! * g[2]!;
    const y = m[1]! * g[0]! + m[4]! * g[1]! + m[7]! * g[2]!;
    const z = m[2]! * g[0]! + m[5]! * g[1]! + m[8]! * g[2]!;
    let r = Math.atan2(y, x) * RAD;
    if (r < 0) r += 360;
    ra.push(r);
    dec.push(Math.asin(z) * RAD);
  }
  return { level, ra_deg: Float64Array.from(ra), dec_deg: Float64Array.from(dec) };
}

describe('the Milky Way (milkyway.ts)', () => {
  it('knows the galactic frame', () => {
    const centre = galacticOf(266.405, -28.936);
    expect(Math.min(centre.l, 360 - centre.l)).toBeLessThan(0.1);
    expect(Math.abs(centre.b)).toBeLessThan(0.1);
    expect(galacticOf(192.859, 27.128).b).toBeGreaterThan(89.9); // north galactic pole
  });

  it('fills a band between two rings, and a brighter level inside it, whichever way the rings run', () => {
    const outline = { levels: [0.3, 0.6], rings: [latitudeRing(10, 0), latitudeRing(-10, 0), latitudeRing(4, 1), latitudeRing(-4, 1)] };
    const sharp = buildMilkyWayGrid(outline, 0);
    const at = (l: number, b: number): number => sharp.value[Math.floor((b + GRID_B_MAX) / 0.5) * sharp.cols + Math.floor(l / 0.5)]!;
    expect(at(30, 0)).toBe(1); // both levels
    expect(at(200, 7)).toBe(0.5); // the faint band only
    expect(at(120, -15)).toBe(0); // outside
    expect(sharp.maxAbsB).toBeCloseTo(10, 6);
    const reversed = buildMilkyWayGrid({ ...outline, rings: outline.rings.map((r) => latitudeRing(Math.round(galacticOf(r.ra_deg[0]!, r.dec_deg[0]!).b), r.level, true)) }, 0);
    expect(Array.from(reversed.value)).toEqual(Array.from(sharp.value));
    // Blurred: soft edges, the same total light.
    const soft = buildMilkyWayGrid(outline, 1);
    const sum = (a: Float32Array): number => a.reduce((s, v) => s + v, 0);
    expect(sum(soft.value)).toBeCloseTo(sum(sharp.value), -1);
    expect(soft.value[Math.floor((10 + GRID_B_MAX) / 0.5) * soft.cols + 100]!).toBeGreaterThan(0.1);
    expect(soft.value[Math.floor((10 + GRID_B_MAX) / 0.5) * soft.cols + 100]!).toBeLessThan(0.5);
  });

  it('fills the mock engine’s two bands', () => {
    const grid = buildMilkyWayGrid(mock().milkyWayOutline(), 0);
    const v = (l: number, b: number): number => {
      const g = [Math.cos(b * DEG) * Math.cos(l * DEG), Math.cos(b * DEG) * Math.sin(l * DEG), Math.sin(b * DEG)];
      return sampleGrid(grid, g[0]!, g[1]!, g[2]!);
    };
    expect(v(10, 0)).toBe(1);
    expect(v(10, 8)).toBe(0.5);
    expect(v(10, 20)).toBe(0);
    expect(v(10, 60)).toBe(0);
  });

  it('turns the observer’s horizon into galactic coordinates', () => {
    const lst = 123.4;
    const hm = horizonMatrix(lst, PHILLY.lat_deg);
    const m = horizonToGalactic(hm, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    // A star at RA 200°, Dec 30°: its horizon vector, turned, is its galactic vector.
    const u = new Float64Array(3);
    unitFromRaDec(200 * DEG, 30 * DEG, u);
    const h = [0, 1, 2].map((i) => hm[3 * i]! * u[0]! + hm[3 * i + 1]! * u[1]! + hm[3 * i + 2]! * u[2]!);
    const g = [0, 1, 2].map((i) => m[3 * i]! * h[0]! + m[3 * i + 1]! * h[1]! + m[3 * i + 2]! * h[2]!);
    const want = galacticOf(200, 30);
    expect(Math.asin(g[2]!) * RAD).toBeCloseTo(want.b, 9);
    expect((Math.atan2(g[1]!, g[0]!) * RAD + 360) % 360).toBeCloseTo(want.l, 9);
    expect(matrixDelta(m, m)).toBe(0);
  });

  it('rasters the glow above the horizon only, fading toward it with extinction', () => {
    const grid = buildMilkyWayGrid(mock().milkyWayOutline(), 0);
    // Put the galactic centre at the zenith: a horizon frame whose "up" is the galactic x axis.
    const m = Float64Array.of(0, 1, 0, 0, 0, 1, 1, 0, 0); // (E, N, U) → galactic g = (N, U, E): the band runs north–south through the zenith
    const w = 40;
    const h = 40;
    const data = new Uint8ClampedArray(4 * w * h);
    const lit = rasterMilkyWay(grid, { data, width: w, height: h, cell: 5 }, { kind: 'dome', cx: 100, cy: 100, radius: 90, southUp: false }, m, { r: 1, g: 2, b: 3, alpha: 0.5, fade: null });
    expect(lit).toBeGreaterThan(0);
    const alphaAt = (x: number, y: number): number => data[4 * (Math.floor(y / 5) * w + Math.floor(x / 5)) + 3]!;
    expect(alphaAt(100, 100)).toBeCloseTo(127, -1); // the zenith: the centre, both levels
    expect(alphaAt(2, 2)).toBe(0); // outside the horizon circle
    expect(data[4 * (20 * w + 20)]).toBe(1);
    // With extinction the glow near the horizon is dimmer than overhead.
    const fade = extinctionFade(relativeExtinction(mock().extinction()));
    expect(fade[200]).toBeCloseTo(1, 6);
    expect(fade[10]!).toBeLessThan(0.3);
    const faded = new Uint8ClampedArray(4 * w * h);
    rasterMilkyWay(grid, { data: faded, width: w, height: h, cell: 5 }, { kind: 'dome', cx: 100, cy: 100, radius: 90, southUp: false }, m, { r: 1, g: 2, b: 3, alpha: 0.5, fade });
    // A point on the band 5° above the northern horizon (texel column 20, row 3).
    const nearRim = 4 * (3 * w + 20) + 3;
    expect(data[nearRim]!).toBeGreaterThan(0);
    expect(faded[nearRim]!).toBeLessThan(data[nearRim]! * 0.5);
    // The panorama: nothing below the horizon.
    const pano = new Uint8ClampedArray(4 * w * h);
    rasterMilkyWay(grid, { data: pano, width: w, height: h, cell: 5 }, { kind: 'panorama', width: 200, az0: 0, s: 100, yHorizon: 150 }, m, { r: 1, g: 2, b: 3, alpha: 0.5, fade: null });
    for (let y = 31; y < h; y += 1) for (let x = 0; x < w; x += 1) expect(pano[4 * (y * w + x) + 3]).toBe(0);
  });
});

// ---------------------------------------------------------------------------------
// Deep-sky objects
// ---------------------------------------------------------------------------------

describe('deep-sky objects (deepsky.ts)', () => {
  it('draws each kind with its own symbol', () => {
    expect(dsoShape('spiral_galaxy')).toBe(DsoShape.Galaxy);
    expect(dsoShape('irregular_galaxy')).toBe(DsoShape.Galaxy);
    expect(dsoShape('open_cluster')).toBe(DsoShape.OpenCluster);
    expect(dsoShape('globular_cluster')).toBe(DsoShape.Globular);
    expect(dsoShape('emission_nebula')).toBe(DsoShape.Nebula);
    expect(dsoShape('supernova_remnant')).toBe(DsoShape.Nebula);
    expect(dsoShape('planetary_nebula')).toBe(DsoShape.Planetary);
    expect(dsoShape('cluster_with_nebula')).toBe(DsoShape.ClusterNebula);
    expect(dsoShape('star_cloud')).toBe(DsoShape.Other);
  });

  it('reaches fainter as the chart zooms in, within bounds', () => {
    expect(dsoReach(3.4)).toBeCloseTo(1.5, 9); // a laptop's whole-sky chart
    expect(dsoReach(6.8)).toBeCloseTo(3.1, 9);
    expect(dsoReach(1)).toBe(-1); // a phone's whole-sky chart: the showpieces only
    expect(dsoReach(100)).toBe(4);
    for (let px = 0.5; px < 60; px += 0.5) expect(dsoReach(px + 0.5)).toBeGreaterThanOrEqual(dsoReach(px));
  });

  it('places the catalogue by the engine, cuts it by magnitude, and hit-tests the small over the large', () => {
    const engine = mock();
    const field = new DeepSkyField();
    expect(field.load(engine)).toBe(true);
    expect(field.n).toBe(engine.dsoCatalog().objects.length);
    expect(field.indexOf('m 31')).toBe(field.indexOf('NGC224'));
    expect(field.indexOf('nonsense')).toBe(-1);
    expect(dsoKey('NGC 869')).toBe('ngc869');
    field.ensureBucket(engine, T0);
    expect(field.ok).toBe(true);
    // Its places are the engine's apparent places of date.
    const pos = engine.dsoList(null, T0);
    const i31 = field.indexOf('M31');
    const k = Array.from(pos.index).indexOf(i31);
    const rd = field.raDec(i31);
    expect(rd.ra).toBeCloseTo(pos.ra_deg[k]!, 9);
    expect(rd.dec).toBeCloseTo(pos.dec_deg[k]!, 9);
    const scene = new SkyScene();
    scene.setCatalog(engine.starfieldCatalog(), []);
    scene.update(engine, PHILLY, T0 + 2 / 24, { boundaries: false, constellationLabels: false, equator: false, ecliptic: false });
    field.update(scene.hm, scene.refraction);
    const dome = new DomeProjector();
    dome.configure(400, 400, 380, false);
    const all = field.project(dome, 800, 800, 99, null);
    const bright = field.project(dome, 800, 800, 5, null);
    expect(all).toBeGreaterThan(bright);
    for (let i = 0; i < field.n; i += 1) {
      if (field.on[i]) {
        expect(field.h.alt[i]!).toBeGreaterThanOrEqual(0);
        expect(field.effMag[i]!).toBeLessThanOrEqual(5);
      }
    }
    // M31 at 2 h UTC from Philadelphia in late September is high in the east.
    field.project(dome, 800, 800, 99, null);
    expect(field.on[i31]).toBe(1);
    const hit = field.hit(field.x[i31]!, field.y[i31]!);
    expect(hit?.index).toBe(i31);
    expect(field.hit(-500, -500)).toBeNull();
    // Extinction dims objects low in the sky.
    const ext = relativeExtinction(engine.extinction());
    field.project(dome, 800, 800, 99, ext);
    for (let i = 0; i < field.n; i += 1) if (field.on[i]) expect(field.effMag[i]!).toBeGreaterThanOrEqual(field.mag[i]!);
    expect(NO_MAGNITUDE_AS).toBe(7);
  });
});

// ---------------------------------------------------------------------------------
// Meteor radiants
// ---------------------------------------------------------------------------------

describe('meteor radiants (meteors.ts)', () => {
  const shower = {
    shower: { lambda_start_deg: 350, lambda_peak_deg: 5, lambda_end_deg: 15, ra_deg: 100, dec_deg: 20, dra_deg: 1, ddec_deg: -0.5 },
    start: { jd_utc: 100, utc: '' },
    peak: { jd_utc: 115, utc: '' },
    end: { jd_utc: 125, utc: '' },
  };

  it('interpolates the solar longitude between the engine’s own instants, across 0°', () => {
    expect(lambdaFromPeak(shower, 100)).toBeCloseTo(-15, 9);
    expect(lambdaFromPeak(shower, 115)).toBeCloseTo(0, 12);
    expect(lambdaFromPeak(shower, 125)).toBeCloseTo(10, 9);
    expect(lambdaFromPeak(shower, 120)).toBeCloseTo(5, 9);
  });

  it('follows the Sun between the engine’s instants, over the longest run of the table (verify2)', () => {
    // The Sun's longitude referred to the J2000 equinox (Meeus, Astronomical Algorithms,
    // ch. 25, low precision: 0.01°), and the instants at which it reaches a shower's table
    // values, as the engine finds them. The Southern Taurids of 2026 run 46 days to their
    // peak: a straight line there was 0.15° off the Sun; the parabola must stay within 0.01°.
    const sunLambda = (jd: number): number => {
      const t = (jd - 2451545) / 36525;
      const m = (357.52911 + 35999.05029 * t - 0.0001537 * t * t) * DEG;
      const c = (1.914602 - 0.004817 * t) * Math.sin(m) + (0.019993 - 0.000101 * t) * Math.sin(2 * m) + 0.000289 * Math.sin(3 * m);
      return (((280.46646 + 36000.76983 * t + 0.0003032 * t * t + c - 1.3969713 * t) % 360) + 360) % 360;
    };
    const when = (lambda: number, guess: number): number => {
      let jd = guess;
      for (let i = 0; i < 20; i += 1) jd -= ((((sunLambda(jd) - lambda + 540) % 360) - 180) / 360) * 365.2422;
      return jd;
    };
    for (const [code, ls, lp, le, guess] of [['STA', 177, 223, 238, 2461350], ['PER', 114, 140, 151, 2461265]] as const) {
      const s = {
        shower: { lambda_start_deg: ls, lambda_peak_deg: lp, lambda_end_deg: le },
        start: { jd_utc: when(ls, guess - 45), utc: '' },
        peak: { jd_utc: when(lp, guess), utc: '' },
        end: { jd_utc: when(le, guess + 15), utc: '' },
      };
      let worst = 0;
      for (let jd = s.start.jd_utc; jd <= s.end.jd_utc; jd += 0.25) {
        const truth = (((sunLambda(jd) - lp + 540) % 360) - 180);
        worst = Math.max(worst, Math.abs(lambdaFromPeak(s, jd) - truth));
      }
      expect(worst, code).toBeLessThan(0.01);
    }
  });

  it('drifts the radiant from its place at the peak', () => {
    expect(radiantJ2000(shower.shower, 0)).toEqual({ ra: 100, dec: 20 });
    const r = radiantJ2000(shower.shower, 10);
    expect(r.ra).toBeCloseTo(110, 9);
    expect(r.dec).toBeCloseTo(15, 9);
    expect(radiantJ2000({ ra_deg: 359, dec_deg: 89, dra_deg: 1, ddec_deg: 1 }, 4)).toEqual({ ra: 3, dec: 90 });
  });

  it('lists the showers active at an instant, strongest first, with radiants of date', () => {
    const engine = mock();
    const year: ShowerYear = engine.meteorShowers(2026);
    const d = year.showers[0]!;
    const mid = (d.start.jd_utc + d.end.jd_utc) / 2;
    const active = activeShowers([year, null], mid, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(active.map((a) => a.dates.shower.code)).toContain(d.shower.code);
    for (let k = 1; k < active.length; k += 1) expect(active[k - 1]!.dates.shower.zhr).toBeGreaterThanOrEqual(active[k]!.dates.shower.zhr);
    for (const a of active) {
      expect(Math.hypot(a.unit[0]!, a.unit[1]!, a.unit[2]!)).toBeCloseTo(1, 12);
      expect(mid).toBeGreaterThanOrEqual(a.dates.start.jd_utc);
    }
    // The same year twice lists each shower once.
    expect(activeShowers([year, year], mid, [1, 0, 0, 0, 1, 0, 0, 0, 1])).toHaveLength(active.length);
    expect(activeShowers([year], year.showers[0]!.start.jd_utc - 400, [1, 0, 0, 0, 1, 0, 0, 0, 1])).toEqual([]);
  });

  it('asks for the neighbouring year near its ends', () => {
    expect(yearsFor(2_461_041.5)).toEqual([2026, 2025]); // 2026-01-01
    expect(yearsFor(2_461_220.5)).toEqual([2026]); // 2026-06-29
    expect(yearsFor(2_461_404.5)).toEqual([2026, 2027]); // 2026-12-31
  });

  it('says rates in words and finds the night’s estimate', () => {
    expect(rateWords(0.2)).toBe('hardly any');
    expect(rateWords(2)).toBe('a few an hour');
    expect(rateWords(7.4)).toBe('about 7 an hour');
    expect(rateWords(43)).toBe('about 45 an hour');
    expect(tonightFor(null, 'PER')).toBeNull();
    expect(tonightFor([{ code: 'PER' } as never], 'PER')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------
// Fields of view
// ---------------------------------------------------------------------------------

describe('fields of view (fov.ts)', () => {
  it('works out a camera’s field from the lens and sensor', () => {
    const f = cameraField(50, sensorOf('ff'));
    expect(f.widthDeg).toBeCloseTo(39.6, 1);
    expect(f.heightDeg).toBeCloseTo(27.0, 1);
    expect(sensorOf('nonsense').id).toBe('ff');
    const s: FovSettings = { preset: 'camera', focalMm: 50, sensorId: 'ff', anchor: 'target' };
    expect(fovLabel(s)).toBe('Camera 50 mm · 40° × 27°');
    expect(fovLabel({ ...s, focalMm: 300 })).toBe('Camera 300 mm · 6.9° × 4.6°');
    expect(fovExtentDeg(s)).toBeCloseTo(39.6, 1);
    expect(fovLabel({ ...s, preset: 'bino7x50' })).toBe('Binoculars 7×50 · 7.1°');
    expect(fovLabel({ ...s, preset: 'eye' })).toBe('Naked eye · 50°');
    expect(fovLabel({ ...s, preset: null })).toBe('');
  });

  it('draws a circle at its angular radius and a camera frame level with the horizon', () => {
    const out = new Float64Array(3 * 200);
    const alt = 35 * DEG;
    const az = 120 * DEG;
    const d = [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)];
    const n = fovOutline(d, { diameterDeg: 7.1 }, out);
    expect(n).toBeGreaterThan(90);
    for (let k = 0; k < n; k += 1) {
      const dot = out[3 * k]! * d[0]! + out[3 * k + 1]! * d[1]! + out[3 * k + 2]! * d[2]!;
      expect(Math.acos(Math.min(1, dot)) * RAD).toBeCloseTo(3.55, 9);
    }
    const m = fovOutline(d, { widthDeg: 40, heightDeg: 27 }, out);
    // The top edge's middle is 13.5° above the centre, straight up (same azimuth).
    const top = 8; // points 0..15 run along the top edge; the 8th is its middle
    const e = out[3 * top]!;
    const nn = out[3 * top + 1]!;
    const u = out[3 * top + 2]!;
    expect(Math.asin(u) * RAD).toBeCloseTo(35 + 13.5, 6);
    expect((Math.atan2(e, nn) * RAD + 360) % 360).toBeCloseTo(120, 6);
    expect(m).toBe(65);
    // Looking straight up still makes a frame.
    expect(fovOutline([0, 0, 1], { diameterDeg: 1 }, out)).toBeGreaterThan(90);
  });
});

// ---------------------------------------------------------------------------------
// Rise times, formats
// ---------------------------------------------------------------------------------

describe('when a fixed direction rises (astro.ts nextRise)', () => {
  /** The first time after 0 the apparent (−34′) horizon is crossed upward, by brute force. */
  function bruteRise(raDeg: number, decDeg: number, latDeg: number, lst0: number): number {
    const u = new Float64Array(3);
    unitFromRaDec(raDeg * DEG, decDeg * DEG, u);
    const alt = (t: number): number => {
      const m = horizonMatrix((lst0 + SIDEREAL_DEG_PER_DAY * t) % 360, latDeg);
      return Math.asin(m[6]! * u[0]! + m[7]! * u[1]! + m[8]! * u[2]!) * RAD + 34 / 60;
    };
    let prev = alt(0);
    for (let t = 1e-4; t < 1.01; t += 1e-4) {
      const a = alt(t);
      if (prev < 0 && a >= 0) return t;
      prev = a;
    }
    return Number.NaN;
  }

  it('matches the rotating sky to a second', () => {
    for (const [ra, dec, lat, lst] of [
      [279.2, 38.8, 39.95, 10],
      [101.3, -16.7, 39.95, 200],
      [10.7, 41.3, -33.9, 55.5],
      [266.4, -28.9, 51.5, 300],
    ] as const) {
      const r = nextRise(ra, dec, lat, lst);
      expect(typeof r).toBe('object');
      const dt = (r as { dtDays: number }).dtDays;
      expect(Math.abs(dt - bruteRise(ra, dec, lat, lst)) * 86_400).toBeLessThan(10);
      expect(dt).toBeGreaterThanOrEqual(0);
      expect(dt).toBeLessThan(1.0);
    }
  });

  it('knows the circumpolar and the never-rising', () => {
    expect(nextRise(0, 89, 40, 0)).toBe('always');
    expect(nextRise(0, -89, 40, 0)).toBe('never');
    expect(localSiderealDeg(350, 20)).toBe(10);
  });

  it('writes right ascension and declination', () => {
    expect(formatRa(0)).toBe('0h 00m 00s');
    expect(formatRa(10.6847)).toBe('0h 42m 44s');
    expect(formatRa(359.9999)).toBe('0h 00m 00s');
    expect(formatDec(41.2692)).toBe('+41° 16′');
    expect(formatDec(-0.0001)).toBe('0° 00′');
    expect(formatDec(-28.936)).toBe('−28° 56′');
    expect(formatDec(-28.936, 'decimal')).toBe('−28.94°');
  });
});

// ---------------------------------------------------------------------------------
// The scene's additions
// ---------------------------------------------------------------------------------

describe('the scene (sky2 additions)', () => {
  it('builds the RA/Dec grid of date', () => {
    const g = raDecGridUnits();
    expect(g.count).toBe(24 + 17);
    expect(Number.isFinite(g.hourOf[0]!)).toBe(true);
    expect(g.decOf[24]).toBe(-80);
    for (let i = 0; i < g.units.length / 3; i += 1) expect(Math.hypot(g.units[3 * i]!, g.units[3 * i + 1]!, g.units[3 * i + 2]!)).toBeCloseTo(1, 12);
  });

  it('dims stars toward the horizon and keeps the bucket during fast playback', () => {
    const engine = mock();
    const scene = new SkyScene();
    scene.setCatalog(engine.starfieldCatalog(), []);
    const flags = { boundaries: false, constellationLabels: false, equator: false, ecliptic: false };
    scene.update(engine, PHILLY, T0, flags);
    const dome = new DomeProjector();
    dome.configure(400, 400, 380, false);
    const ext = relativeExtinction(engine.extinction());
    scene.project(dome, 800, 800, 24, ext);
    let low = 0;
    for (let i = 0; i < scene.n; i += 1) {
      if (!scene.onScreen[i]) continue;
      const a = scene.h.alt[i]! * RAD;
      const dimmed = scene.effMag[i]! - scene.stars!.vmag[i]!;
      expect(dimmed).toBeGreaterThanOrEqual(0);
      if (a < 5) {
        expect(dimmed).toBeGreaterThan(1.5);
        low += 1;
      }
      if (a > 80) expect(dimmed).toBeLessThan(0.01);
    }
    expect(low).toBeGreaterThan(0);
    scene.project(dome, 800, 800, 24, null);
    for (let i = 0; i < scene.n; i += 1) if (scene.onScreen[i]) expect(scene.effMag[i]).toBe(scene.stars!.vmag[i]);
    // Frozen: a later hour keeps the last places.
    const before = scene.refreshes;
    scene.update(engine, PHILLY, T0 + 0.5, { ...flags, frozen: true });
    expect(scene.refreshes).toBe(before);
    scene.update(engine, PHILLY, T0 + 0.5, flags);
    expect(scene.refreshes).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------------
// Channels: requests, highlights, added bodies
// ---------------------------------------------------------------------------------

describe('asking the Sky view from other views (requests.ts)', () => {
  it('keeps one request until the view takes it, and opens the view', () => {
    const store = createExplorerStore({ storage: null });
    const ctx = { store };
    const seen: number[] = [];
    const stop = skyRequests(ctx).subscribe(() => seen.push(1));
    showInSky(ctx, { kind: 'deep_sky', id: 'M31' });
    expect(store.get().view).toBe('sky');
    expect(skyRequests(ctx).peek()?.target).toEqual({ kind: 'deep_sky', id: 'M31' });
    openUpClose(ctx, 'Moon', { features: ['Copernicus'] });
    const r = skyRequests(ctx).take();
    expect(r?.upClose).toBe('Moon');
    expect(r?.features).toEqual(['Copernicus']);
    expect(skyRequests(ctx).take()).toBeNull();
    expect(seen).toHaveLength(2);
    stop();
    // Another explorer's channel is its own.
    expect(skyRequests({ store: createExplorerStore({ storage: null }) }).peek()).toBeNull();
  });
});

describe('highlight sources (highlight.ts)', () => {
  it('rings the union of every source, and clears one without the others', () => {
    const ctx = { store: createExplorerStore({ storage: null }) };
    const h = skyHighlights(ctx);
    highlightBodies(ctx, ['Vega', 'Deneb']);
    highlightBodies(ctx, ['Altair', 'Vega'], 'tonight-sights');
    expect(h.get()).toEqual(['Vega', 'Deneb', 'Altair']);
    highlightBodies(ctx, []);
    expect(h.get()).toEqual(['Altair', 'Vega']);
  });

  it('rings a panel’s list while it is shown (outside the shell: always), and clears it on destroy', () => {
    const ctx = { store: createExplorerStore({ storage: null }) };
    const host = { closest: () => null } as unknown as HTMLElement;
    const ring = ringWhileShown(ctx, host, 'tonight-sights');
    ring.set(['Kochab', 'Jupiter']);
    expect(skyHighlights(ctx).get()).toEqual(['Kochab', 'Jupiter']);
    ring.destroy();
    expect(skyHighlights(ctx).get()).toEqual([]);
  });
});

describe('added comets and asteroids (custom.ts)', () => {
  const body = (name: string, source: OrbitalElements['source'] = 'manual'): OrbitalElements =>
    ({ name, designation: null, class: 'asteroid', epoch_jd_tt: T0, perihelion_distance_au: 2, eccentricity: 0.1, inclination_deg: 1, ascending_node_deg: 2, argument_of_perihelion_deg: 3, perihelion_jd_tt: T0, magnitude: { model: 'none' }, source }) as OrbitalElements;

  it('adds, replaces by name, removes, keeps at most twenty, and credits the MPC', () => {
    const ctx = { store: createExplorerStore({ storage: null }) };
    const c = customBodies(ctx);
    c.add([body('A'), body('B', 'mpcorb')]);
    c.add([body('A')], 'Source: a circular');
    expect(c.get().map((b) => b.name)).toEqual(['B', 'A']);
    expect(c.creditOf(c.get()[0]!)).toBe(MPC_CREDIT);
    expect(c.creditOf(c.get()[1]!)).toBe('Source: a circular');
    expect(fromMpc(body('C', 'mpc_comet'))).toBe(true);
    c.remove('B');
    expect(c.get().map((b) => b.name)).toEqual(['A']);
    c.add(Array.from({ length: 30 }, (_, i) => body(`N${i}`)));
    expect(c.get()).toHaveLength(MAX_CUSTOM_BODIES);
    c.clear();
    expect(c.get()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------------

describe('search helpers (find.ts)', () => {
  const hit = (over: Partial<SearchHit>): SearchHit => ({
    kind: 'star',
    id: 'HR 7001',
    label: 'Vega',
    detail: '',
    magnitude: 0,
    index: 6988,
    ra_deg: null,
    dec_deg: null,
    alt_deg: null,
    az_deg: null,
    alt_apparent_deg: null,
    above_horizon: null,
    score: 100,
    ...over,
  });

  it('maps each kind of hit to what the Sky view shows', () => {
    expect(targetOfHit(hit({}))).toEqual({ kind: 'star', id: '6988' });
    expect(targetOfHit(hit({ index: null }))).toEqual({ kind: 'star', id: 'HR 7001' });
    expect(targetOfHit(hit({ kind: 'planet', id: 'Mars', label: 'Mars' }))).toEqual({ kind: 'body', id: 'Mars' });
    expect(targetOfHit(hit({ kind: 'moon', id: 'Moon', label: 'Moon' }))).toEqual({ kind: 'body', id: 'Moon' });
    expect(targetOfHit(hit({ kind: 'deep_sky', id: 'M31' }))).toEqual({ kind: 'deep_sky', id: 'M31' });
    expect(targetOfHit(hit({ kind: 'constellation', id: 'Ori' }))).toEqual({ kind: 'constellation', id: 'Ori' });
    expect(targetOfHit(hit({ kind: 'shower', id: 'PER' }))).toEqual({ kind: 'shower', id: 'PER' });
  });

  it('says where a hit is in plain words', () => {
    expect(hitWhere(hit({}))).toBe('');
    expect(hitWhere(hit({ above_horizon: true, alt_apparent_deg: 34.4, az_deg: 225 }))).toBe('34° up in the SW');
    expect(hitWhere(hit({ above_horizon: false, alt_apparent_deg: -12, az_deg: 10 }))).toBe('below the horizon');
  });

  it('searches through the engine, and offers the panel only confident matches', () => {
    const engine = mock();
    const r = runSkySearch(engine, 'andromeda', PHILLY, T0);
    expect(r.error).toBeNull();
    expect(r.hits.length).toBeGreaterThan(0);
    expect(runSkySearch(engine, '  ', PHILLY, T0).hits).toEqual([]);
    const plain = { ...new MockEngine({ syntheticStars: 10 }) } as unknown as ExplorerEngine;
    expect(runSkySearch(plain, 'vega', null, null).unavailable).toBe(true);
    expect(panelSkyOptions(engine, 'a', PHILLY, T0)).toEqual([]);
    const opts = panelSkyOptions(engine, 'andromeda', PHILLY, T0);
    for (const o of opts) expect(o.hit.score).toBeGreaterThanOrEqual(60);
  });
});

// ---------------------------------------------------------------------------------
// The built WebAssembly package, when there is one
// ---------------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('the Sky view’s layers on the built WebAssembly package', () => {
  let load: WasmLoad;
  beforeAll(async () => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as { initSync: (i: { module: BufferSource }) => unknown; init?: () => void };
    glue.initSync({ module: readFileSync(WASM_FILE) });
    glue.init?.();
    load = inspectWasmModule(glue);
  });

  it('finds things by name in under 5 ms (the fastest of 20, as the engine’s own timing test judges it; 15 ms on an overloaded machine)', ({ skip }) => {
    if (load.status !== 'ready' || !isDeepSkyEngine(load.engine)) return skip();
    const engine = load.engine;
    engine.skySearch('vega', PHILLY, T0, 12); // warm
    let best = Infinity;
    for (let k = 0; k < 20; k += 1) {
      const t0 = performance.now();
      const r = engine.skySearch(['vega', 'm31', 'orion', 'perseids', 'alpha cma'][k % 5]!, PHILLY, T0 + k / 100, 12);
      best = Math.min(best, performance.now() - t0);
      expect(r.hits.length).toBeGreaterThan(0);
    }
    // Strict unless the machine is running more than a job per core (then the number is only reported).
    const busy = loadavg()[0]! > cpus().length;
    if (busy) console.info(`sky_search: fastest of 20 ${best.toFixed(2)} ms, load average ${loadavg()[0]!.toFixed(1)} on ${cpus().length} cores`);
    expect(best).toBeLessThan(busy ? 15 : 5);
  });

  it('fills the engine’s Milky Way: the Sagittarius cloud bright, the dust lane dimmer, the poles dark, the whole band lit', ({ skip }) => {
    if (load.status !== 'ready' || !isDeepSkyEngine(load.engine)) return skip();
    const grid = buildMilkyWayGrid(load.engine.milkyWayOutline());
    expect(grid.maxAbsB).toBeLessThan(GRID_B_MAX);
    const v = (l: number, b: number): number => {
      const g = [Math.cos(b * DEG) * Math.cos(l * DEG), Math.cos(b * DEG) * Math.sin(l * DEG), Math.sin(b * DEG)];
      return sampleGrid(grid, g[0]!, g[1]!, g[2]!);
    };
    expect(v(5, -7)).toBeGreaterThan(0.9); // the Sagittarius star cloud, below the plane
    expect(v(5, 0)).toBeLessThan(0.4); // the dust lane along the plane toward the centre
    expect(v(5, 6)).toBeGreaterThan(0.8); // the clouds above it in Ophiuchus and Scorpius
    expect(v(0, 88)).toBe(0);
    expect(v(0, -88)).toBe(0);
    for (let l = 0; l < 360; l += 15) expect(v(l, 0)).toBeGreaterThan(0.2);
  });

  it('agrees with the engine’s rise times for a star (nextRise, within a minute)', ({ skip }) => {
    if (load.status !== 'ready') return skip();
    const engine = load.engine;
    const vega = engine.skyState(PHILLY, T0, ['Vega']).bodies[0]!;
    const lst = localSiderealDeg(engine.sidereal(T0).gha_aries_deg, PHILLY.lon_deg);
    const r = nextRise(vega.ra_deg, vega.dec_deg, PHILLY.lat_deg, lst);
    const ev = engine.dayEvents(PHILLY, T0, T0 + 1.1, ['Vega']);
    const rise = ev.bodies[0]!.events.find((e) => e.kind === 'rise')!;
    expect(Math.abs(T0 + (r as { dtDays: number }).dtDays - rise.jd_utc) * 1440).toBeLessThan(1);
  });

  it('dims by the engine’s air mass (Pickering 2002): k(X − 1) at 10° up', ({ skip }) => {
    if (load.status !== 'ready' || !isDeepSkyEngine(load.engine)) return skip();
    const rel = relativeExtinction(load.engine.extinction({ nelm: 6, k: 0.25 }));
    const X = (h: number): number => 1 / Math.sin((h + 244 / (165 + 47 * h ** 1.1)) * DEG);
    expect(rel[10]).toBeCloseTo(0.25 * (X(10) - X(90)), 4);
    expect(rel[0]).toBeCloseTo(0.25 * (X(0) - X(90)), 3);
  });

  it('has the Moon in detail for the close-up', ({ skip }) => {
    if (load.status !== 'ready') return skip(); // verify2: skipped, not a silent pass
    expect(isMoonDetailEngine(load.engine)).toBe(true);
  });
});
