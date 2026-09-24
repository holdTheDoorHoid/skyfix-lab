/**
 * The Sky view's data side, without a browser: star render data (bins, draw order,
 * names), the per-frame scene (engine budget, frames of date, projection), the
 * `highlightBodies` hook, and the text the tooltips show.
 */
import { describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { ExplorerEngine } from '../../src/next/engine/types.js';
import { createExplorerStore } from '../../src/next/state.js';
import { azimuthOf, DEG, horizonBatch, horizonMatrix, localSiderealDeg, unitsFromRaDecArray } from '../../src/next/sky/astro.js';
import { compassPoint, formatAngle, formatBearing, formatMagnitude } from '../../src/next/sky/format.js';
import { highlightBodies, skyHighlights } from '../../src/next/sky/highlight.js';
import { DomeProjector } from '../../src/next/sky/projection.js';
import { SkyScene } from '../../src/next/sky/scene.js';
import {
  binMagnitude,
  buildStarRenderData,
  colourBin,
  COLOUR_BINS,
  MAG_BINS,
  magBin,
  starAlpha,
  starRadius,
  starTitle,
} from '../../src/next/sky/stars.js';

const PHILLY = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 };
const T0 = 2_461_308.5; // 2026-09-25T00:00Z

/** A mock engine that counts calls. */
function countingEngine(): { engine: ExplorerEngine; calls: Record<string, number> } {
  const inner = new MockEngine({ syntheticStars: 500 });
  const calls: Record<string, number> = {};
  const count = (k: string): void => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  const engine: ExplorerEngine = Object.create(inner) as ExplorerEngine;
  const wrap = <K extends keyof MockEngine>(k: K): void => {
    const fn = (inner[k] as unknown as (...a: unknown[]) => unknown).bind(inner);
    (engine as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => {
      count(k);
      return fn(...a);
    };
  };
  wrap('starfieldApparent');
  wrap('starfieldFrameMatrix');
  wrap('sidereal');
  return { engine, calls };
}

describe('star render data', () => {
  const cat = new MockEngine({ syntheticStars: 1500 }).starfieldCatalog();
  const data = buildStarRenderData(cat);

  it('bins magnitudes and colours into range, NaN colour to the neutral bin', () => {
    expect(magBin(-1.75)).toBe(0);
    expect(magBin(-1.46)).toBe(1); // Sirius
    expect(magBin(99)).toBe(MAG_BINS - 1);
    expect(magBin(Number.NaN)).toBe(MAG_BINS - 1);
    expect(colourBin(Number.NaN)).toBe(COLOUR_BINS - 1);
    expect(colourBin(-5)).toBe(0);
    expect(colourBin(5)).toBe(COLOUR_BINS - 2);
    expect(Math.abs(binMagnitude(magBin(3.1)) - 3.1)).toBeLessThanOrEqual(0.125);
  });

  it('draws every star exactly once, faint groups first', () => {
    const seen = new Uint8Array(data.count);
    let lastMag = Infinity;
    for (let g = 0; g < data.groupCount; g += 1) {
      const [mb, , start, end] = [...data.groups.subarray(4 * g, 4 * g + 4)] as [number, number, number, number];
      expect(binMagnitude(mb)).toBeLessThanOrEqual(lastMag);
      lastMag = binMagnitude(mb);
      for (let k = start; k < end; k += 1) seen[data.order[k]!]! += 1;
    }
    expect([...seen].every((v) => v === 1)).toBe(true);
  });

  it('knows the 58 by their Nautical Almanac names and titles the rest', () => {
    expect(data.navByName.size).toBe(58);
    expect(data.isNav.reduce((a, b) => a + b, 0)).toBe(58);
    const vega = data.navByName.get('Vega')!;
    expect(starTitle(data, vega)).toBe('Vega');
    expect(data.byName.get('rigil kentaurus')).toBe(data.navByName.get('Rigil Kentaurus'));
    // Named stars come brightest first (label priority).
    for (let k = 1; k < data.named.length; k += 1) {
      expect(cat.vmag[data.named[k]!]!).toBeGreaterThanOrEqual(cat.vmag[data.named[k - 1]!]!);
    }
    // A synthetic star has neither name nor designation nor a real HR number.
    const anon = data.count - 1;
    expect(starTitle(data, anon)).toBe(`Star ${anon + 1}`);
  });

  it('sizes and fades by magnitude', () => {
    expect(starRadius(-1.5)).toBeGreaterThan(starRadius(1));
    expect(starRadius(1)).toBeGreaterThan(starRadius(6));
    expect(starAlpha(2, 6.5)).toBe(1);
    expect(starAlpha(6.4, 6.5)).toBeLessThan(0.5);
    expect(starAlpha(7.2, 6.5)).toBe(0);
  });
});

describe('scene', () => {
  it('asks for star places at most once per simulated hour, the sidereal angle every frame', () => {
    const { engine, calls } = countingEngine();
    const scene = new SkyScene();
    scene.setCatalog(engine.starfieldCatalog(), engine.constellationBoundaries());
    const flags = { boundaries: true, constellationLabels: true, equator: true, ecliptic: true };
    // Three simulated hours in one-minute frames.
    for (let k = 0; k <= 180; k += 1) scene.update(engine, PHILLY, T0 + k / 1440, flags);
    expect(calls.sidereal).toBe(181);
    expect(calls.starfieldApparent!).toBeLessThanOrEqual(4);
    expect(calls.starfieldFrameMatrix).toBe(calls.starfieldApparent);
    // Fast playback: a day per frame for a week, refreshed at most daily.
    const before = calls.starfieldApparent!;
    for (let k = 1; k <= 7; k += 1) scene.update(engine, PHILLY, T0 + k, { ...flags, daily: true });
    expect(calls.starfieldApparent! - before).toBeLessThanOrEqual(7);
  });

  it('puts the navigational stars where the reference conversion does, and marks what is up', () => {
    const engine = new MockEngine({ syntheticStars: 200 });
    const scene = new SkyScene();
    const cat = engine.starfieldCatalog();
    scene.setCatalog(cat, engine.constellationBoundaries());
    const jd = T0 + 0.2;
    scene.update(engine, PHILLY, jd, { boundaries: false, constellationLabels: false, equator: false, ecliptic: false });
    // Reference: the same hour-rounded star places through horizonBatch.
    const units = new Float64Array(3 * cat.count);
    unitsFromRaDecArray(engine.starfieldApparent(Math.round(jd * 24) / 24), cat.count, units);
    const alt = new Float64Array(cat.count);
    const az = new Float64Array(cat.count);
    const m = horizonMatrix(localSiderealDeg(engine.sidereal(jd).gha_aries_deg, PHILLY.lon_deg), PHILLY.lat_deg);
    horizonBatch(units, cat.count, m, 1, alt, az);
    for (const { index } of cat.navigational) {
      if (alt[index]! < -20 * DEG) continue; // the scene leaves far-below stars unrefracted
      expect(scene.starAlt(index)).toBeCloseTo(alt[index]!, 12);
      const d = Math.abs(((scene.starAz(index) - az[index]! + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      expect(d * Math.cos(alt[index]!)).toBeLessThan(1e-12);
    }
    const dome = new DomeProjector();
    dome.configure(500, 500, 450, false);
    scene.project(dome, 1000, 1000);
    for (let i = 0; i < cat.count; i += 1) {
      if (scene.onScreen[i]) {
        expect(scene.starAlt(i)).toBeGreaterThanOrEqual(0);
        expect(Math.hypot(scene.x[i]! - 500, scene.y[i]! - 500)).toBeLessThanOrEqual(450 + 1e-6);
      } else if (scene.starAlt(i) >= 0) {
        throw new Error(`star ${i} is up but not on screen`);
      }
    }
    expect(azimuthOf(0, -1)).toBeCloseTo(Math.PI, 12);
  });

  it('carries J2000 boundaries into the frame of date with the engine’s matrix', () => {
    const engine = new MockEngine({ syntheticStars: 10 });
    const scene = new SkyScene();
    scene.setCatalog(engine.starfieldCatalog(), engine.constellationBoundaries());
    scene.update(engine, PHILLY, T0, { boundaries: true, constellationLabels: true, equator: false, ecliptic: false });
    expect(scene.frameOfDate).toBe(true);
    // A rotation keeps unit vectors unit length and moves them by the precession since J2000.
    const b = scene.bUnits;
    const n = Math.hypot(b[0]!, b[1]!, b[2]!);
    expect(n).toBeCloseTo(1, 12);
    expect(scene.bCount).toBe(engine.constellationBoundaries().length);
  });

  it('keeps drawing stars without a frame matrix (identity) and reports star-field faults', () => {
    const inner = new MockEngine({ syntheticStars: 10 });
    const engine = Object.create(inner) as ExplorerEngine & { starfieldFrameMatrix?: unknown };
    engine.starfieldFrameMatrix = undefined;
    const scene = new SkyScene();
    scene.setCatalog(inner.starfieldCatalog(), []);
    scene.update(engine, PHILLY, T0, { boundaries: true, constellationLabels: true, equator: true, ecliptic: true });
    expect(scene.frameOfDate).toBe(false);
    expect(scene.starsOk).toBe(true);
    const broken = Object.create(inner) as ExplorerEngine;
    broken.starfieldApparent = () => {
      throw new Error('outside 1800-2200');
    };
    const s2 = new SkyScene();
    s2.setCatalog(inner.starfieldCatalog(), []);
    s2.update(broken, PHILLY, T0, { boundaries: false, constellationLabels: false, equator: false, ecliptic: false });
    expect(s2.starsOk).toBe(false);
    expect(s2.error).toMatch(/1800/);
  });
});

describe('highlightBodies (the hook for tonight’s star sights)', () => {
  it('keeps one list per explorer, cleaned, and tells subscribers once per change', () => {
    const a = { store: createExplorerStore({ storage: null }) };
    const b = { store: createExplorerStore({ storage: null }) };
    const seen: (readonly string[])[] = [];
    const stop = skyHighlights(a).subscribe((names) => seen.push(names));
    highlightBodies(a, [' Vega ', 'Arcturus', 'Vega', '']);
    highlightBodies(a, ['Vega', 'Arcturus']); // no change: no call
    expect(skyHighlights(a).get()).toEqual(['Vega', 'Arcturus']);
    expect(skyHighlights(b).get()).toEqual([]);
    highlightBodies(a, []);
    expect(seen).toEqual([['Vega', 'Arcturus'], []]);
    stop();
    highlightBodies(a, ['Jupiter']);
    expect(seen.length).toBe(2);
  });
});

describe('tooltip text', () => {
  it('formats heights and bearings in the chosen style', () => {
    expect(formatAngle(34.2051, 'dm')).toBe('34° 12.3′');
    expect(formatAngle(-0.5, 'dm')).toBe('−0° 30.0′');
    expect(formatAngle(34.2051, 'dms')).toBe('34° 12′ 18″');
    expect(formatAngle(34.2051, 'decimal')).toBe('34.21°');
    expect(formatAngle(-0.001, 'decimal')).toBe('0.00°');
    expect(formatBearing(359.99, 'dm')).toBe('359° 59.4′');
    expect(formatBearing(359.9995, 'dm')).toBe('0° 00.0′'); // never shown as 360°
    expect(formatBearing(359.99, 'decimal')).toBe('359.99°');
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(128)).toBe('SE');
    expect(compassPoint(349)).toBe('N');
    expect(formatMagnitude(-1.46)).toBe('−1.5');
    expect(formatMagnitude(-0.01)).toBe('0.0');
  });
});
